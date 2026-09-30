// Shared Playwright launcher for play.mjs / smoke.mjs.
// Chromium and WebKit (WebKit is the closest local stand-in for iPhone / Telegram). telegram-web-app.js is replaced by
// an empty stub so runs work offline and never depend on telegram.org. Console errors, page errors and failed
// requests are collected into `logs`.
import { chromium, webkit } from 'playwright';

const ENGINES = { chromium, webkit };
const ARGS = {
  // macOS: real GPU through ANGLE/Metal (~60 fps; the default SwiftShader software path runs the game at ~3 fps).
  // Elsewhere SwiftShader keeps WebGL2 available. BVR_GL=swiftshader forces the software path.
  chromium: (process.platform === 'darwin' && process.env.BVR_GL !== 'swiftshader'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']).concat('--autoplay-policy=no-user-gesture-required'),
  webkit: [],
};

// Fake Telegram.WebApp for layout tests (Bot API 8.0: full screen, safe areas, CloudStorage in memory).
export function fakeTelegram({ fullscreen = true, safe = {}, content = {}, lang = 'ru', platform = 'ios' } = {}) {
  const ins = (o) => JSON.stringify({ top: o.top || 0, right: o.right || 0, bottom: o.bottom || 0, left: o.left || 0 });
  return `window.Telegram={WebApp:(function(){ var store={}; var noop=function(){};
    return { initData:'query_id=test&user=%7B%22id%22%3A1%7D&auth_date=1&hash=test', initDataUnsafe:{user:{id:1, language_code:'${lang}'}}, version:'8.0', platform:'${platform}',
      isFullscreen:${!!fullscreen}, safeAreaInset:${ins(safe)}, contentSafeAreaInset:${ins(content)}, viewportStableHeight:0,
      isVersionAtLeast:function(v){ return parseFloat(v)<=8.0; },
      ready:noop, expand:noop, disableVerticalSwipes:noop, setHeaderColor:noop, setBackgroundColor:noop,
      enableClosingConfirmation:noop, requestFullscreen:noop, openTelegramLink:noop, onEvent:noop, offEvent:noop,
      HapticFeedback:{impactOccurred:noop, notificationOccurred:noop, selectionChanged:noop},
      // BackButton: calls are recorded in window.__tgBack (visible, clicks); window.__tgBackClick() presses it
      BackButton:(function(){ var cbs=[]; window.__tgBack={visible:false, shows:0, hides:0};
        window.__tgBackClick=function(){ cbs.slice().forEach(function(f){ f(); }); };
        return { get isVisible(){ return window.__tgBack.visible; },
          show:function(){ window.__tgBack.visible=true; window.__tgBack.shows++; }, hide:function(){ window.__tgBack.visible=false; window.__tgBack.hides++; },
          onClick:function(f){ cbs.push(f); }, offClick:function(f){ cbs=cbs.filter(function(x){ return x!==f; }); } }; })(),
      CloudStorage:{ getItem:function(k,cb){ setTimeout(function(){ cb(null, store[k]||''); },0); },
                     setItem:function(k,v,cb){ store[k]=String(v); if(cb) cb(null,true); } } }; })()};`;
}

// noRoute: no request interception (Playwright's routing disables the HTTP cache — load tests need the cache)
export async function openGame(name, { w = 1280, h = 720, headed = false, tg = null, mobile = false, dpr = 1, noRoute = false } = {}) {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`unknown browser "${name}" (chromium | webkit)`);
  const browser = await engine.launch({ headless: !headed, args: ARGS[name] });
  // mobile: screen = viewport, so screen.orientation (the game's portrait test) follows it; isMobile only exists in Chromium
  const ctxOpt = { viewport: { width: w, height: h }, deviceScaleFactor: dpr };
  if (mobile) Object.assign(ctxOpt, { screen: { width: w, height: h }, hasTouch: true }, name === 'chromium' ? { isMobile: true } : {});
  const context = await browser.newContext(ctxOpt);
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning' || process.env.ALLLOGS) logs.push({ type: t, text: m.text() });
  });
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: `${e.message}\n${(e.stack || '').split('\n').slice(0, 5).join('\n')}` }));
  page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText || ''}` }));
  if (!noRoute) await page.route(/telegram\.org\/js\/telegram-web-app\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: tg || '/* telegram stub */' }));
  return { browser, context, page, logs };
}

export const isError = (l) => l.type === 'error' || l.type === 'pageerror' || l.type === 'requestfailed';
