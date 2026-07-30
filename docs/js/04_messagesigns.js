// 04_messagesigns.js — PennDOT DMS/VMS fetching, matching, banner + speech
// Part of the PA Traffic app; loaded as a classic (non-module) script so it
// shares top-level `let`/`const` scope with the other js/*.js files.

// ---------- DMS message signs ----------
// 511PA splits sign data across two endpoints that have to be joined:
// mapIcons gives { itemId, location: [lat, lon] } for every sign in one
// plain GET; the DataTables list endpoint gives the actual roadway/
// direction/message content, keyed by the same id. The list endpoint caps
// each response at 100 rows regardless of requested length — confirmed
// live — so it goes through fetchAllDataTablesRows() (defined in
// 02_geo-utils.js, shared with cameras) to page through all ~1195 rows.
// mapIcons has no draw/recordsTotal/recordsFiltered fields at all (unlike
// the DataTables endpoints), which is why it's assumed to return
// everything in one shot rather than being paginated the same way — that
// assumption is NOT independently confirmed though; if dmsParsedCount
// stays suspiciously low even after the list-side pagination fix, a
// mapIcons page cap we don't know about would be the next thing to check.
// Both fetched in parallel each poll, joined by id, then mapped into the
// { Id, Name, Roadway, DirectionOfTravel, Latitude, Longitude, Messages }
// shape every function below already expects — same shape used for
// VA/MD/DE, none of which needed changes below this point either.
function buildMessageSignsListUrl(start, length) {
  const query = {
    columns: [
      { data: null, name: '' },
      { name: 'sortOrder', s: true },
      { name: 'dotDistrict', s: true },
      { name: 'county', s: true },
      { name: 'roadway', s: true },
      { name: 'turnpikeOnly' },
      { name: 'location' },
      { name: 'messageSignName' },
      { name: 'district' },
      { data: 9, name: '' },
    ],
    order: [{ column: 1, dir: 'asc' }, { column: 2, dir: 'asc' }],
    start,
    length,
    search: { value: '' },
  };
  return `${MSG_SIGN_LIST_URL_BASE}?query=${encodeURIComponent(JSON.stringify(query))}&lang=en-US`;
}

// Messages come with HTML <br/> tags for line breaks, e.g.
// "PA-987<br/>6 MILES<br/> 7 MIN" — convert to spaces, same idea as DE's
// signs. "NO_MESSAGE" (511PA's own literal string for a blank sign)
// already matches the convention used everywhere else in this app.
function stripPaMessageHtml(raw) {
  if (!raw) return '';
  return raw
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchMessageSignsIfNeeded() {
  const now = Date.now();
  if (now - lastMsgSignFetch < MSG_SIGN_POLL_MS) return;
  lastMsgSignFetch = now;
  if (!MSG_SIGN_LIST_URL_BASE || !MSG_SIGN_ICONS_URL) {
    setDebug({ messageSigns: 'MSG_SIGN_LIST_URL_BASE/MSG_SIGN_ICONS_URL not configured' });
    return;
  }
  try {
    const [iconsJson, records] = await Promise.all([
      fetch(MSG_SIGN_ICONS_URL).then(r => {
        if (!r.ok) throw new Error(`icons HTTP ${r.status}`);
        return r.json();
      }),
      fetchAllDataTablesRows((start, length) => buildMessageSignsListUrl(start, length)),
    ]);

    // Location lookup: itemId -> { lat, lon }
    const locationsById = new Map();
    (iconsJson.item2 || []).forEach(item => {
      const loc = item.location;
      if (Array.isArray(loc) && loc.length === 2) {
        locationsById.set(String(item.itemId), { lat: loc[0], lon: loc[1] });
      }
    });

    const parsed = records
      .map(r => {
        const loc = locationsById.get(String(r.DT_RowId));
        if (!loc) return null; // no coordinates for this sign — can't place it, so skip
        const parts = [r.message, r.message2, r.message3]
          .map(stripPaMessageHtml)
          .filter(t => t && t !== 'NO_MESSAGE');
        return {
          Id: r.DT_RowId,
          Name: r.name,
          Roadway: normalizeHighwayName(r.roadwayName),
          DirectionOfTravel: r.direction, // already "Northbound"/"Eastbound"/"Unknown" — matches convention directly
          Latitude: loc.lat,
          Longitude: loc.lon,
          Messages: parts.length ? parts : ['NO_MESSAGE'],
        };
      })
      .filter(s => s !== null);

    messageSigns = parsed;

    setDebug({
      dmsRecordCount: records.length,
      dmsParsedCount: parsed.length,
      dmsWithMessages: parsed.filter(s => s.Messages[0] !== 'NO_MESSAGE').length,
      dmsSample: parsed.filter(s => s.Messages[0] !== 'NO_MESSAGE').slice(0, 3),
    });
  } catch (err) {
    setDebug({ messageSigns: `fetch failed: ${err.message}` });
  }
}

// Fallback direction inference from a sign's name — kept for structural
// parity with VA/MD/DE, though 511PA's direction field is already
// reliable (see DirectionOfTravel above), so this should rarely fire.
function directionFromSignId(s) {
  const map = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound' };
  if (typeof s.Name !== 'string') return null;
  const name = s.Name.trim();
  const wordMatch = /\b(North|South|East|West)\b/i.exec(name);
  if (wordMatch) return map[wordMatch[1][0].toUpperCase()];
  const letterMatch = /([NSEW])\s*[)\]]*\s*$/i.exec(name);
  return letterMatch ? map[letterMatch[1].toUpperCase()] : null;
}

