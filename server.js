'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const DEFAULT_DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';
const PGPOOL_MAX = Number.parseInt(process.env.PGPOOL_MAX || '10', 10);
const PGPOOL_IDLE = Number.parseInt(process.env.PGPOOL_IDLE || '30000', 10);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
  max: Number.isFinite(PGPOOL_MAX) && PGPOOL_MAX > 0 ? PGPOOL_MAX : 10,
  idleTimeoutMillis: Number.isFinite(PGPOOL_IDLE) && PGPOOL_IDLE >= 0 ? PGPOOL_IDLE : 30000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error', err);
});

const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb', strict: false }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'application/octet-stream'] }));

const sseClients = new Set();
let cachedSnapshot = null;
let lastRevision = 0;
let revisionColumnInfo = null;

const PG_UNDEFINED_TABLE = '42P01';
const DEFAULT_EXTRA_PERCENT = 5;
const DEFAULT_EXTRA_MINIMUM = 0.25;
const SNAPSHOT_CATEGORY_STATE = 'state';
const SNAPSHOT_CATEGORY_META = 'meta';

function normalizeWeakEtag(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const hasWeak = trimmed.length >= 2 && (trimmed[0] === 'W' || trimmed[0] === 'w') && trimmed[1] === '/';
  const withoutWeak = hasWeak ? trimmed.slice(2) : trimmed;
  const stripped = withoutWeak.replace(/^"|"$/g, '');
  return stripped || null;
}

function extractHashFromHeader(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(',')
    .map((token) => normalizeWeakEtag(token))
    .find((token) => token && token !== '*')
    || null;
}

function parseIfMatchHeader(value) {
  if (!value) {
    return { any: false, hash: null };
  }
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') {
      return { any: true, hash: null };
    }
    const normalized = normalizeWeakEtag(token);
    if (normalized && normalized !== '*') {
      return { any: false, hash: normalized };
    }
  }
  return { any: false, hash: null };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function computeSnapshotHash(stateString) {
  return crypto.createHash('sha1').update(stateString, 'utf8').digest('hex');
}

function buildEmptySnapshot() {
  return {
    routeOverrides: [],
    t: [],
    done: [],
    trash: [],
    exc: [],
    res: [],
    process: 'bend',
    capByProc: {},
    parallelByProc: {},
    filter: '',
    locked: [],
    orders: [],
    freshness: '',
    freshnessCsv: '',
    freshnessManual: '',
    lastImportTime: '',
    lastManualTime: '',
    autosaveOn: true,
    autoOptimizeOn: true,
    cascadeReadyOn: true,
    priorityChangeLoggingOn: false,
    routeDateChangeLoggingOn: false,
    notificationsMuted: false,
    crm: { boards: [], currentBoardId: null },
    shiftOnProgress: true,
    ignoredStates: [],
    meta: {
      versions: {},
      lastAuthors: {},
      csvTimestamp: '',
      manualTimestamp: '',
      history: [],
      settings: {
        capacity: {},
        parallel: {},
        tableColumns: {},
        extraTime: { percent: DEFAULT_EXTRA_PERCENT, minimum: DEFAULT_EXTRA_MINIMUM },
        crmStageMapping: {},
        logLimit: 50,
        admin: { allowForceOverwrite: false, snapshotRetention: 50 },
        updatedAt: ''
      },
      ignoredStates: [],
      storage: { local: false, remote: true, remotePreferred: true, mode: 'remote' }
    },
    modeScoped: {}
  };
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort()
    .map((filename) => ({
      filename,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
    }));
}

