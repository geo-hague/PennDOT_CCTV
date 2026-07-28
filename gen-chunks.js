// gen-chunks.js (PA) — emits the scrape job matrix: one entry per 50-camera page.
// Pulls the roadway list + per-roadway counts from 511PA's OWN camera feed (the
// same DataTables endpoint the app's loadCameras() uses), so the roadway filter
// values are exactly what 511PA expects. Prints compact JSON array to stdout.
//
// Env: CAMERAS_URL_BASE (the proxy /List/GetData/Cameras path).
const PAGE_SIZE = 50;
const log = (...a) => console.error(...a);
const CAMERAS_URL_BASE = process.env.CAMERAS_URL_BASE ||
  'https://penndotdms.m-c-hunt429.workers.dev/List/GetData/Cameras';

function buildCamerasUrl(start, length) {
  const query = {
    columns: [
      { data: null, name: '' }, { name: 'sortOrder', s: true }, { name: 'dotDistrict', s: true },
      { name: 'county', s: true }, { name: 'roadway', s: true }, { name: 'turnpikeOnly' },
      { name: 'location' }, { name: 'cameraName' }, { name: 'district' }, { data: 9, name: '' },
    ],
    order: [{ column: 1, dir: 'asc' }, { column: 2, dir: 'asc' }],
    start, length, search: { value: '' },
  };
  return `${CAMERAS_URL_BASE}?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;
}

async function fetchAll() {
  let start = 0, all = [], total = Infinity;
  while (start < total) {
    const resp = await fetch(buildCamerasUrl(start, 100));
    if (!resp.ok) throw new Error(`HTTP ${resp.status} at start=${start}`);
    const json = await resp.json();
    total = json.recordsTotal ?? (all.length + (json.data || []).length);
    const page = json.data || [];
    if (!page.length) break;
    all = all.concat(page); start += 100;
  }
  return all;
}

async function run() {
  const records = await fetchAll();
  // Count cameras per RAW roadway string (that's what the /cctv filter uses),
  // keeping only Interstate / US / PA routes.
  // Normalize the feed's roadway string to the hyphen form the /cctv filter
  // expects (feed uses "I 95"/"US 22" style; the filter wants "I-95"/"US-22").
  const normalizeRoadway = (raw) => {
    const t = (raw || '').toUpperCase().trim();
    let m = t.match(/\bI[-\s]?(\d+)\b/) || t.match(/INTERSTATE\s+(\d+)/);
    if (m) return `I-${m[1]}`;
    m = t.match(/\bUS[-\s]?(\d+)\b/);
    if (m) return `US-${m[1]}`;
    m = t.match(/\bPA[-\s]?(\d+)\b/) || t.match(/\bSR[-\s]?(\d+)\b/);
    if (m) return `PA-${m[1]}`;
    return null;
  };
  const counts = {};
  for (const c of records) {
    const rw = normalizeRoadway(c.roadway);
    if (rw) counts[rw] = (counts[rw] || 0) + 1;
  }
  const chunks = [];
  let id = 0;
  for (const roadway of Object.keys(counts).sort()) {
    // +1 safety page: the /cctv list can show a few more rows than the feed
    // count (concurrent-route overlap), and an empty page just no-ops.
    const pages = Math.ceil(counts[roadway] / PAGE_SIZE) + 1;
    for (let p = 0; p < pages; p++) chunks.push({ id: id++, roadway, start: p * PAGE_SIZE });
    log(`${roadway}: ${counts[roadway]} cams -> ${pages} chunk(s)`);
  }
  log(`Total: ${records.length} cams, ${Object.keys(counts).length} roadways, ${chunks.length} chunks`);
  process.stdout.write(JSON.stringify(chunks));
}
run().catch(err => { console.error('gen-chunks failed:', err); process.exit(1); });
