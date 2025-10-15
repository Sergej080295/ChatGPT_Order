#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://planner:planner@localhost:5432/planner';
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined
});

const SNAPSHOT_CATEGORY_STATE = 'state';
const SNAPSHOT_CATEGORY_META = 'meta';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeMetaForStorage(meta) {
  if (!isPlainObject(meta)) return null;
  const copy = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (value === null) {
      copy[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      copy[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      copy[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      try {
        copy[key] = JSON.parse(JSON.stringify(value));
      } catch (_err) {
        /* ignore */
      }
      continue;
    }
    if (isPlainObject(value)) {
      const nested = sanitizeMetaForStorage(value);
      if (nested !== null) {
        copy[key] = nested;
      }
    }
  }
  return Object.keys(copy).length ? copy : null;
}

function encodePathSegment(segment) {
  if (segment === null || segment === undefined) {
    return '';
  }
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function normalizePrimitiveForStorage(value) {
  if (value === null || value === undefined) {
    return { type: 'null', text: null, numeric: null, boolean: null };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', text: null, numeric: null, boolean: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { type: 'string', text: String(value), numeric: null, boolean: null };
    }
    return { type: 'number', text: null, numeric: value, boolean: null };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { type: 'string', text: '', numeric: null, boolean: null };
    }
    return { type: 'string', text: value.toISOString(), numeric: null, boolean: null };
  }
  if (typeof value === 'string') {
    return { type: 'string', text: value, numeric: null, boolean: null };
  }
  try {
    return { type: 'string', text: JSON.stringify(value), numeric: null, boolean: null };
  } catch (_err) {
    return { type: 'string', text: String(value), numeric: null, boolean: null };
  }
}

function flattenValueForStorage(value, pathSegments, rows, parentIsArray, ordinal) {
  const path = pathSegments.join('/');
  if (Array.isArray(value)) {
    rows.push({ path, type: 'array', ordinal: parentIsArray ? ordinal : 0, valueText: null, valueNumeric: null, valueBoolean: null });
    value.forEach((item, index) => {
      const next = pathSegments.slice();
      next.push(encodePathSegment(index));
      flattenValueForStorage(item, next, rows, true, index);
    });
    return;
  }
  if (isPlainObject(value)) {
    rows.push({ path, type: 'object', ordinal: parentIsArray ? ordinal : 0, valueText: null, valueNumeric: null, valueBoolean: null });
    Object.entries(value).forEach(([key, child]) => {
      const next = pathSegments.slice();
      next.push(encodePathSegment(key));
      flattenValueForStorage(child, next, rows, false, 0);
    });
    return;
  }
  const normalized = normalizePrimitiveForStorage(value);
  rows.push({
    path,
    type: normalized.type,
    ordinal: parentIsArray ? ordinal : 0,
    valueText: normalized.text,
    valueNumeric: normalized.numeric,
    valueBoolean: normalized.boolean
  });
}

function flattenObjectForStorage(source) {
  const rows = [];
  if (!isPlainObject(source)) {
    return rows;
  }
  Object.entries(source).forEach(([key, value]) => {
    flattenValueForStorage(value, [encodePathSegment(key)], rows, false, 0);
  });
  return rows;
}

async function persistSnapshotData(client, rev, snapshot, hash, meta) {
  const snapshotRows = flattenObjectForStorage(isPlainObject(snapshot) ? snapshot : {});
  await client.query(
    `INSERT INTO planner_snapshots (rev, hash)
     VALUES ($1,$2)
     ON CONFLICT (rev) DO UPDATE
       SET hash = EXCLUDED.hash,
           created_at = NOW()` ,
    [rev, hash]
  );
  await client.query(
    'DELETE FROM planner_snapshot_entries WHERE rev = $1 AND category = $2',
    [rev, SNAPSHOT_CATEGORY_STATE]
  );
  for (const row of snapshotRows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO planner_snapshot_entries (rev, category, path, value_type, value_text, value_numeric, value_boolean, ordinal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        rev,
        SNAPSHOT_CATEGORY_STATE,
        row.path,
        row.type,
        row.valueText,
        row.valueNumeric,
        row.valueBoolean,
        row.ordinal
      ]
    );
  }
  await client.query(
    'DELETE FROM planner_snapshot_entries WHERE rev = $1 AND category = $2',
    [rev, SNAPSHOT_CATEGORY_META]
  );
  const metaRows = flattenObjectForStorage(isPlainObject(meta) ? meta : {});
  for (const row of metaRows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO planner_snapshot_entries (rev, category, path, value_type, value_text, value_numeric, value_boolean, ordinal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        rev,
        SNAPSHOT_CATEGORY_META,
        row.path,
        row.type,
        row.valueText,
        row.valueNumeric,
        row.valueBoolean,
        row.ordinal
      ]
    );
  }
}

function computeSnapshotHash(stateString) {
  return crypto.createHash('sha1').update(stateString, 'utf8').digest('hex');
}

function normalizeExtraTimeSettings(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }
  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }
  if (!isPlainObject(snapshot.meta.settings)) {
    snapshot.meta.settings = {};
  }
  if (!isPlainObject(snapshot.meta.settings.extraTime)) {
    snapshot.meta.settings.extraTime = {};
  }
  const extra = snapshot.meta.settings.extraTime;
  const percent = Number.isFinite(extra.percent) ? extra.percent : 5;
  const minimum = Number.isFinite(extra.minimum) ? extra.minimum : 0.25;
  extra.percent = Math.max(0, Math.round(percent * 100) / 100);
  extra.minimum = Math.max(0, Math.round(minimum * 100) / 100);
  if (typeof extra.enabled !== 'boolean') {
    extra.enabled = extra.percent > 0 || extra.minimum > 0;
  }
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: import_legacy_snapshot.js <snapshot.json>');
    process.exit(1);
    return;
  }
  const filePath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let snapshot = {};
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse snapshot JSON', err);
    process.exit(1);
    return;
  }
  if (!isPlainObject(snapshot)) {
    console.error('Snapshot must be a JSON object');
    process.exit(1);
    return;
  }

  normalizeExtraTimeSettings(snapshot);
  const stateString = JSON.stringify(snapshot);
  const hash = computeSnapshotHash(stateString);
  const meta = sanitizeMetaForStorage({
    actor: 'import-script',
    source: 'legacy-import',
    note: 'Initial import'
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
    const rev = Number(rows[0]?.rev || 0);
    if (!Number.isFinite(rev) || rev <= 0) {
      throw new Error('Failed to allocate revision number');
    }
    await client.query(
      'INSERT INTO revisions (rev, actor, source, note) VALUES ($1,$2,$3,$4)',
      [rev, 'import-script', 'legacy-import', 'Initial import']
    );
    await client.query('SELECT set_config($1,$2,false)', ['app.rev', String(rev)]);
    await persistSnapshotData(client, rev, snapshot, hash, meta);
    await client.query('COMMIT');
    console.log(`Snapshot imported as revision ${rev}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
