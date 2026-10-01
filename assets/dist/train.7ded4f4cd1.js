/* BVR Hockey 26 — уроки тренировки (docs/MENU_PLAN.md, этап 5): расстановка, ход урока, 10 уроков и свободная
   тренировка, скрипт ввода для автотеста. Отдельный файл: публикуется как assets/dist/train.<хеш>.js (npm run assets)
   и грузится только при входе в «Тренировку» и на первом запуске (index.html, trainLoad). В index.html остались
   состояние (TRAIN, TPROG), медали, тексты, список уроков для меню (LESSONS: ключ, кнопка, пороги медалей), старт и итог.
   Код игры в index.html — одна функция, отсюда видно только то, что она передала в K, и свойства-посредники матча
   на window (players, puck, state, HS, …). Меняющиеся значения — геттеры K: K.HUMAN, K.F, K.cyw, K.syw, K.LANG;
   K.ctrl(p) — сменить управляемого игрока. */
window.BVRTrain=function(K){
'use strict';
var IN=K.IN, stick=K.stick, T=K.T, SFX=K.SFX, buzz=K.buzz, attackDir=K.attackDir, GOAL_X=K.GOAL_X, pt=K.pt,
    TRAIN=K.TRAIN, trainEnd=K.trainEnd, trainHud=K.trainHud, placeFaceoff=K.placeFaceoff, setTactic=K.setTactic;
/* ---------- расстановка ---------- */
function tAD(){ return attackDir(K.HUMAN); }
function tX(x){ return tAD()*x; }
function tYaw(back){ return (tAD()>0)!==!!back ? 0 : Math.PI; }
function tMine(){ return players.filter(function(p){ return p.team===K.HUMAN && !p.goalie; }); }
function tTheirs(){ return players.filter(function(p){ return p.team!==K.HUMAN && !p.goalie; }); }
function tGK(team){ for(var i=0;i<players.length;i++) if(players[i].goalie && players[i].team===team) return players[i]; return null; }
function tOff(p){ p.boxed=1; p.x=0; p.z=-90; p.vx=0; p.vz=0; p.down=0; }
function tOn(p, x, z, yaw){ p.boxed=0; p.down=0; p.os=0; p.x=x; p.z=z; p.vx=0; p.vz=0; p.spd=0; if(yaw!==undefined) p.yaw=yaw; }
/* оставить на льду: своих полевых n, чужих m, вратарей — по флагам; остальные — со льда */
function tStage(n, m, gkMine, gkTheirs){
  var a=tMine(), b=tTheirs(), i;
  for(i=0;i<a.length;i++) if(i>=n) tOff(a[i]);
  for(i=0;i<b.length;i++) if(i>=m) tOff(b[i]);
  var g0=tGK(K.HUMAN), g1=tGK(1-K.HUMAN);
  if(g0){ if(gkMine){ g0.boxed=0; g0.x=-tAD()*GOAL_X+tAD()*0.4; g0.z=0; } else tOff(g0); }
  if(g1){ if(gkTheirs){ g1.boxed=0; g1.x=tAD()*GOAL_X-tAD()*0.4; g1.z=0; } else tOff(g1); }
  return {mine:a.slice(0,n), theirs:b.slice(0,m)};
}
function tCtrl(p){ HS[K.HUMAN].ctrl=p; K.ctrl(p); }
function tGive(p){ puck.owner=p; puck.free=0; puck.vx=puck.vy=puck.vz=0; puck.y=0.05;
  puck.x=p.x+Math.cos(p.yaw)*0.95; puck.z=p.z+Math.sin(p.yaw)*0.95; lastTouch=p; LASTPASS=null; }
function tLoose(x, z, vx, vz){ puck.owner=null; puck.x=x; puck.z=z; puck.y=0.05; puck.vx=vx||0; puck.vz=vz||0; puck.vy=0; puck.free=0; }
/* шайба остаётся у принявшего (на клюшке, без владельца — его ИИ ею не сыграет), потом возвращается игроку */
function tHold(p){ puck.owner=null; puck.vx=puck.vy=puck.vz=0; puck.free=99; puck.x=p.x+Math.cos(p.yaw)*0.95; puck.z=p.z+Math.sin(p.yaw)*0.95; }
function tPin(p, x, z, o){ o=o||{}; var q={p:p, x:x, z:z, yaw:o.yaw, soft:!!o.soft, vx:o.vx||0, vz:o.vz||0}; TRAIN.pins.push(q); return q; }
function tPinsApply(dt){
  for(var i=0;i<TRAIN.pins.length;i++){
    var q=TRAIN.pins[i], p=q.p; if(p.boxed) continue;
    if(q.soft && p===HS[K.HUMAN].ctrl) continue;
    q.x+=q.vx*dt; q.z+=q.vz*dt;
    if(q.soft){ var k=Math.min(1,dt*3); p.x+=(q.x-p.x)*k; p.z+=(q.z-p.z)*k; } else { p.x=q.x; p.z=q.z; }
    p.vx=q.vx; p.vz=q.vz; p.spd=Math.hypot(q.vx,q.vz); p.down=0;
    if(q.yaw!==undefined) p.yaw=q.yaw; else if(p.spd>0.5) p.yaw=Math.atan2(q.vz,q.vx);
  }
}
function tFace(p, q){ return Math.atan2(q.z-p.z, q.x-p.x); }
/* где игрок со скоростью v встретит свободную шайбу (её трение не учитываем — на коротком отрезке мало) */
function tIntercept(p, v){
  var ox=puck.x-p.x, oz=puck.z-p.z, a=puck.vx*puck.vx+puck.vz*puck.vz-v*v, b=2*(ox*puck.vx+oz*puck.vz), c=ox*ox+oz*oz, t=-1;
  if(Math.abs(a)<1e-6) t = b<0 ? -c/b : -1;
  else { var d=b*b-4*a*c; if(d>=0){ var r=Math.sqrt(d), t1=(-b-r)/(2*a), t2=(-b+r)/(2*a); t=Math.min(t1,t2)>0?Math.min(t1,t2):Math.max(t1,t2); } }
  if(!(t>0) || t>2.5) return [puck.x, puck.z];
  return [puck.x+puck.vx*t, puck.z+puck.vz*t];
}

/* ---------- ход урока ---------- */
function tMsg(k, good){ TRAIN.msg=T(k); TRAIN.msgGood=!!good; TRAIN.msgT=1.6; if(good){ buzz(14,'soft'); SFX.swap(); } }
function tWin(){ TRAIN.n++; }
function trainTick(dt){
  var L=TRAIN.L; if(!L || TRAIN.res) return;
  /* гол / свисток: урок сам ставит новую попытку */
  if(state==='goal' || state==='face'){ state='play'; stateT=0; score[0]=0; score[1]=0; if(L.stop) L.stop(); }
  /* удаление (силовой против игрока без шайбы): без бокса, но попытка пропадает */
  if(pen.length){ for(var i=0;i<pen.length;i++) pen[i].p.boxed=0; pen.length=0; tMsg('tPen'); if(L.stop) L.stop(); }
  offWarn=-1; icing.armed=false; clock=99*60;
  TRAIN.t+=dt; if(TRAIN.msgT>0) TRAIN.msgT-=dt;
  tPinsApply(dt);
  if(L.tick) L.tick(dt);
  if(!TRAIN.res && L.limit && TRAIN.t>=L.limit) trainEnd(L.isDone ? L.isDone() : false);
  trainHud();
}

function tBotMove(wx, wz, mag){
  var Lw=Math.hypot(wx,wz); if(Lw<0.05){ stick.dx=0; stick.dz=0; return; }
  wx/=Lw; wz/=Lw; mag=mag===undefined?1:mag;
  stick.dx=(wx*K.cyw - wz*K.syw)*mag; stick.dz=(wx*K.syw + wz*K.cyw)*mag;
}
function tBotTap(k){ IN[k]=true; TRAIN.d.tap=k; TRAIN.d.tapT=0.07; }
function tBotRelease(dt){ if(TRAIN.d.tap){ TRAIN.d.tapT-=dt; if(TRAIN.d.tapT<=0){ IN[TRAIN.d.tap]=false; TRAIN.d.tap=null; } } }
function tDrawRing(c, x, z, r, col, w){
  c.strokeStyle=col; c.lineWidth=w||3; c.beginPath();
  for(var i=0;i<=24;i++){ var a=i/24*6.283, q=pt(x+Math.cos(a)*r, 0.03, z+Math.sin(a)*r); if(q[2]<1) return; if(i) c.lineTo(q[0],q[1]); else c.moveTo(q[0],q[1]); }
  c.stroke();
}
function tDrawCone(c, x, z, col){
  var a=pt(x,0,z), b=pt(x,1.1,z); if(a[2]<1) return;
  var w=Math.max(3, K.F/a[2]*0.28);
  c.fillStyle=col; c.beginPath(); c.moveTo(b[0],b[1]); c.lineTo(a[0]-w,a[1]); c.lineTo(a[0]+w,a[1]); c.closePath(); c.fill();
  c.strokeStyle='rgba(0,0,0,.35)'; c.lineWidth=1; c.stroke();
}
function tDrawTarget(c, z, col){
  var gx=tAD()*GOAL_X, q=pt(gx, 0.35, z); if(q[2]<1) return;
  var r=Math.max(5, K.F/q[2]*0.3);
  c.lineWidth=3; c.strokeStyle='#fff'; c.beginPath(); c.arc(q[0],q[1],r,0,6.283); c.stroke();
  c.fillStyle=col; c.beginPath(); c.arc(q[0],q[1],r*0.45,0,6.283); c.fill();
}


var LESSONS=[
/* 1. катание и ускорение: 6 ворот-флажков слаломом */
{key:'skate',
 setup:function(){ var s=tStage(1,0,false,false), me=s.mine[0], D=TRAIN.d;
   tOn(me, tX(-23), 0, tYaw()); tCtrl(me); tGive(me);
   D.g=0; D.gates=[]; for(var i=0;i<6;i++) D.gates.push({x:tX(-16+i*7), z:(i%2?-4:4)}); D.px=me.x; },
 isDone:function(){ return TRAIN.d.g>=6; },
 tick:function(dt){ var me=HS[K.HUMAN].ctrl, D=TRAIN.d, g=D.gates[D.g];
   if(g && (D.px-g.x)*(me.x-g.x)<=0 && D.px!==me.x){ if(Math.abs(me.z-g.z)<1.8){ D.g++; tMsg('tGate',true); if(D.g>=6) trainEnd(true); } else tMsg('tGateMiss'); }
   D.px=me.x;
   if(puck.owner!==me && !TRAIN.res){ D.lost=(D.lost||0)+dt; if(D.lost>1) { tGive(me); D.lost=0; } } else D.lost=0; },
 main:function(){ return TRAIN.d.g+' / 6'; },
 draw:function(c){ var D=TRAIN.d; D.gates.forEach(function(g,i){ var col=i<D.g?'#5ad07f':(i===D.g?'#ffd166':'#ff8a3d'); tDrawCone(c,g.x,g.z-1.8,col); tDrawCone(c,g.x,g.z+1.8,col); }); },
 bot:function(dt){ var me=HS[K.HUMAN].ctrl, D=TRAIN.d, g=D.gates[D.g]; if(!g) return; var ad=tAD(), ahead=(g.x-me.x)*ad;
   /* к воротам — через точку перед ними на их линии по ширине; проскочил мимо — назад к этой точке */
   if(ahead<0 || (ahead<3.2 && Math.abs(me.z-g.z)>1.1)) tBotMove(g.x-ad*3.6-me.x, g.z-me.z);
   else if(Math.abs(me.z-g.z)>1.1 && ahead>=3.2) tBotMove(g.x-ad*3.6-me.x, g.z-me.z);
   else tBotMove(g.x+ad*3-me.x, g.z-me.z);
   IN.RTb=true; }},

/* 2. пас: 5 точных пасов партнёрам в кругах */
{key:'pass',
 setup:function(){ var s=tStage(4,0,false,false), me=s.mine[0], D=TRAIN.d;
   tOn(me, tX(-6), 0, tYaw()); tCtrl(me); tGive(me); D.me=me; D.mates=[];
   [[6,-6],[10,0],[6,6]].forEach(function(xy,i){ var p=s.mine[i+1]; tOn(p, tX(xy[0]), xy[1]); p.yaw=tFace(p,me); tPin(p, p.x, p.z, {yaw:p.yaw}); D.mates.push(p); });
   D.passT=-1; D.ret=0; },
 isDone:function(){ return TRAIN.n>=5; },
 val:function(){ return TRAIN.t; },
 ev:function(n, e){ var D=TRAIN.d;
   if(n==='pass' && e.t===K.HUMAN) D.passT=TRAIN.t;
   if(n==='pass:recv' && e.t===K.HUMAN && players[e.p]!==D.me){ tWin(); tMsg('tNice',true); tHold(players[e.p]); D.ret=0.5; D.passT=-1; if(TRAIN.n>=5) trainEnd(true); } },
 tick:function(dt){ var D=TRAIN.d;
   if(D.ret>0){ D.ret-=dt; if(D.ret<=0){ tGive(D.me); tCtrl(D.me); } return; }
   if(D.passT>=0 && TRAIN.t-D.passT>2.2){ TRAIN.miss++; tMsg('tMiss'); D.passT=-1; tGive(D.me); tCtrl(D.me); } },
 main:function(){ return TRAIN.n+' / 5'; },
 draw:function(c){ TRAIN.d.mates.forEach(function(p){ tDrawRing(c,p.x,p.z,1.4,'#ffd166'); }); },
 bot:function(dt){ var D=TRAIN.d, me=D.me; tBotRelease(dt);
   if(puck.owner!==me || D.ret>0){ stick.dx=stick.dz=0; D.bt=0; return; }
   var tg=D.mates[TRAIN.n%3]; D.bt=(D.bt||0)+dt; tBotMove(tg.x-me.x, tg.z-me.z, 0.5);
   if(D.bt>0.3){ tBotTap('A'); D.bt=-0.6; } }},

/* 3. пас в разрез: партнёр уходит в отрыв, пас на ход */
{key:'lead',
 setup:function(){ var s=tStage(2,0,false,false), D=TRAIN.d; D.me=s.mine[0]; D.mate=s.mine[1]; this.next(); },
 next:function(){ var D=TRAIN.d; TRAIN.pins=[];
   /* пас на ход в симуляции — на 0.55 с хода партнёра и ещё 3.2 м вперёд: партнёр успевает, если пасующий дальше
      ~19 м от этой точки, а партнёр уже разогнался */
   tOn(D.me, tX(-14), -6, tYaw()); tCtrl(D.me); tGive(D.me);
   tOn(D.mate, tX(-9), 6, tYaw()); D.q=tPin(D.mate, D.mate.x, 6, {vx:tAD()*9}); D.at=0; D.over=0; D.lead=false; D.flying=false; },
 isDone:function(){ return TRAIN.n>=4; },
 val:function(){ return TRAIN.tries; },
 stop:function(){ TRAIN.d.over=0.01; },
 ev:function(n, e){ var D=TRAIN.d; if(D.over) return;
   if(n==='pass' && e.t===K.HUMAN){ D.lead=!!e.lead; D.flying=true; }
   if(n==='pass:recv' && players[e.p]===D.mate){ tHold(D.mate); D.q.vx=0; D.q.vz=0; D.flying=false;
     if(D.lead){ tWin(); tMsg('tNice',true); } else tMsg('tNeedLead'); D.over=0.8; } },
 tick:function(dt){ var D=TRAIN.d; D.at+=dt;
   /* пас в пути: партнёр едет на точку встречи с шайбой (до 9.5 м/с — ускорение), как живой игрок */
   if(!D.over && D.flying && !puck.owner){ var it=tIntercept(D.mate, 9.5);
     var dx=it[0]-D.q.x, dz=it[1]-D.q.z, Lq=Math.hypot(dx,dz)||1, sp=Math.min(9.5, Lq/Math.max(dt,0.016));
     D.q.vx=dx/Lq*sp; D.q.vz=dz/Lq*sp; }
   if(!D.over && (D.mate.x-tX(22))*tAD()>0){ tMsg('tMiss'); D.over=0.6; }
   if(D.over){ D.over-=dt; if(D.over<=0){ TRAIN.tries++; if(TRAIN.n>=4) trainEnd(true); else if(TRAIN.tries>=8) trainEnd(false); else this.next(); } } },
 main:function(){ return TRAIN.n+' / 4 · '+T('tTries')+' '+(TRAIN.tries+1)+'/8'; },
 bot:function(dt){ var D=TRAIN.d; tBotRelease(dt); if(D.over || puck.owner!==D.me){ stick.dx=stick.dz=0; return; }
   tBotMove(D.mate.x+tAD()*4-D.me.x, D.mate.z-D.me.z, 0.45); if(D.at>0.55 && !D.sent){ tBotTap('Y'); D.sent=true; } if(D.at<0.1) D.sent=false; }},

/* 4. навес: шайба над клюшкой защитника */
{key:'lob',
 setup:function(){ var s=tStage(2,0,false,false), D=TRAIN.d; D.me=s.mine[0]; D.mate=s.mine[1]; this.next(); },
 next:function(){ var D=TRAIN.d; TRAIN.pins=[];
   tOn(D.me, tX(-7), 0, tYaw()); tCtrl(D.me); tGive(D.me);
   tOn(D.mate, tX(8), (TRAIN.tries%2?3:-3)); D.mate.yaw=tFace(D.mate, D.me); tPin(D.mate, D.mate.x, D.mate.z, {yaw:D.mate.yaw});
   D.over=0; D.lift=false; D.passT=-1; },
 isDone:function(){ return TRAIN.n>=3; },
 val:function(){ return TRAIN.tries; },
 stop:function(){ TRAIN.d.over=0.01; },
 ev:function(n, e){ var D=TRAIN.d; if(D.over) return;
   if(n==='pass' && e.t===K.HUMAN){ D.lift=!!e.lift; D.passT=TRAIN.t; }
   if(n==='pass:recv' && players[e.p]===D.mate){ tHold(D.mate); if(D.lift){ tWin(); tMsg('tNice',true); } else tMsg('tNeedLob'); D.over=0.8; } },
 tick:function(dt){ var D=TRAIN.d;
   if(!D.over && D.passT>=0 && TRAIN.t-D.passT>2.5){ tMsg('tMiss'); D.over=0.4; }
   if(D.over){ D.over-=dt; if(D.over<=0){ TRAIN.tries++; if(TRAIN.n>=3) trainEnd(true); else if(TRAIN.tries>=8) trainEnd(false); else this.next(); } } },
 main:function(){ return TRAIN.n+' / 3 · '+T('tTries')+' '+(TRAIN.tries+1)+'/8'; },
 draw:function(c){ tDrawRing(c, TRAIN.d.mate.x, TRAIN.d.mate.z, 1.4, '#ffd166'); },
 bot:function(dt){ var D=TRAIN.d; tBotRelease(dt); if(D.over || puck.owner!==D.me){ stick.dx=stick.dz=0; D.bt=0; return; }
   D.bt=(D.bt||0)+dt; tBotMove(D.mate.x-D.me.x, D.mate.z-D.me.z, 0.4); if(D.bt>0.3){ tBotTap('X'); D.bt=-2; } }},

/* 5. бросок с зарядом: мишени слева и справа в воротах, 8 шайб */
{key:'shot',
 cam:function(){ return [tX(24), 0]; },
 setup:function(){ var s=tStage(1,0,false,false), D=TRAIN.d; D.me=s.mine[0]; D.side=1; this.next(); },
 next:function(){ var D=TRAIN.d;
   tOn(D.me, tX(15), 0, tYaw()); tCtrl(D.me); tGive(D.me); D.tz=D.side*0.68; D.side=-D.side; D.shotT=-1; D.pow=0; D.over=0; D.bt=0;
   /* бросок сам целит в угол, открытый вратарём (shotAim): невидимого вратаря ставим с другой стороны — горящая
      мишень в открытом углу, стиком её надо «дожать» (без стика шайба уходит в 0.4 м от центра — мимо) */
   var g1=tGK(1-K.HUMAN); if(g1){ g1.boxed=1; g1.x=0; g1.z=D.tz>0?-90:90; } },
 isDone:function(){ return TRAIN.n>=3; },
 val:function(){ return TRAIN.n; },
 stop:function(){ var D=TRAIN.d; if(!D.over){ D.over=0.6; } },
 ev:function(n, e){ var D=TRAIN.d; if(D.over) return;
   if(n==='shot' && e.t===K.HUMAN){ D.shotT=TRAIN.t; D.pow=e.power; }
   if(n==='goal' && e.t===K.HUMAN){
     if(Math.abs(e.z-D.tz)<0.22 && D.pow>=0.45){ tWin(); tMsg('tHit',true); }
     else if(Math.abs(e.z-D.tz)<0.22) tMsg('tWeak'); else tMsg('tMiss');
     D.over=0.7; }
   if(n==='post'){ tMsg('tMiss'); D.over=0.7; } },
 tick:function(dt){ var D=TRAIN.d;
   if(!D.over && D.shotT>=0 && TRAIN.t-D.shotT>2.2){ tMsg('tMiss'); D.over=0.3; }
   if(!D.over && D.shotT<0 && puck.owner!==D.me){ D.lost=(D.lost||0)+dt; if(D.lost>1.5){ D.lost=0; tGive(D.me); } } else D.lost=0;
   if(D.over){ D.over-=dt; if(D.over<=0){ TRAIN.tries++; if(TRAIN.tries>=8) trainEnd(TRAIN.n>=3); else this.next(); } } },
 main:function(){ return TRAIN.n+' · '+T('tTries')+' '+Math.min(8,TRAIN.tries+1)+'/8'; },
 draw:function(c){ var D=TRAIN.d; tDrawTarget(c, D.tz, '#e8736f'); tDrawTarget(c, -D.tz, 'rgba(255,255,255,.25)'); },
 bot:function(dt){ var D=TRAIN.d; if(D.over || puck.owner!==D.me){ stick.dx=stick.dz=0; IN.B=false; return; }
   D.bt+=dt; tBotMove(tAD()*0.66, D.tz>0?0.75:-0.75, 0.35);
   if(D.bt>0.15 && D.bt<0.85) IN.B=true; else if(D.bt>=0.85){ IN.B=false; } }},

/* 6. отбор и силовой: соперник ведёт шайбу по кругу */
{key:'poke',
 setup:function(){ var s=tStage(1,1,false,false), D=TRAIN.d; D.me=s.mine[0]; D.foe=s.theirs[0];
   tOn(D.me, tX(-6), 0, tYaw()); tCtrl(D.me); D.a=0; this.next(); },
 next:function(){ var D=TRAIN.d; TRAIN.pins=[]; D.cx=tX(4); D.r=6; D.w=0.75;
   tOn(D.foe, D.cx+Math.cos(D.a)*D.r, Math.sin(D.a)*D.r); D.q=tPin(D.foe, D.foe.x, D.foe.z); tGive(D.foe); D.ret=0; },
 isDone:function(){ return TRAIN.n>=3; },
 stop:function(){ var D=TRAIN.d; if(!D.ret) D.ret=0.8; },
 tick:function(dt){ var D=TRAIN.d;
   if(D.ret>0){ D.ret-=dt; if(D.ret<=0){ if(TRAIN.n>=3) trainEnd(true); else this.next(); } return; }
   /* соперник катится по кругу (скорость ~4.5 м/с), шайба у него на клюшке */
   D.a+=D.w*dt; var nx=D.cx+Math.cos(D.a)*D.r, nz=Math.sin(D.a)*D.r;
   D.q.vx=(nx-D.q.x)/dt; D.q.vz=(nz-D.q.z)/dt; D.q.x=nx-D.q.vx*dt; D.q.z=nz-D.q.vz*dt;
   if(puck.owner===D.me){ tWin(); tMsg('tNice',true); tHold(D.me); D.q.vx=D.q.vz=0; D.ret=0.8; return; }
   if(puck.owner && puck.owner!==D.foe && puck.owner!==D.me) tGive(D.foe);
   if(!puck.owner && Math.hypot(puck.vx,puck.vz)<0.5 && Math.hypot(puck.x-D.me.x,puck.z-D.me.z)>8) tGive(D.foe); },
 main:function(){ return TRAIN.n+' / 3'; },
 bot:function(dt){ var D=TRAIN.d, me=D.me; tBotRelease(dt); if(D.ret>0){ stick.dx=stick.dz=0; return; }
   var tx=puck.x, tz=puck.z; tBotMove(tx-me.x, tz-me.z, 1); IN.RTb=true;
   D.bt=(D.bt||0)+dt; if(Math.hypot(tx-me.x,tz-me.z)<1.7 && D.bt>0.35){ tBotTap('B'); D.bt=0; } }},

/* 7. смена игрока: шайба катится к одному из партнёров — подбери её ближайшим */
{key:'switch',
 setup:function(){ var s=tStage(3,0,false,false), D=TRAIN.d; D.ps=s.mine; D.times=[]; D.home=[[-10,-6],[-10,6],[6,0]];
   D.home.forEach(function(xy,i){ var p=s.mine[i]; tOn(p, tX(xy[0]), xy[1], tYaw()); tPin(p, p.x, p.z, {soft:true}); });
   D.k=0; this.next(); },
 next:function(){ var D=TRAIN.d;
   for(var i=0;i<3;i++){ var q=TRAIN.pins[i]; q.x=tX(D.home[i][0]); q.z=D.home[i][1]; }
   var ti=(D.k*2+1)%3, tg=D.ps[ti]; D.k++;
   /* ведёт другой игрок: переключиться — часть задания */
   tCtrl(D.ps[(ti+1)%3]);
   /* шайба из центральной зоны (в 8–9 м от всех) катится к партнёру и останавливается за 3 м до него */
   var sx=tX(-2), sz=0, dx=tg.x-sx, dz=tg.z-sz, L=Math.hypot(dx,dz), dist=Math.max(1,L-3);
   /* трение шайбы 0.996 за шаг 1/60 с: путь до остановки ≈ 4.17·v0 */
   tLoose(sx, sz, dx/L*0.24*dist, dz/L*0.24*dist); puck.free=0.4;
   D.t0=TRAIN.t; D.ret=0; },
 isDone:function(){ return TRAIN.d.times.length>=5; },
 val:function(){ var a=TRAIN.d.times, s=0; for(var i=0;i<a.length;i++) s+=a[i]; return a.length?Math.round(s/a.length*10)/10:99; },
 stop:function(){ TRAIN.d.ret=0.5; },
 tick:function(dt){ var D=TRAIN.d;
   if(D.ret>0){ D.ret-=dt; if(D.ret<=0){ if(D.times.length>=5) trainEnd(true); else this.next(); } return; }
   if(puck.owner && puck.owner.team===K.HUMAN && puck.owner===HS[K.HUMAN].ctrl){ D.times.push(TRAIN.t-D.t0); tWin(); tMsg('tNice',true); tHold(puck.owner); D.ret=0.6; } },
 main:function(){ return TRAIN.d.times.length+' / 5'; },
 bot:function(dt){ var D=TRAIN.d, me=HS[K.HUMAN].ctrl; tBotRelease(dt); if(D.ret>0){ stick.dx=stick.dz=0; return; }
   var best=null, bd=1e9; D.ps.forEach(function(p){ var d=Math.hypot(p.x-puck.x,p.z-puck.z); if(d<bd){ bd=d; best=p; } });
   if(best!==me && !D.tap){ tBotTap('LB'); }
   /* к шайбе подводим крюк, а не корпус: подбор — от конца клюшки */
   var dx=puck.x-me.x, dz=puck.z-me.z, L=Math.hypot(dx,dz)||1;
   tBotMove(dx-dx/L*0.8, dz-dz/L*0.8, L>3?1:0.6); IN.RTb=L>3; }},

/* 8. выход вратаря: соперник один на один, держи Y */
{key:'goalie',
 setup:function(){ var s=tStage(1,1,true,false), D=TRAIN.d; D.me=s.mine[0]; D.foe=s.theirs[0]; D.gk=tGK(K.HUMAN);
   tOn(D.me, tX(12), 9, tYaw()); tCtrl(D.me); tPin(D.me, D.me.x, D.me.z); this.next(); },
 next:function(){ var D=TRAIN.d; tOn(D.foe, tX(-2), (TRAIN.tries%3-1)*4, tYaw(true)); tGive(D.foe);
   D.gk.x=-tAD()*GOAL_X+tAD()*0.4; D.gk.z=0; D.over=0; D.at=0; D.shotT=-1; },
 isDone:function(){ return TRAIN.n>=5; },
 val:function(){ return TRAIN.n; },
 stop:function(){ var D=TRAIN.d; if(!D.over){ D.over=0.7; } },
 /* атака отбита, если не было гола: сейв, штанга, мимо (через 1.2 с после броска) или вышло время */
 ev:function(n, e){ var D=TRAIN.d; if(D.over) return;
   if(n==='save' && e.t===K.HUMAN){ tWin(); tMsg('tSave',true); D.over=0.9; }
   if(n==='shot' && e.t!==K.HUMAN) D.shotT=D.at;
   if(n==='goal' && e.t!==K.HUMAN){ tMsg('tConceded'); D.over=0.9; } },
 tick:function(dt){ var D=TRAIN.d; D.at+=dt;
   if(!D.over && ((D.shotT>=0 && D.at-D.shotT>1.2) || D.at>9 || (puck.owner && puck.owner.team===K.HUMAN))){ tWin(); tMsg('tSave',true); D.over=0.7; }
   if(D.over){ D.over-=dt; if(D.over<=0){ TRAIN.tries++; if(TRAIN.tries>=8) trainEnd(TRAIN.n>=4); else this.next(); } } },
 main:function(){ return TRAIN.n+' · '+T('tTries')+' '+Math.min(8,TRAIN.tries+1)+'/8'; },
 bot:function(dt){ var D=TRAIN.d, o=puck.owner; IN.Y=!!(o && o===D.foe && Math.abs(o.x-(-tAD()*GOAL_X))<9.5); }},

/* 9. тактика: включай тактику, которую просит тренер */
{key:'tactic',
 setup:function(){ var D=TRAIN.d; D.k=0; D.times=[]; D.seq=[2,1,0]; D.wait=1.2; TACTIC[K.HUMAN]=0; D.ask=-1;
   var me=HS[K.HUMAN].ctrl||tMine()[0]; tCtrl(me); placeFaceoff(0,0); },
 isDone:function(){ return TRAIN.d.times.length>=3; },
 val:function(){ var a=TRAIN.d.times, m=0; for(var i=0;i<a.length;i++) m=Math.max(m,a[i]); return a.length?Math.round(m*10)/10:99; },
 stop:function(){ placeFaceoff(0,0); },
 tick:function(dt){ var D=TRAIN.d;
   if(D.ask<0){ D.wait-=dt; if(D.wait<=0){ D.ask=D.seq[D.k]; if(TACTIC[K.HUMAN]===D.ask) setTactic(K.HUMAN, (D.ask+1)%3); D.t0=TRAIN.t; } return; }
   if(TACTIC[K.HUMAN]===D.ask){ D.times.push(TRAIN.t-D.t0); tWin(); tMsg('tNice',true); D.k++; D.ask=-1; D.wait=1.5; if(D.k>=3) trainEnd(true); } },
 main:function(){ return TRAIN.d.times.length+' / 3'; },
 task:function(){ var D=TRAIN.d; return D.ask<0 ? null : T(['tq2','tq0','tq1'][D.ask]); },
 bot:function(dt){ var D=TRAIN.d; if(D.ask<0) return; D.bt=(D.bt||0)+dt; if(D.bt>0.6){ D.bt=0; setTactic(K.HUMAN, D.ask); } }},

/* 10. итог: атака 2 на 1 */
{key:'rush',
 cam:function(fx, fz){ return [fx*tAD()>8 ? fx+tAD()*4 : fx, fz]; },
 setup:function(){ var s=tStage(2,1,false,true), D=TRAIN.d; D.me=s.mine[0]; D.mate=s.mine[1]; D.def=s.theirs[0]; this.next(); },
 next:function(){ var D=TRAIN.d;
   tOn(D.me, tX(-2), -3, tYaw()); tOn(D.mate, tX(-3), 4, tYaw()); tOn(D.def, tX(13), 0, tYaw(true));
   var g1=tGK(1-K.HUMAN); if(g1){ g1.x=tAD()*GOAL_X-tAD()*0.4; g1.z=0; }
   tCtrl(D.me); tGive(D.me); D.over=0; D.at=0; D.bt=0; },
 isDone:function(){ return TRAIN.n>=1; },
 val:function(){ return TRAIN.n; },
 stop:function(){ var D=TRAIN.d; if(!D.over) D.over=0.6; },
 ev:function(n, e){ var D=TRAIN.d; if(D.over) return;
   if(n==='goal' && e.t===K.HUMAN){ tWin(); tMsg('tGoal',true); D.over=1.0; }
   if(n==='save' && e.t!==K.HUMAN){ tMsg('tSave2'); D.over=0.8; } },
 tick:function(dt){ var D=TRAIN.d; D.at+=dt;
   /* шайба у соперника (не у вратаря) — атака закончилась */
   if(!D.over && puck.owner && puck.owner.team!==K.HUMAN && !puck.owner.goalie){ tMsg('tLost'); D.over=0.8; }
   if(!D.over && D.at>12){ tMsg('tMiss'); D.over=0.4; }
   if(D.over){ D.over-=dt; if(D.over<=0){ TRAIN.tries++; if(TRAIN.tries>=5) trainEnd(TRAIN.n>=1); else this.next(); } } },
 main:function(){ return TRAIN.n+' · '+T('tTries')+' '+Math.min(5,TRAIN.tries+1)+'/5'; },
 /* бот: заход под углом (z ≈ ±4) и бросок в дальний угол; защитник впереди вплотную — пас партнёру */
 bot:function(dt){ var D=TRAIN.d, me=HS[K.HUMAN].ctrl, ad=tAD(); tBotRelease(dt); if(D.over){ stick.dx=stick.dz=0; IN.B=false; return; }
   if(puck.owner===me){ var gx=ad*GOAL_X, side=me.z>=0?1:-1, ahead=(D.def.x-me.x)*ad, near=ahead>0 && ahead<3 && Math.abs(D.def.z-me.z)<2;
     var mate=me===D.me?D.mate:D.me;
     if(near && D.bt===0){ tBotMove(mate.x-me.x, mate.z-me.z, 0.4); tBotTap('A'); return; }
     if((gx-me.x)*ad<10 && Math.abs(me.z)>2.2){ D.bt+=dt; tBotMove(ad*0.6, -side*0.8, 0.35); IN.B=D.bt<0.55; }
     else { D.bt=0; IN.B=false; tBotMove(gx-ad*9-me.x, side*4.2-me.z, 1); IN.RTb=true; } }
   else { D.bt=0; IN.B=false; IN.RTb=false; tBotMove(puck.x-me.x, puck.z-me.z, 1); } }},

/* свободная тренировка: лёд без соперников, шайба возвращается сама */
{key:'free',
 setup:function(){ var s=tStage(1,0,false,true), D=TRAIN.d; D.me=s.mine[0]; tOn(D.me, 0, 0, tYaw()); tCtrl(D.me); tGive(D.me); D.lost=0; },
 stop:function(){ tGive(TRAIN.d.me); },
 tick:function(dt){ var D=TRAIN.d; if(puck.owner===D.me){ D.lost=0; return; } D.lost+=dt;
   if(D.lost>3 || (puck.owner && puck.owner.goalie && D.lost>1)){ D.lost=0; tGive(D.me); } },
 main:function(){ return ''; }}
];

return {lessons:LESSONS, tick:trainTick, intercept:tIntercept};
};
