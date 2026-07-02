// Screenshot the preview with a headless browser (system Edge/Chrome via the
// Playwright `channel`, so no browser download is needed).
//
//   URL=http://localhost:8421/ OUT=shot.png W=1440 H=900 \
//   STEPS='["Controls","Map","Open layout editor"]' node shoot.mjs
//
// STEPS is a JSON array; each item is text to click (getByText, first match),
// with a short settle wait between clicks. Use "text@N" to click the Nth match
// (0-based), e.g. "Controls@2" for the 3rd room's Controls button.
import { chromium } from 'playwright';

const url = process.env.URL || 'http://localhost:8421/';
const out = process.env.OUT || 'shot.png';
const w = Number(process.env.W || 1440);
const h = Number(process.env.H || 900);
const channel = process.env.BROWSER_CHANNEL || 'msedge';
const full = process.env.FULL !== '0';
const steps = process.env.STEPS ? JSON.parse(process.env.STEPS) : [];

const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('pageerror', e => console.log('[pageerror]', e.message));

// `load`, not `networkidle` — the SSE /events stream never goes idle.
await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(2800); // Babel transpile + React mount + first data load

for (const raw of steps) {
  const m = String(raw).match(/^(.*)@(\d+)$/);
  const text = m ? m[1] : raw;
  const nth = m ? Number(m[2]) : 0;
  try {
    await page.getByText(text, { exact: false }).nth(nth).click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    console.log('ok:', raw);
  } catch (e) {
    console.log('FAIL:', raw, '-', e.message.split('\n')[0]);
  }
}

await page.waitForTimeout(400);
await page.screenshot({ path: out, fullPage: full });
await browser.close();
console.log('shot ->', out);