async function runMigrations() {
  resetOrdersTableInfo();
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = readMigrations();
    for (const migration of migrations) {
      const { rows } = await client.query('SELECT 1 FROM planner_schema_migrations WHERE filename = $1', [migration.filename]);
      if (rows.length > 0) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await ensureMigrationRevision(client);
        await client.query(migration.sql);
        await client.query('INSERT INTO planner_schema_migrations (filename) VALUES ($1)', [migration.filename]);
        await client.query('COMMIT');
        console.log(`Applied migration ${migration.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function getLatestRevision(client) {
  const runner = client || pool;
  const { rows } = await runner.query('SELECT COALESCE(MAX(rev), 0) AS rev FROM revisions');
  const rev = rows.length > 0 ? Number(rows[0].rev || 0) : 0;
  lastRevision = Math.max(lastRevision, rev);
  return rev;
}

async function loadRevisionColumnInfo(runner) {
  if (revisionColumnInfo) {
    return revisionColumnInfo;
  }
  const client = runner || pool;
  const { rows } = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'revisions'
  `);
  const columnNames = rows.map((row) => row.column_name);
  revisionColumnInfo = {
    hasCurrentRev: columnNames.includes('current_rev'),
    hasId: columnNames.includes('id')
  };
  return revisionColumnInfo;
}

async function insertRevisionRow(client, rev, actor, source, note) {
  const info = await loadRevisionColumnInfo(client);
  const actorValue = actor || null;
  const sourceValue = source || null;
  const noteValue = note || null;

  if (info.hasCurrentRev) {
    if (info.hasId) {
      await client.query(
        'INSERT INTO revisions (id, rev, current_rev, actor, source, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [rev, rev, rev, actorValue, sourceValue, noteValue]
      );
    } else {
      await client.query(
        'INSERT INTO revisions (rev, current_rev, actor, source, note) VALUES ($1,$2,$3,$4,$5)',
        [rev, rev, actorValue, sourceValue, noteValue]
      );
    }
  } else if (info.hasId) {
    await client.query(
      'INSERT INTO revisions (id, rev, actor, source, note) VALUES ($1,$2,$3,$4,$5)',
      [rev, rev, actorValue, sourceValue, noteValue]
    );
  } else {
    await client.query(
      'INSERT INTO revisions (rev, actor, source, note) VALUES ($1,$2,$3,$4)',
      [rev, actorValue, sourceValue, noteValue]
    );
  }
}

async function ensureMigrationRevision(client) {
  const { rows: regRows } = await client.query("SELECT to_regclass('public.revisions') AS oid");
  if (!regRows.length || regRows[0].oid === null) {
    return;
  }

  await loadRevisionColumnInfo(client);

  let rev = null;
  const { rows: maxRows } = await client.query('SELECT MAX(rev) AS rev FROM revisions');
  if (maxRows.length && maxRows[0].rev !== null) {
    const candidate = Number(maxRows[0].rev);
    if (Number.isFinite(candidate) && candidate > 0) {
      rev = candidate;
    }
  }

  if (rev === null) {
    let nextRev = null;
    const { rows: seqRows } = await client.query("SELECT to_regclass('public.revisions_rev_seq') AS oid");
    if (seqRows.length && seqRows[0].oid !== null) {
      const { rows: nextRows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
      if (nextRows.length && nextRows[0].rev !== null) {
        nextRev = Number(nextRows[0].rev);
      }
    }
    if (!Number.isFinite(nextRev) || nextRev <= 0) {
      nextRev = 1;
    }
    rev = nextRev;
    await insertRevisionRow(
      client,
      rev,
      'system',
      'migration-bootstrap',
      'auto-generated revision for pending migrations'
    );
  }

  lastRevision = Math.max(lastRevision, rev);
  await client.query('SELECT set_config($1, $2, true)', ['app.rev', String(rev)]);
}

async function loadLatestSnapshot(runner) {
  const client = runner || pool;
  const { rows } = await client.query(
    'SELECT rev FROM planner_snapshots ORDER BY rev DESC, created_at DESC LIMIT 1'
  );
  if (!rows.length) {
    return null;
  }
  const rev = Number(rows[0].rev || 0);
  if (!Number.isFinite(rev) || rev <= 0) {
    return null;
  }
  return loadSnapshotRevision(client, rev);
}

async function getCachedSnapshot() {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const latest = await loadLatestSnapshot();
  if (latest) {
    lastRevision = Math.max(lastRevision, latest.rev);
    cachedSnapshot = latest;
    return cachedSnapshot;
  }
  const empty = buildEmptySnapshot();
  const stateString = JSON.stringify(empty);
  const hash = computeSnapshotHash(stateString);
  cachedSnapshot = { rev: 0, snapshot: empty, stateString, hash, meta: null };
  return cachedSnapshot;
}

function invalidateCache() {
  cachedSnapshot = null;
}

function broadcastRevision(event) {
  const payload = JSON.stringify({ type: 'revision', ...event });
  sseClients.forEach((client) => {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.warn('Failed to push SSE event', err);
    }
  });
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
      const trimmed = value.trim();
      copy[key] = trimmed;
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
        /* ignore unserializable values */
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

function valuesEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!valuesEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!valuesEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function diffSnapshotValue(current, next) {
  if (valuesEqual(current, next)) {
    return undefined;
  }
  if (Array.isArray(current) && Array.isArray(next)) {
    return next;
  }
  if (isPlainObject(current) && isPlainObject(next)) {
    const diff = {};
    const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
    for (const key of keys) {
      const delta = diffSnapshotValue(
        current ? current[key] : undefined,
        next ? next[key] : undefined
      );
      if (delta !== undefined) {
        diff[key] = delta;
      }
    }
    return Object.keys(diff).length ? diff : undefined;
  }
  if (next === undefined) {
    return null;
  }
  return next;
}

function buildSnapshotDiff(current, next) {
  const delta = diffSnapshotValue(current || {}, next || {});
  if (delta === undefined || delta === null) {
    return null;
  }
  if (isPlainObject(delta) && !Object.keys(delta).length) {
    return null;
  }
  return delta;
}

function computeEtag(hash) {
  const normalized = hash ? String(hash).trim() : '';
  if (!normalized) return null;
  return normalized.startsWith('W/') ? normalized : `W/"${normalized}"`;
}

function encodePathSegment(segment) {
  if (segment === null || segment === undefined) {
    return '';
  }
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function decodePathSegment(segment) {
  if (!segment) {
    return '';
  }
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
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
  if (typeof value === 'bigint') {
    return { type: 'string', text: value.toString(), numeric: null, boolean: null };
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

function flattenValueForStorage(value, path, rows, parentIsArray, ordinal) {
  if (!path && !parentIsArray) {
    return;
  }
  if (Array.isArray(value)) {
    rows.push({ path, type: 'array', ordinal: parentIsArray ? ordinal : 0, valueText: null, valueNumeric: null, valueBoolean: null });
    value.forEach((item, index) => {
      const childPath = path
        ? `${path}/${encodePathSegment(index)}`
        : encodePathSegment(index);
      flattenValueForStorage(item, childPath, rows, true, index);
    });
    return;
  }
  if (isPlainObject(value)) {
    rows.push({ path, type: 'object', ordinal: parentIsArray ? ordinal : 0, valueText: null, valueNumeric: null, valueBoolean: null });
    Object.entries(value).forEach(([key, child]) => {
      const childPath = path
        ? `${path}/${encodePathSegment(key)}`
        : encodePathSegment(key);
      flattenValueForStorage(child, childPath, rows, false, 0);
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
    const path = encodePathSegment(key);
    flattenValueForStorage(value, path, rows, false, 0);
  });
  return rows;
}

function finalizeStructure(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => finalizeStructure(entry === undefined ? null : entry));
  }
  if (isPlainObject(value)) {
    const result = {};
    Object.keys(value).forEach((key) => {
      result[key] = finalizeStructure(value[key]);
    });
    return result;
  }
  return value === undefined ? null : value;
}

function buildObjectFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return {};
  }
  const valueMap = new Map();
  valueMap.set('', { type: 'object', value: {} });

  const sorted = rows
    .slice()
    .sort((a, b) => {
      const depthA = a.path ? a.path.split('/').length : 0;
      const depthB = b.path ? b.path.split('/').length : 0;
      if (depthA !== depthB) {
        return depthA - depthB;
      }
      if (a.path === b.path) {
        return a.ordinal - b.ordinal;
      }
      return a.path < b.path ? -1 : 1;
    });

  sorted.forEach((row) => {
    const path = row.path || '';
    if (!path) {
      if (row.value_type === 'array') {
        valueMap.set('', { type: 'array', value: [] });
      } else if (row.value_type === 'object') {
        valueMap.set('', { type: 'object', value: {} });
      }
      return;
    }
    if (row.value_type === 'object') {
      valueMap.set(path, { type: 'object', value: {} });
    } else if (row.value_type === 'array') {
      valueMap.set(path, { type: 'array', value: [] });
    } else if (row.value_type === 'number') {
      valueMap.set(path, { type: 'number', value: row.value_numeric });
    } else if (row.value_type === 'boolean') {
      valueMap.set(path, { type: 'boolean', value: row.value_boolean === null ? false : !!row.value_boolean });
    } else if (row.value_type === 'null') {
      valueMap.set(path, { type: 'null', value: null });
    } else {
      valueMap.set(path, { type: 'string', value: row.value_text == null ? '' : row.value_text });
    }
  });

  const entries = Array.from(valueMap.entries()).sort((a, b) => {
    const depthA = a[0] ? a[0].split('/').length : 0;
    const depthB = b[0] ? b[0].split('/').length : 0;
    return depthB - depthA;
  });

  entries.forEach(([path, entry]) => {
    if (!path) {
      return;
    }
    const segments = path.split('/');
    const parentSegments = segments.slice(0, -1);
    const keySegment = decodePathSegment(segments[segments.length - 1]);
    const parentPath = parentSegments.join('/');
    const parentEntry = valueMap.get(parentPath);
    if (!parentEntry) {
      return;
    }
    if (parentEntry.type === 'array') {
      const index = Number(keySegment);
      if (!Array.isArray(parentEntry.value)) {
        parentEntry.value = [];
      }
      parentEntry.value[index] = entry.value;
    } else if (isPlainObject(parentEntry.value)) {
      parentEntry.value[keySegment] = entry.value;
    }
  });

  const rootEntry = valueMap.get('');
  return finalizeStructure(rootEntry ? rootEntry.value : {});
}

async function loadEntriesForCategory(runner, rev, category, paths = null) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  const params = [rev, category];
  let sql = `
    SELECT path, value_type, value_text, value_numeric, value_boolean, ordinal
      FROM planner_snapshot_entries
     WHERE rev = $1
       AND category = $2
  `;
  if (Array.isArray(paths) && paths.length > 0) {
    const offset = params.length;
    const clauses = paths
      .map((_, idx) => `(path = $${offset + idx + 1} OR path LIKE ($${offset + idx + 1} || '/%'))`)
      .join(' OR ');
    sql += ` AND (${clauses})`;
    params.push(...paths);
  }
  sql += ' ORDER BY char_length(path), path, ordinal';
  const { rows } = await executor.query(sql, params);
  return rows;
}

async function loadSnapshotDataObject(runner, rev, paths = null) {
  const rows = await loadEntriesForCategory(runner, rev, SNAPSHOT_CATEGORY_STATE, paths);
  if (!rows.length) {
    return {};
  }
  return buildObjectFromRows(rows);
}

async function loadSnapshotMetaObject(runner, rev) {
  const rows = await loadEntriesForCategory(runner, rev, SNAPSHOT_CATEGORY_META);
  if (!rows.length) {
    return null;
  }
  const meta = buildObjectFromRows(rows);
  return Object.keys(meta).length ? meta : null;
}

async function persistSnapshotData(client, rev, snapshot, hash, meta) {
  const safeSnapshot = isPlainObject(snapshot) ? snapshot : {};
  const snapshotRows = flattenObjectForStorage(safeSnapshot);
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
  if (isPlainObject(meta)) {
    const metaRows = flattenObjectForStorage(meta);
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
}

async function loadSnapshotRevision(runner, rev) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  const { rows } = await executor.query(
    'SELECT rev, hash FROM planner_snapshots WHERE rev = $1',
    [rev]
  );
  if (!rows.length) {
    return null;
  }
  const data = await loadSnapshotDataObject(executor, rev);
  const meta = await loadSnapshotMetaObject(executor, rev);
  const stateObject = isPlainObject(data) ? data : {};
  const stateString = JSON.stringify(stateObject);
  const hash = rows[0].hash || computeSnapshotHash(stateString);
  return {
    rev: Number(rows[0].rev || rev),
    snapshot: stateObject,
    stateString,
    hash,
    meta
  };
}

async function loadMetadataForRevisions(runner, revs) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  const unique = Array.from(new Set((revs || []).map((rev) => Number(rev)).filter((rev) => Number.isFinite(rev) && rev > 0)));
  if (!unique.length) {
    return new Map();
  }
  const { rows } = await executor.query(
    `SELECT rev, path, value_type, value_text, value_numeric, value_boolean, ordinal
       FROM planner_snapshot_entries
      WHERE category = $1
        AND rev = ANY($2::bigint[])
      ORDER BY rev, char_length(path), path, ordinal`,
    [SNAPSHOT_CATEGORY_META, unique]
  );
  const grouped = new Map();
  rows.forEach((row) => {
    const rev = Number(row.rev || 0);
    if (!grouped.has(rev)) {
      grouped.set(rev, []);
    }
    grouped.get(rev).push(row);
  });
  const result = new Map();
  grouped.forEach((list, rev) => {
    result.set(rev, buildObjectFromRows(list));
  });
  return result;
}


