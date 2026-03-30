/**
 * screenshot.mjs — Headless Chrome screenshots via CDP
 * Usage: node screenshot.mjs http://localhost:3000
 */
import { spawn }    from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME    = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR   = join(__dirname, 'temporary screenshots');
const BASE_URL  = process.argv[2] || 'http://localhost:3000';

await mkdir(OUT_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Start Chrome ──────────────────────────────────────────────
const chrome = spawn(CHROME, [
  '--remote-debugging-port=9229',
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--window-size=1440,900',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

await sleep(1500); // give Chrome time to start

// ── Get WS debugger URL ───────────────────────────────────────
let wsUrl;
for (let i = 0; i < 10; i++) {
  try {
    const r = await fetch('http://127.0.0.1:9229/json');
    const tabs = await r.json();
    wsUrl = tabs[0]?.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch {}
  await sleep(400);
}
if (!wsUrl) { chrome.kill(); throw new Error('Chrome CDP not available'); }

// ── Minimal CDP over WebSocket ────────────────────────────────
let msgId = 1;
const ws = new WebSocket(wsUrl);
const pending = new Map();

ws.addEventListener('message', e => {
  try {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  } catch {}
});

await new Promise(r => ws.addEventListener('open', r, { once: true }));

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }
    }, 8000);
  });
}

// ── Navigate and prepare ──────────────────────────────────────
await send('Page.enable');
await send('Page.navigate', { url: BASE_URL + '/?reveal' });
await sleep(3000); // wait for fonts, images, JS

// Force all reveals visible
await send('Runtime.evaluate', {
  expression: `
    document.querySelectorAll('.reveal').forEach(el => {
      el.style.cssText += 'opacity:1!important;transform:none!important;transition:none!important';
    });
  `
});
await sleep(300);

// ── Helper: screenshot current viewport ──────────────────────
async function snap(name) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false
  });
  const file = join(OUT_DIR, name);
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log(`✅  ${name}`);
}

// ── Helper: scroll to element ─────────────────────────────────
async function scrollTo(id) {
  await send('Runtime.evaluate', {
    expression: `
      const el = document.getElementById('${id}');
      if (el) { el.scrollIntoView({ behavior: 'instant' }); }
    `
  });
  await sleep(600);
}

// ── Screenshots ───────────────────────────────────────────────
// 1. Hero
await send('Runtime.evaluate', { expression: `window.scrollTo(0,0)` });
await sleep(400);
await snap('01-hero.png');

// 2. About
await scrollTo('about');
await snap('02-about.png');

// 3. Menu
await scrollTo('menu');
await snap('03-menu.png');

// 4. Kunafa
await scrollTo('kunafa');
await snap('04-kunafa.png');

// 5. Reviews
await scrollTo('reviews');
await snap('05-reviews.png');

// 6. Catering
await scrollTo('catering');
await snap('06-catering.png');

// 7. Find Us
await scrollTo('find-us');
await snap('07-find-us.png');

// 8. Mobile — reload at 390px
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true
});
await send('Page.navigate', { url: BASE_URL + '/?reveal' });
await sleep(2500);
await send('Runtime.evaluate', {
  expression: `document.querySelectorAll('.reveal').forEach(el => { el.style.cssText += 'opacity:1!important;transform:none!important;transition:none!important'; });`
});
await sleep(300);
await snap('08-mobile-hero.png');

// ── Done ──────────────────────────────────────────────────────
ws.close();
chrome.kill();
console.log('\n🎉  All screenshots saved to "temporary screenshots/"');
