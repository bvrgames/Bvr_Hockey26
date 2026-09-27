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

export async function openGame(name, { w = 1280, h = 720, headed = false } = {}) {
  const engine = ENGINES[name];
  if (!engine) throw new Error(`unknown browser "${name}" (chromium | webkit)`);
  const browser = await engine.launch({ headless: !headed, args: ARGS[name] });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning' || process.env.ALLLOGS) logs.push({ type: t, text: m.text() });
  });
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: `${e.message}\n${(e.stack || '').split('\n').slice(0, 5).join('\n')}` }));
  page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText || ''}` }));
  await page.route(/telegram\.org\/js\/telegram-web-app\.js/, (r) => r.fulfill({ contentType: 'text/javascript', body: '/* telegram stub */' }));
  return { browser, context, page, logs };
}

export const isError = (l) => l.type === 'error' || l.type === 'pageerror' || l.type === 'requestfailed';