function normalizeRequestMeta(rawMeta) {
  const response = {
    actor: null,
    source: null,
    note: null,
    summary: null,
    meta: null,
    concurrency: {
      baseHash: null,
      baseEtag: null,
      forceOverwrite: false
    }
  };
  if (!isPlainObject(rawMeta)) {
    return response;
  }

  const working = { ...rawMeta };

  if (working.forceOverwrite === true || working.force === true) {
    response.concurrency.forceOverwrite = true;
  }

  if (typeof working.baseHash === 'string') {
    const trimmed = working.baseHash.trim();
    if (trimmed) {
      response.concurrency.baseHash = trimmed;
    }
  }
  if (typeof working.baseEtag === 'string') {
    const trimmed = working.baseEtag.trim();
    if (trimmed) {
      response.concurrency.baseEtag = trimmed;
    }
  }

  delete working.baseHash;
  delete working.baseEtag;
  delete working.forceOverwrite;
  delete working.force;
  delete working.ifMatch;

  const actor = sanitizeString(working.actor || working.user || working.username || working.owner);
  const source = sanitizeString(working.source || working.changeType || working.stage || working.reason);
  const note = sanitizeString(working.note || working.comment);
  const summary = sanitizeString(working.summary || working.description || working.message);

  if (actor) {
    response.actor = actor;
    working.actor = actor;
  }
  if (source) {
    response.source = source;
    working.source = source;
  }
  if (note) {
    response.note = note;
    working.note = note;
  } else {
    delete working.note;
  }
  if (summary) {
    response.summary = summary;
    working.summary = summary;
  } else {
    delete working.summary;
  }

  response.meta = sanitizeMetaForStorage(working);
  return response;
}

