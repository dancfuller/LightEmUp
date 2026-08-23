// Regression test for the palette adjacency cost model (v3.37.0).
//
// The rule it enforces: a FIXTURE (several bulbs in one housing, e.g. "Triple
// Lamp") must never show fewer distinct colors than it has bulbs, as long as the
// palette has at least that many colors. That is the property that kept
// silently breaking — and it broke on SOME palettes while typical library ones
// passed, which is why hand-testing missed it repeatedly.
//
// Run against a live preview server (read-only; writes are stubbed, the Pi is
// never mutated):
//   node serve.mjs &                      # in one shell
//   ROOM_INDEX=1 node fixture-check.mjs   # exits non-zero on failure
//
// Env:
//   ROOM_INDEX  which room's Scenes panel to open (0-based, default 1)
//   PALETTES    JSON array of palette names to sweep; the room's own saved
//               palette is always tested first, under the name "(saved)"
//   SHUFFLES    shuffles per palette (default 6)
import { chromium } from 'playwright';

const ROOM = Number(process.env.ROOM_INDEX ?? 1);
const SHUFFLES = Number(process.env.SHUFFLES || 6);
const PALETTES = process.env.PALETTES
  ? JSON.parse(process.env.PALETTES)
  : ['Cotton Candy', 'Pop Art', 'Frostbite', 'Autumn'];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto('http://localhost:8421/', { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(7000);
await page.getByText('Scenes', { exact: false }).nth(ROOM).click();
await page.waitForTimeout(1500);

// Preview swatches are 40x40 bordered divs inside a wrapper carrying the full
// device name as `title` (the visible label is truncated).
const readSwatches = () => page.evaluate(() => {
  const out = {};
  document.querySelectorAll('div[title]').forEach(w => {
    const sw = [...w.querySelectorAll('div')].find(d => {
      const cs = getComputedStyle(d);
      return cs.width === '40px' && cs.height === '40px' && cs.borderStyle !== 'none';
    });
    if (sw) out[w.getAttribute('title')] = getComputedStyle(sw).backgroundColor;
  });
  return out;
});

// Group whole-device swatches by fixture using the shared name prefix the app
// gives fixture mates ("Triple Lamp - Top/Middle/Bottom").
const groupFixtures = (all) => {
  const groups = {};
  Object.entries(all).forEach(([name, color]) => {
    if (/ — Segment /.test(name)) return;      // strips cycle; not fixtures
    const m = name.match(/^(.+?)\s+-\s+/);
    if (m) (groups[m[1]] ||= []).push(color);
  });
  return Object.entries(groups).filter(([, v]) => v.length > 1);
};

const paletteSize = () => page.evaluate(() => {
  const label = [...document.querySelectorAll('*')]
    .find(e => e.children.length === 0 && e.textContent.trim() === 'Colors:');
  const row = label?.parentElement;
  const n = row && [...row.children].map(c => c.textContent.trim()).find(t => /^\d+$/.test(t));
  return n ? Number(n) : null;
});

const failures = [];
const results = [];

for (const name of ['(saved)', ...PALETTES]) {
  if (name !== '(saved)') {
    try {
      await page.getByText(name, { exact: true }).first().click({ timeout: 6000 });
    } catch {
      results.push({ palette: name, skipped: 'not in the visible list' });
      continue;
    }
    await page.waitForTimeout(900);
  }
  const colors = await paletteSize();
  for (let s = 0; s < SHUFFLES; s++) {
    const all = await readSwatches();
    for (const [fixture, swatches] of groupFixtures(all)) {
      const distinct = new Set(swatches).size;
      const want = Math.min(swatches.length, colors ?? swatches.length);
      const row = { palette: name, colors, shuffle: s, fixture, bulbs: swatches.length, distinct, want };
      results.push(row);
      if (distinct < want) failures.push(row);
    }
    await page.getByRole('button', { name: 'Shuffle', exact: true }).first().click();
    await page.waitForTimeout(700);
  }
}

await browser.close();

const checked = results.filter(r => r.distinct !== undefined).length;
console.log(`checked ${checked} fixture renders across ${new Set(results.map(r => r.palette)).size} palettes`);
results.filter(r => r.skipped).forEach(r => console.log(`  skipped ${r.palette}: ${r.skipped}`));
if (pageErrors.length) console.log('page errors:', pageErrors);
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} render(s) gave a fixture fewer colors than bulbs:`);
  failures.forEach(f => console.log(
    `  ${f.palette} (${f.colors} colors), shuffle ${f.shuffle}: ${f.fixture} → ${f.distinct} of ${f.bulbs}`));
  process.exit(1);
}
console.log(pageErrors.length ? 'FAIL — page errors' : 'PASS — every fixture showed one color per bulb');
process.exit(pageErrors.length ? 1 : 0);
