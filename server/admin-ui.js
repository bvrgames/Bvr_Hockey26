/**
 * BVR Hockey 26 — the developer's page (read only), docs/EVENTS.md «Страница разработчика».
 *
 * This file is NOT part of the game: the Worker serves it as text only to ADMIN_IDS (GET /v1/admin/ui.js, 403 to
 * everyone else), so a player's client never gets its code or its texts. The game runs it as
 *   new Function('K', text + '\nreturn BVRDev(K);')(K)
 * K — what the game lends it (index.html, «страница разработчика»):
 *   K.api(path) → Promise<json>   GET STATS_API + path with the signed initData (rejects with the HTTP status)
 *   K.sec                         the menu section of this screen (#start section[data-s=ext])
 *   K.head(title, extra)          the menu's header;   K.esc(text)  HTML escape;   K.rebuild()  build the screen again;
 *   K.refocus()                   put the menu focus back after a part of the screen was replaced
 * Returns { render() → html, act(name, el, ev), adj(name, el, d, ev), tabs(d), back() → handled }.
 * Markup: a tappable element — class mf + data-act="x" data-x="<name>"; an adjustable row — data-adj="x" data-x="<name>".
 * Russian only, landscape, the menu's look.
 */
function BVRDev(K) {
  var E = K.esc;
  var S = { tab: 0, ov: null, ovAt: 0, err: '', card: null, cd: null, tip: '',
    pl: { q: '', sort: 'seen', page: 0, data: null, t: 0 }, pay: { status: '', page: 0, data: null } };
  var TABS = ['Обзор', 'Игроки', 'Платежи'];
  var SORTS = [['seen', 'Последний вход'], ['matches', 'Матчи'], ['coins', 'Монеты'], ['stars', 'Звёзды'], ['bought', 'Куплено']];
  var PAYST = [['', 'Все'], ['paid', 'Оплачены'], ['pending', 'Ожидают'], ['refunded', 'Возвраты'], ['failed', 'Ошибка'], ['unmatched', 'Не опознаны']];
  // three series, checked for the dark menu surface (dataviz validate_palette: lightness band, CVD, contrast)
  var C = { ai: '#3f8cf5', server: '#b8821a', host: '#b05cc8', one: '#3f8cf5' };

  if (!document.getElementById('xdcss')) {
    var st = document.createElement('style'); st.id = 'xdcss';
    st.textContent = [
      '.xd{position:relative;height:100%;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;padding:8px 12px 14px;border-radius:14px;font:600 12px/1.3 system-ui,-apple-system,sans-serif;color:#e6eef8;' +
        'background:rgba(5,12,24,.93);border:1px solid rgba(143,216,255,.16);box-shadow:0 10px 30px rgba(0,0,0,.4)}',
      '.xd h4{margin:10px 0 5px;font:italic 800 15px/1 var(--msport);text-transform:uppercase;color:var(--mgold);letter-spacing:.02em}',
      '.xd h4:first-child{margin-top:2px}',
      '.xd-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}',
      '.xd-k{display:grid;grid-template-columns:repeat(auto-fill,minmax(74px,1fr));gap:4px}',
      '.xd-t{min-width:0;padding:4px 7px 5px;border-radius:8px;background:rgba(255,255,255,.07)}',
      '.xd-t b{display:block;font:italic 800 16px/1.05 var(--msport);color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.xd-t>span{display:block;margin-top:2px;font:700 8.5px/1.15 system-ui;letter-spacing:.05em;text-transform:uppercase;color:#9fb3c9}',
      '.xd-ch{padding:6px 8px 4px;border-radius:10px;background:rgba(255,255,255,.04)}',
      '.xd-ch svg{display:block;width:100%;height:auto}',
      '.xd-ch .cap{display:flex;justify-content:space-between;gap:8px;font:700 10px/1.2 system-ui;color:var(--mdim)}',
      '.xd-ch .tip{min-height:13px;font:700 10.5px/1.2 system-ui;color:#fff}',
      '.xd-lg{display:flex;flex-wrap:wrap;gap:10px;font:700 10px/1.2 system-ui;color:var(--mdim)}',
      '.xd-lg i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}',
      '.xd-hb{display:grid;grid-template-columns:78px minmax(0,1fr) 34px;align-items:center;gap:6px;margin:2px 0;font:700 11px/1 system-ui;color:var(--mdim)}',
      '.xd-hb i{display:block;height:9px;border-radius:0 3px 3px 0;background:' + C.one + '}',
      '.xd-hb b{color:#fff;text-align:right}',
      '.xd-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px}',
      '.xd-bar input{flex:0 1 220px;min-width:140px;padding:7px 10px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.35);color:#eef2f7;font:700 13px/1 system-ui;user-select:text;-webkit-user-select:text}',
      '.xd-c{padding:5px 8px;border-radius:8px;font:italic 800 11.5px/1 var(--msport);text-transform:uppercase;color:var(--mdim);background:rgba(255,255,255,.08);white-space:nowrap}',
      '.xd-c.cur{color:#241703;background:linear-gradient(180deg,var(--mgold),var(--mgold2))}',
      '.xd-c.on,.xd-r.on,.xd-pg .mf.on{outline:2px solid var(--mgold);outline-offset:1px}',
      '.xd-n{margin-left:auto;font:700 11px/1 system-ui;color:var(--mdim);white-space:nowrap}',
      '.xd-tb{display:flex;flex-direction:column;gap:1px;font:600 11px/1.25 system-ui}',
      '.xd-r{display:grid;align-items:center;gap:6px;padding:3px 6px;border-radius:7px;background:rgba(255,255,255,.045)}',
      '.xd-r.th{background:none;font:700 9px/1.1 system-ui;letter-spacing:.06em;text-transform:uppercase;color:#9fb3c9}',
      '.xd-r>*{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xd-r .nm b{color:#fff}.xd-r .nm i{display:block;font-style:normal;color:var(--mdim);font-size:10px}',
      '.xd-r .num{text-align:right;font-variant-numeric:tabular-nums}',
      '.xd-r .mono{font:600 10px/1.2 ui-monospace,Menlo,monospace;user-select:text;-webkit-user-select:text}',
      '.xd-s{display:inline-block;padding:2px 6px;border-radius:999px;font:700 9.5px/1.2 system-ui;background:rgba(255,255,255,.1)}',
      '.xd-s.ok{background:rgba(90,208,127,.18);color:#8de6a8}.xd-s.wait{background:rgba(143,216,255,.15);color:var(--mcyan)}',
      '.xd-s.bad{background:rgba(232,115,111,.2);color:#ffb4a8}',
      '.xd-pg{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:6px;font:700 12px/1 system-ui;color:var(--mdim)}',
      '.xd-pg .mf{padding:5px 12px;border-radius:8px;background:rgba(255,255,255,.08);color:var(--mgold);font:800 16px/1 system-ui}',
      '.xd-pg .mf.dis{opacity:.3}',
      '.xd-msg{padding:20px 4px;color:var(--mdim);font:700 13px/1.3 system-ui}',
      '.xd-msg.bad{color:#ffb4a8}',
      '.xd .neg{color:#ffb4a8}.xd .pos{color:#8de6a8}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ---------- formatting
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  function dt(t, noTime) {
    if (!t) return '—';
    var d = new Date(t * 1000), now = new Date();
    var s = pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + (d.getFullYear() !== now.getFullYear() ? '.' + String(d.getFullYear()).slice(2) : '');
    return noTime ? s : s + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(t) {
    if (!t) return '—';
    var s = Math.max(0, Date.now() / 1000 - t);
    return s < 3600 ? Math.max(1, Math.round(s / 60)) + ' мин' : s < 86400 ? Math.round(s / 3600) + ' ч' : s < 86400 * 45 ? Math.round(s / 86400) + ' дн' : dt(t, true);
  }
  var num = function (v) { v = +v || 0; return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };
  var pct = function (v) { return Math.round((+v || 0) * 100) + '%'; };
  var PLAT = { ios: 'iOS', android: 'Android', android_x: 'Android', macos: 'ПК', tdesktop: 'ПК', unigram: 'ПК', weba: 'Веб', webk: 'Веб', web: 'Веб' };
  var plat = function (p) { return p ? (PLAT[p] || p) : '—'; };
  function mode(m) { return m.mode === 'ai' ? 'с ИИ' : m.net === 'server' ? 'двое · сервер' : m.net === 'host' ? 'двое · хост' : 'двое'; }
  var RES = { win: 'победа', draw: 'ничья', loss: 'поражение', left: 'вышел' };
  var REASON = { match_ai: 'матч с ИИ', match_duo: 'матч вдвоём', stake: 'ставка', stake_win: 'ставка выиграна', stake_back: 'ставка вернулась',
    stars_buy: 'покупка звёзд', stars_refund: 'возврат звёзд', purchase: 'покупка', admin: 'вручную' };
  var OST = { pending: ['ожидает', 'wait'], paid: ['оплачен', 'ok'], refunded: ['возврат', 'bad'], failed: ['ошибка', 'bad'], unmatched: ['не опознан', 'bad'],
    locked: ['идёт', 'wait'], settled: ['рассчитана', 'ok'] };
  function badge(s) { var o = OST[s] || [s, '']; return '<span class="xd-s ' + o[1] + '">' + E(o[0]) + '</span>'; }
  function tile(v, k) { return '<div class="xd-t"><b>' + v + '</b><span>' + E(k) + '</span></div>'; }
  function chip(name, v, label, cur) { return '<span class="xd-c mf' + (cur ? ' cur' : '') + '" data-act="x" data-x="' + name + '" data-v="' + E(v) + '">' + E(label) + '</span>'; }
  function table(cols, head, rows) {
    var g = ' style="grid-template-columns:' + cols + '"';
    return '<div class="xd-tb"><div class="xd-r th"' + g + '>' + head.map(function (h) { return '<span' + (h[1] ? ' class="num"' : '') + '>' + E(h[0]) + '</span>'; }).join('') + '</div>' +
      rows.map(function (r) { return r.replace('@G', g); }).join('') + '</div>';
  }

  // ---------- charts: bars per UTC day (30), stacked for the match kinds; tap / hover a day → its numbers under the chart
  function days(d0, n) { var a = []; for (var i = 0; i < n; i++) a.push(dt((d0 + i) * 86400, true)); return a; }
  function bars(id, d0, series, title) {
    var n = series[0].v.length, W = 300, H = 64, gap = 2, bw = (W - gap * (n - 1)) / n, lab = days(d0, n);
    var tot = []; for (var i = 0; i < n; i++) { var s = 0; series.forEach(function (x) { s += x.v[i] || 0; }); tot.push(s); }
    var max = Math.max(1, Math.max.apply(null, tot));
    var g = '<line x1="0" y1="' + H + '" x2="' + W + '" y2="' + H + '" stroke="rgba(255,255,255,.25)" stroke-width="1"/>';
    for (i = 0; i < n; i++) {
      var x = i * (bw + gap), y = H, tip = lab[i] + ': ' + (series.length > 1 ? series.map(function (s) { return s.k + ' ' + (s.v[i] || 0); }).join(' · ') + ' · всего ' + tot[i] : tot[i]);
      series.forEach(function (s, k) {
        var h = (s.v[i] || 0) / max * (H - 4); if (h <= 0) return;
        var top = k === series.length - 1 || !series.slice(k + 1).some(function (z) { return z.v[i] > 0; });
        if (k > 0 && h > 1.5) { h -= 1; y -= 1; }    // a 1-unit surface gap between stacked segments
        var r = top ? Math.min(2, bw / 2, h) : 0;
        g += '<path d="M' + x.toFixed(2) + ' ' + y.toFixed(2) + 'V' + (y - h + r).toFixed(2) + (r ? 'Q' + x.toFixed(2) + ' ' + (y - h).toFixed(2) + ' ' + (x + r).toFixed(2) + ' ' + (y - h).toFixed(2) + 'H' + (x + bw - r).toFixed(2) + 'Q' + (x + bw).toFixed(2) + ' ' + (y - h).toFixed(2) + ' ' + (x + bw).toFixed(2) + ' ' + (y - h + r).toFixed(2) : 'H' + (x + bw).toFixed(2)) + 'V' + y.toFixed(2) + 'Z" fill="' + s.c + '"/>';
        y -= h;
      });
      // a hit target the full height of the chart, wider than the bar
      g += '<rect x="' + (x - gap / 2).toFixed(2) + '" y="0" width="' + (bw + gap).toFixed(2) + '" height="' + H + '" fill="transparent" data-tip="' + E(tip) + '" data-tipfor="' + id + '"><title>' + E(tip) + '</title></rect>';
    }
    var lg = series.length > 1 ? '<div class="xd-lg">' + series.map(function (s) { return '<span><i style="background:' + s.c + '"></i>' + E(s.k) + '</span>'; }).join('') + '</div>' : '';
    return '<div class="xd-ch"><div class="cap"><span>' + E(title) + '</span><span>макс. ' + max + ' в день</span></div>' + lg +
      '<svg viewBox="0 -2 ' + W + ' ' + (H + 2) + '" role="img" aria-label="' + E(title) + '">' + g + '</svg>' +
      '<div class="cap"><span>' + lab[0] + '</span><span class="tip" id="tip-' + id + '">' + (S.tip && S.tipFor === id ? E(S.tip) : 'коснись дня — числа') + '</span><span>' + lab[n - 1] + '</span></div></div>';
  }
  function hbars(rows) {
    var max = 1; rows.forEach(function (r) { max = Math.max(max, r[1]); });
    return rows.map(function (r) { return '<div class="xd-hb"><span>' + E(r[0]) + '</span><i style="width:' + Math.max(1, r[1] / max * 100).toFixed(1) + '%"></i><b>' + num(r[1]) + '</b></div>'; }).join('');
  }
  if (!K.sec._xd) {
    K.sec._xd = true;
    var tipOn = function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-tip]'); if (!t) return;
      S.tip = t.getAttribute('data-tip'); S.tipFor = t.getAttribute('data-tipfor');
      var el = document.getElementById('tip-' + S.tipFor); if (el) el.textContent = S.tip;
    };
    K.sec.addEventListener('click', tipOn); K.sec.addEventListener('mouseover', tipOn);
    // the search: typing narrows the list without rebuilding the field
    K.sec.addEventListener('input', function (ev) {
      if (ev.target.id !== 'xq') return;
      clearTimeout(S.pl.t);
      S.pl.t = setTimeout(function () { S.pl.q = ev.target.value.trim(); S.pl.page = 0; loadPlayers(); }, 350);
    });
  }

  // ---------- data
  function fail(e) { S.err = typeof e === 'number' ? 'Сервер ответил ' + e : 'Нет связи с сервером'; paint(); }
  function loadOverview(force) {
    if (S.ov && !force && Date.now() - S.ovAt < 60000) return;
    K.api('/v1/admin/overview').then(function (j) { S.ov = j; S.ovAt = Date.now(); S.err = ''; paint(); }, fail);
  }
  function loadPlayers() {
    var p = S.pl;
    K.api('/v1/admin/players?q=' + encodeURIComponent(p.q) + '&sort=' + p.sort + '&page=' + p.page)
      .then(function (j) { p.data = j; S.err = ''; paintList(); }, fail);
  }
  function loadCard(id) {
    S.card = id; S.cd = null; K.rebuild();
    K.api('/v1/admin/player?id=' + id).then(function (j) { if (S.card === id) { S.cd = j; S.err = ''; K.rebuild(); } }, fail);
  }
  function loadPay() {
    var p = S.pay;
    K.api('/v1/admin/payments?status=' + p.status + '&page=' + p.page).then(function (j) { p.data = j; S.err = ''; paint(); }, fail);
  }
  // what the visible tab lacks (a render never fetches what it already has: no request loops)
  function load() { if (S.card) return; if (S.tab === 0) loadOverview(); else if (S.tab === 1) { if (!S.pl.data) loadPlayers(); } else if (!S.pay.data) loadPay(); }
  function paint() { K.rebuild(); }
  function paintList() {
    var el = document.getElementById('xdl');
    if (el && S.tab === 1 && !S.card) { el.innerHTML = playersList(); K.refocus(); } else paint();
  }

  // ---------- tabs
  function overview() {
    var o = S.ov; if (!o) return msg('Считаем…');
    var p = o.players, m = o.matches, c = o.coins, k = o.stakes, s = o.stars;
    var h = '<div class="xd-row"><div><h4>Игроки</h4><div class="xd-k">' + tile(num(p.total), 'всего') + tile(num(p.new1), 'новых сегодня') + tile(num(p.new7), 'за 7 дней') +
      tile(num(p.new30), 'за 30 дней') + tile(num(p.act1), 'активны за день') + tile(num(p.act7), 'за неделю') + tile(num(p.act30), 'за месяц') + '</div></div>' +
      '<div><h4>&nbsp;</h4>' + bars('np', o.d0, [{ k: 'новые', v: o.newByDay, c: C.one }], 'Новые игроки по дням') + '</div></div>';
    h += '<div class="xd-row"><div><h4>Матчи</h4><div class="xd-k">' + tile(num(m.day.ai + m.day.server + m.day.host), 'сегодня') + tile(num(m.day.ai), 'с ИИ') +
      tile(num(m.day.server), 'двое · сервер') + tile(num(m.day.host), 'двое · хост') + tile(num(m.n30), 'за 30 дней') +
      tile(m.avgLen ? (m.avgLen / 60).toFixed(1).replace('.', ',') + ' мин' : '—', 'средняя длина') + tile(m.n30 ? pct(m.done) : '—', 'доиграно') + '</div></div>' +
      '<div><h4>&nbsp;</h4>' + bars('mt', o.d0, [{ k: 'с ИИ', v: m.byDay.ai, c: C.ai }, { k: 'двое · сервер', v: m.byDay.server, c: C.server }, { k: 'двое · хост', v: m.byDay.host, c: C.host }], 'Матчи по дням') + '</div></div>';
    h += '<div class="xd-row"><div><h4>Монеты</h4><div class="xd-k">' + tile(num(c.issued), 'выдано') + tile(num(c.spent), 'потрачено') + tile(num(c.circ), 'в обороте') + tile(num(c.staked), 'в ставках сейчас') + '</div>' +
      '<h4>Ставки</h4><div class="xd-k">' + tile(num(k.n), 'матчей со ставкой') + tile(num(k.pot), 'сумма (банк)') + tile(num(k.refunds), 'возвратов') + tile(num(k.refundPot), 'вернулось монет') + '</div></div>' +
      '<div><h4>Звёзды</h4><div class="xd-k">' + tile(num(s.buys), 'покупок') + tile(num(s.sold), 'звёзд продано') + tile(num(s.x1), 'Stars за день') + tile(num(s.x30), 'за месяц') +
      tile(num(s.xall), 'за всё время') + tile(num(s.refunds) + ' · ' + num(s.refundX), 'возвраты · Stars') + (s.unmatched ? tile('<span class="neg">' + num(s.unmatched) + '</span>', 'не опознаны') : '') + '</div></div></div>';
    h += '<div class="xd-row"><div><h4>Платформы</h4>' + hbars([['iOS', o.platforms.ios], ['Android', o.platforms.android], ['ПК', o.platforms.pc], ['Веб', o.platforms.web], ['нет данных', o.platforms.other]]) + '</div>' +
      '<div><h4>Языки</h4>' + hbars(o.langs.length ? o.langs.map(function (l) { return [l[0] || '—', l[1]]; }) : [['—', 0]]) + '</div></div>';
    return h + '<div class="xd-msg" style="padding:8px 0 0;font-size:10.5px">Сутки — по UTC. Числа обновляются раз в минуту (' + dt(o.at) + ').</div>';
  }
  var PCOLS = 'minmax(0,1.7fr) .6fr .55fr .95fr .6fr .55fr .6fr .8fr';
  function playersList() {
    var d = S.pl.data; if (!d) return msg('Загружаем…');
    if (!d.rows.length) return msg(S.pl.q ? 'Никого не нашлось' : 'Игроков пока нет');
    var rows = d.rows.map(function (u) {
      return '<div class="xd-r mf" data-act="x" data-x="open" data-id="' + u.id + '"@G><span class="nm"><b>' + E(u.name || '—') + '</b><i>' + (u.username ? '@' + E(u.username) + ' · ' : '') + u.id + '</i></span>' +
        '<span>' + dt(u.created, true) + '</span><span>' + ago(u.seen) + '</span><span class="num">' + u.matches + ' <i style="color:var(--mdim);font-style:normal">' + u.wins + '/' + u.draws + '/' + u.losses + '</i></span>' +
        '<span class="num">' + num(u.coins) + '</span><span class="num">' + num(u.stars) + '</span><span class="num">' + num(u.bought) + '</span><span>' + plat(u.platform) + '</span></div>';
    });
    return table(PCOLS, [['Игрок'], ['Пришёл'], ['Был'], ['Матчи п/н/п', 1], ['Монеты', 1], ['Звёзды', 1], ['Куплено', 1], ['Платформа']], rows) + pager(d, 'pl');
  }
  function pager(d, k) {
    var pages = Math.max(1, Math.ceil(d.total / d.size)), p = d.page;
    if (pages < 2) return '';
    return '<div class="xd-pg"><span class="mf' + (p > 0 ? '' : ' dis') + '" data-act="x" data-x="pg" data-k="' + k + '" data-v="-1">‹</span>' + (p + 1) + ' / ' + pages +
      '<span class="mf' + (p < pages - 1 ? '' : ' dis') + '" data-act="x" data-x="pg" data-k="' + k + '" data-v="1">›</span></div>';
  }
  function players() {
    var ch = SORTS.map(function (s) { return chip('sort', s[0], s[1], S.pl.sort === s[0]); }).join('');
    return '<div class="xd-bar"><input id="xq" type="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Имя, @username или id" value="' + E(S.pl.q) + '">' +
      ch + '<span class="xd-n">' + (S.pl.data ? num(S.pl.data.total) + ' игр.' : '') + '</span></div><div id="xdl">' + playersList() + '</div>';
  }
  function card() {
    var d = S.cd; if (!d) return msg('Загружаем…');
    var u = d.user;
    if (!u) return msg('Такого игрока нет');
    var h = '<div class="xd-k">' + tile(E(u.name || '—'), u.username ? '@' + u.username : 'без username') + tile(u.id, 'telegram id') + tile(E(u.lang || '—') + (u.premium ? ' · ★' : ''), 'язык' + (u.premium ? ' · premium' : '')) +
      tile(plat(u.platform), 'платформа') + tile(dt(u.created), 'пришёл') + tile(dt(u.seen), 'был') + tile(u.matches + ' · ' + u.wins + '/' + u.draws + '/' + u.losses, 'матчи · п/н/п') +
      tile(u.goals + ':' + u.goals_against, 'голы') + tile(num(u.coins), 'монеты') + tile(num(u.stars), 'звёзды') + tile(num(u.bought), 'куплено Stars') + '</div>';
    h += '<h4>Последние матчи</h4>' + (d.matches.length ? table('.75fr 1.2fr .4fr .65fr .45fr .65fr minmax(0,.9fr)', [['Когда'], ['Режим'], ['Счёт'], ['Результат'], ['Монеты', 1], ['Вердикт'], ['id']],
      d.matches.map(function (m) {
        return '<div class="xd-r"@G><span>' + dt(m.at) + '</span><span>' + mode(m) + ' · ' + Math.round(m.len / 60) + ' мин</span><span>' + m.my + ':' + m.op + '</span><span>' + (RES[m.result] || m.result) +
          '</span><span class="num">' + m.reward + '</span><span>' + E(m.verdict) + '</span><span class="mono">' + E(m.id) + '</span></div>';
      })) : msg('Матчей нет'));
    h += '<h4>Ставки</h4>' + (d.stakes.length ? table('.8fr .5fr .5fr .7fr .8fr minmax(0,1fr)', [['Когда'], ['Ставка', 1], ['Роль'], ['Статус'], ['Итог'], ['Соперник']],
      d.stakes.map(function (k) {
        var out = k.status !== 'settled' ? '—' : k.outcome === 'refund' ? 'возврат' : k.outcome === 'draw' ? 'ничья' : k.outcome === k.role ? '<span class="pos">+' + k.amount * 2 + '</span>' : '<span class="neg">−' + k.amount + '</span>';
        return '<div class="xd-r"@G><span>' + dt(k.at) + '</span><span class="num">' + k.amount + '</span><span>' + (k.role === 'host' ? 'хост' : 'гость') + '</span><span>' + badge(k.status) + '</span><span>' + out + '</span><span>' + E(k.opp || '') + ' ' + k.oppId + '</span></div>';
      })) : msg('Ставок нет'));
    h += '<h4>Покупки звёзд</h4>' + (d.orders.length ? orders(d.orders, false) : msg('Покупок нет'));
    h += '<h4>Журнал (ledger)</h4>' + (d.ledger.length ? table('.8fr .55fr .5fr .9fr .55fr minmax(0,1fr)', [['Когда'], ['Валюта'], ['Сумма', 1], ['Причина'], ['Баланс', 1], ['Ссылка']],
      d.ledger.map(function (l) {
        return '<div class="xd-r"@G><span>' + dt(l.at) + '</span><span>' + (l.currency === 'stars' ? 'звёзды' : 'монеты') + '</span><span class="num ' + (l.delta < 0 ? 'neg' : 'pos') + '">' + (l.delta > 0 ? '+' : '') + l.delta +
          '</span><span>' + E(REASON[l.reason] || l.reason) + '</span><span class="num">' + l.balance + '</span><span class="mono">' + E(l.ref || '') + '</span></div>';
      })) : msg('Записей нет'));
    return h;
  }
  function orders(rows, who) {
    return table((who ? '.75fr minmax(0,1.1fr) ' : '.75fr ') + '.45fr .4fr .7fr .75fr minmax(0,1.6fr) .5fr', [['Создан']].concat(who ? [['Игрок']] : []).concat([['Звёзды', 1], ['Stars', 1], ['Статус'], ['Оплачен'], ['charge id'], ['Недост.', 1]]),
      rows.map(function (o) {
        return '<div class="xd-r' + (who ? ' mf" data-act="x" data-x="open" data-id="' + o.uid + '"' : '"') + '@G><span>' + dt(o.created) + '</span>' +
          (who ? '<span class="nm"><b>' + E(o.name || '—') + '</b><i>' + (o.username ? '@' + E(o.username) + ' · ' : '') + o.uid + '</i></span>' : '') +
          '<span class="num">' + o.stars + '</span><span class="num">' + o.price + '</span><span>' + badge(o.status) + '</span><span>' + (o.refunded ? '↩ ' + dt(o.refunded) : dt(o.paid)) +
          '</span><span class="mono">' + E(o.charge || '—') + '</span><span class="num' + (o.short ? ' neg' : '') + '">' + (o.status === 'refunded' ? o.short : '') + '</span></div>';
      }));
  }
  function payments() {
    var d = S.pay.data;
    var ch = PAYST.map(function (s) { return chip('pst', s[0], s[1], S.pay.status === s[0]); }).join('');
    return '<div class="xd-bar">' + ch + '<span class="xd-n">' + (d ? num(d.total) + ' заказ.' : '') + '</span></div>' +
      (!d ? msg('Загружаем…') : !d.rows.length ? msg('Заказов нет') : orders(d.rows, true) + pager(d, 'pay'));
  }
  function msg(t, bad) { return '<div class="xd-msg' + (bad ? ' bad' : '') + '">' + E(t) + '</div>'; }

  return {
    render: function () {
      var tabs = S.card ? '' : '<div class="mtabs mf" data-adj="x" data-x="tab" style="margin-left:auto">' +
        TABS.map(function (t, i) { return '<span class="mtab' + (S.tab === i ? ' cur' : '') + '" data-tab="' + i + '">' + E(t) + '</span>'; }).join('') + '</div>';
      var title = S.card ? (S.cd && S.cd.user ? (S.cd.user.name || 'Игрок') : 'Игрок') : 'Разработчик';
      var body = S.card ? card() : S.tab === 0 ? overview() : S.tab === 1 ? players() : payments();
      if (S.err) body = msg(S.err, true) + body;
      setTimeout(load, 0);
      return K.head(title, tabs + '<span class="mpill">только просмотр</span>') + '<div class="mleft"><div class="xd">' + body + '</div></div>';
    },
    act: function (name, el) {
      var v = el.getAttribute('data-v');
      if (name === 'open') { loadCard(+el.getAttribute('data-id')); return; }
      if (name === 'sort') { S.pl.sort = v; S.pl.page = 0; S.pl.data = null; paint(); return; }
      if (name === 'pst') { S.pay.status = v; S.pay.page = 0; S.pay.data = null; paint(); return; }
      if (name === 'pg') {
        if (el.classList.contains('dis')) return;
        var P = el.getAttribute('data-k') === 'pl' ? S.pl : S.pay;
        P.page = Math.max(0, P.page + (+v)); if (P === S.pl) loadPlayers(); else loadPay();
      }
    },
    adj: function (name, el, d, ev) {
      if (name !== 'tab') return;
      var t = ev && ev.target && ev.target.closest && ev.target.closest('[data-tab]');
      S.tab = t ? +t.getAttribute('data-tab') : (S.tab + d + 3) % 3; S.err = ''; paint();
    },
    tabs: function (d) { if (S.card) return; S.tab = (S.tab + d + 3) % 3; S.err = ''; paint(); },
    back: function () { if (!S.card) return false; S.card = null; S.cd = null; paint(); return true; },
  };
}
