/*
 * BVR Hockey 26 — общая симуляция матча: физика, правила, ИИ, управление игроками.
 *
 * Один и тот же файл работает
 *   · в браузере — обычный <script src="shared/sim.js">, даёт globalThis.BVRSim (index.html: одиночная игра и хост);
 *   · в Cloudflare Worker / Durable Object и в Node.js — `import './shared/sim.js'` (ES-модуль без экспортов,
 *     тоже кладёт BVRSim в globalThis; shared/sim.mjs — то же с `export default`).
 * Никаких DOM, звука, камеры, сети: что случилось — события (env.emit), как показать — решает клиент
 * (env.fx: звук у бортов, «офсайд», смена игрока, конец матча, счёт, анимация действия, брызги).
 *
 * Код перенесён из index.html без изменения поведения: с тем же Math.random (env.random по умолчанию)
 * `npm run balance` даёт те же цифры до последнего знака. Порядок вызовов случайных чисел — часть
 * поведения: не переставлять.
 *
 *   var sim = BVRSim.create({ emit(name, e), fx:{…}, random, toWorld(mx,mz,out), sprayK() });
 *   sim.setControl({ tick:[b,b], hum:[b,b], inp:[inp0,inp1], edge:[e0,e1], rem:[r0|null,r1|null], lv:['normal','hard'], first:0 });
 *   sim.reset(true); sim.state='face'; …; var r = sim.step(1/60);   // r: 0 — ранний выход, 1 — гол (люди уже отыграли), 2 — полный шаг
 *   sim.state, sim.clock, sim.players, sim.puck, sim.score, … — живое состояние (get/set)
 *
 * inp — {mx, mz, _A, _B, _X, _Y, RT, _LB} (стик в экранных координатах, в мир переводит env.toWorld;
 * на сервере — тождественно, клиент шлёт уже мировое направление); edge — фронты {A,B,X,Y,LB} этого шага;
 * rem — состояние удалённого ввода {tapB, pend}: придержка нажатий у шайбы (сетевая задержка).
 */
