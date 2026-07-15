// 00_config.js — Configuration constants (Overpass, camera feed, DMS, tuning params)
// Part of the PA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- Config ----------
// 511PA's own DataTables-backed list endpoint — the same one their /cctv
// page calls. NOT part of PennDOT's formal (gated) Data Feed Request
// process; this is the public map's own backing data, same category of
// "undocumented but technically public" endpoint as NC/VA/MD/DE — a
// deliberate call for this project, not an oversight, since PennDOT does
// explicitly require signup + a video license agreement for their
// *official* data feed program. Needs a specific DataTables-style "query"
// JSON param (column defs, paging, sort) — see buildCamerasUrl() in
// 02_geo-utils.js, not a plain GET.
//
// Confirmed via a live "NetworkError" that 511pa.com doesn't send CORS
// headers for third-party origins (only meant for its own map page to
// call from its own domain) — routed through a tiny CORS-only proxy
// instead, no secret involved (see pa-511-proxy/README.md for deploy
// steps). Point this at your deployed worker's /List/GetData/Cameras path
// once it's live.
const CAMERAS_URL_BASE = 'https://penndotdms.m-c-hunt429.workers.dev/List/GetData/Cameras';
const MIN_DISPLACEMENT_M = 40;     // min movement before recomputing bearing
const BEARING_DISAGREE_DEG = 45;   // how much new bearing must differ to challenge current direction
const BEARING_CONFIRM_COUNT = 2;   // consecutive disagreeing samples needed to flip direction
const HIGHWAY_RECHECK_MS = 6000;   // re-run highway snap at most this often (base rate — backs off on repeated failures, see overpassFailStreak in 01_state.js)
const HIGHWAY_RECHECK_MAX_MS = 90000; // cap for the exponential backoff below, so we never go longer than 90s between attempts even during a sustained outage/rate-limit
const HIGHWAY_CONFIRM_COUNT = 2;   // consecutive matching reads needed before switching displayed highway
const MAX_SEARCH_DIST_M = 24140.2; // ~15 miles — cameras farther than this on your highway are ignored
const SWAP_BUFFER_M = 402.336;     // 1320 ft (1/4 mile) — a camera stays the displayed
                                    // "nearest"/"next" camera, counting down through negative
                                    // distance, until it's this far behind you
const BROWSE_RANGE_M = 80467;      // ~50 miles — how far the manual ahead/behind scan can look
const MANIFEST_TIMEOUT_MS = 12000; // if a stream hasn't started playing within this long, treat as stalled
const MAX_STREAM_RETRIES = 3;      // automatic retry attempts before showing a manual "tap to retry" button

// ---- Mile marker lookup ----
// PennDOT's Interstate Mile Markers layer (public ArcGIS MapServer, no
// gating). As the name says, interstate-only — the Turnpike (I-70/I-76
// toll road segments) isn't included, which is a real gap if you need
// Turnpike mileposts, but fine for I-95/I-80/etc. Since this whole layer
// is scoped to interstates, every record is assumed type "I" — no
// separate route-type field needed. ST_RT_NO is zero-padded (e.g. "0095"
// for I-95); MILE_MARKER is a clean numeric field (e.g. 16.00), unlike
// DE's LEGEND_TEXT quirks.
const MILEMARKER_QUERY_URL = 'https://gis.penndot.pa.gov/gis/rest/services/opendata/interstatemilemarkers/MapServer/0/query';
const MILEMARKER_SEARCH_RADIUS_M = 1800; // ~1.12mi — PA's interstate markers are spaced ~1 mile apart
                                          // (confirmed), so the radius needs to exceed 1609m (1mi) to
                                          // reliably catch a bracketing pair no matter where you are
                                          // between them — standing almost exactly on one marker still
                                          // needs to reach ~1609m in the other direction to find the
                                          // next one. 1800m adds a margin over the bare minimum.
const MILEMARKER_RECHECK_MS = 8000;      // how often we re-query for the current milepost

// ---- Highway shield images (Wikipedia / Wikimedia Commons) ----
// Special:FilePath redirects straight to the file, so it works as a plain
// <img src> with no API key or CORS preflight needed. We try a short list
// of likely filenames per route type and fall back silently if none load.
const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

// ---- PennDOT message signs (DMS/VMS) ----
// Two separate 511PA endpoints have to be joined to get both location and
// message content — unusual among the five states done so far, but
// confirmed working: /map/mapIcons/MessageSigns gives { itemId, location:
// [lat, lon] } for every sign (a single plain GET, no query params, no
// DataTables pagination needed), while /List/GetData/MessageSigns (the
// same DataTables-style endpoint as cameras) gives the actual roadway/
// direction/message content, keyed by the same id (its DT_RowId matches
// mapIcons' itemId). See fetchMessageSignsIfNeeded() in 04_messagesigns.js
// for the join logic. Like cameras, this is 511PA's own public map
// backing data — not PennDOT's gated official Data Feed Request process.
// Same CORS issue as cameras above — routed through the same proxy.
const MSG_SIGN_ICONS_URL = 'https://penndotdms.m-c-hunt429.workers.dev/map/mapIcons/MessageSigns';
const MSG_SIGN_LIST_URL_BASE = 'https://penndotdms.m-c-hunt429.workers.dev/List/GetData/MessageSigns';
const MSG_SIGN_URL = MSG_SIGN_LIST_URL_BASE; // kept for the "is DMS configured" guard elsewhere — real fetch logic builds both URLs itself
const MSG_SIGN_RANGE_M = 16093.4;   // 10 miles
const MSG_SIGN_POLL_MS = 30000;     // re-poll signs this often so a sign 10mi out
                                     // can't silently change message before we reach it