function extractSnapshotPayload(body) {
  if (body === null || body === undefined) {
    throw new Error('Empty payload');
  }

  let stateSource = body;
  let meta = null;

  if (Buffer.isBuffer(body)) {
    stateSource = body.toString('utf8');
  }

  if (typeof stateSource === 'string') {
    const trimmed = stateSource.trim();
    if (!trimmed) {
      throw new Error('Snapshot payload is empty');
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        snapshot: parsed,
        stateString: JSON.stringify(parsed),
        requestMeta: null
      };
    } catch (err) {
      throw new Error('Snapshot payload must be valid JSON');
    }
  }

  if (isPlainObject(stateSource) && Object.prototype.hasOwnProperty.call(stateSource, 'state')) {
    stateSource = stateSource.state;
  }

  if (isPlainObject(body) && body.meta !== undefined) {
    meta = body.meta;
  }

  if (typeof stateSource === 'string') {
    const trimmed = stateSource.trim();
    if (!trimmed) {
      throw new Error('Snapshot payload is empty');
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        snapshot: parsed,
        stateString: JSON.stringify(parsed),
        requestMeta: meta
      };
    } catch (err) {
      throw new Error('Snapshot payload must be valid JSON');
    }
  }

  if (isPlainObject(stateSource)) {
    return {
      snapshot: stateSource,
      stateString: JSON.stringify(stateSource),
      requestMeta: meta
    };
  }

  throw new Error('Unsupported snapshot payload');
}

