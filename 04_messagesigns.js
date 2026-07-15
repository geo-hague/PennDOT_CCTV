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

function pickActiveMessageSign(lat, lon) {
  if (!messageSigns.length || !currentHighway || !currentHighway.length) return null;

  const dirMatches = (s) => {
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
  };

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
        dirMatched: dirMatches(x.s),
        roadwayMatched: currentHighway.some(h => (x.s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
          || (x.s.Roadway || '').toUpperCase().includes(h)),
        distMi: Math.round(x.dist / 160.934) / 10,
      }));
    if (nearbyForDebug.length) {
      console.log('[DMS debug] our direction:', highwayDirectionLabel, 'currentHighway:', currentHighway, nearbyForDebug);
    }
  }

  const candidates = messageSigns
    .filter(s => s.Messages && s.Messages.length && s.Messages[0] !== 'NO_MESSAGE')
    .filter(s => dirMatches(s))
    .filter(s => currentHighway.some(h => (s.Roadway || '').toUpperCase().includes(h.replace('-', ''))
      || (s.Roadway || '').toUpperCase().includes(h)))
    .map(s => {
      const straightDist = haversineMeters(lat, lon, s.Latitude, s.Longitude);
      const bearingToSign = bearingDeg(lat, lon, s.Latitude, s.Longitude);
      const dist = lastStableBearing === null
        ? straightDist
        : straightDist * Math.cos(toRad(angleDiff(bearingToSign, lastStableBearing)));
      return { sign: s, dist };
    })
    .filter(c => c.dist >= -SWAP_BUFFER_M && c.dist <= MSG_SIGN_RANGE_M);

  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.length ? candidates[0] : null;
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
  const active = pickActiveMessageSign(lat, lon);

  if (!active) {
    msgBannerEl.style.display = 'none';
    activeSignId = null;
    return;
  }

  const msgText = active.sign.Messages.join(' • ');
  msgBannerEl.innerHTML = '';
  const main = document.createElement('div');
  main.textContent = msgText;
  const meta = document.createElement('span');
  meta.className = 'msg-meta';
  meta.textContent = `${formatDistance(Math.max(0, active.dist))} ahead`;
  msgBannerEl.appendChild(main);
  msgBannerEl.appendChild(meta);
  msgBannerEl.style.display = 'block';

  // Speak only when this is a genuinely new sign/message, not every poll.
  const signKey = active.sign.Id + '::' + msgText;
  if (signKey !== activeSignId && msgText !== lastSpokenMessage) {
    speakMessage(msgText);
    lastSpokenMessage = msgText;
  }
  activeSignId = signKey;
}
