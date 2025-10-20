#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INPUT_PATH = process.argv[2];
if (!INPUT_PATH) {
  console.error('Usage: node scripts/import_legacy_snapshot.js <snapshot.json>');
  process.exit(1);
}

const resolved = path.resolve(INPUT_PATH);
let raw;
try {
  raw = fs.readFileSync(resolved, 'utf8');
} catch (err) {
  console.error(`Failed to read snapshot file: ${resolved}`);
  console.error(err.message || err);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error('Snapshot file is not valid JSON');
  console.error(err.message || err);
  process.exit(1);
}

const snapshot = parsed && typeof parsed === 'object' && parsed.snapshot && typeof parsed.snapshot === 'object'
  ? parsed.snapshot
  : parsed;
if (!snapshot || typeof snapshot !== 'object') {
  console.error('Snapshot payload must be an object');
  process.exit(1);
}

const stateString = JSON.stringify(snapshot);
const hash = crypto.createHash('sha1').update(stateString, 'utf8').digest('hex');
const rev = Number(parsed.rev) && Number(parsed.rev) > 0 ? Number(parsed.rev) : 0;
const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : null;

const dataDir = path.resolve(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const statePath = path.join(dataDir, 'planner-state.json');
const payload = {
  rev,
  snapshot,
  stateString,
  hash,
  meta,
  savedAt: new Date().toISOString(),
  savedBy: {
    actor: 'legacy-import',
    source: 'legacy-json',
    note: path.basename(resolved),
    channel: null
  }
};

fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Snapshot imported to ${statePath}`);