(function (G) {
'use strict';

/* ---------- площадка: X = длина, Z = ширина ---------- */
var RL=30, RW=15;
var GOAL_X=RL-4.0, BLUE_X=8.5, CORNER=7.0;
function halfWidthAt(x){
  var r=CORNER, ax=Math.abs(x);
  if(ax<=RL-r) return RW;
  var d=ax-(RL-r);
  if(d>=r) return 0;
  return (RW-r)+Math.sqrt(Math.max(0,r*r-d*d));
}

function noop(){}

function create(env){
  env=env||{};
  /* Math.random ищется при каждом вызове: в браузере его подменяет ?seed до старта матча */
  var R=env.random||function(){ return Math.random(); };
  var emit=env.emit||noop;
  var F=env.fx||{};
  var fx={boards:F.boards||noop, offside:F.offside||noop, swap:F.swap||noop, over:F.over||noop,
          score:F.score||noop, act:F.act||noop, spray:F.spray||noop};
  var toWorld=env.toWorld||function(mx,mz,out){ out[0]=mx; out[1]=mz; return out; };
  var sprayK=env.sprayK||function(){ return 0; };
  function rnd(a,b){return a+R()*(b-a);}
  function clamp(v,a,b){return v<a?a:(v>b?b:v);}
  function lerp(a,b,t){return a+(b-a)*t;}
  function r2(v){ return Math.round(v*100)/100; }
  function stickEnd(p){ return [p.x+Math.cos(p.yaw)*0.95, p.z+Math.sin(p.yaw)*0.95]; }
  /* адресат паса партнёра (и выигранного вбрасывания), пока шайба свободна и летит: он разворачивается к ней клюшкой
     и принимает и коньком / телом — раньше шайба, пришедшая в спину или в бок, проезжала мимо стоящего игрока */
  function recvOf(p){
    return !!(LASTPASS && LASTPASS.to===p && LASTPASS.from.team===p.team && !puck.owner && SIMT-LASTPASS.t<RECV_CFG.run && !p.goalie);
  }

  /* кем управляет ввод (см. setControl) */
  var CFG={tick:[false,false], hum:[false,false], inp:[null,null], edge:[null,null], rem:[null,null],
           lv:['normal','normal'], first:0};

  var players=[], puck={x:0,y:0.05,z:0,vx:0,vz:0,vy:0,owner:null,free:0};
  var score=[0,0], period=1, clock=5*60, state='menu', stateT=0;
  function mkHS(){ return {ctrl:null, charge:0, pressT:0, pressCd:0, autoT:0,
    press:{on:false,x:0,z:0,d:0}, goalieCtl:false, prevCtl:null, pokeT:0,
    aimX:1, aimZ:0, thruM:null, thruT:0, otT:0, otRecv:0}; }
  var HS=[mkHS(),mkHS()];
  var checkT=0, pokeT=0;
  var pen=[], offWarn=-1, lastTouch=null, prevZone=[0,0];
  /* тактика ботов: 0 стандарт, 1 атака, 2 оборона (на команду) */
  var TACTIC=[0,0];
  /* вратарь-«выход на игрока»: удержание Y */
  var gkRush=[false,false];
  var offT=0;   /* время удержания отложенного офсайда (для мигания) */
  var icing={armed:false,team:-1};
  /* ---------- удаления и вбрасывание: все настройки здесь ---------- */
  var PEN_CFG={
    minorFrac:1/6,       /* малый штраф = длина матча / 6: 1 мин → 10 с, 3 мин → 30 с, 5 мин → 50 с игрового времени */
    majorMul:2.5,        /* большой = малый × 2.5 (25 / 75 / 125 с) */
    showMinor:120, showMajor:300,   /* на табло — хоккейные 2:00 и 5:00, идут вниз с ускорением */
    /* силовой сзади: направление удара и взгляд жертвы сходятся (cos > backDot); шанс растёт со скоростью и у борта */
    backDot:0.5, backBase:0.15, backSpeed:0.25, backWall:0.15, wallDist:2.6,
    majorSpeed:8.6, majorDot:0.8, majorChance:0.6,   /* очень сильный на скорости строго в спину — большой */
    /* блокировка: силовой против игрока без шайбы; чем дальше от него шайба, тем вернее свисток */
    intBase:0.35, intFar:0.07,
    /* тычок клюшкой (B): по игроку без шайбы — подножка (сзади) или удар клюшкой (спереди, сбоку) */
    stickReach:1.5, stickBase:0.20, stickBack:0.35, stickSpeed:0.15, tripDot:0.3,
    /* прессинг (удержание A): клюшка не достала до шайбы — по рукам, клюшке, корпусу владельца; чистый отбор — никогда */
    holdReach:2.1, holdBase:0.01, holdBack:0.08,
    maxChance:0.70,      /* потолок любого нарушения: за грязный приём иногда удаляют, а иногда судья не видит */
    /* тычок по владельцу сзади — мимо шайбы по ногам */
    hookDot:0.5, hookChance:0.08
  };
  var FACE_CFG={
    holdMin:1, holdMax:3,     /* шайба падает через случайное время после расстановки, с */
    window:1.5,               /* окно нажатий A после падения, с */
    grace:1.2,                /* сколько ждать счёт удалённого игрока после окна (сеть), с */
    tapMax:30,                /* больше нажатий за окно не бывает (защита от подделки) */
    botRate:{easy:5, normal:7, hard:9}, botSpread:0.15,   /* нажатий в секунду у бота по сложности, разброс ±15 % */
    setGoal:1.0, setStop:1.4, /* расстановка после гола / после свистка, с (начало матча задаёт клиент: stateT) */
    puckY:1.2,                /* высота шайбы в руке судьи, м */
    coverPress:3.5,           /* вратарь накрывает шайбу, если соперник ближе, м */
    lockA:0.5                 /* после вбрасывания A ещё столько не пас и не смена игрока: добивание кнопки, с */
  };
  /* вратарь с шайбой: ловит, держит (живой — пас / бросок теми же кнопками), накрывает по свистку */
  var GK_CFG={
    holdMax:2.6,              /* дольше держать нельзя — накрывает: свисток, вбрасывание в его зоне, с */
    coverFoe:2.4,             /* соперник ближе — накрывает сразу, м */
    aiThink:[0.6,1.3],        /* бот-вратарь думает перед пасом, с */
    catchHigh:0.55,           /* выше этой высоты бросок в створ ловит ловушкой (фиксирует), м */
    catchLow:0.25,            /* низовой бросок в створ фиксирует с таким шансом, остальное — отскок в сторону */
    reboundZ:[4.5,8.5],       /* отскок уходит вбок, от ворот, м/с */
    passLane:1.4, passMax:24  /* бот-вратарь отдаёт пас: свободная линия не уже, м; дальше не пасует, м */
  };
  /* бросок живого игрока: прицел стиком и бросок в одно касание (ИИ целится сам — aiShoot, его это не касается) */
  var SHOT_CFG={
    sideMin:0.3,              /* стик вбок от линии атаки хоть на столько (доля) — бросок в этот угол ворот */
    corner:0.70,              /* угол — так далеко от центра ворот, м (штанга 0.92; дальше 0.76 — уже в штангу) */
    otWin:1.6,                /* B, пока летит свой пас (не дольше этого с паса), — бросок сразу при приёме, с */
    otPow:0.7,                /* сила броска в одно касание не меньше (0..1) */
    otHold:0.4,               /* держал B и при приёме — бросок в одно касание, если отпустил за столько, с */
    otSave:0.40               /* шанс сейва в створе у броска в одно касание (у обычного 0.55): вратарь не успел за пасом */
  };
  /* адресат своего паса, пока шайба летит (recvOf): рвётся к ней, а не встаёт в расчётной точке; управление к нему не
     уходит, пока пас в пути; у живого с отпущенным стиком — едет к шайбе сам. Редко на выходе один на один
     (впереди ни одного полевого соперника) — поскальзывается при приёме паса: падает, шайба катится дальше.
     У ИИ против ИИ такой приём редок (≈0.02 за матч); у живого, который выводит партнёра пасом в разрез, — чаще */
  var RECV_CFG={
    run:2.2,                  /* сколько после паса адресат рвётся за шайбой, с (было 1.6 — дальний пас не успевал) */
    slip:0.12,                /* шанс поскользнуться при приёме паса на выходе один на один (≈ раз в 3–4 матча) */
    slipDown:1.1              /* сколько лежит, с */
  };
  var matchLen=5*60;          /* длина матча, с (задают клиент и комната вместе с clock) — от неё длина удалений */
  /* вбрасывание: ph 0 нет, 1 расстановка, 2 судья держит шайбу, 3 шайба упала — окно нажатий */
  var FO={ph:0, id:0, x:0, z:0, t:0, wait:0, taps:[0,0], acc:[0,0], rate:[0,0], done:[false,false],
          tgt:[null,null], ctr:[null,null], win:-1, lockT:-1};
  function attackDir(t){ return t===0?1:-1; }
  /* направление атаки игрока: у полевого — dir, у вратаря dir — сторона, которую он защищает */
  function adir(p){ return p.goalie ? -p.dir : p.dir; }
  function gkFoeNear(g, r){
    for(var i=0;i<players.length;i++){ var o=players[i];
      if(o.team!==g.team && !o.goalie && !o.boxed && o.down<=0 && Math.hypot(o.x-g.x,o.z-g.z)<r) return true; }
    return false;
  }
  /* вратарь берёт шайбу в руки (сейв с фиксацией или подбор в своей зоне) */
  function gkTake(g){
    puck.owner=g; puck.vx=0; puck.vz=0; puck.vy=0; puck.y=0.05; lastTouch=g; icing.armed=false;
    g._hold=SIMT; g._gkT=rnd(GK_CFG.aiThink[0],GK_CFG.aiThink[1]);
    if(CFG.hum[g.team]){ var hs=HS[g.team]; hs.prevCtl=hs.ctrl; hs.ctrl=g; hs.goalieCtl=true; hs.charge=0; }
  }
  /* накрыл: свисток, вбрасывание в его зоне */
  function gkCover(g){
    puck.owner=null; puck.x=g.x+Math.cos(g.yaw)*0.5; puck.z=g.z+Math.sin(g.yaw)*0.5;
    puck.vx=0; puck.vz=0; puck.vy=0; puck.free=0.3;
    emit('save',{g:pIdx(g), t:g.team, by:-1, kind:'body', shot:0, cover:1});
    whistle('cover', -attackDir(g.team)*20, puck.z>0?7:-7, g.team);
  }
  /* бот-вратарь: открытый партнёр со свободной линией, лучше защитник */
  function gkPassPick(g){
    var arr=teamOf(g.team), best=null, bs=-1e9, ad=adir(g);
    for(var i=0;i<arr.length;i++){
      var m=arr[i]; if(m.down>0) continue;
      var L=Math.hypot(m.x-g.x,m.z-g.z); if(L<4 || L>GK_CFG.passMax) continue;
      var lane=laneBlock(g.team, g.x,g.z, m.x,m.z); if(lane<GK_CFG.passLane) continue;
      var sc=clamp(nearestFoe(m),0,6)*0.5 + (m.x-g.x)*ad*0.05 - L*0.04 + (m.role>=3?0.4:0);
      if(sc>bs){ bs=sc; best=m; }
    }
    return best;
  }
  function zoneOf(x,dir){ var v=x*dir; return v>BLUE_X?1:(v<-BLUE_X?-1:0); }
  function onIce(t){ return players.filter(function(p){return p.team===t&&!p.goalie&&!p.boxed;}); }
  /* ---------- PHASE 1: Player feel constants (tunable) ---------- */
  var PLAYER_CFG = {
    /* base skating */
    maxSpeed: 7.0,         // was 8.6
    accel: 12,             // was 13 (10 was too sluggish)
    damping: 0.972,        // was 0.975 — lighter slide for target top speed
    turnRate: 6.5,         // was 9.0 rad/s — more gradual turn
    /* with puck penalty */
    puckSpeedMul: 0.94,
    /* press assist (when pressing stick toward target) */
    pressRange: 2.6,       // was 2.6
    pressMaxSpeed: 9.6,    // was 9.6
    pressAccel: 17,        // was 17
    /* sprint (RT) */
    sprintMaxSpeed: 9.5,   // was 11.4
    sprintAccel: 16,       // was 16
    /* AI speeds */
    aiBaseMaxSpeed: 9.0,   // was 9.0
    aiAttackMaxSpeed: 8.4, // was 8.4
    aiChaseMaxSpeed: 9.7,  // was 9.7
    aiTacticAttackBonus: 0.5,
    aiOffsidesMaxSpeed: 10.2,
    /* puck pickup at stick end */
    pickupReachSkater: 0.85,  // was 1.05 (body center)
    pickupReachGoalie: 1.35,  // unchanged
    leadReach: 1.15,          // the addressed receiver of a through pass (Y) reaches further — catching it in stride
    recvBody: 0.8,             // the addressee of a pass stops it with the skate / body too, not only with the stick end
    recvTurn: 9,              // and turns the stick to the coming puck, rad/s (even standing: his stick let go)
    pickupHeight: 0.85,       // unchanged
    pickupMaxSpeed: 24,       // unchanged
    /* poke check */
    pokeRangeCarrier: 1.6,   // was 2.0
    pokeRangeLoose: 1.8,     // was 1.8
    /* body check */
    checkRange: 1.7,         // was 1.9
    checkMinSpeed: 4.2,      // unchanged
    checkDownTime: 1.5,      // unchanged
    checkKnockback: 9,       // unchanged
    checkPuckKnockback: 5.5, // unchanged
    /* shot/pass */
    shotBaseSpeed: 17,       // unchanged per user request
    shotPowerScale: 17,      // unchanged
    passFreeTime: 0.16,      // unchanged
    shotFreeTime: 0.2        // unchanged
  };
  /* TURN_RATE kept as alias for backward compat */
  var TURN_RATE = PLAYER_CFG.turnRate;
  var LANEZ=[-7.6,0,7.6,-5.2,5.2], DEPTH=[6.5,4.5,6.5,-4.0,-4.0];
  var NAMES=[['Тарасов','Гурьев','Лукоянов','Шипачёв','Кагарлицкий','Соколов'],
             ['Адамчук','Журавлёв','Бурмистров','Провольнев','Юдин','Панюков']];

  function makeTeam(t){
    var dir = t===0?1:-1;
    for(var i=0;i<5;i++){
      players.push({team:t,role:i,dir:dir,goalie:false,
        x:-dir*rnd(3,11), z:LANEZ[i], vx:0,vz:0, yaw:0, spd:0, stride:rnd(0,6.3),
        down:0, boxed:0, num:[9,17,77,4,55][i], name:NAMES[t][i]});
    }
    /* вратарь защищает СВОИ ворота: его dir противоположен направлению атаки */
    var gdir=-dir;
    players.push({team:t,role:9,dir:gdir,goalie:true,
      x:gdir*(GOAL_X-0.7), z:0, vx:0,vz:0, yaw:gdir>0?-Math.PI/2:Math.PI/2, spd:0,stride:0,down:0,boxed:0,num:30,name:NAMES[t][5]});
  }
  function reset(faceoff){
    DQ=-1;
    players.length=0; makeTeam(0); makeTeam(1);
    puck.x=0;puck.z=0;puck.y=0.05;puck.vx=0;puck.vz=0;puck.vy=0;puck.owner=null;puck.free=0;
    HS[0]=mkHS(); HS[1]=mkHS(); FO.ph=0; FO.ctr=[null,null]; FO.tgt=[null,null];
    HS[0].ctrl = players.filter(function(p){return p.team===0&&!p.goalie;})[2];
    HS[1].ctrl = players.filter(function(p){return p.team===1&&!p.goalie;})[2];
  }

  function teamOf(t){ return players.filter(function(p){return p.team===t&&!p.goalie&&!p.boxed;}); }
  function nearestOf(t,x,z){
    var arr=teamOf(t),best=arr[0],bd=1e9;
    for(var i=0;i<arr.length;i++){var d=Math.hypot(arr[i].x-x,arr[i].z-z); if(d<bd){bd=d;best=arr[i];}}
    return best;
  }
  function goalieOf(t){ return players.filter(function(p){return p.team===t&&p.goalie;})[0]; }

  /* ---------- правила ---------- */
  var FACE_OFFS=[[0,0],[20,7],[20,-7],[-20,7],[-20,-7],[4.5,7],[4.5,-7],[-4.5,7],[-4.5,-7]];
  /* Расстановка как в NHL: центр на точке, крайние на краю круга, защитники за кругом (позиция — по роли, а не по
     порядку в списке). Нет центра (удалён) — на точку встаёт крайний, нет и их — защитник. Смещения — по атаке команды. */
  var FO_SPOT={c:[-1.0,0], w:[-1.2,4.9], d:[-6.6,3.4]};
  function faceCenter(arr){
    var pref=[1,0,2,3,4];
    for(var i=0;i<pref.length;i++) for(var j=0;j<arr.length;j++) if(arr[j].role===pref[i]) return arr[j];
    return arr[0]||null;
  }
  /* куда центр отбросит шайбу без стика: назад к ближайшему защитнику */
  function faceDefault(t){
    var arr=onIce(t), c=FO.ctr[t], best=null, bd=1e9, i, d;
    for(i=0;i<arr.length;i++){ if(arr[i]===c||arr[i].role<3) continue; d=Math.hypot(arr[i].x-FO.x,arr[i].z-FO.z); if(d<bd){bd=d;best=arr[i];} }
    if(!best) for(i=0;i<arr.length;i++){ if(arr[i]===c) continue; d=Math.hypot(arr[i].x-FO.x,arr[i].z-FO.z); if(d<bd){bd=d;best=arr[i];} }
    return best;
  }
  function placeFaceoff(dx,dz){
    puck.x=dx;puck.z=dz;puck.y=0.05;puck.vx=0;puck.vz=0;puck.vy=0;puck.owner=null;puck.free=0.35;
    for(var t=0;t<2;t++){
      var dir=attackDir(t), arr=onIce(t), C=faceCenter(arr);
      FO.ctr[t]=C;
      for(var i=0;i<arr.length;i++){
        var p=arr[i], o, sz=(p.role===0||p.role===3)?-1:1;
        o = p===C ? FO_SPOT.c : (p.role<3 ? FO_SPOT.w : FO_SPOT.d);
        p.x=clamp(dx+o[0]*dir,-RL+2,RL-2);
        p.z=clamp(dz+o[1]*sz,-RW+2,RW-2);
        p.vx=0; p.vz=0; p.spd=0; p.down=0; p.os=0;
        p.yaw=dir>0?0:Math.PI;
        p._fx=p.x; p._fz=p.z;
      }
      var g=goalieOf(t);
      if(g){ g.x=g.dir*(GOAL_X-0.7); g.z=0; g.vx=0; g.vz=0; g.spd=0; g.yaw=g.dir>0?-Math.PI/2:Math.PI/2; }
    }
    lastTouch=null; icing.armed=false; offWarn=-1; offT=0;
    for(var zz=0;zz<players.length;zz++) players[zz].os=0;
    HS[0].goalieCtl=false; HS[0].prevCtl=null;
    HS[1].goalieCtl=false; HS[1].prevCtl=null;
    /* Зону запоминаем по точке вбрасывания, а не нулём. Иначе первый же кадр
       после вбрасывания в чужой зоне читался как «шайба только что вошла» —
       и на каждом атакующем вбрасывании зажигался отложенный офсайд. */
    prevZone=[zoneOf(dx,attackDir(0)), zoneOf(dx,attackDir(1))];
    /* настоящее вбрасывание (не перестановка урока тренировки): управление — на центра, судья держит шайбу */
    if(state==='face'){
      FO.ph=1; FO.id=(FO.id+1)%1000000; FO.x=dx; FO.z=dz; FO.taps=[0,0]; FO.acc=[0,0]; FO.done=[false,false]; FO.win=-1;
      for(var t2=0;t2<2;t2++){
        var hs=HS[t2]; hs.charge=0; hs.otT=0; hs.pressT=0; hs.press.on=false; gkRush[t2]=false;
        if(FO.ctr[t2]) hs.ctrl=FO.ctr[t2];
        FO.tgt[t2]=faceDefault(t2);
      }
      puck.y=FACE_CFG.puckY;
    }
  }
  /* reason: 'offside' | 'icing' | 'penalty' | 'cover' — по нему подписчик выбирает надпись */
  function whistle(reason,dx,dz,team){
    state='face'; stateT=FACE_CFG.setStop;
    emit('stoppage',{reason:reason, t:team===undefined?-1:team});
    placeFaceoff(dx,dz);
  }

  /* ---------- вбрасывание: судья держит шайбу, падение в случайный момент, кто чаще жмёт A ---------- */
  function faceAim(t){
    var C=FO.ctr[t]; if(!C || !CFG.hum[t]) return;
    var inp=CFG.inp[t]; if(!inp) return;
    var L=Math.hypot(inp.mx||0,inp.mz||0); if(L<0.35) return;     /* стик не трогал — остаётся прежний выбор */
    var w=toWorld(inp.mx/L,inp.mz/L,[0,0]), arr=onIce(t), best=null, bs=-2;
    for(var i=0;i<arr.length;i++){
      var m=arr[i]; if(m===C) continue;
      var dx=m.x-FO.x, dz=m.z-FO.z, D=Math.hypot(dx,dz)||1, k=(dx*w[0]+dz*w[1])/D;
      if(k>bs){bs=k;best=m;}
    }
    if(best) FO.tgt[t]=best;
  }
  function faceTick(dt){
    if(!FO.ph) placeFaceoff(puck.x,puck.z);          /* начало матча: state='face' без расстановки */
    /* все стоят; нажатия во время вбрасывания в игру не переходят */
    for(var i=0;i<players.length;i++){
      var p=players[i]; if(p.boxed||p.goalie||p._fx===undefined) continue;
      p.x=p._fx; p.z=p._fz; p.vx=0; p.vz=0; p.spd=0;
    }
    for(var t=0;t<2;t++){
      var RM=CFG.rem[t], NE=CFG.edge[t];
      if(RM){ if(NE){ NE.A=NE.B=NE.X=NE.Y=NE.LB=false; } RM.tapB=false; if(RM.pend) RM.pend.t=0; }
    }
    if(FO.ph===1){
      puck.y=FACE_CFG.puckY; faceAim(0); faceAim(1);
      stateT-=dt;
      if(stateT<=0){ FO.ph=2; FO.t=rnd(FACE_CFG.holdMin,FACE_CFG.holdMax); }
      return;
    }
    if(FO.ph===2){
      puck.y=FACE_CFG.puckY; faceAim(0); faceAim(1);
      FO.t-=dt;
      if(FO.t<=0){
        FO.ph=3; FO.t=FACE_CFG.window; FO.wait=FACE_CFG.window+FACE_CFG.grace; puck.vy=0;
        for(var b=0;b<2;b++){
          FO.taps[b]=0; FO.acc[b]=0; FO.done[b]=false;
          if(!CFG.hum[b]){ var r0=FACE_CFG.botRate[CFG.lv[b]]||FACE_CFG.botRate.normal;
            FO.rate[b]=r0*(1+FACE_CFG.botSpread*(2*R()-1)); }
        }
        emit('face:drop',{id:FO.id, x:r2(FO.x), z:r2(FO.z)});
      }
      return;
    }
    /* ph 3: шайба падает, считаем нажатия после падения */
    if(puck.y>0.05){ puck.vy-=13*dt; puck.y=Math.max(0.05, puck.y+puck.vy*dt); }
    FO.t-=dt; FO.wait-=dt;
    for(var q=0;q<2;q++){
      if(FO.done[q]) continue;
      var rm=CFG.rem[q];
      if(!CFG.hum[q]){                                  /* бот (или ИИ за ушедшего игрока) */
        if(FO.t>-dt){ FO.acc[q]+=FO.rate[q]*Math.min(dt, FO.t+dt); while(FO.acc[q]>=1){ FO.taps[q]++; FO.acc[q]-=1; } }
        if(FO.t<=0) FO.done[q]=true;
      } else if(rm){                                    /* удалённый: его телефон считает сам и шлёт число */
        var f=rm.fo;
        if(f && f.id===FO.id){ FO.taps[q]=Math.max(FO.taps[q], Math.min(FACE_CFG.tapMax, f.n|0)); if(f.done) FO.done[q]=true; }
        if(FO.wait<=0) FO.done[q]=true;
      } else {                                          /* живой на этом устройстве: фронты A этого шага */
        var e=CFG.edge[q];
        if(FO.t>-dt && e && e.A && FO.taps[q]<FACE_CFG.tapMax) FO.taps[q]++;
        if(FO.t<=0) FO.done[q]=true;
      }
    }
    if(!FO.done[0] || !FO.done[1]) return;
    var w = FO.taps[0]>FO.taps[1] ? 0 : (FO.taps[1]>FO.taps[0] ? 1 : (R()<0.5?0:1));
    var C=FO.ctr[w], m=FO.tgt[w];
    if(m && m.boxed) m=null;
    puck.x=FO.x; puck.z=FO.z; puck.y=0.05; puck.vy=0; puck.vx=0; puck.vz=0; puck.owner=null;
    if(C){
      var tx=m?m.x:C.x-attackDir(w)*6, tz=m?m.z:C.z, ddx=tx-puck.x, ddz=tz-puck.z, L=Math.hypot(ddx,ddz)||1;
      var sp=clamp(6+L*0.8, 8, 13);
      puck.vx=ddx/L*sp; puck.vz=ddz/L*sp; puck.free=0.12;
      lastTouch=C;
      /* это пас партнёру: адресат едет навстречу и принимает (recvOf), а не пропускает шайбу в спину */
      if(m) LASTPASS={from:C, to:m, t:SIMT, lead:false, x:tx, z:tz, fo:true};   /* fo: в статистику пасов не идёт */
    }
    FO.ph=0; FO.win=w; FO.lockT=SIMT+FACE_CFG.lockA;
    state='play'; stateT=0;
    emit('faceoff',{x:r2(FO.x), z:r2(FO.z), w:w, taps:FO.taps.slice(), to:pIdx(m)});
  }
  /* что нужно второму игроку по сети: хвост снимка (index.html netSnap, server/room-sim.js) */
  function netTail(){
    var ph=state==='face'?FO.ph:0;
    return [penaltyShow(0)|0, penaltyShow(1)|0, ph, FO.id, FO.taps[0], FO.taps[1],
            pIdx(FO.tgt[0]), pIdx(FO.tgt[1]), FO.win];
  }

  /* ---------- удаления ---------- */
  function penLen(major){ var m=matchLen*PEN_CFG.minorFrac; return major ? m*PEN_CFG.majorMul : m; }
  /* reason: 'trip' подножка, 'slash' удар клюшкой, 'hold' задержка клюшкой, 'back' атака сзади, 'board' толчок на борт,
     'interference' блокировка */
  function penalize(p,reason,major){
    var len=penLen(major);
    p.boxed=1; pen.push({team:p.team,t:len,full:len,p:p,major:!!major,reason:reason});
    if(HS[p.team].ctrl===p){ var alt=onIce(p.team)[0]; if(alt) HS[p.team].ctrl=alt; }
    emit('penalty',{p:pIdx(p), t:p.team, reason:reason, major:major?1:0, len:Math.round(len)});
    /* удалены все полевые, остался один вратарь — дисквалификация: матч окончен, победа сопернику при любом счёте */
    if(!onIce(p.team).length){ forfeit(p.team); return; }
    var dir=attackDir(p.team);
    whistle('penalty', -dir*20, puck.z>0?7:-7, p.team);
  }
  var DQ=-1;                  /* дисквалифицированная команда (-1 — нет) */
  function forfeit(t){
    DQ=t;
    for(var pe=pen.length-1;pe>=0;pe--) releasePen(pe);
    state='over'; stateT=99;
    puck.vx=0; puck.vz=0; puck.vy=0; puck.owner=null;
    emit('match:end',{score:score.slice(), reason:'dq', dq:t});
    fx.over();
  }
  /* сколько осталось, с игрового времени (самое длинное удаление команды) */
  function penaltyLeft(t){
    var m=0;
    for(var i=0;i<pen.length;i++) if(pen[i].team===t&&pen[i].t>m) m=pen[i].t;
    return m;
  }
  /* то же в хоккейных секундах для табло: 2:00 / 5:00 идут вниз с ускорением */
  function penaltyShow(t){
    var m=0;
    for(var i=0;i<pen.length;i++){
      var q=pen[i]; if(q.team!==t) continue;
      var v=q.t/(q.full||q.t||1)*(q.major?PEN_CFG.showMajor:PEN_CFG.showMinor);
      if(v>m) m=v;
    }
    return m;
  }
  function releasePen(i){
    var q=pen[i], pp=q.p;
    pp.boxed=0;
    /* выпускаем со скамейки, а не из точки, где он стоял два месяца назад */
    pp.x=-attackDir(q.team)*BLUE_X; pp.z=(RW-2)*(R()<0.5?1:-1);
    pp.vx=0; pp.vz=0; pp.down=0; pp.os=0;
    pen.splice(i,1);
  }
  /* гол в большинстве: досрочно кончается малый штраф (тот, где меньше осталось); большой сидят до конца */
  function clearOnePenalty(t){
    var k=-1;
    for(var i=0;i<pen.length;i++) if(pen[i].team===t && !pen[i].major && (k<0 || pen[i].t<pen[k].t)) k=i;
    if(k>=0) releasePen(k);
  }
  /* насколько удар пришёлся в спину: 1 — строго сзади, 0 — сбоку, −1 — в лицо */
  function backness(p,o){
    var dx=o.x-p.x, dz=o.z-p.z, L=Math.hypot(dx,dz)||1;
    return (dx*Math.cos(o.yaw)+dz*Math.sin(o.yaw))/L;
  }
  function nearBoards(o){
    return halfWidthAt(o.x)-Math.abs(o.z)<PEN_CFG.wallDist || RL-Math.abs(o.x)<PEN_CFG.wallDist;
  }
  /* силовой: нарушение или нет. legal — жертва с шайбой (или только что её касалась рядом) */
  function hitCall(p,o,legal){
    var C=PEN_CFG, b=backness(p,o), sp=p.spd||0, sk=clamp((sp-PLAYER_CFG.checkMinSpeed)/4,0,1);
    if(b>C.backDot){
      var wall=nearBoards(o), k=(b-C.backDot)/(1-C.backDot);
      if(R()<clamp((C.backBase+C.backSpeed*sk+(wall?C.backWall:0))*k,0,C.maxChance)){
        var major = sp>=C.majorSpeed && b>=C.majorDot && R()<C.majorChance;
        return {reason:wall?'board':'back', major:major};
      }
    }
    if(!legal){
      var dP=Math.hypot(puck.x-o.x,puck.z-o.z);
      if(R()<clamp(C.intBase+(dP-2)*C.intFar, C.intBase, C.maxChance)) return {reason:'interference', major:false};
    }
    return null;
  }
  /* тычок по владельцу сзади: мимо шайбы — по ногам */
  function hookCall(p,o){
    var C=PEN_CFG, b=backness(p,o); if(b<=C.hookDot) return false;
    var k=(b-C.hookDot)/(1-C.hookDot);
    return R()<C.hookChance*k*(0.5+0.5*clamp((p.spd||0)/7,0,1));
  }

  /* ---------- действия ---------- */
  /* Прицел паса/броска берём со стика только того человека, который управляет
     этим игроком. Раньше стик локального игрока направлял пасы и броски всех,
     включая ИИ соперника и игрока гостя на хосте. */
  function aimInput(p){
    var hs=HS[p.team]; if(!hs || hs.ctrl!==p) return null;
    return CFG.hum[p.team] ? CFG.inp[p.team] : null;
  }
  function aimDir(p){
    var inp=aimInput(p);
    if(inp){
      var L=Math.hypot(inp.mx,inp.mz);
      if(L>0.25){ var w=toWorld(inp.mx/L,inp.mz/L,[0,0]); return {x:w[0], z:w[1]}; }
    }
    return {x:adir(p), z:0};
  }
  /* Кому пас. Обычный (A) — партнёру по направлению стика, из них — открытому (свободная линия, соперник
     не вплотную). В разрез (Y) — тому, у кого лучший выход к воротам: thruMate (ниже, у игры без шайбы). */
  function bestMate(p, mode){
    var d=aimDir(p);
    if(mode==='thru'){ var th=thruMate(p, d); return th ? th.m : null; }
    return openMate(p, d);
  }
  function openMate(p, d){
    var arr=teamOf(p.team), best=null, bs=-1e9;
    for(var i=0;i<arr.length;i++){
      var m=arr[i]; if(m===p) continue;
      var ddx=m.x-p.x, ddz=m.z-p.z, L=Math.hypot(ddx,ddz)||1;
      if(L>26) continue;
      var dot=(ddx/L)*d.x+(ddz/L)*d.z;
      var s=dot*2.2 - L*0.045;
      var lane=laneBlock(p.team, p.x,p.z, m.x+m.vx*0.3, m.z+m.vz*0.3);
      s += clamp(nearestFoe(m),0,5)*0.22 - (lane<1.0?1.4:(lane<1.8?0.4:0));
      if(s>bs){bs=s;best=m;}
    }
    return best;
  }
  /* ---------- что нужно событиям: время симуляции, последний пас и бросок ---------- */
  var SIMT=0;                 /* секунды симуляции с загрузки (только у хоста / в одиночной игре) */
  var SIMF=0;                 /* номер кадра симуляции — чередует порядок обхода игроков */
  var LASTPASS=null;          /* {from, to, t} — для «пас дошёл» */
  var LASTRECV=null;          /* {from, to, t} — последний дошедший пас: для передачи при голе */
  var LASTSHOT=null;          /* {p, t} — чтобы отличить сейв после броска от простого подбора */
  var LASTSAVE=null;          /* {t: команда вратаря, time} — отскок для добивания */
  function pIdx(p){ return p ? players.indexOf(p) : -1; }
  /* подбор шайбы полевым: владение, перехват или дошедший пас */
  function pickupEvent(p, prev){
    var e={p:pIdx(p), t:p.team, prev:pIdx(prev)};
    if(LASTPASS && !LASTPASS.fo && LASTPASS.from!==p && SIMT-LASTPASS.t<3){
      if(LASTPASS.from.team===p.team){
        LASTRECV={from:LASTPASS.from, to:p, t:SIMT};
        p._recvT=SIMT; p._recvLead=!!LASTPASS.lead;
        emit('pass:recv',{p:pIdx(p), t:p.team, from:pIdx(LASTPASS.from), aimed:LASTPASS.to===p?1:0, lead:LASTPASS.lead?1:0});
        if(breakaway(p) && R()<RECV_CFG.slip){ slip(p); LASTPASS=null; return; }
      } else e.intercept=1;
    }
    LASTPASS=null;
    if(prev && prev.team!==p.team) e.turnover=1;
    emit('pickup',e);
  }
  /* выход один на один: на чужой половине, впереди (ближе к воротам соперника) ни одного полевого соперника */
  function breakaway(p){
    var dir=attackDir(p.team); if(p.x*dir<0) return false;
    var fo=teamOf(1-p.team);
    for(var i=0;i<fo.length;i++) if(fo[i].down<=0 && fo[i].x*dir>p.x*dir-0.5) return false;
    return true;
  }
  /* поскользнулся: падает, шайба уходит с его скоростью; подбор этого кадра — без владельца */
  function slip(p){
    p.down=RECV_CFG.slipDown;
    puck.owner=null; puck.free=0.45; puck.vx=p.vx*0.7; puck.vz=p.vz*0.7; puck.vy=0;
    emit('slip',{p:pIdx(p), t:p.team, x:r2(p.x), z:r2(p.z)});
  }
  /* гол: автор — последний коснувшийся из забившей команды, передача — кто отдал ему пас */
  function goalEvent(team, z){
    var sc = (lastTouch && lastTouch.team===team) ? lastTouch : null;
    var as = (sc && LASTRECV && LASTRECV.to===sc && LASTRECV.from.team===team && SIMT-LASTRECV.t<10) ? LASTRECV.from : null;
    /* гол всегда считается броском: добивание или рикошет без doShot помечаем noShot */
    var shot = !!(LASTSHOT && LASTSHOT.p.team===team && SIMT-LASTSHOT.t<3);
    emit('goal',{t:team, p:pIdx(sc), assist:pIdx(as), own:(lastTouch && lastTouch.team!==team)?1:0, noShot:shot?0:1,
                    z:r2(z), score:score.slice(), clock:Math.round(clock)});
    LASTSHOT=null; LASTPASS=null; LASTRECV=null;
  }

  var passN=[0,0];       /* сколько пасов отдал ввод команды — для тестов ввода */
  /* target / pt — адресат и точка паса, выбранные ИИ; у человека не передаются */
  /* куда пасовать (без побочных эффектов) — общее для симуляции и предсказания гостя */
  function passAim(p,lead,target,pt){
    var th=(lead && !pt) ? (target ? {m:target, pt:thruPoint(p,target)} : thruMate(p, aimDir(p))) : null;
    var m=th ? th.m : (target||bestMate(p,'norm'));
    var tx,tz;
    if(pt){ tx=pt.x; tz=pt.z; }
    else if(th){ tx=th.pt.x; tz=th.pt.z; }   /* в разрез — туда, где партнёр будет к прилёту шайбы */
    else if(m){
      tx=m.x + (lead? m.vx*0.55 + adir(p)*3.2 : m.vx*0.30);
      tz=m.z + (lead? m.vz*0.55 : m.vz*0.30);
    } else {
      var d=aimDir(p); tx=p.x+d.x*12; tz=p.z+d.z*12;
    }
    return {tx:tx, tz:tz, m:m, v:th?th.pt.v:0};
  }
  /* куда бросать (без побочных эффектов) */
  function shotAim(p,aiZ){
    var gx=adir(p)*GOAL_X, aimZ;
    if(aiZ!==undefined) aimZ=aiZ;
    else {
      /* стик вбок (вверх / вниз по экрану при камере сбоку) — шайба в этот угол; стик к воротам или отпущен —
         в угол, открытый вратарём, как раньше */
      var inp=aimInput(p), sL=inp?Math.hypot(inp.mx,inp.mz):0, side=0;
      if(sL>0.25){ var sw=toWorld(inp.mx/sL,inp.mz/sL,[0,0]); if(Math.abs(sw[1])>=SHOT_CFG.sideMin) side=sw[1]>0?1:-1; }
      if(side) aimZ=side*SHOT_CFG.corner;
      else {
        var d=aimDir(p);
        aimZ = clamp(d.z*0.9, -0.85, 0.85);
        var gk=goalieOf(p.team===0?1:0);
        var open = gk ? (gk.z>0 ? -0.72 : 0.72) : 0;
        aimZ = clamp(aimZ*0.45 + open*0.55, -0.85, 0.85);
      }
    }
    return {tx:gx, tz:aimZ};
  }
  function doPass(p,power,lift,lead,target,pt){
    fx.act(p,'pass_forehand',0.45);
    var pa=passAim(p,lead,target,pt), m=pa.m, tx=pa.tx, tz=pa.tz;
    if(pa.v) power=pa.v;                 /* в разрез — с силой под рывок партнёра */
    var dx=tx-puck.x, dz=tz-puck.z, L=Math.hypot(dx,dz)||1;
    puck.vx=dx/L*power; puck.vz=dz/L*power;
    puck.vy = lift?3.2:0;
    puck.owner=null; puck.free=0.16; lastTouch=p;
    if(p.x*adir(p) < -1) { icing.armed=true; icing.team=p.team; } else icing.armed=false;
    LASTPASS={from:p, to:m||null, t:SIMT, lead:!!lead, x:tx, z:tz};
    emit('pass',{p:pIdx(p), t:p.team, to:m?pIdx(m):-1, x:r2(p.x), z:r2(p.z), power:r2(power), lift:!!lift, lead:!!lead});
  }
  /* aiZ — точка по ширине ворот, выбранная ИИ (может быть мимо створа); у человека не передаётся;
     ot — бросок в одно касание (SHOT_CFG) */
  function doShot(p,power,aiZ,ot){
    var gx=p.dir*GOAL_X, sa=shotAim(p,aiZ), tx=sa.tx, tz=sa.tz;
    var dx=tx-puck.x, dz=tz-puck.z, L=Math.hypot(dx,dz)||1;
    var sp=17+power*17;
    puck.vx=dx/L*sp; puck.vz=dz/L*sp; puck.vy=0;
    puck.owner=null; puck.free=0.2; lastTouch=p;
    if(p.x*adir(p) < -1) { icing.armed=true; icing.team=p.team; } else icing.armed=false;
    /* сильный бросок отыгрывается размашистым клипом, обычный — кистевым */
    fx.act(p, power>0.55?'slap_shot':'wrist_shot', power>0.55?0.9:0.65);
    LASTSHOT={p:p, t:SIMT, ot:!!ot};
    var se={p:pIdx(p), t:p.team, x:r2(p.x), z:r2(p.z), power:r2(power), dist:r2(Math.hypot(gx-p.x,p.z))};
    if(ot) se.ot=1;
    emit('shot',se);
  }
  /* auto — тычок от прессинга (удержание A): по игроку без шайбы он не бьёт */
  function doPoke(p,auto){
    fx.act(p,'poke_check',0.45);
    HS[p.team].pokeT=0.22; pokeT=0.22;
    var o=puck.owner;
    if(o && o.goalie) return;                    /* шайбу у вратаря клюшкой не выбить */
    if(o && o.team!==p.team){
      var d=Math.hypot(o.x-p.x,o.z-p.z);
      if(d<PLAYER_CFG.pokeRangeCarrier){
        if(!auto && hookCall(p,o)){ penalize(p,'trip'); return; }
        puck.owner=null; puck.free=0.35;
        var a=Math.atan2(puck.z-p.z,puck.x-p.x);
        puck.vx=Math.cos(a)*7; puck.vz=Math.sin(a)*7;
        emit('poke',{p:pIdx(p), t:p.team, from:pIdx(o), btn:1});
        return;
      }
    } else if(!puck.owner){
      if(Math.hypot(puck.x-p.x,puck.z-p.z)<PLAYER_CFG.pokeRangeLoose){ puck.owner=p; puck.vx=0;puck.vz=0; return; }
    }
    /* прессинг: клюшка не достала до шайбы владельца — задержка клюшкой, чаще сзади */
    if(auto){
      if(o && o.team!==p.team && Math.hypot(o.x-p.x,o.z-p.z)<PEN_CFG.holdReach &&
         R()<clamp(PEN_CFG.holdBase+PEN_CFG.holdBack*Math.max(0,backness(p,o)),0,PEN_CFG.maxChance)) penalize(p,'hold');
      return;
    }
    /* мимо шайбы — в соперника без шайбы рядом: подножка (сзади) или удар клюшкой */
    var C=PEN_CFG, v=null, vd=C.stickReach;
    for(var i=0;i<players.length;i++){
      var q=players[i];
      if(q.team===p.team||q.goalie||q.boxed||q.down>0||q===puck.owner) continue;
      var dq=Math.hypot(q.x-p.x,q.z-p.z); if(dq<vd){vd=dq;v=q;}
    }
    if(!v) return;
    var b=backness(p,v);
    if(R()<clamp(C.stickBase+C.stickBack*Math.max(0,b)+C.stickSpeed*clamp((p.spd||0)/7,0,1),0,C.maxChance)){
      penalize(p, b>C.tripDot?'trip':'slash');
    }
  }
  function doCheck(p){
    fx.act(p,'body_check',0.7);
    checkT=0.30;
    var arr=players;
    for(var i=0;i<arr.length;i++){
      var o=arr[i];
      if(o.team===p.team||o.goalie||o.down>0||o.boxed) continue;
      var d=Math.hypot(o.x-p.x,o.z-p.z);
      if(d<PLAYER_CFG.checkRange && p.spd>PLAYER_CFG.checkMinSpeed){
        /* запоминаем до того, как отберём шайбу: ниже puck.owner уже null,
           и чистый силовой на владельце засчитывался как нарушение */
        var wasCarrier = (puck.owner===o);
        /* нарушение решаем до отброса: шайба ещё у него */
        var call = hitCall(p,o, wasCarrier || (lastTouch===o && Math.hypot(puck.x-o.x,puck.z-o.z)<2.2));
        o.down=1.5;
        var a=Math.atan2(o.z-p.z,o.x-p.x);
        o.vx=Math.cos(a)*9; o.vz=Math.sin(a)*9;
        if(puck.owner===o){ puck.owner=null; puck.free=0.4;
          puck.vx=Math.cos(a)*5.5; puck.vz=Math.sin(a)*5.5; }
        emit('hit',{p:pIdx(p), t:p.team, v:pIdx(o), vt:o.team, clean:!call, x:r2(o.x), z:r2(o.z), hard:1});
        if(call) penalize(p,call.reason,call.major);
        return;
      }
    }
  }
  function switchPlayer(team){
    var hs=HS[team], arr=teamOf(team), best=null, bd=1e9;
    for(var i=0;i<arr.length;i++){
      if(arr[i]===hs.ctrl||arr[i].down>0) continue;
      var d=Math.hypot(arr[i].x-puck.x,arr[i].z-puck.z);
      if(d<bd){bd=d;best=arr[i];}
    }
    if(best){ hs.ctrl=best; fx.swap(team); }
  }


  /* ============================================================
     ИИ С ШАЙБОЙ: когда бросать, кому пасовать
     Раньше: бросок только ближе 11–15 м «по таймеру», а под давлением —
     мгновенный пас наугад в первом же кадре. Теперь владелец оценивает
     момент (дистанция, угол, слот, свободна ли линия броска, вратарь, свежий
     пас в разрез, отскок) и выбирает открытого партнёра.
     Уровень задаёт качество решений, а не просто частоту бросков: сильный
     ИИ точнее целится, читает вратаря и ждёт открытую линию.
     ============================================================ */
  var AI_LV={
    /* think — пауза между решениями, с; thr — порог оценки для броска;
       aimErr — разброс прицела по ширине ворот (створ ±0.92); read — доля
       бросков в дальний от вратаря угол; lane — штраф за перекрытую линию;
       react — задержка реакции на давление, с; meet — адресат идёт к шайбе;
       crash — нападающие идут на добивание; smart — выбор паса по открытости;
       passErr — промах паса, м; pow — сила броска (по умолчанию 1);
       noise — ошибка в оценке момента: слабый ИИ бьёт из плохих позиций и пропускает хорошие */
    easy:   {think:[0.8,1.5],  thr:0.45, aimErr:0.90, read:0.0, lane:0.15, react:[0.45,0.80], meet:0.4, crash:0, smart:0, passErr:3.6, pow:0.70, noise:0.25},
    normal: {think:[0.35,0.8], thr:0.38, aimErr:0.36, read:0.6, lane:0.25, react:[0.20,0.40], meet:0.9, crash:1, smart:1, passErr:2.8},
    hard:   {think:[0.25,0.55],thr:0.40, aimErr:0.22, read:1.0, lane:0.30, react:[0.10,0.25], meet:1.0, crash:1, smart:1, passErr:1.7}
  };
  /* соперник-компьютер получает уровень ?ai=, партнёры живого игрока — normal */
  function aiLevel(team){ return AI_LV[CFG.lv[team]] || AI_LV.normal; }

  /* clamp, которому всё равно, в каком порядке границы (для «от своих ворот до синей» с любой стороны) */
  function clampR(v,a,b){ return a<b ? clamp(v,a,b) : clamp(v,b,a); }
  /* расстояние от точки до отрезка */
  function segDist(px,pz, ax,az, bx,bz){
    var dx=bx-ax, dz=bz-az, L2=dx*dx+dz*dz||1e-6;
    var t=clamp(((px-ax)*dx+(pz-az)*dz)/L2,0,1);
    return Math.hypot(px-(ax+dx*t), pz-(az+dz*t));
  }
  /* ближайший полевой соперник к отрезку a→b (кроме вратаря) */
  function laneBlock(team, ax,az, bx,bz){
    var fo=teamOf(team===0?1:0), m=99;
    for(var i=0;i<fo.length;i++){ var d=segDist(fo[i].x,fo[i].z, ax,az, bx,bz); if(d<m) m=d; }
    return m;
  }
  function nearestFoe(p){
    var fo=teamOf(p.team===0?1:0), m=99;
    for(var i=0;i<fo.length;i++){ var d=Math.hypot(fo[i].x-p.x,fo[i].z-p.z); if(d<m) m=d; }
    return m;
  }
  /* оценка броска из точки (x,z) для команды team: 0 — безнадёжно, 1 — пустые ворота */
  function shotQuality(team, x, z, LV){
    var dir=attackDir(team), gx=dir*GOAL_X;
    var ahead=(gx-x)*dir;                          /* сколько до линии ворот */
    if(ahead<0.6) return 0;                        /* из-за ворот не бросаем */
    var d=Math.hypot(gx-x, z);
    var fd = clamp((19-d)/13, 0, 1);               /* 1 ближе 6 м, 0 дальше 19 м */
    var ang = ahead/d;                             /* 1 — прямо по центру, 0 — с линии ворот */
    var fa = clamp((ang-0.25)/0.55, 0, 1);
    var q = fd*(0.35+0.65*fa);
    if(d<10 && Math.abs(z)<4.5) q+=0.12;           /* слот */
    var lb=laneBlock(team, x,z, gx,0);             /* перекрыта ли линия броска */
    if(lb<0.9) q-=LV.lane; else if(lb>2.2) q+=0.05;
    var gk=goalieOf(team===0?1:0);
    if(gk){                                         /* вратарь не на месте — ворота открыты */
      var gd=segDist(gk.x,gk.z, x,z, gx,0);
      if(gd>1.2) q+=0.15*LV.read;
    }
    return q;
  }
  function aiCarrier(p, dt, foes){
    var LV=aiLevel(p.team), gx=p.dir*GOAL_X;
    if(offWarn===p.team){ p._t=0.05; return; }     /* сначала снять офсайд */
    var pd=nearestFoe(p), pressed=pd<2.3;
    var q=shotQuality(p.team, p.x, p.z, LV);
    if(LV.noise){
      /* оценка «плавает» медленно (раз в решение), а не дрожит каждый кадр */
      if(p._qn===undefined || p._t<=0) p._qn=(R()*2-1)*LV.noise;
      q+=p._qn;
    }
    /* свежий пас в разрез — бросок в одно касание */
    var fresh = p._recvT!==undefined && SIMT-p._recvT<0.9;
    if(fresh && p._recvLead) q+=0.28;
    else if(fresh) q+=0.08;
    /* подобрал отскок у чужих ворот сразу после сейва */
    if(LASTSAVE && LASTSAVE.t!==p.team && SIMT-LASTSAVE.time<2.5 && Math.hypot(gx-p.x,p.z)<8) q+=0.32;
    /* долго держит шайбу в зоне атаки — не катать по кругу, а бросать */
    /* (но только с нормальной дистанции — не выстреливать издалека от скуки) */
    if((p.x*p.dir)>BLUE_X){ p._zoneT=(p._zoneT||0)+dt; if(Math.hypot(gx-p.x,p.z)<13) q+=Math.min(0.15, p._zoneT*0.04); } else p._zoneT=0;

    /* реакция на давление: не в первом же кадре, а через задержку */
    if(pressed){ p._pr=(p._pr===undefined? rnd(LV.react[0],LV.react[1]) : p._pr-dt); }
    else p._pr=undefined;
    p._t=(p._t===undefined? rnd(0.15,0.35) : p._t-dt);

    var mustAct = pressed && p._pr<=0;
    var oneTimer = fresh && q>=LV.thr;               /* бросок сразу по приёму */
    if(!(p._t<=0 || mustAct || oneTimer)) return;
    p._t=rnd(LV.think[0], LV.think[1]);

    if(q>=LV.thr || (mustAct && q>=LV.thr-0.12)){ aiShoot(p, LV, q); return; }
    var ps=aiPassPick(p, LV, q);
    if(ps && (mustAct || ps.gain>0.12)){
      /* промах паса растёт с дальностью */
      var e=LV.passErr*(0.6+ps.L/20)*(R()*2-1), a=R()*6.283;
      doPass(p, ps.v, ps.lift, ps.lead, ps.m, {x:ps.pt.x+Math.cos(a)*e, z:ps.pt.z+Math.sin(a)*e});
      return;
    }
    if(mustAct){ /* открытых нет: сброс в сторону ворот соперника */
      doPass(p, 18, true, false); return;
    }
    /* ничего лучше — везём шайбу дальше, решим чуть позже */
    p._t=rnd(0.15,0.3);
  }
  function aiShoot(p, LV, q){
    var gk=goalieOf(p.team===0?1:0);
    /* угол: дальний от вратаря (читает вратаря) или случайный */
    var side = (R()<LV.read && gk) ? (gk.z>0?-1:1) : (R()<0.5?-1:1);
    var z = side*0.68 + (R()*2-1)*LV.aimErr;
    var power = clamp((0.45+q*0.5+rnd(-0.1,0.15))*(LV.pow||1), 0.25, 1);
    p._zoneT=0; p._recvT=undefined;
    doShot(p, power, clamp(z,-1.4,1.4));
  }
  /* лучший пас: открытый партнёр со свободной линией, в хорошей позиции для броска */
  function aiPassPick(p, LV, myQ){
    var arr=teamOf(p.team), best=null, bs=-1e9;
    var inZone=(p.x*p.dir)>BLUE_X;
    for(var i=0;i<arr.length;i++){
      var m=arr[i]; if(m===p || m.down>0) continue;
      var dx=m.x-p.x, dz=m.z-p.z, L=Math.hypot(dx,dz);
      if(L<3 || L>24) continue;
      /* не отдаём за синюю, пока шайба не в зоне, — это офсайд */
      if(!inZone && m.x*p.dir>BLUE_X+0.3) continue;
      var fwd=(m.x-p.x)*p.dir;
      /* в разрез — нападающему впереди, который успевает рывком в свободное место (thruPoint) */
      var tpt = (LV.smart && m.role<3 && fwd>0.5 && m.vx*p.dir>0.5 && (m.x*p.dir)>BLUE_X-6) ? thruPoint(p, m) : null;
      var lead = !!tpt && foeGap(p.team, tpt.x, tpt.z, tpt.t)>2.0 && !thruOffside(p, m, tpt);
      /* упреждение на время полёта шайбы */
      var tf=L/18*1.05;
      var txp=lead? tpt.x : m.x+m.vx*tf, tzp=lead? tpt.z : m.z+m.vz*tf;
      var lane=laneBlock(p.team, p.x,p.z, txp,tzp);
      var cover=nearestFoe(m);
      var mq=shotQuality(p.team, txp, tzp, LV);
      var sc = mq*1.6 + clamp(cover,0,5)*0.12 + fwd*0.02 - L*0.02;
      if(LV.smart){ if(lane<1.0) sc-=1.2; else if(lane<1.8) sc-=0.4; }
      else sc += R()*0.6;               /* слабый ИИ видит поле хуже */
      if(lead) sc+=0.25;
      if(sc>bs){ bs=sc; best={m:m, lead:lead, lift:lane<1.0 && L>10, gain:mq-myQ+(lead?0.2:0), pt:{x:txp, z:tzp}, L:L, v:lead?tpt.v:18}; }
    }
    return best;
  }

  /* ============================================================
     ИГРА БЕЗ ШАЙБЫ: открывание и пас в разрез (обе команды, любой уровень)
     Раньше партнёры владельца стояли в своих полосах на фиксированном
     расстоянии от шайбы и не искали окно, а адресат паса в разрез ехал
     «навстречу шайбе», а не на ход. Теперь:
     · у каждого опорная точка по роли — крайние широко и вперёд, центр
       в слоте, защитники у синей; вокруг неё кольцо кандидатов, и игрок
       выбирает место подальше от соперников со свободной линией паса от
       владельца, не на месте партнёра и не в офсайде (пока шайба не в
       зоне — не дальше синей). Пересчёт раз в 0.3 с, между пересчётами
       игрок «ищет окно» — покачивается около точки;
     · пас в разрез идёт тому, у кого лучший выход к воротам и свободная
       линия, в точку, где он будет к прилёту шайбы (thruPoint); адресат
       сразу рвётся на перехват, а живой игрок с шайбой видит его заранее
       (маркер в index.html — та же функция passTargets).
     Случайных чисел здесь нет: порядок вызовов R() у остальной игры прежний.
     ============================================================ */
  var THRU_V=21, THRU_MIN=15;
  /* куда рвётся партнёр: к воротам, с загибом в слот */
  function runDir(m){
    var dir=attackDir(m.team), tx=dir*(GOAL_X-6.5), tz=clamp(m.z*0.45,-5,5);
    var dx=tx-m.x, dz=tz-m.z, L=Math.hypot(dx,dz);
    if(L<2 || dx*dir<0){ dx=dir; dz=-m.z*0.08; L=Math.hypot(dx,dz)||1; }
    return [dx/L, dz/L];
  }
  /* время рывка на s метров с начальной скоростью v0 по ходу. Рывок — как ускорение живого игрока: разгон
     sprintAccel против трения (damping за кадр) — скорость v(t)=vt−(vt−v0)·e^(−kt), vt — потолок 9.5 м/с */
  var RUN_K=(1-PLAYER_CFG.damping)*60, RUN_VT=Math.min(PLAYER_CFG.sprintMaxSpeed, PLAYER_CFG.sprintAccel/RUN_K);
  function runDist(t, v0){ return RUN_VT*t - (RUN_VT-v0)/RUN_K*(1-Math.exp(-RUN_K*t)); }
  function runTime(s, v0){
    v0=clamp(v0,-3,RUN_VT); var a=0, b=4;
    for(var i=0;i<22;i++){ var m=(a+b)/2; if(runDist(m,v0)<s) a=m; else b=m; }
    return b;
  }
  function inRink(x, z, team){
    var dir=attackDir(team);
    x=clamp(x,-RL+2,RL-2); if(x*dir>GOAL_X-1.8) x=dir*(GOAL_X-1.8);
    var hw=halfWidthAt(x)-2.2; z=clamp(z,-hw,hw);
    return [x,z];
  }
  /* Точка встречи паса в разрез: партнёр m рвётся по runDir, шайба от p летит в свободное место впереди него
     с такой силой (15…21 м/с; тише — перехватят или догонит сам пасующий), чтобы прийти туда вместе с ним. Из точек 2.5…9 м по ходу выбирается та, где
     лучше бросать и дальше от соперников. Вернёт {x, z, t — время полёта, v — сила паса}. */
  function thruPoint(p, m){
    var dir=attackDir(m.team), from=stickEnd(p), LV=aiLevel(p.team), q=null, qs=-1e9;
    /* куда рваться: к слоту, прямо вперёд (крайний — вдоль борта) или по своему ходу, если он вперёд */
    var sp=Math.hypot(m.vx,m.vz), U=[runDir(m), [dir,0]];
    if(sp>3 && m.vx*dir>0.3*sp) U.push([m.vx/sp, m.vz/sp]);
    for(var k=0;k<U.length;k++){
      var u=U[k], v0=m.vx*u[0]+m.vz*u[1];
      for(var s=2.5; s<=9.01; s+=0.75){
        var c=inRink(m.x+u[0]*s, m.z+u[1]*s, m.team), tr=runTime(s, v0);
        var D=Math.hypot(c[0]-from[0], c[1]-from[1]), v=clamp(D/Math.max(tr,0.05)*1.05, THRU_MIN, THRU_V);
        var tp=D/v*1.05, miss=Math.abs(tp-tr);
        var sc=shotQuality(m.team, c[0], c[1], LV)*1.5 + clamp(foeGap(m.team, c[0], c[1], tp),0,5)*0.3 + s*0.04
               - miss*1.5 - (miss>0.25?3:0);             /* не успевает к шайбе — не годится */
        if(sc>qs){ qs=sc; q={x:c[0], z:c[1], t:tp, v:v, miss:miss}; }
      }
    }
    return q;
  }
  /* пас из средней зоны в зону атаки, а партнёр пересечёт синюю раньше шайбы — офсайд */
  function thruOffside(p, m, pt){
    var dir=attackDir(p.team);
    if(p.x*dir>BLUE_X || pt.x*dir<=BLUE_X) return false;
    var from=stickEnd(p), ux=Math.abs(pt.x-from[0])/(Math.hypot(pt.x-from[0],pt.z-from[1])||1);
    var tPuck=(BLUE_X-from[0]*dir)/Math.max(1, THRU_V*ux);
    var tMate=Math.max(0, BLUE_X-m.x*dir)/Math.max(4, m.vx*dir+2);
    return tMate < tPuck+0.08;
  }
  /* перекрыта ли линия паса — соперники с упреждением их хода на dt */
  function laneBlockAt(team, ax,az, bx,bz, dt){
    var fo=teamOf(team===0?1:0), m=99;
    for(var i=0;i<fo.length;i++){ var d=segDist(fo[i].x+fo[i].vx*dt, fo[i].z+fo[i].vz*dt, ax,az, bx,bz); if(d<m) m=d; }
    return m;
  }
  /* ближайший полевой соперник к точке — с упреждением его хода на dt */
  function foeGap(team, x, z, dt){
    var fo=teamOf(team===0?1:0), m=99;
    for(var i=0;i<fo.length;i++){ var d=Math.hypot(fo[i].x+fo[i].vx*dt-x, fo[i].z+fo[i].vz*dt-z); if(d<m) m=d; }
    return m;
  }
  /* адресат паса в разрез: лучший выход к воротам, свободная линия, немного — по направлению стика d */
  function thruMate(p, d){
    var arr=teamOf(p.team), dir=attackDir(p.team), LV=aiLevel(p.team), best=null, bs=-1e9;
    for(var i=0;i<arr.length;i++){
      var m=arr[i]; if(m===p || m.down>0) continue;
      var pt=thruPoint(p, m), L=Math.hypot(pt.x-p.x, pt.z-p.z);
      if(L>30) continue;
      var lane=Math.min(laneBlock(p.team, p.x,p.z, pt.x,pt.z), laneBlockAt(p.team, p.x,p.z, pt.x,pt.z, Math.min(0.3, pt.t*0.5)));
      var gap=foeGap(p.team, pt.x,pt.z, pt.t);
      var dot=d ? ((pt.x-p.x)*d.x+(pt.z-p.z)*d.z)/(L||1) : 0;
      var fwd=(pt.x-p.x)*dir;
      var s=shotQuality(p.team, pt.x, pt.z, LV)*2.0 + clamp(gap,0,6)*0.3 + dot*0.8 + clamp(fwd,-6,10)*0.12;
      if(fwd<0) s-=1.0;                                   /* в разрез — вперёд, а не назад */
      if(lane<1.0) s-=2.5; else if(lane<1.8) s-=0.8;
      if(m.role>=3) s-=0.6;                               /* защитник в разрез — в последнюю очередь */
      if(pt.miss>0.3) s-=3.0;                             /* к шайбе не успевает */
      if(thruOffside(p, m, pt)) s-=2.0;
      if(s>bs){ bs=s; best={m:m, pt:pt, s:s, lane:lane, gap:gap}; }
    }
    return best;
  }
  /* для подсказки над партнёрами: кому уйдёт пас по Y и по A при направлении стика d (или «вперёд») */
  function passTargets(p, d){
    d=d||{x:attackDir(p.team), z:0};
    var th=thruMate(p, d);
    return {thru:th?th.m:null, norm:openMate(p, d)};
  }

  /* точка на пути летящей шайбы, куда игрок p успеет со скоростью v (трение шайбы — как в шаге) */
  /* null — шайба уходит быстрее, чем он успеет */
  function interceptPt(p){
    var x=puck.x, z=puck.z, vx=puck.vx, vz=puck.vz, t=0, k=0.996*0.996;
    var v0=Math.max(0, p.vx*(x-p.x)+p.vz*(z-p.z))/(Math.hypot(x-p.x, z-p.z)||1);
    for(var i=0;i<54;i++){
      t+=1/30; vx*=k; vz*=k; x+=vx/30; z+=vz/30;
      if(Math.hypot(x-p.x, z-p.z)<=runDist(t, v0)+0.8) return inRink(x, z, p.team);
    }
    return null;
  }

  /* куда открываться партнёру владельца c */
  var RING=[[0,0],[2.6,0],[-2.6,0],[0,2.6],[0,-2.6],[1.9,1.9],[1.9,-1.9],[-1.9,1.9],[-1.9,-1.9],[4.4,0],[0,4.4],[0,-4.4],[3.4,3.4],[3.4,-3.4],[-3.4,3.4],[-3.4,-3.4]];
  function supportAnchor(p, c){
    var dir=p.dir, TC=TACTIC[p.team], inZone=(c.x*dir)>BLUE_X;
    var side=(p.role===0||p.role===3)?-1:1, ax, az;
    if(p.role>=3){                                      /* защитники: у синей, разведены по ширине */
      ax = inZone ? dir*(BLUE_X+(TC===2?-1.0:(TC===1?2.2:1.2))) : c.x-dir*(TC===2?9:6);
      az = side*6.2;
    } else if(p.role===1){                              /* центр: слот, вне зоны — по центру впереди шайбы */
      ax = inZone ? dir*(GOAL_X-7.0) : c.x+dir*(4.5+(TC===1?1.5:(TC===2?-2.5:0)));
      az = inZone ? clamp(-c.z*0.25,-2.5,2.5) : clamp(-c.z*0.35,-4,4);
    } else {                                            /* крайние: широко и вперёд */
      var weak = side*c.z < -1;                         /* дальний от шайбы край — к дальней штанге */
      ax = inZone ? dir*(GOAL_X-(weak?5.5:7.5)) : c.x+dir*(6.5+(TC===1?1.5:(TC===2?-2.5:0)));
      az = inZone ? side*(weak?5.0:9.0) : side*9.5;
    }
    return [ax, az];
  }
  function supportSpot(p, c){
    var dir=p.dir, inZone=(c.x*dir)>BLUE_X, IS_D=p.role>=3;
    var fresh = p._sT===undefined || SIMT>=p._sT || p._sc!==c;
    if(fresh){
      var an=supportAnchor(p, c), LV=aiLevel(p.team), mates=teamOf(p.team), best=null, bs=-1e9;
      for(var i=0;i<RING.length;i++){
        var ox=RING[i][0], oz=RING[i][1];
        if(IS_D) ox=clamp(ox,-1.2,1.2);                 /* защитник ходит вдоль синей, а не в глубину */
        var cc=inRink(an[0]+ox*dir, an[1]+oz, p.team), cx=cc[0], cz=cc[1];
        if(!inZone && cx*dir>BLUE_X-0.6) cx=dir*(BLUE_X-0.6);         /* не раньше шайбы в зону */
        if(IS_D && !inZone && (cx-c.x)*dir>-2) cx=c.x-dir*2;          /* защитник сзади шайбы */
        var L=Math.hypot(cx-c.x, cz-c.z);
        var s=clamp(foeGap(p.team, cx,cz, 0.3),0,4)*0.6;     /* свободно — до 4 м, дальше уже не важно */
        var lane=laneBlock(p.team, c.x,c.z, cx,cz);
        if(lane<1.0) s-=2.0; else if(lane<1.8) s-=0.7;
        if(L<4) s-=(4-L)*0.4; else if(L>22) s-=(L-22)*0.15;
        s-=Math.hypot(cx-an[0], cz-an[1])*0.2 + Math.hypot(cx-p.x, cz-p.z)*0.04;   /* своё место по роли */
        if(!IS_D && inZone) s+=shotQuality(p.team, cx, cz, LV)*(p.role===1?1.6:1.0);
        for(var j=0;j<mates.length;j++){
          var o=mates[j]; if(o===p || o===c) continue;
          var sd=Math.hypot(cx-(o._sx===undefined?o.x:o._sx), cz-(o._sz===undefined?o.z:o._sz));
          if(sd<4.5) s-=(4.5-sd)*0.5;
        }
        if(p._sx!==undefined && Math.hypot(cx-p._sx, cz-p._sz)<1.0) s+=0.35;   /* не дёргаться между равными */
        if(s>bs){ bs=s; best=[cx,cz]; }
      }
      p._sx=best[0]; p._sz=best[1]; p._sc=c; p._sT=SIMT+0.3;
    }
    var tx=p._sx, tz=p._sz;
    if(!IS_D){
      /* ищет окно: не стоит, а покачивается около точки */
      tx+=Math.cos(SIMT*1.3+p.role*2.1)*0.6; tz+=Math.sin(SIMT*1.7+p.role*1.3)*0.9;
      /* адресат будущего паса в разрез у живого владельца уже клонится в рывок */
      if(HS[p.team].thruM===p){ var u=runDir(p); tx+=u[0]*1.5; tz+=u[1]*1.5; }
      if(!inZone && tx*dir>BLUE_X-0.6) tx=dir*(BLUE_X-0.6);
    }
    return [tx,tz];
  }

  /* ---------- управление живым игроком ---------- */
  var NOIN={mx:0,mz:0}, NOEDGE={};
  function humanTick(team, inp, edge, dt){
    var hs=HS[team];
    /* вратарь отдал шайбу (пас, бросок, накрыл) — управление снова у полевого */
    if(hs.goalieCtl && !(hs.ctrl && hs.ctrl.goalie && puck.owner===hs.ctrl)){
      hs.goalieCtl=false;
      var back=(hs.prevCtl && !hs.prevCtl.boxed) ? hs.prevCtl : null;
      hs.ctrl = (LASTPASS && LASTPASS.to && LASTPASS.from.goalie && LASTPASS.from.team===team) ? LASTPASS.to : (nearestOf(team,puck.x,puck.z)||back);
      hs.prevCtl=null; hs.charge=0;
    }
    if(!hs.ctrl || hs.ctrl.boxed){ var f0=onIce(team)[0]; if(f0) hs.ctrl=f0; }
    if(state!=='play'){ hs.press.on=false; hs.pressT=0; gkRush[team]=false; return; }
    var lockA = SIMT<FO.lockT;     /* сразу после вбрасывания A ещё жмут по инерции */

    /* бросок в одно касание: B нажали, пока летел свой пас, — бьём, как только шайба дошла до своего (управление
       переходит к нему при приёме). Держит B — заряд копится и в полёте, отпустил после приёма — бросок с ним. */
    if(hs.otT>0){
      var rc=hs.ctrl;
      if(rc && puck.owner===rc && !rc.goalie && LASTRECV && LASTRECV.to===rc && SIMT-LASTRECV.t<0.25){
        hs.otT=0;
        if(!inp._B){ doShot(rc, Math.max(SHOT_CFG.otPow, hs.charge/0.85), undefined, true); hs.charge=0; }
        else hs.otRecv=SIMT;
      } else if(puck.owner || SIMT>hs.otT){ hs.otT=0; hs.charge=0; }
      else if(inp._B) hs.charge=Math.min(0.85,hs.charge+dt);
    }
    /* заряд броска */
    if(hs.charge>0 && !inp._B && !(hs.otT>0)){
      if(hs.ctrl && puck.owner===hs.ctrl){
        var otH=hs.otRecv>0 && SIMT-hs.otRecv<SHOT_CFG.otHold;
        doShot(hs.ctrl, otH ? Math.max(SHOT_CFG.otPow, hs.charge/0.85) : clamp(hs.charge/0.85,0.18,1), undefined, otH);
      }
      hs.charge=0; hs.otRecv=0;
    }

    /* автовыбор активного */
    if(!hs.goalieCtl){
      if(puck.owner && puck.owner.team===team && !puck.owner.goalie){
        if(hs.ctrl!==puck.owner) hs.ctrl=puck.owner;
      } else if(!puck.owner && LASTPASS && LASTPASS.lead && LASTPASS.from.team===team && LASTPASS.to && LASTPASS.to!==hs.ctrl && SIMT-LASTPASS.t<RECV_CFG.run){
        /* пас в разрез летит партнёру: он рвётся за шайбой сам, управление перейдёт к нему при приёме */
      } else {
        hs.autoT-=dt;
        if(hs.autoT<=0){
          hs.autoT=0.22;
          var cand=nearestOf(team,puck.x,puck.z);
          if(cand){
            var dCur=(hs.ctrl&&!hs.ctrl.boxed)?Math.hypot(hs.ctrl.x-puck.x,hs.ctrl.z-puck.z):999;
            var dNew=Math.hypot(cand.x-puck.x,cand.z-puck.z);
            if(cand!==hs.ctrl && dNew<dCur-1.5) hs.ctrl=cand;
          }
        }
      }
    }

    var p=hs.ctrl;
    if(!p || p.down>0) return;
    /* вектор прицела: направление левого стика, иначе — вперёд по атаке */
    var aL=Math.hypot(inp.mx,inp.mz);
    if(aL>0.22){ var aw=toWorld(inp.mx/aL,inp.mz/aL,[0,0]); hs.aimX=aw[0]; hs.aimZ=aw[1]; }
    else if(!hs.aimX && !hs.aimZ){ hs.aimX=attackDir(team); hs.aimZ=0; }
    var hasPuck = puck.owner===p;
    if(hasPuck){ hs.press.on=false; hs.pressT=0; }

    if(hasPuck){
      /* счётчик пасов для тестов: считаем само нажатие, а не игрока —
         игра может переключить управление между тапом и пасом */
      if(edge.A && !lockA){ doPass(p,19,false,false); passN[team]++; }
      if(edge.Y){ doPass(p,21,false,true);  passN[team]++; }
      if(edge.X){ doPass(p,15,true,false);  passN[team]++; }
      if(inp._B) hs.charge=Math.min(0.85,hs.charge+dt);
    } else {
      gkRush[team]=!!inp._Y;
      if(true){
        if(lockA) hs.pressT=0;
        else if(inp._A) hs.pressT+=dt;
        else { if(hs.pressT>0 && hs.pressT<0.20) switchPlayer(team); hs.pressT=0; }
        if(edge.B){
          /* свой пас летит — B не отбор, а бросок в одно касание при приёме */
          if(!puck.owner && LASTPASS && !LASTPASS.fo && LASTPASS.from.team===team && SIMT-LASTPASS.t<SHOT_CFG.otWin){
            hs.otT=LASTPASS.t+SHOT_CFG.otWin; hs.charge=1/60; hs.otRecv=0;
          } else doPoke(p);
        }
        if(edge.X) doCheck(p);
        if(edge.LB) switchPlayer(team);
        if(hs.pressCd>0) hs.pressCd-=dt;
        if(hs.pressT>0.18){
          var tgt = puck.owner && puck.owner.team!==team ? puck.owner : null;
          var tx3=tgt?tgt.x:puck.x, tz3=tgt?tgt.z:puck.z;
          var ddx=tx3-p.x, ddz=tz3-p.z, L4=Math.hypot(ddx,ddz)||1;
          hs.press.on=true; hs.press.x=ddx/L4; hs.press.z=ddz/L4; hs.press.d=L4;
          if(L4<2.1 && hs.pressCd<=0){ hs.pressCd=0.42; doPoke(p,true); }
        } else hs.press.on=false;
      }
    }
  }

  /* ---------- вратарь ---------- */
  /* Вратарь работает сам: держит угол между шайбой и воротами,
     выкатывается навстречу дальнему броску, прижимается к линии при близкой шайбе,
     а при летящей на ворота шайбе смещается в точку её пересечения с линией. */
  function goalieLogic(g,dt){
    var gx0=g.dir*GOAL_X;                  /* линия ворот */
    var dxp=puck.x-gx0, dzp=puck.z;
    var dist=Math.hypot(dxp,dzp);
    var mine = Math.sign(puck.x)===Math.sign(g.dir) || Math.abs(puck.x)<6;

    /* угол на шайбу от центра ворот */
    var ang=Math.atan2(dzp, -g.dir*dxp);   /* 0 = прямо перед воротами */
    ang=clamp(ang,-1.15,1.15);

    /* глубина выхода: далеко — смелее, близко — в воротах */
    var depth;
    if(!mine) depth=0.55;
    else depth = clamp(0.45 + (clamp(dist,2,16)-2)*0.075, 0.45, 1.55);
    if(dist<2.6) depth=0.42;

    var tx = gx0 - g.dir*depth*Math.cos(ang);
    var tz = clamp(depth*Math.sin(ang)*1.35 + clamp(dzp,-3,3)*0.30, -1.45, 1.45);

    /* шайба за линией ворот — прижимается к ближней штанге (как в NHL), а не катается по дуге */
    if((puck.x-gx0)*g.dir > -0.3){ tx=gx0-g.dir*0.32; tz=(dzp>=0?1:-1)*0.70; }

    /* шайба летит в створ — идём в точку пересечения */
    var speed=Math.hypot(puck.vx,puck.vz);
    if(!puck.owner && speed>6 && Math.sign(puck.vx)===g.dir && Math.abs(dxp)<22){
      var tt=Math.abs(dxp)/Math.max(1,Math.abs(puck.vx));
      var cz=puck.z+puck.vz*tt;
      if(Math.abs(cz)<2.6){
        tz=lerp(tz, clamp(cz,-1.5,1.5), 0.85);
        tx=lerp(tx, gx0-g.dir*0.45, 0.6);
      }
    }

    /* выход на игрока с шайбой по удержанию Y */
    var rush = gkRush[g.team] && puck.owner && puck.owner.team!==g.team &&
               Math.sign(puck.owner.x)===Math.sign(g.dir) &&
               Math.abs(puck.owner.x-gx0)<9.5;
    var spd = rush?9.0:6.5;
    if(rush){
      var o=puck.owner;
      var L=Math.hypot(o.x-gx0,o.z)||1;
      var reach=Math.min(L-0.5, 6.2);
      tx = gx0 + (o.x-gx0)/L*reach;
      tz = clamp(o.z/L*reach, -5.0, 5.0);
    }

    /* реальное движение с ограничением скорости */
    var mvx=tx-g.x, mvz=tz-g.z, mL=Math.hypot(mvx,mvz);
    if(mL>0.001){
      var step=Math.min(mL, spd*dt);
      g.x+=mvx/mL*step; g.z+=mvz/mL*step;
    }
    /* никогда не заезжает за линию ворот назад */
    if(g.dir>0) g.x=clamp(g.x,GOAL_X-7.0,GOAL_X+0.30);
    else        g.x=clamp(g.x,-GOAL_X-0.30,-GOAL_X+7.0);
    g.z=clamp(g.z,-6.0,6.0);
    g.spd=mL>0.001?Math.min(mL/Math.max(dt,0.001),spd):0;
    /* Вратарь провожает шайбу взглядом, но не разворачивается спиной к площадке.
       Раньше при шайбе за воротами (x дальше линии) он вставал лицом к своей
       сетке — ровно то, на что жаловались. Держим курс в пределах ±65° от «в поле». */
    var faceOut = g.dir>0 ? Math.PI : 0;
    var want = Math.atan2(puck.z-g.z, puck.x-g.x);
    var dyG = Math.atan2(Math.sin(want-faceOut), Math.cos(want-faceOut));
    g.yaw = faceOut + clamp(dyG, -1.15, 1.15);
  }

  /* ---------- симуляция ---------- */
  /* Доля шага, на которой шайба пересекла плоскость x=gx (или -1, если не пересекла).
     Проверять надо именно отрезок: за кадр шайба пролетает больше ширины створа,
     и на 30 кадрах бросок 34 м/с проходил сквозь сетку без гола. */
  function crossAt(x0,x1,gx,dirC){
    if((x0-gx)*dirC>=0) return -1;      /* уже была за линией */
    if((x1-gx)*dirC<0)  return -1;      /* не дошла */
    var d=x1-x0;
    return Math.abs(d)<1e-9 ? 0 : (gx-x0)/d;
  }

  /* ---------- движение человека-игрока: вынесено в отдельные функции,
     чтобы предсказание на госте (netPredictGuest) считало ТЕМ ЖЕ кодом,
     что и sim() на хосте — без риска расхождения между предсказанным и
     авторитетным движением. sim() ниже вызывает их вместо старого
     инлайн-кода; поведение не изменилось, просто вынесено. ---------- */
  function humanMoveIntent(p, hsp, inp2){
    var ax=0,az=0,maxs=PLAYER_CFG.maxSpeed,accel=PLAYER_CFG.accel;
    var wv=toWorld(inp2.mx,inp2.mz,[0,0]);
    ax=wv[0]; az=wv[1];
    var PR=hsp.press;
    if(PR.on){
      // Auto-approach: blend stick input with press direction when A held
      // If stick is significantly deflected (>0.35), manual input has more weight
      var stickMag = Math.hypot(inp2.mx, inp2.mz);
      var blend = stickMag > 0.35 ? 0.55 : 0.0;  // 0 = full auto, 0.55 = blend
      ax = blend === 0 ? PR.x : lerp(ax, PR.x, blend);
      az = blend === 0 ? PR.z : lerp(az, PR.z, blend);
      if(PR.d<PLAYER_CFG.pressRange){ maxs=PLAYER_CFG.pressMaxSpeed; accel=PLAYER_CFG.pressAccel; }
    }
    if(inp2.RT){ maxs=PLAYER_CFG.sprintMaxSpeed; accel=PLAYER_CFG.sprintAccel; }
    /* адресат своего паса, стик отпущен (управление перешло к нему, а игрок не успел взяться): едет к шайбе сам */
    if(!PR.on && Math.hypot(inp2.mx, inp2.mz)<0.2 && recvOf(p)){
      var ip=interceptPt(p), rx=(ip?ip[0]:puck.x+puck.vx*0.4)-p.x, rz=(ip?ip[1]:puck.z+puck.vz*0.4)-p.z, rL=Math.hypot(rx,rz)||1;
      if(rL>0.6){ ax=rx/rL; az=rz/rL; maxs=PLAYER_CFG.sprintMaxSpeed; accel=PLAYER_CFG.sprintAccel; }
    }
    if(puck.owner===p){ maxs*=PLAYER_CFG.puckSpeedMul; }
    return [ax,az,maxs,accel];
  }
  function humanMoveIntegrate(st, ax, az, maxs, accel, dt){
    st.vx+=ax*accel*dt; st.vz+=az*accel*dt;
    var sp=Math.hypot(st.vx,st.vz);
    if(sp>maxs){st.vx=st.vx/sp*maxs;st.vz=st.vz/sp*maxs;sp=maxs;}
    st.vx*=PLAYER_CFG.damping; st.vz*=PLAYER_CFG.damping;
    st.x+=st.vx*dt; st.z+=st.vz*dt;
    // Rectangular clamp first
    st.x=clamp(st.x,-RL+0.8,RL-0.8); st.z=clamp(st.z,-RW+0.8,RW-0.8);
    // Corner projection: keep players inside rounded corners (CORNER=7.0)
    var cornerSafe = CORNER - 0.8;           // 6.2 — safe radius inside corner arc
    var cornerX = RL - cornerSafe;           // 23.8 — x threshold where corner starts
    var cornerZ = RW - cornerSafe;           // 8.8  — z threshold where corner starts
    var axm = Math.abs(st.x), azm = Math.abs(st.z);
    if(axm > cornerX && azm > cornerZ){
      var cx = (st.x > 0 ? 1 : -1) * (RL - CORNER); // ±23
      var cz = (st.z > 0 ? 1 : -1) * (RW - CORNER); // ±8
      var dx = st.x - cx, dz = st.z - cz;
      var d = Math.hypot(dx, dz);
      if(d > cornerSafe){
        st.x = cx + dx/d * cornerSafe;
        st.z = cz + dz/d * cornerSafe;
      }
    }
    st.spd=sp;
    /* Разворот доводим с ограничением скорости, а не ставим мгновенно:
       мгновенная установка выглядит как телепорт, а на резкой смене
       направления игрок успевает мгновение ехать спиной — это и включает
       клип заднего хода. */
    if(recvOf(st) && Math.hypot(puck.x-st.x,puck.z-st.z)<14){
      /* адресат паса смотрит клюшкой на шайбу, куда бы ни ехал */
      var ry=Math.atan2(puck.z-st.z,puck.x-st.x)-st.yaw;
      ry=Math.atan2(Math.sin(ry),Math.cos(ry));
      st.yaw+=clamp(ry,-PLAYER_CFG.recvTurn*dt,PLAYER_CFG.recvTurn*dt);
      st._back=sp>0.5 && (Math.cos(st.yaw)*st.vx+Math.sin(st.yaw)*st.vz) < -0.30*sp;
    } else if(sp>0.5){
      var tgt=Math.atan2(st.vz,st.vx);
      var dy=tgt-st.yaw;
      dy=Math.atan2(Math.sin(dy),Math.cos(dy));
      st.yaw+=clamp(dy,-PLAYER_CFG.turnRate*dt,PLAYER_CFG.turnRate*dt);
      st._back=(Math.cos(st.yaw)*st.vx+Math.sin(st.yaw)*st.vz) < -0.30*sp;
    } else st._back=false;
    st.stride+=dt*(2.5+sp*1.6);
  }
  function sim(dt){
    if(state==='menu') return 0;
    SIMT+=dt;
    if(state==='over'){ stateT-=dt; return 0; }
    if(state==='goal'){
      stateT-=dt;
      if(stateT>0) return 0;
      state='face'; stateT=FACE_CFG.setGoal; placeFaceoff(0,0);
    }
    /* вбрасывание: время матча и удалений стоит, все на местах (полный шаг — камера у клиента едет к точке) */
    if(state==='face'){ faceTick(dt); return 2; }

    clock-=dt;
    if(clock<=0){
      clock=0;
      /* время вышло — удаления просто заканчиваются */
      for(var pe=pen.length-1;pe>=0;pe--) releasePen(pe);
      state='over'; stateT=99;
      puck.vx=0; puck.vz=0; puck.vy=0; puck.owner=null;
      emit('match:end',{score:score.slice(), reason:'time'});
      fx.over();
      return 0;
    }

    /* --- удаления --- */
    for(var pi=pen.length-1;pi>=0;pi--){
      pen[pi].t-=dt;
      if(pen[pi].t<=0) releasePen(pi);
    }

    /* --- ОТЛОЖЕННЫЙ ОФСАЙД (как в NHL на Xbox) и проброс --- */
    if(state==='play'){
      offT+=dt;
      for(var t2=0;t2<2;t2++){
        var dir2=attackDir(t2), pz=zoneOf(puck.x,dir2);
        var arr2=onIce(t2), carrier=puck.owner, q2;
        var mine = carrier ? (carrier.team===t2) : !!(lastTouch && lastTouch.team===t2);

        /* «отметился»: нарушитель выехал за синюю — флаг снимается */
        for(q2=0;q2<arr2.length;q2++)
          if(arr2[q2].os && zoneOf(arr2[q2].x,dir2)!==1) arr2[q2].os=0;

        /* 1. ВОЗНИКНОВЕНИЕ: шайба входит в чужую зону, а свои уже там */
        if(pz===1 && prevZone[t2]!==1 && mine){
          var armed=0;
          for(q2=0;q2<arr2.length;q2++){
            var pl=arr2[q2];
            if(pl!==carrier && zoneOf(pl.x,dir2)===1){ pl.os=1; armed=1; }
          }
          if(armed && offWarn!==t2){ offWarn=t2; offT=0; fx.offside(t2); }
        }

        /* 2. СБРОС: шайба вышла из зоны (пас/выкат назад) */
        if(pz!==1){
          for(q2=0;q2<arr2.length;q2++) arr2[q2].os=0;
          if(offWarn===t2) offWarn=-1;
        }

        if(offWarn===t2){
          var still=0, viol=null;
          for(q2=0;q2<arr2.length;q2++) if(arr2[q2].os) still++;
          /* 2b. СБРОС: все нарушители вышли из зоны */
          if(!still) offWarn=-1;
          else {
            /* 3. ФИКСАЦИЯ: нарушитель тронул шайбу или поехал к воротам */
            for(q2=0;q2<arr2.length;q2++){
              var pv=arr2[q2];
              if(!pv.os) continue;
              var touched = (carrier===pv) ||
                            (lastTouch===pv && Math.hypot(puck.x-pv.x,puck.z-pv.z)<1.3);
              var deep = pv.x*dir2 > GOAL_X-2.2;
              if(touched || deep){ viol=pv; break; }
            }
            if(viol){
              offWarn=-1;
              for(q2=0;q2<arr2.length;q2++) arr2[q2].os=0;
              whistle('offside', dir2*4.5, puck.z>0?7:-7, t2);
              break;
            }
          }
        }
        prevZone[t2]=pz;
      }
      if(icing.armed){
        var dI=attackDir(icing.team);
        if(puck.x*dI > GOAL_X+0.2){
          icing.armed=false;
          whistle('icing', -dI*20, puck.z>0?7:-7, icing.team);
        }
      }
    }
    if(pokeT>0) pokeT-=dt;
    if(checkT>0) checkT-=dt;
    if(HS[0].pokeT>0) HS[0].pokeT-=dt;
    if(HS[1].pokeT>0) HS[1].pokeT-=dt;

    /* --- игроки-люди ---
       Кем управляет ввод, задаёт CFG (setControl): в одиночной игре — команда игрока, у хоста — обе,
       на сервере — обе. Порядок: сначала CFG.first. Для удалённого ввода (CFG.rem) — придержка
       нажатий у шайбы: у удалённого игрока подбор уже случился на его экране. */
    for(var hti=0;hti<2;hti++){
      var ht=hti?1-CFG.first:CFG.first;
      if(!CFG.tick[ht]) continue;
      var RM=CFG.rem[ht], NE=CFG.edge[ht];
      if(RM){
        var hsg=HS[ht];
        /* удалённый игрок нажал пас/бросок, а здесь его игрок ещё не подобрал шайбу (она у него почти
           на клюшке) — придерживаем нажатие до 0.3 с: у него подбор уже случился, иначе нажатие
           превратилось бы в смену игрока */
        var gp=hsg.ctrl, PD=RM.pend||(RM.pend={A:0,B:0,X:0,Y:0,t:0,tapB:0});
        if(gp && !puck.owner && (NE.A||NE.B||NE.X||NE.Y)){
          var gse=stickEnd(gp);
          if(Math.hypot(gse[0]-puck.x,gse[1]-puck.z)<2.2){
            PD.A|=NE.A; PD.B|=NE.B; PD.X|=NE.X; PD.Y|=NE.Y; PD.tapB|=RM.tapB; PD.t=0.3;
            NE.A=NE.B=NE.X=NE.Y=false; RM.tapB=false;
          }
        }
        if(PD.t>0){
          PD.t-=dt;
          if(gp && puck.owner===gp){ NE.A|=PD.A; NE.B|=PD.B; NE.X|=PD.X; NE.Y|=PD.Y; RM.tapB|=PD.tapB; PD.t=0; }
          if(PD.t<=0){ PD.A=PD.B=PD.X=PD.Y=PD.tapB=0; PD.t=0; }
        }
        NE.A=!!NE.A; NE.B=!!NE.B; NE.X=!!NE.X; NE.Y=!!NE.Y;
        /* B нажали и уже отпустили до этого шага (пакеты пришли пачкой — джиттер, переотправка): заряд не
           начинался, и без этого бросок пропадал. Тот же короткий бросок, что и при tapB. */
        if(NE.B && !CFG.inp[ht]._B && !(hsg.charge>0)) RM.tapB=true;
        /* фронт B, ставший коротким броском, использован: иначе в том же шаге, уже без шайбы, он же
           срабатывал как отбор (B без шайбы) — и игрок тут же забирал только что брошенную шайбу */
        if(RM.tapB){ if(hsg.ctrl && puck.owner===hsg.ctrl){ hsg.charge=Math.max(hsg.charge,1/60); NE.B=false; } RM.tapB=false; }
      }
      humanTick(ht, CFG.inp[ht], NE, dt);
      if(RM){ NE.A=NE.B=NE.X=NE.Y=NE.LB=false; }      /* фронт использован */
    }

    /* --- шайба --- */
    if(puck.owner){
      var o=puck.owner, rr=o.goalie?0.55:0.95;     /* у вратаря — в ловушке перед собой */
      puck.x=o.x+Math.cos(o.yaw)*rr; puck.z=o.z+Math.sin(o.yaw)*rr; puck.y=0.05;
      puck.vx=0;puck.vz=0;puck.vy=0;
    } else {
      if(puck.free>0) puck.free-=dt;
      /* точка до шага: створ проверяем отрезком, а не «попал ли кадр в полосу».
         На 30 кадрах бросок 34 м/с пролетал за кадр 1.1 м — полоса ворот шире
         не была, и шайба проходила сквозь сетку без гола. */
      var px0=puck.x, py0=puck.y, pz0=puck.z;
      puck.x+=puck.vx*dt; puck.z+=puck.vz*dt;
      puck.y+=puck.vy*dt; puck.vy-=13*dt;
      if(puck.y<0.05){ puck.y=0.05; puck.vy=(Math.abs(puck.vy)>1.4)? -puck.vy*0.32:0; }
      puck.vx*=0.996; puck.vz*=0.996;

      if(puck.z<-RW+0.35){puck.z=-RW+0.35;puck.vz=-puck.vz*0.72;fx.boards();}
      if(puck.z> RW-0.35){puck.z= RW-0.35;puck.vz=-puck.vz*0.72;fx.boards();}
      if(puck.x<-RL+0.35){puck.x=-RL+0.35;puck.vx=-puck.vx*0.72;fx.boards();}
      if(puck.x> RL-0.35){puck.x= RL-0.35;puck.vx=-puck.vx*0.72;fx.boards();}
      var hw=halfWidthAt(puck.x)-0.35;
      if(Math.abs(puck.z)>hw && hw>0){ puck.z=Math.sign(puck.z)*hw; puck.vz=-puck.vz*0.72; fx.boards(); }

      /* штанги и перекладина */
      for(var gp=0;gp<2;gp++){
        var pdir=(gp===0?1:-1), pgx=pdir*GOAL_X;
        var sp0=crossAt(px0,puck.x,pgx,pdir);
        if(sp0>=0 && Math.hypot(puck.vx,puck.vz)>4){
          var cz0=pz0+(puck.z-pz0)*sp0, cy0=py0+(puck.y-py0)*sp0;
          var hitPost = (Math.abs(Math.abs(cz0)-0.92)<0.16 && cy0<1.28);
          var hitBar  = (Math.abs(cz0)<0.98 && cy0>1.10 && cy0<1.34);
          if(hitPost||hitBar){
            /* ставим шайбу в точку удара, иначе она уже «внутри» и отскок мимо */
            puck.x=pgx-pdir*0.05; puck.z=cz0; puck.y=Math.max(0.05,cy0);
            emit('post',{t:lastTouch?lastTouch.team:-1, p:lastTouch?pIdx(lastTouch):-1, bar:!!hitBar});
            if(hitBar){ puck.vy=-Math.abs(puck.vy)-1.5; puck.vx=-puck.vx*0.55; }
            else { puck.vz=-puck.vz*0.9 + (cz0>0?3.5:-3.5); puck.vx=-puck.vx*0.45; }
            puck.free=0.25;
          }
        }
      }

      /* ворота */
      for(var g=0;g<2;g++){
        var dir=(g===0?1:-1), gx=dir*GOAL_X;
        var sg=crossAt(px0,puck.x,gx,dir);
        var czg=sg<0?0:pz0+(puck.z-pz0)*sg, cyg=sg<0?9:py0+(puck.y-py0)*sg;
        if(sg>=0 && Math.abs(czg)<0.92 && cyg<1.2 && Math.hypot(puck.vx,puck.vz)>3){
          var gk=goalieOf(g===0?1:0);
          /* меряем от точки пересечения створа, а не от той, куда шайба уже улетела */
          var saveDist=gk?Math.hypot(gk.x-(gx-dir*0.1),gk.z-czg):99;
          var otShot=!!(LASTSHOT && LASTSHOT.ot && SIMT-LASTSHOT.t<2.5);
          if(saveDist<1.15 && R()<(otShot?SHOT_CFG.otSave:0.55)){
            puck.x=gx-dir*0.35; puck.z=czg; puck.y=Math.max(0.05,cyg);
            /* высокий — в ловушку, низовой — иногда фиксирует; соперник у пятака — отбивает. Отскок — вбок, от ворот */
            var hold = !gkFoeNear(gk, GK_CFG.coverFoe) && (cyg>GK_CFG.catchHigh || R()<GK_CFG.catchLow);
            if(!hold){
              var side = Math.abs(czg)>0.15 ? Math.sign(czg) : (R()<0.5?-1:1);
              puck.vx=-puck.vx*0.3; puck.vz=side*rnd(GK_CFG.reboundZ[0],GK_CFG.reboundZ[1]); puck.vy=0; puck.free=0.2;
            }
            /* шайба шла в створ — это бросок в створ, даже если её не бросали, а отдавали пасом */
            var lineShot = !!(LASTSHOT && LASTSHOT.p.team!==gk.team && SIMT-LASTSHOT.t<2.5);
            LASTSHOT=null;             /* один бросок — не больше одного сейва */
            LASTSAVE={t:gk.team, time:SIMT};
            emit('save',{g:pIdx(gk), t:gk.team, by:lastTouch?pIdx(lastTouch):-1, kind:'line', shot:1, noShot:lineShot?0:1,
                         y:r2(cyg), z:r2(czg-gk.z), hold:hold?1:0});
            if(hold) gkTake(gk);
          } else {
            var scorer = (g===0)?0:1;
            score[scorer]++;
            goalEvent(scorer, czg);
            fx.score();
            /* гол в большинстве — малый штраф соперника кончается досрочно */
            if(onIce(scorer).length>onIce(1-scorer).length) clearOnePenalty(1-scorer);
            puck.vx=0;puck.vz=0;puck.vy=0;
            state='goal'; stateT=1.5;
            return 1;
          }
        }
      }
      /* подбор. Шайба достаётся тому, кто к ней ближе (в долях своей досягаемости).
         Раньше её брал первый подходящий в порядке players[], а команда 0 идёт
         первой — в спорных ситуациях она выигрывала всегда (в сети это хост). */
      if(puck.free<=0 && puck.y<PLAYER_CFG.pickupHeight && Math.hypot(puck.vx,puck.vz)<PLAYER_CFG.pickupMaxSpeed){
        var pick=null, pickK=1;
        for(var i=0;i<players.length;i++){
          var p=players[i];
          if(p.down>0||p.boxed) continue;
          var k;
          if(p.goalie) k=Math.hypot(p.x-puck.x,p.z-puck.z)/PLAYER_CFG.pickupReachGoalie;   /* вратарь: по телу */
          else k=Math.hypot(p.x+Math.cos(p.yaw)*0.95-puck.x, p.z+Math.sin(p.yaw)*0.95-puck.z)/
                 /* полевой: по концу клюшки; адресат паса в разрез тянется за шайбой дальше — приём на ход */
                 ((LASTPASS && LASTPASS.lead && LASTPASS.to===p && SIMT-LASTPASS.t<1.6) ? PLAYER_CFG.leadReach : PLAYER_CFG.pickupReachSkater);
          if(!p.goalie && recvOf(p)) k=Math.min(k, Math.hypot(p.x-puck.x,p.z-puck.z)/PLAYER_CFG.recvBody);
          /* ничья (например, на вбрасывании концы клюшек ровно на одинаковом
             расстоянии) решается случаем, а не порядком в массиве */
          k+=R()*0.03;
          if(k<pickK){ pickK=k; pick=p; }
        }
        if(pick && pick.goalie){
          var p=pick;
          /* сейвом считаем, только если это чужой бросок, а не любая шайба у вратаря */
          var fromShot = !!(LASTSHOT && LASTSHOT.p.team!==p.team && SIMT-LASTSHOT.t<2.5);
          /* соперник рядом — вратарь накрывает шайбу: свисток, вбрасывание в его зоне */
          var cover=false, foes2=teamOf(1-p.team);
          for(var fi=0;fi<foes2.length;fi++) if(foes2[fi].down<=0 && Math.hypot(foes2[fi].x-p.x,foes2[fi].z-p.z)<FACE_CFG.coverPress){ cover=true; break; }
          icing.armed=false;
          if(fromShot){ LASTSHOT=null; LASTSAVE={t:p.team, time:SIMT}; }
          if(cover){
            puck.vx=0; puck.vz=0; puck.vy=0; puck.free=0.3;
            emit('save',{g:pIdx(p), t:p.team, by:lastTouch?pIdx(lastTouch):-1, kind:'body', shot:fromShot?1:0, cover:1});
            whistle('cover', -attackDir(p.team)*20, puck.z>0?7:-7, p.team); return 2;
          }
          /* соперника рядом нет — вратарь берёт шайбу (раньше отбивал наугад): пас, бросок или накроет */
          emit('save',{g:pIdx(p), t:p.team, by:lastTouch?pIdx(lastTouch):-1, kind:'body', shot:fromShot?1:0, cover:0, hold:1});
          gkTake(p);
        } else if(pick){
          var prevT=lastTouch;
          puck.owner=pick; lastTouch=pick; icing.armed=false;
          /* шайба у партнёра живого игрока — управление к нему сразу, а не со следующего шага: иначе в этот
             шаг за человека решал ИИ (бросал в одно касание после паса в разрез) */
          if(CFG.hum[pick.team] && !HS[pick.team].goalieCtl) HS[pick.team].ctrl=pick;
          pickupEvent(pick, prevT);
        }
      }
    }

    /* адресат паса в разрез у живого владельца (он клонится в рывок; подсказка в index.html) — раз в 0.2 с */
    for(var th0=0;th0<2;th0++){
      var hs0=HS[th0], ow=puck.owner;
      if(CFG.hum[th0] && ow && ow===hs0.ctrl && ow.team===th0){
        if(!(hs0.thruT>SIMT)){ var tm0=thruMate(ow, aimDir(ow)); hs0.thruM=tm0?tm0.m:null; hs0.thruT=SIMT+0.2; }
      } else { hs0.thruM=null; hs0.thruT=0; }
    }

    /* --- игроки ---
       Порядок обхода чередуется каждый кадр. При постоянном порядке команда 0
       (первая в players[]) в спорный кадр всегда действовала раньше: её защитник
       успевал выбить шайбу до броска/паса владельца из команды 1, а её владелец —
       сыграть до того, как до него дотянутся. */
    SIMF=(SIMF+1)|0;
    for(var k0=0;k0<players.length;k0++){
      var k=(SIMF&1)?players.length-1-k0:k0;
      var p=players[k];
      if(p.boxed) continue;
      if(p.goalie){
        var hsg=HS[p.team];
        /* шайба у вратаря: соперник подъехал или держит слишком долго — накрывает; бот отдаёт пас */
        if(puck.owner===p && state==='play'){
          if(gkFoeNear(p, GK_CFG.coverFoe) || SIMT-p._hold>GK_CFG.holdMax){ gkCover(p); return 2; }
          if(!CFG.hum[p.team]){
            p._gkT-=dt;
            if(p._gkT<=0){
              var gm=gkPassPick(p);
              if(gm) doPass(p, 17, false, false, gm);
              else p._gkT=0.25;                 /* открытых нет — ждёт; не дождался — накроет */
            }
            p.vx=0; p.vz=0; p.spd=0;
            continue;
          }
        }
        var gHuman = (p===hsg.ctrl && hsg.goalieCtl) && CFG.hum[p.team];
        if(gHuman && state==='play'){
          var gin=CFG.inp[p.team];
          var gw=toWorld(gin.mx,gin.mz,[0,0]);
          var gsp=gin.RT?8.2:6.2;
          p.vx=lerp(p.vx, gw[0]*gsp, Math.min(1,dt*9));
          p.vz=lerp(p.vz, gw[1]*gsp, Math.min(1,dt*9));
          p.x+=p.vx*dt; p.z+=p.vz*dt;
          var gx0=p.dir*GOAL_X;
          /* (была ещё строка clamp(p.x, gx0-dir*3.4, gx0+dir*0.35): при dir<0 границы
             шли в обратном порядке, и вратарь команды 0 под управлением прыгал
             между двумя точками. Правильные границы — строкой ниже) */
          p.x=p.dir>0?clamp(p.x,GOAL_X-3.4,GOAL_X+0.35):clamp(p.x,-GOAL_X-0.35,-GOAL_X+3.4);
          p.z=clamp(p.z,-3.0,3.0);
          p.spd=Math.hypot(p.vx,p.vz);
          /* Вратарь смотрит в поле, а не в свои ворота: его dir — это сторона,
             которую он защищает, значит лицом он в противоположную. */
          p.yaw=p.dir>0?Math.PI:0;
        } else goalieLogic(p,dt);
        continue;
      }
      if(p.down>0){
        p.down-=dt;
        p.x+=p.vx*dt; p.z+=p.vz*dt; p.vx*=0.90; p.vz*=0.90;
        p.x=clamp(p.x,-RL+1,RL-1); p.z=clamp(p.z,-RW+1,RW-1);
        continue;
      }
      var ax=0,az=0,maxs=PLAYER_CFG.maxSpeed,accel=PLAYER_CFG.accel;
      var hsp = HS[p.team], humanP = (p===hsp.ctrl) && CFG.hum[p.team];
      if(humanP && state==='play'){
        var inp2 = CFG.inp[p.team];
        var mi=humanMoveIntent(p, hsp, inp2);
        ax=mi[0]; az=mi[1]; maxs=mi[2]; accel=mi[3];
      } else {
        var tx,tz;
        var carrier = puck.owner;
        var att = carrier && carrier.team===p.team;
        /* свой пас в полёте: команда по-прежнему в атаке и открывается под адресата, а не откатывается в оборону */
        var passTo = (!carrier && LASTPASS && LASTPASS.to && LASTPASS.from.team===p.team && SIMT-LASTPASS.t<1.6) ? LASTPASS.to : null;
        var chaser = nearestOf(p.team, carrier?carrier.x:puck.x, carrier?carrier.z:puck.z);
        if(CFG.hum[p.team] && p===HS[p.team].ctrl){ ax=0; az=0; }
        var gx = p.dir*GOAL_X, ownGx = -p.dir*GOAL_X;
        var foes = teamOf(p.team===0?1:0);
        var supp=false, runner=false;

        /* ---------- позиционная игра ----------
           Роли: 0 левый крайний, 1 центр, 2 правый крайний, 3 и 4 защитники.
           Раньше все, кроме владельца, шли к шайбе или «держали» случайного
           соперника — отсюда и куча вокруг шайбы. Теперь у каждого своя зона,
           защитники не лезут в чужой угол, а крайние открываются в свободной
           полосе. В конце все цели разводятся друг от друга. */
        var IS_D = (p.role>=3);
        var LANE = IS_D ? (p.role===3?-5.2:5.2) : (p.role===0?-7.6:(p.role===2?7.6:0));
        var TC=TACTIC[p.team];
        var blueOwn = -p.dir*BLUE_X, blueOpp = p.dir*BLUE_X;

        if(carrier===p){
          var near=null, nd=1e9, f1;
          for(f1=0;f1<foes.length;f1++){
            var dq=Math.hypot(foes[f1].x-p.x,foes[f1].z-p.z);
            if(dq<nd){nd=dq;near=foes[f1];}
          }
          tx = gx - p.dir*3.0;
          tz = clamp(p.z*0.55, -8, 8);
          /* защитник с шайбой не идёт на ворота сам — доводит до синей и ищет пас */
          /* с направлением: у команды 1 (атака в −x) прежний clamp(tx,-RL+3,blueOpp-dir*0.5)
             не останавливал защитника у синей, а гнал его к чужим воротам */
          if(IS_D) tx = (p.dir>0) ? Math.min(tx, blueOpp-0.5) : Math.max(tx, blueOpp+0.5);
          if(near && nd<3.6){
            var ex=p.x-near.x, ez=p.z-near.z, eL=Math.hypot(ex,ez)||1;
            tx += ex/eL*2.6; tz += ez/eL*5.2;
          }
        }
        else if(att || (passTo && passTo!==p)){
          /* СВОЯ АТАКА: открываемся (supportSpot — игра без шайбы) */
          var spt=supportSpot(p, carrier||passTo); tx=spt[0]; tz=spt[1]; supp=true;
        }
        else if(chaser===p){
          /* единственный, кто идёт на шайбу, — с упреждением */
          var tgt = carrier || puck;
          tx = tgt.x + (carrier? carrier.vx*0.28 : 0);
          tz = tgt.z + (carrier? carrier.vz*0.28 : 0);
        }
        else {
          /* ОБОРОНА: между шайбой и своими воротами, каждый на своём месте */
          var pz=puck.z, px=puck.x;
          var deep = ((px - blueOwn)*p.dir < 0);        /* шайба в нашей зоне */
          if(IS_D){
            if(deep){
              /* один закрывает пятак перед воротами, второй — ближний угол */
              var slot = (Math.abs(pz)<3.5);
              if((p.role===3) === (pz<0) || slot){
                tx = ownGx + p.dir*2.4;                  /* пятак */
                tz = clamp(pz*0.35, -2.2, 2.2);
              } else {
                tx = ownGx + p.dir*3.6;
                tz = clamp(pz*0.9, -RW+3, RW-3);
              }
            } else {
              /* шайба выше — отходим к своей синей и держим ширину */
              /* границы по порядку для обеих сторон: у команды 1 прежний
                 clamp(v, ownGx+dir*2.5, blueOwn) шёл с min > max, и её защитники
                 всегда стояли у своих ворот вместо синей линии */
              tx = clampR(px - p.dir*6.5, ownGx + p.dir*2.5, blueOwn);
              tz = clamp(LANE*0.8 + pz*0.25, -RW+2.5, RW-2.5);
            }
            if(TC===1) tx = clamp(tx + p.dir*3.2, -RL+3, RL-3);   /* атака: выше */
          } else {
            /* нападающие перекрывают выход из зоны и точки на синей */
            var back = (TC===1? 1.4 : (TC===2? 6.5 : 4.0));
            tx = clamp(px - p.dir*back, -RL+3, RL-3);
            tz = clamp(LANE*0.75 + pz*0.35, -RW+2.5, RW-2.5);
            if(deep){
              /* в своей зоне центр помогает у ворот, крайние стерегут точки */
              if(p.role===1){ tx = ownGx + p.dir*5.0; tz = clamp(pz*0.5,-3,3); }
              else          { tx = clamp(blueOwn - p.dir*0.5, -RL+3, RL-3); tz = LANE*0.9; }
            }
          }
        }

        /* Разведение: если цель совпала с целью более приоритетного партнёра,
           отходим в сторону. Это и есть страховка от толпы вокруг шайбы. */
        if(carrier!==p && chaser!==p && !supp){
          if(carrier && carrier.team===p.team){
            var cx=tx-carrier.x, cz=tz-carrier.z, cL=Math.hypot(cx,cz);
            if(cL<5.0){
              if(cL<0.001){ cx=p.dir; cz=1; cL=1; }
              tx+=cx/cL*(5.0-cL); tz+=cz/cL*(5.0-cL);
            }
          }
          var mates=teamOf(p.team);
          for(var mi=0;mi<mates.length;mi++){
            var m=mates[mi];
            if(m===p || m.goalie) continue;
            if(m.role>p.role) continue;                 /* уступает младший по роли */
            var sx=tx-(m._tx===undefined?m.x:m._tx), sz=tz-(m._tz===undefined?m.z:m._tz);
            var sL=Math.hypot(sx,sz);
            if(sL<5.2){
              if(sL<0.001){ sx=(p.role%2?1:-1); sz=1; sL=1; }
              tx += sx/sL*(5.2-sL)*0.9;
              tz += sz/sL*(5.2-sL)*0.9;
            }
          }
          tx=clamp(tx,-RL+3,RL-3); tz=clamp(tz,-RW+2.5,RW-2.5);
        }
        /* адресат паса идёт навстречу шайбе, а не ждёт её на месте */
        var LVp=aiLevel(p.team);
        if(!carrier && LASTPASS && LASTPASS.to===p && LASTPASS.from.team===p.team && SIMT-LASTPASS.t<RECV_CFG.run && LVp.meet>0){
          if(LASTPASS.lead){
            /* пас в разрез: рывок в точку встречи; успевает перехватить раньше — туда. Шайба уже прошла точку встречи
               (расчёт разошёлся) — вдогонку за ней, а не стоять в точке */
            var ip=interceptPt(p), past=(LASTPASS.x-puck.x)*puck.vx+(LASTPASS.z-puck.z)*puck.vz<0;
            tx=ip?ip[0]:(past?puck.x+puck.vx*0.5:LASTPASS.x); tz=ip?ip[1]:(past?puck.z+puck.vz*0.5:LASTPASS.z); runner=true;
            /* шайба ещё не в зоне — у синей ждём её, иначе офсайд */
            if(puck.x*p.dir<BLUE_X && tx*p.dir>BLUE_X-0.4 && p.x*p.dir<BLUE_X) tx=Math.min(tx*p.dir, Math.max(p.x*p.dir, BLUE_X-0.4))*p.dir;
          } else { tx=lerp(tx, puck.x+puck.vx*0.22, LVp.meet); tz=lerp(tz, puck.z+puck.vz*0.22, LVp.meet); }
        }
        /* добивание: после броска партнёра нападающие без шайбы едут на пятак */
        else if(LVp.crash && !IS_D && carrier!==p && LASTSHOT && LASTSHOT.p.team===p.team && LASTSHOT.p!==p &&
                SIMT-LASTSHOT.t<1.8 && (!carrier || carrier.team!==p.team)){
          tx = gx - p.dir*2.0; tz = (p.role===0?-1.6:(p.role===2?1.6:0));
        }
        p._tx=tx; p._tz=tz;
        /* отложенный офсайд: нарушитель немедленно выкатывается за синюю линию */
        if(p.os){
          tx = p.dir*(BLUE_X-1.8);
          tz = clamp(p.z, -RW+2.5, RW-2.5);
        } else if(offWarn===p.team && carrier===p){
          /* владелец шайбы отводит её назад, чтобы снять офсайд */
          tx = p.dir*(BLUE_X-2.2);
          tz = clamp(p.z, -RW+2.5, RW-2.5);
        }

        var dx=tx-p.x, dz=tz-p.z, L=Math.hypot(dx,dz)||1;
        ax=dx/L; az=dz/L;
        if(L<1.2){ax*=L;az*=L;}
        maxs = att?PLAYER_CFG.aiAttackMaxSpeed:PLAYER_CFG.aiBaseMaxSpeed;
        if(chaser===p && !att) maxs=PLAYER_CFG.aiChaseMaxSpeed;
        if(runner){ maxs=PLAYER_CFG.sprintMaxSpeed; accel=PLAYER_CFG.sprintAccel; }   /* рывок — как ускорение живого */
        /* открывание: до своей точки далеко — догоняет атаку ускорением, а не трусцой */
        if(supp && Math.hypot(tx-p.x, tz-p.z)>4){ maxs=PLAYER_CFG.sprintMaxSpeed; accel=PLAYER_CFG.sprintAccel; }
        if(TACTIC[p.team]===1) maxs+=PLAYER_CFG.aiTacticAttackBonus;
        if(p.os) maxs=PLAYER_CFG.aiOffsidesMaxSpeed;

        p._cd=(p._cd||0)-dt;
        if(carrier===p){
          aiCarrier(p, dt, foes);
        }
        else if(carrier && carrier.team!==p.team && p._cd<=0){
          var dc=Math.hypot(carrier.x-p.x,carrier.z-p.z);
          if(dc<1.5){
            p._cd=0.55;
            if(hookCall(p,carrier)){ penalize(p,'trip'); continue; }
            if(R()<0.55){
              puck.owner=null; puck.free=0.3;
              var aa=Math.atan2(puck.z-p.z,puck.x-p.x);
              puck.vx=Math.cos(aa)*6.5; puck.vz=Math.sin(aa)*6.5;
              lastTouch=p;
              emit('poke',{p:pIdx(p), t:p.team, from:pIdx(carrier)});
            }
          } else if(dc<1.9 && p.spd>5.0 && R()<0.30){
            p._cd=1.2;
            var callH=hitCall(p,carrier,true);
            carrier.down=1.3;
            var ab=Math.atan2(carrier.z-p.z,carrier.x-p.x);
            carrier.vx=Math.cos(ab)*8; carrier.vz=Math.sin(ab)*8;
            puck.owner=null; puck.free=0.4;
            puck.vx=Math.cos(ab)*5; puck.vz=Math.sin(ab)*5;
            lastTouch=p;
            emit('hit',{p:pIdx(p), t:p.team, v:pIdx(carrier), vt:carrier.team, clean:!callH, x:r2(carrier.x), z:r2(carrier.z), hard:0});
            if(callH){ penalize(p,callH.reason,callH.major); continue; }
          }
        }
      }
      humanMoveIntegrate(p, ax, az, maxs, accel, dt);
      var sp=p.spd;
      if(sp>5.6&&R()<0.32*sprayK()) fx.spray(p);
      for(var q=0;q<players.length;q++){
        if(q===k) continue;
        var o2=players[q];
        /* удалённый игрок не рисуется — и толкаться им нельзя: он оставался
           невидимой стенкой ровно там, где схватил штраф */
        if(o2.boxed) continue;
        var ox=p.x-o2.x, oz=p.z-o2.z, od=Math.hypot(ox,oz);
        if(od>0.01&&od<1.2){ p.x+=ox/od*(1.2-od)*0.5; p.z+=oz/od*(1.2-od)*0.5; }
      }
    }

    /* камера и брызги — у клиента, после шага (step вернул 2) */
    return 2;
  }

  var api={
    step:sim,
    setControl:function(c){ for(var k in c) if(c[k]!==undefined) CFG[k]=c[k]; },
    control:CFG,
    RL:RL, RW:RW, GOAL_X:GOAL_X, BLUE_X:BLUE_X, CORNER:CORNER, halfWidthAt:halfWidthAt,
    rnd:rnd, clamp:clamp, lerp:lerp, r2:r2
  };
  api.mkHS=mkHS;
  api.attackDir=attackDir;
  api.zoneOf=zoneOf;
  api.onIce=onIce;
  api.makeTeam=makeTeam;
  api.reset=reset;
  api.teamOf=teamOf;
  api.nearestOf=nearestOf;
  api.goalieOf=goalieOf;
  api.placeFaceoff=placeFaceoff;
  api.whistle=whistle;
  api.penalize=penalize;
  api.penaltyLeft=penaltyLeft;
  api.penaltyShow=penaltyShow;
  api.netTail=netTail;
  api.PEN_CFG=PEN_CFG;
  api.FACE_CFG=FACE_CFG;
  api.SHOT_CFG=SHOT_CFG;
  api.RECV_CFG=RECV_CFG;
  api.FO=FO;
  api.clearOnePenalty=clearOnePenalty;
  api.aimInput=aimInput;
  api.aimDir=aimDir;
  api.bestMate=bestMate;
  api.openMate=openMate;
  api.thruMate=thruMate;
  api.thruPoint=thruPoint;
  api.passTargets=passTargets;
  api.supportSpot=supportSpot;
  api.pIdx=pIdx;
  api.pickupEvent=pickupEvent;
  api.goalEvent=goalEvent;
  api.passAim=passAim;
  api.shotAim=shotAim;
  api.doPass=doPass;
  api.doShot=doShot;
  api.doPoke=doPoke;
  api.doCheck=doCheck;
  api.switchPlayer=switchPlayer;
  api.aiLevel=aiLevel;
  api.clampR=clampR;
  api.segDist=segDist;
  api.laneBlock=laneBlock;
  api.nearestFoe=nearestFoe;
  api.shotQuality=shotQuality;
  api.aiCarrier=aiCarrier;
  api.aiShoot=aiShoot;
  api.aiPassPick=aiPassPick;
  api.humanTick=humanTick;
  api.goalieLogic=goalieLogic;
  api.crossAt=crossAt;
  api.humanMoveIntent=humanMoveIntent;
  api.humanMoveIntegrate=humanMoveIntegrate;
  api.stickEnd=stickEnd;
  api.PLAYER_CFG=PLAYER_CFG;
  api.TURN_RATE=TURN_RATE;
  api.LANEZ=LANEZ;
  api.DEPTH=DEPTH;
  api.NAMES=NAMES;
  api.FACE_OFFS=FACE_OFFS;
  api.AI_LV=AI_LV;
  api.NOIN=NOIN;
  api.NOEDGE=NOEDGE;
  api.passN=passN;
  /* живое состояние матча: чтение и запись идут прямо в переменные симуляции */
  Object.defineProperties(api, {
    players:{enumerable:true, get:function(){ return players; }, set:function(v){ players=v; }},
    puck:{enumerable:true, get:function(){ return puck; }, set:function(v){ puck=v; }},
    score:{enumerable:true, get:function(){ return score; }, set:function(v){ score=v; }},
    period:{enumerable:true, get:function(){ return period; }, set:function(v){ period=v; }},
    clock:{enumerable:true, get:function(){ return clock; }, set:function(v){ clock=v; }},
    state:{enumerable:true, get:function(){ return state; }, set:function(v){ state=v; }},
    stateT:{enumerable:true, get:function(){ return stateT; }, set:function(v){ stateT=v; }},
    HS:{enumerable:true, get:function(){ return HS; }, set:function(v){ HS=v; }},
    checkT:{enumerable:true, get:function(){ return checkT; }, set:function(v){ checkT=v; }},
    pokeT:{enumerable:true, get:function(){ return pokeT; }, set:function(v){ pokeT=v; }},
    pen:{enumerable:true, get:function(){ return pen; }, set:function(v){ pen=v; }},
    matchLen:{enumerable:true, get:function(){ return matchLen; }, set:function(v){ matchLen=v; }},
    offWarn:{enumerable:true, get:function(){ return offWarn; }, set:function(v){ offWarn=v; }},
    lastTouch:{enumerable:true, get:function(){ return lastTouch; }, set:function(v){ lastTouch=v; }},
    prevZone:{enumerable:true, get:function(){ return prevZone; }, set:function(v){ prevZone=v; }},
    TACTIC:{enumerable:true, get:function(){ return TACTIC; }, set:function(v){ TACTIC=v; }},
    gkRush:{enumerable:true, get:function(){ return gkRush; }, set:function(v){ gkRush=v; }},
    offT:{enumerable:true, get:function(){ return offT; }, set:function(v){ offT=v; }},
    icing:{enumerable:true, get:function(){ return icing; }, set:function(v){ icing=v; }},
    SIMT:{enumerable:true, get:function(){ return SIMT; }, set:function(v){ SIMT=v; }},
    SIMF:{enumerable:true, get:function(){ return SIMF; }, set:function(v){ SIMF=v; }},
    LASTPASS:{enumerable:true, get:function(){ return LASTPASS; }, set:function(v){ LASTPASS=v; }},
    LASTRECV:{enumerable:true, get:function(){ return LASTRECV; }, set:function(v){ LASTRECV=v; }},
    LASTSHOT:{enumerable:true, get:function(){ return LASTSHOT; }, set:function(v){ LASTSHOT=v; }},
    LASTSAVE:{enumerable:true, get:function(){ return LASTSAVE; }, set:function(v){ LASTSAVE=v; }},
    DQ:{enumerable:true, get:function(){ return DQ; }}
  });
  return api;
}

G.BVRSim={create:create, RL:RL, RW:RW, GOAL_X:GOAL_X, BLUE_X:BLUE_X, CORNER:CORNER, halfWidthAt:halfWidthAt};
})(typeof globalThis!=='undefined' ? globalThis : this);