// Extracted from the old inline dirMatches()/roadway-check so both the
// live "closest sign" pick and manual ahead/behind browsing use the exact
// same eligibility rules — otherwise browsing could show a sign live
// detection would never have picked (or vice versa), which would be a
// confusing inconsistency.
function messageSignDirMatches(s) {
  if (!highwayDirectionLabel) return false; // our own direction isn't known yet — can't confirm
                                              // a directional sign applies to us, so don't show it
  const signDir = s.DirectionOfTravel;
  if (signDir && signDir !== 'None' && signDir !== 'Unknown') {
    if (signDir === 'All Directions' || signDir === 'Both Directions') return true;
    return signDir === highwayDirectionLabel;
  }
  // DirectionOfTravel is missing/None/Unknown — fall back to the sign ID's
  // trailing N/S/E/W letter instead of refusing to show the sign at all.
  const inferred = directionFromSignId(s);
  return inferred ? inferred === highwayDirectionLabel : false;
}

function messageSignRoadwayMatches(s) {
  return currentHighway.some(h => (s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
    || (s.Roadway || '').toUpperCase().includes(h));
}

// Direction+roadway-filtered, signed-distance-scored, sorted-nearest-first
// list of active (non-blank) message signs — shared basis for both the
// live "closest" pick and manual browsing. minDist/maxDist let callers use
// a tight window (live: a small negative buffer so a sign doesn't vanish
// the instant you pass it) or the full symmetric range (browsing: can page
// backward the same distance it can page forward), mirroring
// getScoredCameras() in 05_cameras.js.
function getScoredMessageSigns(lat, lon, minDist, maxDist) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length || !highwayDirectionLabel) return [];

  return messageSigns
    .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
    .filter(messageSignDirMatches)
    .filter(messageSignRoadwayMatches)
    .map(s => {
      const straightDist = haversineMeters(lat, lon, s.Latitude, s.Longitude);
      const bearingToSign = bearingDeg(lat, lon, s.Latitude, s.Longitude);
      const dist = lastStableBearing === null
        ? straightDist
        : straightDist * Math.cos(toRad(angleDiff(bearingToSign, lastStableBearing)));
      return { sign: s, dist };
    })
    .filter(c => c.dist >= minDist && c.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist);
}

function pickActiveMessageSign(lat, lon) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length) return null;

  if (highwayDirectionLabel) {
    const nearbyForDebug = messageSigns
      .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
      .map(s => ({ s, dist: haversineMeters(lat, lon, s.Latitude, s.Longitude) }))
      .filter(x => x.dist <= MSG_SIGN_RANGE_M)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)
      .map(x => ({
        raw: x.s, // full object — check this if the field name assumptions above are wrong
        Roadway: x.s.Roadway,
        DirectionOfTravel: x.s.DirectionOfTravel,
        inferredDirection: directionFromSignId(x.s),
        dirMatched: messageSignDirMatches(x.s),
        roadwayMatched: messageSignRoadwayMatches(x.s),
        distMi: Math.round(x.dist / 160.934) / 10,
      }));
    if (nearbyForDebug.length) {
      console.log('[DMS debug] our direction:', highwayDirectionLabel, 'currentHighway:', currentHighway, nearbyForDebug);
    }
  }

  const scored = getScoredMessageSigns(lat, lon, -SWAP_BUFFER_M, MSG_SIGN_RANGE_M);
  return scored.length ? scored[0] : null;
}

// ---------- Manual ahead/behind DMS browsing ----------
// Lets you page through message signs further out than the live nearest
// match, without changing what the live auto-detected banner (and its
// one-time speech) shows — mirrors the camera browse pattern in
// 06_browse.js. Snapshots the sign list at the moment you first press a
// button (using your last known position), then Ahead/Behind just walk an
// index through that snapshot. Only ever includes signs with an active
// message (a page full of "no message" signs would be clutter, not
// information) and stays direction-filtered, same eligibility rules as
// live detection via getScoredMessageSigns() above.
let msgBrowseActive = false;
let msgBrowseList = [];
let msgBrowseIndex = 0;

