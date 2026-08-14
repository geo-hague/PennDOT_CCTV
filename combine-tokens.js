// combine-tokens.js (PA) — unions the per-shard token files (downloaded into
// ./parts) into a single tokens.json committed to the repo. The app fetches
// this at load time and joins by chan.
const fs = require('fs');
const path = require('path');
const dir = process.env.PARTS_DIR || 'parts';
const all = {};
let files = 0;
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json')) {
      try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); for (const en of (j.entries || [])) if (en.chan) all[en.chan] = en; files++; } catch (e) {}
    }
  }
}
if (fs.existsSync(dir)) walk(dir);
const entries = Object.values(all);
fs.writeFileSync('docs/tokens.json', JSON.stringify({ updated: new Date().toISOString(), count: entries.length, entries }, null, 2), 'utf8');
console.log(`Combined ${entries.length} tokens from ${files} shard files -> tokens.json`);
