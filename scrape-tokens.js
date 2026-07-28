// scrape-tokens.js (PA / 511PA) — ported from the NC scraper.
// Same Arcadis system: clicking a camera mints its token via
// GetSecureTokenUriBySourceId, and only that camera's playlist carries that
// exact token. We match by the click's own token so background map preloads
// can't contaminate. Streams are chan-XXXX/index.m3u8 (or xflow.m3u8) on
// arcadis-ivds.com:8200 — but we key on chan+token, so host/port don't matter.
//
// Env:  ROADWAY, START (offset), OUT_FILE   Output: one 50-camera page's tokens.
// Run:  node scrape-tokens.js

const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 50;
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 20000;
const RETRY_WAIT_MS = 8000;
const DEAD_ROW_MS = 5000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ROADWAY = process.env.ROADWAY;
const START = parseInt(process.env.START || '0', 10);
const OUT = process.env.OUT_FILE || 'tokens-part.json';

// 511PA /cctv list: roadway filter is index 4 (NC was 3).
function pageUrl(roadway, start) {
  return `https://www.511pa.com/cctv?start=${start}&length=${PAGE_SIZE}` +
         `&filters%5B0%5D%5Bi%5D=4&filters%5B0%5D%5Bs%5D=${encodeURIComponent(roadway)}` +
         `&order%5Bi%5D=1&order%5Bdir%5D=asc`;
}

async function run() {
  if (!ROADWAY) { console.error('No ROADWAY set'); process.exit(1); }
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 3000 });
  await page.setUserAgent(UA);

  let activity = false, m3u8Urls = [], clickToken = null;
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('GetSecureTokenUriBySourceId') || u.includes('arcadis-ivds.com') ||
        u.includes('m3u8') || u.includes('stream')) activity = true;
    if (u.includes('.m3u8')) m3u8Urls.push(u);
  });
  page.on('response', async (response) => {
    const req = response.request();
    if (req.method() === 'POST' && req.url().includes('GetSecureTokenUriBySourceId') && !clickToken) {
      try { const b = await response.text(); const m = b.match(/token=([0-9a-fA-F]+)/); if (m) clickToken = m[1]; } catch (e) {}
    }
  });

  await page.goto(pageUrl(ROADWAY, START), { waitUntil: 'networkidle2', timeout: 120000 });
  await sleep(3000);
  await page.keyboard.press('Escape');

  const rows = await page.evaluate(() => document.querySelectorAll('table tbody tr').length);
  const byChan = {};
  let captured = 0;

  async function attempt(i, windowMs) {
    await page.keyboard.press('Escape'); await sleep(250);
    activity = false; m3u8Urls = []; clickToken = null;
    let chan = null, token = null, host = null;

    const clicked = await page.evaluate((rowIndex) => {
      const r = document.querySelectorAll('table tbody tr')[rowIndex];
      if (!r) return false;
      r.scrollIntoView({ block: 'center', behavior: 'instant' });
      const els = [...r.querySelectorAll('button, a, span, td')];
      const btn = els.find(el => (el.textContent || '').trim().toLowerCase() === 'show video');
      if (!btn) return false;
      const fire = (t) => btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      fire('mousedown'); fire('mouseup'); fire('click');
      fire('mousedown'); fire('mouseup'); fire('click');
      return true;
    }, i);
    if (!clicked) return 'nobutton';

    const startT = Date.now();
    while (Date.now() - startT < windowMs) {
      if (!chan && clickToken) {
        const hit = m3u8Urls.find(u => u.includes('token=' + clickToken) && /chan-/i.test(u));
        if (hit) {
          const cM = hit.match(/(chan-[0-9a-zA-Z_]+)/i);
          chan = cM[1].toLowerCase(); token = clickToken;
          try { host = new URL(hit).hostname.split('.')[0]; } catch (e) {}
        }
      }
      if (chan && token) break;
      if (!activity && Date.now() - startT > DEAD_ROW_MS) break;
      await sleep(150);
    }
    let ok = false;
    if (chan && token) { if (!byChan[chan]) captured++; byChan[chan] = { token, host }; ok = true; }

    await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, span, .close, [data-dismiss="modal"]')];
      const c = els.find(el => { const t = (el.textContent || '').trim(); return t.toLowerCase() === 'close' || t === '\u00d7' || el.classList.contains('close'); });
      if (c) c.click();
    });
    await page.keyboard.press('Escape');
    await sleep(ok ? 500 : 700);
    return ok ? 'ok' : 'miss';
  }

  const misses = [];
  for (let i = 0; i < rows; i++) {
    const res = await attempt(i, MAX_WAIT_MS);
    if (res === 'miss') misses.push(i);
  }
  for (let pass = 1; pass < MAX_ATTEMPTS && misses.length; pass++) {
    console.log(`retry pass ${pass}: ${misses.length} remaining`);
    const still = [];
    for (const i of misses) { if (await attempt(i, RETRY_WAIT_MS) !== 'ok') still.push(i); }
    misses.length = 0; misses.push(...still);
  }
  if (misses.length) console.log(`gave up on ${misses.length} rows after ${MAX_ATTEMPTS} attempts`);

  await browser.close();
  const entries = Object.entries(byChan).map(([chan, v]) => ({ chan, ...v }));
  fs.writeFileSync(path.join(__dirname, OUT),
    JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2), 'utf8');
  console.log(`${ROADWAY} @${START}: rows=${rows} captured=${captured} -> ${OUT}`);
}
run().catch(err => { console.error('Scrape failed:', err); process.exit(1); });