function enterMsgBrowseIfNeeded() {
  if (msgBrowseActive || !lastKnownPos) return false;
  // Uses BROWSE_RANGE_M (same ~50mi range camera browsing uses) rather
  // than the tighter MSG_SIGN_RANGE_M live-detection radius — browsing
  // should be able to scan as far ahead as camera browsing does; live
  // auto-detection stays at its original tighter range so a random sign
  // 50 miles out doesn't trigger the live banner/speech.
  const list = getScoredMessageSigns(lastKnownPos.lat, lastKnownPos.lon, -BROWSE_RANGE_M, BROWSE_RANGE_M);
  if (!list.length) return false;
  // Start browsing from whichever sign is currently closest to your actual
  // position, so the first tap moves logically forward/back from where
  // you already are rather than jumping to the list's edge.
  let closestIdx = 0, closestAbs = Infinity;
  list.forEach((s, i) => { const a = Math.abs(s.dist); if (a < closestAbs) { closestAbs = a; closestIdx = i; } });
  msgBrowseList = list;
  msgBrowseIndex = closestIdx;
  msgBrowseActive = true;
  return true;
}

function moveMsgAhead() {
  const justEntered = enterMsgBrowseIfNeeded();
  if (!msgBrowseActive) return;
  if (!justEntered) msgBrowseIndex = Math.min(msgBrowseIndex + 1, Math.max(0, msgBrowseList.length - 1));
  updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

function moveMsgBehind() {
  const justEntered = enterMsgBrowseIfNeeded();
  if (!msgBrowseActive) return;
  if (!justEntered) msgBrowseIndex = Math.max(msgBrowseIndex - 1, 0);
  updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

function exitMsgBrowse() {
  msgBrowseActive = false;
  msgBrowseList = [];
  msgBrowseIndex = 0;
  if (lastKnownPos) updateMessageBanner(lastKnownPos.lat, lastKnownPos.lon);
}

// Shows/hides the small ◀ Closest ▶ controls row. Kept deliberately
// minimal (mobile real estate) — hidden entirely unless there's at least
// one sign to browse to, so it adds zero footprint on quiet stretches of
// highway. The middle button is a static "Closest" label that returns to
// live tracking, matching the camera scan bar's "Closest Cam" button.
function renderMessageBrowseControls(hasBrowsableSigns) {
  const controls = document.getElementById('msg-scan-controls');
  if (!controls) return; // markup not present — degrade silently rather than throw
  const counter = document.getElementById('msg-scan-counter-btn');
  const behindBtn = document.getElementById('msg-scan-behind-btn');
  const aheadBtn = document.getElementById('msg-scan-ahead-btn');

  if (!hasBrowsableSigns && !msgBrowseActive) {
    controls.style.display = 'none';
    return;
  }
  controls.style.display = '';
  counter.textContent = 'Closest';
  counter.classList.toggle('active', msgBrowseActive);
  if (msgBrowseActive) {
    behindBtn.disabled = msgBrowseIndex <= 0;
    aheadBtn.disabled = msgBrowseIndex >= msgBrowseList.length - 1;
  } else {
    behindBtn.disabled = false; // live mode's arrows always just START browsing from here
    aheadBtn.disabled = false;
  }
}

function speakMessage(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel(); // don't stack overlapping announcements
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 0.95;
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn('Speech synthesis failed:', err);
  }
}

async function updateMessageBanner(lat, lon) {
  await fetchMessageSignsIfNeeded();

  const contentEl = document.getElementById('msg-banner-content') || msgBannerEl;

  let active, isLive, hasBrowsableSigns;
  if (msgBrowseActive) {
    active = msgBrowseList[msgBrowseIndex] || null;
    isLive = false;
    hasBrowsableSigns = msgBrowseList.length > 0;
  } else {
    active = pickActiveMessageSign(lat, lon);
    isLive = true;
    hasBrowsableSigns = getScoredMessageSigns(lat, lon, -BROWSE_RANGE_M, BROWSE_RANGE_M).length > 0;
  }

  renderMessageBrowseControls(hasBrowsableSigns);

  if (!active) {
    msgBannerEl.style.display = 'none';
    if (isLive) activeSignId = null;
    return;
  }

  const msgText = active.sign.Messages.join(' • ');
  contentEl.innerHTML = '';
  const main = document.createElement('div');
  main.textContent = msgText;
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = isLive
    ? `${formatDistance(Math.max(0, active.dist))} ahead`
    : `${formatDistance(Math.abs(active.dist))} ${active.dist >= 0 ? 'ahead' : 'behind'}`;
  contentEl.appendChild(main);
  contentEl.appendChild(meta);
  msgBannerEl.style.display = 'block';

  if (isLive) {
    const signKey = active.sign.Id + '::' + msgText;
    if (signKey !== activeSignId && msgText !== lastSpokenMessage) {
      speakMessage(msgText);
      lastSpokenMessage = msgText;
    }
    activeSignId = signKey;
  }
}