function extractHistorySummary(meta) {
  if (!isPlainObject(meta)) return null;
  if (typeof meta.summary === 'string' && meta.summary.trim()) return meta.summary.trim();
  if (typeof meta.note === 'string' && meta.note.trim()) return meta.note.trim();
  if (isPlainObject(meta.diff) && typeof meta.diff.summary === 'string' && meta.diff.summary.trim()) {
    return meta.diff.summary.trim();
  }
  if (typeof meta.changeType === 'string' && meta.changeType.trim()) {
    return meta.changeType.trim();
  }
  return null;
}

function safeSerializeSnapshot(snapshot, stateString = null) {
  if (typeof stateString === 'string') {
    const trimmed = stateString.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch (err) {
        console.warn('Failed to validate provided snapshot string, will re-stringify object', err);
      }
    }
  }

  if (typeof snapshot === 'string') {
    const trimmed = snapshot.trim();
    if (!trimmed) {
      return '{}';
    }
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch (err) {
      console.warn('Snapshot string payload is invalid JSON, returning empty snapshot', err);
      return '{}';
    }
  }

  try {
    return JSON.stringify(snapshot ?? {});
  } catch (err) {
    console.error('Failed to serialize snapshot payload, falling back to empty object', err);
    return '{}';
  }
}

function normalizeExtraTimeSettings(snapshot, override = null) {
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
  const overridePercent = override && Number.isFinite(override.percent)
    ? override.percent
    : null;
  const overrideMinimum = override && Number.isFinite(override.minimum)
    ? override.minimum
    : null;

  const percentSource = overridePercent !== null
    ? overridePercent
    : Number(extra.percent);
  const minimumSource = overrideMinimum !== null
    ? overrideMinimum
    : Number(extra.minimum);

  const normalizedPercent = Number.isFinite(percentSource)
    ? Math.max(0, Math.round(percentSource * 100) / 100)
    : DEFAULT_EXTRA_PERCENT;
  const normalizedMinimum = Number.isFinite(minimumSource)
    ? Math.max(0, Math.round(minimumSource * 100) / 100)
    : DEFAULT_EXTRA_MINIMUM;

  extra.percent = normalizedPercent;
  extra.minimum = normalizedMinimum;
  if (override && override.enabled !== null) {
    extra.enabled = Boolean(override.enabled);
  } else if (typeof extra.enabled !== 'boolean') {
    extra.enabled = normalizedPercent > 0 || normalizedMinimum > 0;
  }
}

