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
const GENERAL_SETTINGS_TABLE = 'planner_general_settings';
const GENERAL_PREFERENCE_KEYS = [
  'autosaveOn',
  'autoOptimizeOn',
  'cascadeReadyOn',
  'shiftOnProgress',
  'priorityChangeLoggingOn',
  'routeDateChangeLoggingOn',
  'notificationsMuted'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneDeepPlain(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeepPlain(item));
  }
  if (isPlainObject(value)) {
    const result = {};
    Object.entries(value).forEach(([key, child]) => {
      result[key] = cloneDeepPlain(child);
    });
    return result;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time);
  }
  return value;
}

function normalizePreferenceValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const lowered = trimmed.toLowerCase();
    if (['true', 'yes', 'on', 'y'].includes(lowered)) {
      return true;
    }
    if (['false', 'no', 'off', 'n'].includes(lowered)) {
      return false;
    }
    if (lowered === '1') {
      return true;
    }
    if (lowered === '0') {
      return false;
    }
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return numeric !== 0;
    }
    return null;
  }
  if (typeof value === 'bigint') {
    return value !== 0n;
  }
  return Boolean(value);
}

function extractGeneralSettingsForStorage(snapshot, meta = null) {
  if (!isPlainObject(snapshot)) {
    return { hasSettings: false, payload: null, meta: isPlainObject(meta) ? meta : null };
  }

  const workingMeta = isPlainObject(meta) ? cloneDeepPlain(meta) : null;
  let settings = null;

  if (Object.prototype.hasOwnProperty.call(snapshot, 'settings')) {
    const rootValue = snapshot.settings;
    delete snapshot.settings;
    if (isPlainObject(rootValue)) {
      settings = rootValue;
    } else if (rootValue === null || rootValue === undefined) {
      settings = null;
    }
  }

  if (isPlainObject(snapshot.meta) && Object.prototype.hasOwnProperty.call(snapshot.meta, 'settings')) {
    const metaValue = snapshot.meta.settings;
    delete snapshot.meta.settings;
    if (isPlainObject(metaValue)) {
      settings = metaValue;
    } else if (metaValue === null || metaValue === undefined) {
      settings = null;
    }
  }

  if (isPlainObject(workingMeta) && Object.prototype.hasOwnProperty.call(workingMeta, 'settings')) {
    const storedValue = workingMeta.settings;
    delete workingMeta.settings;
    if (isPlainObject(storedValue)) {
      settings = storedValue;
    } else if (storedValue === null || storedValue === undefined) {
      settings = null;
    }
  }

  const preferences = {};
  const preferenceSources = [
    snapshot,
    isPlainObject(snapshot.meta) ? snapshot.meta : null,
    workingMeta
  ];

  GENERAL_PREFERENCE_KEYS.forEach((key) => {
    let valueFound = null;
    preferenceSources.forEach((source) => {
      if (!isPlainObject(source) || !Object.prototype.hasOwnProperty.call(source, key)) {
        return;
      }
      const normalized = normalizePreferenceValue(source[key]);
      if (normalized !== null) {
        valueFound = normalized;
      }
      delete source[key];
    });
    if (valueFound !== null) {
      preferences[key] = valueFound;
    }
  });

  const payload = {};
  if (settings === null) {
    payload.settings = null;
  } else if (isPlainObject(settings)) {
    payload.settings = cloneDeepPlain(settings);
  }
  if (Object.keys(preferences).length) {
    payload.preferences = preferences;
  }

  const hasSettings = Boolean(
    (payload.settings && isPlainObject(payload.settings) && Object.keys(payload.settings).length)
    || payload.settings === null
    || Object.keys(preferences).length
  );

  return {
    hasSettings,
    payload: hasSettings ? payload : null,
    meta: workingMeta
  };
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

function sanitizeGeneralPreferences(preferences) {
  if (!isPlainObject(preferences)) {
    return null;
  }
  const sanitized = {};
  GENERAL_PREFERENCE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(preferences, key)) {
      return;
    }
    const normalized = normalizePreferenceValue(preferences[key]);
    if (normalized !== null) {
      sanitized[key] = normalized;
    }
  });
  return Object.keys(sanitized).length ? sanitized : null;
}

function sanitizeGeneralSettingsPayload(payload) {
  if (!isPlainObject(payload)) {
    return null;
  }

  let sanitizedSettings = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'settings')) {
    if (payload.settings === null) {
      sanitizedSettings = null;
    } else {
      const candidate = sanitizeMetaForStorage(payload.settings);
      if (isPlainObject(candidate) && Object.keys(candidate).length) {
        sanitizedSettings = candidate;
      }
    }
  } else {
    const candidate = sanitizeMetaForStorage(payload);
    if (isPlainObject(candidate) && Object.keys(candidate).length) {
      sanitizedSettings = candidate;
    }
  }

  const sanitizedPreferences = sanitizeGeneralPreferences(payload.preferences);

  if (sanitizedSettings === null && !sanitizedPreferences) {
    return null;
  }

  return {
    settings: sanitizedSettings,
    preferences: sanitizedPreferences
  };
}

async function persistGeneralSettings(client, payload, options = {}) {
  const hasSettings = Boolean(options?.hasSettings);
  if (!hasSettings) {
    return;
  }

  const sanitizedPayload = sanitizeGeneralSettingsPayload(payload || {});
  await client.query(`DELETE FROM ${GENERAL_SETTINGS_TABLE}`);

  if (!sanitizedPayload) {
    return;
  }

  const combined = {};
  if (sanitizedPayload.settings) {
    Object.assign(combined, sanitizedPayload.settings);
  }
  if (sanitizedPayload.preferences) {
    combined.preferences = sanitizedPayload.preferences;
  }

  if (!Object.keys(combined).length) {
    return;
  }

  const rows = flattenObjectForStorage(combined);
  const actorValue = options?.actor ? String(options.actor).trim() || null : null;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${GENERAL_SETTINGS_TABLE} (path, value_type, value_text, value_numeric, value_boolean, ordinal, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.path,
        row.type,
        row.valueText,
        row.valueNumeric,
        row.valueBoolean,
        row.ordinal,
        actorValue
      ]
    );
  }
}

async function persistSnapshotData(client, rev, snapshot, hash, meta, options = {}) {
  const snapshotSource = isPlainObject(snapshot) ? snapshot : {};
  const workingSnapshot = cloneDeepPlain(snapshotSource);
  const extraction = extractGeneralSettingsForStorage(workingSnapshot, meta);
  const { hasSettings, payload, meta: cleanedMeta } = extraction;
  const snapshotRows = flattenObjectForStorage(workingSnapshot);
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
  const metaRows = flattenObjectForStorage(isPlainObject(cleanedMeta) ? cleanedMeta : {});
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

  await persistGeneralSettings(client, payload, { hasSettings, actor: options?.actor || null });
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
    await persistSnapshotData(client, rev, snapshot, hash, meta, { actor: 'import-script' });
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
