// 02_geo-utils.js — Generic geo math helpers, highway-name normalization, camera list loading
// Part of the PA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Geo helpers ----------
function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function bearingToCompassLabel(bearing) {
  // Map to the 4 cardinal "of travel" labels most state DOT feeds use.
  if (bearing >= 315 || bearing < 45) return 'Northbound';
  if (bearing >= 45 && bearing < 135) return 'Eastbound';
  if (bearing >= 135 && bearing < 225) return 'Southbound';
  return 'Westbound';
}

// ---------- Highway name normalization ----------
function formatDistance(meters) {
  const miles = meters / 1609.34;
  return `${miles.toFixed(1)} mi`;
}

function normalizeHighwayName(raw) {
  if (!raw) return null;
  const s = raw.toUpperCase().trim();
  // Interstate: "I-40", "I 40", "Interstate 40" (DelDOT's own titles use "I 95", no hyphen)
  let m = s.match(/\bI[-\s]?(\d+)\b/) || s.match(/INTERSTATE\s+(\d+)/);
  if (m) return `I-${m[1]}`;
  // US Highway: "US-13", "US 13", "US Highway 13"
  m = s.match(/\bUS[-\s]?(\d+)\b/);
  if (m) return `US-${m[1]}`;
  // PA Highway: "PA-160", "PA 160", "SR 160" (511PA's camera feed uses "PA
  // 160" style; PennDOT's own asset layers sometimes use "SR" for the same
  // state routes)
  m = s.match(/\bPA[-\s]?(\d+)\b/) || s.match(/\bSR[-\s]?(\d+)\b/);
  if (m) return `PA-${m[1]}`;
  // No route-number pattern matched (e.g. a local street name) — fall back
  // to the literal name, uppercased/trimmed.
  return s;
}

// ---------- 511PA DataTables pagination ----------
// Confirmed live: asking for length:2000/3000 still only ever returns 100
// rows — the server silently caps each response at 100 regardless of what
// length was requested. Both cameras (~1522 total) and DMS (~1195 total)
// need multiple page requests to get everything; this is shared by both
// loadCameras() below and fetchMessageSignsIfNeeded() in
// 04_messagesigns.js. buildUrl(start, length) must return a full request
// URL for that page.
async function fetchAllDataTablesRows(buildUrl, pageSize = 100) {
  let start = 0;
  let all = [];
  let total = Infinity;
  while (start < total) {
    const resp = await fetch(buildUrl(start, pageSize));
    if (!resp.ok) throw new Error(`HTTP ${resp.status} at start=${start}`);
    const json = await resp.json();
    total = json.recordsTotal ?? (all.length + (json.data || []).length);
    const page = json.data || [];
    if (!page.length) break; // safety: stop if the server ever returns an empty page early
    all = all.concat(page);
    start += pageSize;
  }
  return all;
}

// ---------- Load static camera list ----------
// 511PA's endpoint is a DataTables-backed list API — it needs a specific
// "query" JSON param (column definitions, paging, sort) rather than a
// plain GET, or it returns an empty data array with just the record
// count. buildCamerasUrl() replicates the exact query the real /cctv page
// sends (captured via DevTools); pagination (start/length) is filled in
// per-page by fetchAllDataTablesRows() above, since a single request
// only ever returns 100 rows no matter what length is requested.
//
// This is the richest camera schema of any state done so far: roadway and
// direction are clean separate fields (direction already reads
// "Eastbound"/"Northbound"/etc — no text-parsing needed, unlike VA/DE),
// and each camera's videoUrl is a ready-to-use HLS manifest
// (chan-XXXX/index.m3u8, host varies per camera like MD's cctvIp).
// Coordinates come as WKT ("POINT (lon lat)") inside latLng.geography,
// not flat lat/lon fields.
//
// CAVEAT: some records have isVideoAuthRequired:true, and it's unconfirmed
// whether that means the manifest actually needs session auth to load
// cross-origin (which a request from a different site wouldn't have) or
// is just informational — worth checking in practice once deployed;
// cameras with that flag may simply fail to play.
function buildCamerasUrl(start, length) {
  const query = {
    columns: [
      { data: null, name: '' },
      { name: 'sortOrder', s: true },
      { name: 'dotDistrict', s: true },
      { name: 'county', s: true },
      { name: 'roadway', s: true },
      { name: 'turnpikeOnly' },
      { name: 'location' },
      { name: 'cameraName' },
      { name: 'district' },
      { data: 9, name: '' },
    ],
    order: [{ column: 1, dir: 'asc' }, { column: 2, dir: 'asc' }],
    start,
    length,
    search: { value: '' },
  };
  return `${CAMERAS_URL_BASE}?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;
}

// "POINT (-80.579903 41.173561)" -> { lon, lat }
function parseWktPoint(wkt) {
  if (!wkt) return null;
  const m = String(wkt).match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!m) return null;
  return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

async function loadCameras() {
  try {
    const records = await fetchAllDataTablesRows((start, length) => buildCamerasUrl(start, length));

    allCameras = records
      .map(c => {
        const img = (c.images && c.images[0]) || {};
        if (img.disabled || img.blocked || img.videoDisabled) return null;
        const videoUrl = img.videoUrl;
        if (!videoUrl) return null; // no stream for this camera (JPEG-only or currently offline)
        const point = parseWktPoint(c.latLng && c.latLng.geography && c.latLng.geography.wellKnownText);
        if (!point) return null;
        return {
          id: c.id || c.DT_RowId,
          lat: point.lat, lon: point.lon,
          roadway: normalizeHighwayName(c.roadway) || '',
          direction: c.direction || '', // already "Eastbound"/etc — no parsing needed
          location: c.location || '',
          videoUrl,
        };
      })
      .filter(c => c !== null);

    setDebug({ cameraRecordCount: records.length, cameraParsedCount: allCameras.length });
    console.log(`Loaded ${allCameras.length} PA cameras (of ${records.length} total records).`);
  } catch (err) {
    // Camera load failing (CORS block, network error, endpoint down, etc.)
    // must NOT stop the rest of the app from starting — init() awaits this
    // function, so an uncaught throw here would silently kill GPS watching
    // and the simulation button along with it. Fail loud in the debug
    // panel instead, and keep going with an empty camera list.
    allCameras = [];
    setDebug({ camerasLoadError: err.message });
    console.error('Failed to load PA cameras:', err);
  }
}