async function runWithRevision(actor, source, note, handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
    const rev = Number(rows[0]?.rev || 0);
    if (!Number.isFinite(rev) || rev <= 0) {
      throw new Error('Failed to allocate revision number');
    }
    await insertRevisionRow(client, rev, actor || null, source || null, note || null);
    await client.query('SELECT set_config($1,$2,false)', ['app.rev', String(rev)]);
    const result = await handler(client, rev);
    await client.query('COMMIT');
    lastRevision = Math.max(lastRevision, rev);
    return { rev, result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SAVE_LOG_PREFIX = '[SaveService]';

function logSaveEvent(level, message, context = {}) {
  if (level !== 'warn' && level !== 'error') {
    return;
  }
  const payload = { ...context };
  const log = level === 'error' ? console.error : console.warn;
  log(`${SAVE_LOG_PREFIX} ${message}`, payload);
}

async function persistSnapshotWithSql(options) {
  const {
    actor,
    source,
    note,
    snapshot,
    stateString = null,
    hash = null,
    meta = null
  } = options || {};

  let parsedSnapshot = null;
  if (isPlainObject(snapshot)) {
    try {
      parsedSnapshot = JSON.parse(JSON.stringify(snapshot));
    } catch (_err) {
      parsedSnapshot = { ...snapshot };
    }
  } else if (typeof stateString === 'string') {
    const trimmed = stateString.trim();
    if (trimmed) {
      try {
        parsedSnapshot = JSON.parse(trimmed);
      } catch (_err) {
        parsedSnapshot = {};
      }
    } else {
      parsedSnapshot = {};
    }
  } else if (typeof snapshot === 'string') {
    const trimmed = snapshot.trim();
    if (trimmed) {
      try {
        parsedSnapshot = JSON.parse(trimmed);
      } catch (_err) {
        parsedSnapshot = {};
      }
    } else {
      parsedSnapshot = {};
    }
  }

  if (!isPlainObject(parsedSnapshot)) {
    parsedSnapshot = {};
  }

  normalizeExtraTimeSettings(parsedSnapshot);

  const serialized = safeSerializeSnapshot(parsedSnapshot);
  const storedMeta = sanitizeMetaForStorage(meta);
  const normalizedHash = computeSnapshotHash(serialized);
  if (hash && hash !== normalizedHash) {
    logSaveEvent('warn', 'provided hash does not match normalized snapshot', { expected: normalizedHash, provided: hash });
  }
  const effectiveHash = normalizedHash;

  const { rev, result } = await runWithRevision(actor, source, note, async (client, nextRev) => {
    await persistSnapshotData(client, nextRev, parsedSnapshot, effectiveHash, storedMeta);
    return await loadSnapshotRevision(client, nextRev);
  });

  if (result && Number(result.rev || 0) === rev) {
    return result;
  }

  return {
    rev,
    snapshot: parsedSnapshot,
    stateString: serialized,
    hash: effectiveHash,
    meta: storedMeta
  };
}

function mapHistoryRow(row, meta = null) {
  const metaObj = isPlainObject(meta) ? meta : null;
  const summary = extractHistorySummary(metaObj);
  return {
    rev: Number(row.rev || 0),
    hash: row.hash || null,
    etag: computeEtag(row.hash || null),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    actor: row.actor || (metaObj && metaObj.actor ? metaObj.actor : null),
    source: row.source || (metaObj && metaObj.source ? metaObj.source : null),
    note: row.note || (metaObj && metaObj.note ? metaObj.note : null),
    summary: summary || null,
    meta: metaObj
  };
}

app.get('/api/state', async (req, res) => {
  try {
    const snapshot = await getCachedSnapshot();
    const etag = computeEtag(snapshot.hash);
    if (etag) {
      const headerHash = extractHashFromHeader(req.headers['if-none-match']);
      if (headerHash && snapshot.hash && headerHash === snapshot.hash) {
        res.status(304).end();
        return;
      }
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(snapshot.stateString);
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/state', async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    const { snapshot, stateString, requestMeta } = extractSnapshotPayload(req.body);
    if (!isPlainObject(snapshot)) {
      res.status(400).json({ error: 'Snapshot must be an object' });
      return;
    }

    const normalizedMeta = normalizeRequestMeta(requestMeta);
    const hash = computeSnapshotHash(stateString);
    const current = await getCachedSnapshot();
    const currentHash = current?.hash || null;
    const ifMatch = parseIfMatchHeader(req.headers['if-match']);
    const baseHashFromMeta = normalizedMeta.concurrency.baseHash
      || normalizeWeakEtag(normalizedMeta.concurrency.baseEtag || null);
    const expectedHash = normalizedMeta.concurrency.forceOverwrite
      ? null
      : (baseHashFromMeta || (ifMatch.any ? null : ifMatch.hash));

    if (!normalizedMeta.concurrency.forceOverwrite
        && expectedHash
        && currentHash
        && expectedHash !== currentHash) {
      logSaveEvent('warn', 'save conflict ignored (last write wins)', {
        requestId,
        expectedHash,
        currentHash,
        rev: current?.rev || 0
      });
    }

    const actor = normalizedMeta.actor || requestMeta?.actor || requestMeta?.user || 'planner-ui';
    const source = normalizedMeta.source || 'planner-ui';
    const note = normalizedMeta.note || null;
    const summary = normalizedMeta.summary || null;
    const storedMeta = sanitizeMetaForStorage({
      ...normalizedMeta.meta,
      actor: actor || undefined,
      source: source || undefined,
      note: note || undefined,
      summary: summary || undefined
    });

    logSaveEvent('info', 'save request received', {
      requestId,
      actor,
      source,
      expectedHash: expectedHash || null,
      currentHash,
      forceOverwrite: normalizedMeta.concurrency.forceOverwrite
    });

    const latest = await persistSnapshotWithSql({
      actor,
      source,
      note: note || summary,
      snapshot,
      stateString,
      hash,
      meta: storedMeta
    });

    const etag = computeEtag(latest.hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');

    cachedSnapshot = latest;

    broadcastRevision({ rev: latest.rev, hash: latest.hash, etag });
    const duration = Date.now() - startedAt;
    logSaveEvent('info', 'save completed', {
      requestId,
      rev: latest.rev,
      hash: latest.hash || null,
      duration
    });
    res.status(200).json({ ok: true, rev: latest.rev, hash: latest.hash, etag, conflict: false });
  } catch (err) {
    if (err && err.message && err.message.includes('Snapshot payload')) {
      res.status(400).json({ error: err.message });
      return;
    }
    logSaveEvent('error', 'save failed', { requestId, error: err?.message || String(err) });
    console.error('PUT /api/state failed error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write('retry: 3000\n\n');

  sseClients.add(res);

  const sendInitial = async () => {
    try {
      const snapshot = await getCachedSnapshot();
      if (snapshot && snapshot.hash) {
        const etag = computeEtag(snapshot.hash);
        const payload = JSON.stringify({ type: 'revision', rev: snapshot.rev, hash: snapshot.hash, etag });
        res.write(`data: ${payload}\n\n`);
      }
    } catch (err) {
      console.warn('Failed to send initial SSE payload', err);
    }
  };

  sendInitial();

  req.on('close', () => {
    sseClients.delete(res);
    try {
      res.end();
    } catch (_err) {
      /* ignore */
    }
  });
});

app.get('/api/admin/history', async (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const offsetRaw = Number.parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const actorFilter = typeof req.query.actor === 'string' ? req.query.actor.trim().toLowerCase() : '';
  const sourceFilter = typeof req.query.source === 'string' ? req.query.source.trim().toLowerCase() : '';
  const fromRaw = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const toRaw = typeof req.query.to === 'string' ? req.query.to.trim() : '';

  const conditions = [];
  const params = [];

  const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const fromDate = parseDate(fromRaw);
  const toDate = parseDate(toRaw);

  if (fromDate) {
    params.push(fromDate);
    conditions.push(`s.created_at >= $${params.length}`);
  }

  if (toDate) {
    params.push(toDate);
    conditions.push(`s.created_at <= $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const fetchLimit = Math.max(offset + limit, limit) + 200;
  params.push(fetchLimit);

  try {
    const { rows } = await pool.query(
      `SELECT s.rev, s.hash, s.created_at, r.actor, r.source, r.note
         FROM planner_snapshots AS s
         LEFT JOIN revisions AS r ON r.rev = s.rev
        ${whereClause}
        ORDER BY s.created_at DESC, s.rev DESC
        LIMIT $${params.length}` ,
      params
    );

    const revs = rows.map((row) => Number(row.rev || 0));
    const metaMap = await loadMetadataForRevisions(pool, revs);

    const filtered = [];
    rows.forEach((row) => {
      const rev = Number(row.rev || 0);
      const meta = metaMap.get(rev) || null;
      const actorValue = (row.actor || (meta && meta.actor) || '').toString().toLowerCase();
      const sourceValue = (row.source || (meta && meta.source) || '').toString().toLowerCase();
      if (actorFilter && !actorValue.includes(actorFilter)) {
        return;
      }
      if (sourceFilter && !sourceValue.includes(sourceFilter)) {
        return;
      }
      filtered.push({ row, meta });
    });

    const paged = filtered.slice(offset, offset + limit);
    const items = paged.map(({ row, meta }) => mapHistoryRow(row, meta));
    res.json({ items });
  } catch (err) {
    console.error('GET /api/admin/history failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/admin/history/:hash', async (req, res) => {
  const hash = typeof req.params.hash === 'string' ? req.params.hash.trim() : '';
  if (!hash) {
    res.status(400).json({ error: 'Invalid hash' });
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT s.rev, s.hash, s.created_at, r.actor, r.source, r.note
         FROM planner_snapshots AS s
         LEFT JOIN revisions AS r ON r.rev = s.rev
        WHERE s.hash = $1
        ORDER BY s.created_at DESC, s.rev DESC
        LIMIT 1`,
      [hash]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    const row = rows[0];
    const rev = Number(row.rev || 0);
    const stored = await loadSnapshotRevision(pool, rev);
    if (!stored) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    const snapshot = stored.snapshot || {};
    const meta = stored.meta || null;

    let baseRev = null;
    let baseHash = null;
    let baseSnapshot = {};
    try {
      const { rows: prevRows } = await pool.query(
        `SELECT rev, hash
           FROM planner_snapshots
          WHERE rev < $1
          ORDER BY rev DESC
          LIMIT 1`,
        [rev]
      );
      if (prevRows.length) {
        baseRev = Number(prevRows[0].rev || 0) || null;
        baseHash = prevRows[0].hash || null;
        if (baseRev) {
          const previous = await loadSnapshotRevision(pool, baseRev);
          if (previous && previous.snapshot) {
            baseSnapshot = previous.snapshot;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to load previous snapshot for diff', err);
    }

    const diff = buildSnapshotDiff(baseSnapshot || {}, snapshot || {});
    const actor = row.actor || (meta && meta.actor ? meta.actor : null);
    const source = row.source || (meta && meta.source ? meta.source : null);
    const note = row.note || (meta && meta.note ? meta.note : null);
    const etag = computeEtag(stored.hash || null);
    res.json({
      rev: stored.rev,
      hash: stored.hash || null,
      etag,
      baseRev,
      baseHash,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      actor,
      source,
      note,
      meta,
      state: snapshot,
      diff: diff || null
    });
  } catch (err) {
    console.error('GET /api/admin/history/:hash failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.delete('/api/admin/history', async (_req, res) => {
  const requestId = createRequestId();
  try {
    const latest = await loadLatestSnapshot();
    if (!latest) {
      const result = await pool.query('TRUNCATE planner_snapshot_entries, planner_snapshots RESTART IDENTITY');
      const removed = Number(result?.rowCount) || 0;
      logSaveEvent('info', 'history cleared (no snapshots to keep)', { requestId, removed });
      res.json({ ok: true, removed, keptRev: null, keptHash: null });
      return;
    }

    const result = await pool.query(
      'DELETE FROM planner_snapshots WHERE rev <> $1',
      [latest.rev]
    );
    const removed = Number(result?.rowCount) || 0;
    logSaveEvent('info', 'history cleared', {
      requestId,
      removed,
      keptRev: latest.rev,
      keptHash: latest.hash || null
    });
    res.json({ ok: true, removed, keptRev: latest.rev, keptHash: latest.hash || null });
  } catch (err) {
    logSaveEvent('error', 'history clear failed', { requestId, error: err?.message || String(err) });
    console.error('DELETE /api/admin/history failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/admin/snapshot', async (req, res) => {
  try {
    const actor = sanitizeString(req.body?.actor) || 'admin';
    const note = sanitizeString(req.body?.note) || null;
    const source = 'manual-snapshot';
    const latest = await getCachedSnapshot();
    const meta = sanitizeMetaForStorage({
      ...(latest.meta || {}),
      actor,
      source,
      note: note || undefined
    });
    const hash = latest.hash || computeSnapshotHash(latest.stateString || JSON.stringify(latest.snapshot || {}));
    const { rev, result } = await runWithRevision(actor, source, note, async (client, nextRev) => {
      await persistSnapshotData(client, nextRev, latest.snapshot, hash, meta);
      return await loadSnapshotRevision(client, nextRev);
    });
    const stored = result || (await loadSnapshotRevision(pool, rev));
    const etag = computeEtag(stored?.hash || hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');
    if (stored) {
      cachedSnapshot = stored;
      broadcastRevision({ rev: stored.rev, hash: stored.hash, etag });
      res.status(201).json({ ok: true, rev: stored.rev, hash: stored.hash, etag });
    } else {
      cachedSnapshot = {
        rev,
        snapshot: latest.snapshot,
        stateString: latest.stateString,
        hash,
        meta
      };
      broadcastRevision({ rev, hash, etag });
      res.status(201).json({ ok: true, rev, hash, etag });
    }
  } catch (err) {
    console.error('POST /api/admin/snapshot failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/admin/rollback', async (req, res) => {
  const targetHash = sanitizeString(req.body?.targetHash);
  if (!targetHash) {
    res.status(400).json({ error: 'targetHash is required' });
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT s.rev, s.hash, s.created_at, r.actor, r.source, r.note
         FROM planner_snapshots AS s
         LEFT JOIN revisions AS r ON r.rev = s.rev
        WHERE s.hash = $1
        ORDER BY s.created_at DESC, s.rev DESC
        LIMIT 1`,
      [targetHash]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    const row = rows[0];
    const rev = Number(row.rev || 0);
    const stored = await loadSnapshotRevision(pool, rev);
    if (!stored) {
      res.status(404).json({ error: 'Snapshot not found' });
      return;
    }
    const snapshot = stored.snapshot || {};
    const stateString = JSON.stringify(snapshot);
    const hash = computeSnapshotHash(stateString);
    const actor = sanitizeString(req.body?.actor) || 'admin';
    const note = sanitizeString(req.body?.note) || null;
    const rollbackMeta = sanitizeMetaForStorage({
      actor,
      source: 'rollback',
      note: note || undefined,
      rollbackFrom: targetHash,
      baseRev: stored.rev,
      previousMeta: stored.meta || undefined
    });

    const requestId = createRequestId();
    const startedAt = Date.now();
    logSaveEvent('info', 'rollback started', { requestId, actor, hash: targetHash });

    const latest = await persistSnapshotWithSql({
      actor,
      source: 'rollback',
      note,
      snapshot,
      stateString,
      hash,
      meta: rollbackMeta
    });

    const etag = computeEtag(latest.hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');
    cachedSnapshot = latest;
    broadcastRevision({ rev: latest.rev, hash: latest.hash, etag });
    const duration = Date.now() - startedAt;
    logSaveEvent('info', 'rollback completed', {
      requestId,
      rev: latest.rev,
      hash: latest.hash || null,
      duration
    });
    res.json({ ok: true, rev: latest.rev, hash: latest.hash, etag });
  } catch (err) {
    logSaveEvent('error', 'rollback failed', { error: err?.message || String(err) });
    console.error('POST /api/admin/rollback failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.use(express.static(PUBLIC_DIR, { index: 'Planner_Codex_v3.html' }));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
    return;
  }
  next();
});

async function bootstrap() {
  await runMigrations();
  await getLatestRevision();
  await getCachedSnapshot();
  app.listen(PORT, () => {
    console.log(`Planner SQL bridge listening on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
