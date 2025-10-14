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

const SHARED_BOOLEAN_PREF_KEYS = [
  'autosaveOn',
  'shiftOnProgress',
  'autoOptimizeOn',
  'cascadeReadyOn'
];

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

function normalizeStage(code) {
  if (!code) return null;
  return String(code).trim().toLowerCase();
}

function titleFromCode(code) {
  if (!code) return '';
  return code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
  const { rows } = await client.query(`
    SELECT rev, snapshot, hash, meta
      FROM planner_state_snapshots
     ORDER BY rev DESC, created_at DESC
     LIMIT 1
  `);
  if (!rows.length) {
    return null;
  }
  const row = rows[0];
  const snapshotObj = parseJsonColumn(row.snapshot, {});
  try {
    const prefMap = await loadSharedPreferences(client);
    if (prefMap && prefMap.size) {
      applySharedPreferencesToSnapshot(snapshotObj, prefMap);
    }
  } catch (err) {
    console.warn('Failed to merge shared preferences into snapshot', err);
  }
  const stateString = JSON.stringify(snapshotObj);
  const hash = row.hash || computeSnapshotHash(stateString);
  const rev = Number(row.rev || 0);
  return {
    rev,
    snapshot: snapshotObj,
    stateString,
    hash,
    meta: parseJsonColumn(row.meta, null)
  };
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

function computeEtag(hash) {
  const normalized = hash ? String(hash).trim() : '';
  if (!normalized) return null;
  return normalized.startsWith('W/') ? normalized : `W/"${normalized}"`;
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

function serializeMeta(meta) {
  const sanitized = sanitizeMetaForStorage(meta);
  if (sanitized === null) {
    return null;
  }
  try {
    return JSON.stringify(sanitized);
  } catch (err) {
    console.warn('Failed to serialize snapshot meta, discarding meta payload', err);
    return null;
  }
}

async function insertSnapshotRow(client, rev, snapshot, stateString, hash, meta) {
  const snapshotJson = safeSerializeSnapshot(snapshot, stateString);
  const metaJson = serializeMeta(meta);
  const effectiveHash = hash || computeSnapshotHash(snapshotJson);

  await client.query(
    `INSERT INTO planner_state_snapshots (rev, snapshot, meta, hash)
     VALUES ($1,$2::jsonb,$3::jsonb,$4)
     ON CONFLICT (rev) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           meta = EXCLUDED.meta,
           hash = EXCLUDED.hash,
           created_at = NOW()` ,
    [rev, snapshotJson, metaJson, effectiveHash]
  );
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
  const payload = { ...context };
  const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
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

  const serialized = safeSerializeSnapshot(snapshot, stateString);
  const parsedSnapshot = isPlainObject(snapshot) ? snapshot : (() => {
    try {
      return JSON.parse(serialized);
    } catch (_err) {
      return {};
    }
  })();
  const storedMeta = sanitizeMetaForStorage(meta);
  const effectiveHash = hash || computeSnapshotHash(serialized);

  const { rev, result } = await runWithRevision(actor, source, note, async (client, nextRev) => {
    await applySnapshotToSql(client, parsedSnapshot);
    await insertSnapshotRow(client, nextRev, parsedSnapshot, serialized, effectiveHash, storedMeta);
    return await loadLatestSnapshot(client);
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

function mapHistoryRow(row) {
  const meta = parseJsonColumn(row.meta, null);
  const summary = extractHistorySummary(meta);
  return {
    rev: Number(row.rev || 0),
    hash: row.hash || null,
    etag: computeEtag(row.hash || null),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    actor: row.actor || (meta && meta.actor ? meta.actor : null),
    source: row.source || (meta && meta.source ? meta.source : null),
    note: row.note || (meta && meta.note ? meta.note : null),
    summary: summary || null,
    meta
  };
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (Buffer.isBuffer(value) || value instanceof Buffer) {
    if (!value.length) return fallback;
    try {
      return JSON.parse(value.toString('utf8'));
    } catch (_err) {
      return fallback;
    }
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return fallback;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      return fallback;
    }
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function extractSharedPreferences(snapshot) {
  if (!isPlainObject(snapshot)) {
    return [];
  }
  const prefs = [];
  for (const key of SHARED_BOOLEAN_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      prefs.push({ key, value: Boolean(snapshot[key]) });
    }
  }
  return prefs;
}

async function syncSharedPreferences(client, snapshot) {
  const prefs = extractSharedPreferences(snapshot);
  try {
    await client.query('DELETE FROM settings_shared_preferences');
  } catch (err) {
    if (err && err.code === PG_UNDEFINED_TABLE) {
      return;
    }
    throw err;
  }

  if (!prefs.length) {
    return;
  }

  for (const pref of prefs) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO settings_shared_preferences (pref_key, bool_value, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (pref_key) DO UPDATE
         SET bool_value = EXCLUDED.bool_value,
             updated_at = NOW()` ,
      [pref.key, pref.value]
    );
  }
}

async function loadSharedPreferences(runner) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  try {
    const { rows } = await executor.query(
      'SELECT pref_key, bool_value FROM settings_shared_preferences'
    );
    const map = new Map();
    rows.forEach((row) => {
      if (row && row.pref_key) {
        map.set(row.pref_key, Boolean(row.bool_value));
      }
    });
    return map;
  } catch (err) {
    if (err && err.code === PG_UNDEFINED_TABLE) {
      return null;
    }
    throw err;
  }
}

function applySharedPreferencesToSnapshot(snapshot, prefMap) {
  if (!isPlainObject(snapshot) || !(prefMap instanceof Map) || prefMap.size === 0) {
    return;
  }
  for (const key of SHARED_BOOLEAN_PREF_KEYS) {
    if (prefMap.has(key)) {
      snapshot[key] = Boolean(prefMap.get(key));
    }
  }
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

async function ensureSqlHydrated() {
  let hasOrders = true;
  try {
    const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM orders LIMIT 1) AS has_orders');
    hasOrders = Boolean(rows[0]?.has_orders);
  } catch (err) {
    console.warn('Failed to probe orders table before hydration', err);
    return;
  }

  if (hasOrders) {
    return;
  }

  const latest = await loadLatestSnapshot();
  if (!latest || !Number.isFinite(latest.rev) || latest.rev <= 0) {
    return;
  }

  const hydrationMeta = sanitizeMetaForStorage({
    actor: 'system',
    source: 'startup-hydrate',
    note: 'Автоматическое восстановление таблиц из последнего снимка',
    hydratedFromRev: latest.rev,
    baseRev: latest.rev,
    previousMeta: latest.meta || undefined
  }) || {
    actor: 'system',
    source: 'startup-hydrate',
    hydratedFromRev: latest.rev,
    baseRev: latest.rev
  };

  const requestId = createRequestId();
  const startedAt = Date.now();
  logSaveEvent('info', 'auto hydration started', { requestId, rev: latest.rev, hash: latest.hash || null });

  try {
    const persisted = await persistSnapshotWithSql({
      actor: 'system',
      source: 'startup-hydrate',
      note: 'Автоматическое восстановление таблиц из снимка',
      snapshot: latest.snapshot,
      stateString: latest.stateString,
      hash: latest.hash,
      meta: hydrationMeta
    });

    cachedSnapshot = persisted;
    const etag = computeEtag(persisted.hash);
    if (etag) {
      broadcastRevision({ rev: persisted.rev, hash: persisted.hash, etag });
    }
    const duration = Date.now() - startedAt;
    logSaveEvent('info', 'auto hydration completed', {
      requestId,
      rev: persisted.rev,
      hash: persisted.hash || null,
      duration
    });
  } catch (err) {
    logSaveEvent('error', 'auto hydration failed', { requestId, error: err?.message || String(err) });
    console.error('Failed to hydrate normalized tables from snapshot', err);
  }
}

function orderKeyFromTask(task) {
  if (!task || typeof task !== 'object') return null;
  const identity = sanitizeString(task.orderIdentity);
  if (identity) return `identity:${identity}`;
  const orderId = sanitizeString(task.orderId);
  if (orderId) return `id:${orderId}`;
  const number = sanitizeString(task.orderNumber);
  if (number) return `number:${number}`;
  const uid = sanitizeString(task.uid);
  if (uid) return `uid:${uid}`;
  return null;
}

async function applySnapshotToSql(client, snapshot) {
  const tasks = Array.isArray(snapshot.t) ? snapshot.t : [];
  const done = Array.isArray(snapshot.done) ? snapshot.done : [];
  const trash = Array.isArray(snapshot.trash) ? snapshot.trash : [];

  const parallelSet = new Set();
  if (isPlainObject(snapshot.parallelByProc)) {
    Object.keys(snapshot.parallelByProc).forEach((key) => {
      const normalized = normalizeStage(key);
      if (normalized) parallelSet.add(normalized);
    });
  }

  await syncSharedPreferences(client, snapshot);

  const processMap = new Map();
  const ensureProcess = (code) => {
    const normalized = normalizeStage(code);
    if (!normalized) return null;
    if (!processMap.has(normalized)) {
      processMap.set(normalized, {
        code: normalized,
        name: titleFromCode(normalized),
        isParallel: parallelSet.has(normalized),
        id: null
      });
    }
    return processMap.get(normalized);
  };

  tasks.forEach((task) => ensureProcess(task?.stage));
  done.forEach((task) => ensureProcess(task?.stage));
  if (isPlainObject(snapshot.capByProc)) {
    Object.keys(snapshot.capByProc).forEach((code) => ensureProcess(code));
  }
  if (isPlainObject(snapshot.meta?.settings?.capacity)) {
    Object.keys(snapshot.meta.settings.capacity).forEach((code) => ensureProcess(code));
  }
  if (isPlainObject(snapshot.meta?.settings?.crmStageMapping)) {
    Object.values(snapshot.meta.settings.crmStageMapping).forEach((code) => ensureProcess(code));
  }

  await client.query('TRUNCATE order_process RESTART IDENTITY CASCADE');
  await client.query('TRUNCATE orders RESTART IDENTITY CASCADE');
  await client.query('TRUNCATE customers RESTART IDENTITY CASCADE');
  await client.query('TRUNCATE processes RESTART IDENTITY CASCADE');
  await client.query('TRUNCATE capacity_by_process');
  await client.query('TRUNCATE settings_column_widths');
  await client.query('TRUNCATE settings_mapping');
  await client.query('TRUNCATE excluded_statuses');
  await client.query('DELETE FROM settings_autoweight');
  await client.query('DELETE FROM settings_journal');
  await client.query('DELETE FROM settings_admin');

  const processes = Array.from(processMap.values());
  processes.sort((a, b) => a.code.localeCompare(b.code));
  for (let index = 0; index < processes.length; index += 1) {
    const stage = processes[index];
    const { rows } = await client.query(
      `INSERT INTO processes (code, name, position, has_hours, is_parallel, is_active)
       VALUES ($1,$2,$3,TRUE,$4,TRUE)
       RETURNING id`,
      [stage.code, stage.name || stage.code, index, stage.isParallel]
    );
    stage.id = rows[0].id;
  }

  const customerNames = new Set();
  const collectCustomer = (task) => {
    if (!task) return;
    const name = sanitizeString(task.orderCustomer);
    if (name) customerNames.add(name);
  };
  tasks.forEach(collectCustomer);
  done.forEach(collectCustomer);

  const customerMap = new Map();
  const sortedCustomers = Array.from(customerNames.values()).sort();
  for (const name of sortedCustomers) {
    const { rows } = await client.query(
      'INSERT INTO customers (name) VALUES ($1) RETURNING id',
      [name]
    );
    customerMap.set(name, rows[0].id);
  }

  const orderData = new Map();
  const collectOrderData = (task, options = {}) => {
    if (!task || typeof task !== 'object') return;
    const key = orderKeyFromTask(task);
    if (!key) return;
    const existing = orderData.get(key) || {
      key,
      crmOrderId: null,
      number: null,
      customerName: null,
      status: null,
      deleted: false,
      deletedAt: null,
      createdAt: null,
      updatedAt: null
    };
    const crmOrderId = sanitizeString(task.orderId);
    if (crmOrderId) existing.crmOrderId = existing.crmOrderId || crmOrderId;
    const number = sanitizeString(task.orderNumber);
    if (number) existing.number = existing.number || number;
    const customerName = sanitizeString(task.orderCustomer);
    if (customerName) existing.customerName = existing.customerName || customerName;
    const status = sanitizeString(task.status) || sanitizeString(task.state);
    if (status) existing.status = status;
    const start = parseDate(task.startDate || task.start);
    if (start && !existing.createdAt) existing.createdAt = start;
    const end = parseDate(task.endDate || task.end);
    if (end) existing.updatedAt = end;
    if (options.isDone) {
      existing.status = existing.status || 'done';
      const doneAt = parseDate(task.doneMeta?.when || task.when || end || start);
      if (doneAt) existing.updatedAt = doneAt;
    }
    if (options.deleted) {
      existing.deleted = true;
      const deletedAt = parseDate(task.when || task.end || task.endDate || task.startDate);
      if (deletedAt) existing.deletedAt = deletedAt;
    }
    orderData.set(key, existing);
  };

  tasks.forEach((task) => collectOrderData(task));
  done.forEach((task) => collectOrderData(task, { isDone: true }));
  trash.forEach((task) => collectOrderData(task, { deleted: true }));

  const orderIdMap = new Map();
  for (const data of orderData.values()) {
    const customerId = data.customerName ? customerMap.get(data.customerName) || null : null;
    const createdAt = data.createdAt || new Date();
    const updatedAt = data.updatedAt || createdAt;
    const number = data.number || data.crmOrderId || data.key;
    const { rows } = await client.query(
      `INSERT INTO orders (crm_order_id, number, customer_id, status, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        data.crmOrderId || null,
        number,
        customerId,
        data.status || null,
        createdAt,
        updatedAt,
        data.deleted ? (data.deletedAt || updatedAt) : null
      ]
    );
    orderIdMap.set(data.key, rows[0].id);
  }

  const seqByOrder = new Map();
  const positionByProcess = new Map();
  const insertTask = async (task, options = {}) => {
    if (!task) return;
    const key = orderKeyFromTask(task);
    if (!key) return;
    const orderId = orderIdMap.get(key);
    if (!orderId) return;
    const process = ensureProcess(task.stage);
    if (!process || !process.id) return;
    const seq = seqByOrder.get(key) || 0;
    seqByOrder.set(key, seq + 1);
    const position = positionByProcess.get(process.code) || 0;
    positionByProcess.set(process.code, position + 1);
    const routeSeg = task.route && task.stage ? task.route[task.stage] : null;
    const plannedStart = parseDate(task.startDate || routeSeg?.start);
    const plannedEnd = parseDate(task.endDate || routeSeg?.end);
    const actualStart = parseDate(routeSeg?.start);
    const actualEnd = parseDate(routeSeg?.doneAt || task.doneMeta?.when || routeSeg?.end || task.when);
    const progressRaw = Number(task.progress);
    const progress = Number.isFinite(progressRaw) ? progressRaw : 0;
    const isDone = options.isDone || Boolean(task.doneMeta?.when) || progress >= 100;
    await client.query(
      `INSERT INTO order_process (
         order_id, process_id, seq, planned_start, planned_end,
         actual_start, actual_end, progress, is_done,
         position_index, hidden_by_state
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orderId,
        process.id,
        seq,
        plannedStart,
        plannedEnd,
        actualStart,
        actualEnd,
        progress,
        isDone,
        position,
        false
      ]
    );
  };

  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop
    await insertTask(task, { isDone: false });
  }
  for (const task of done) {
    // eslint-disable-next-line no-await-in-loop
    await insertTask(task, { isDone: true });
  }

  const today = new Date().toISOString().slice(0, 10);
  const capacitySource = isPlainObject(snapshot.capByProc)
    ? snapshot.capByProc
    : snapshot.meta?.settings?.capacity || {};
  for (const [code, value] of Object.entries(capacitySource || {})) {
    const process = ensureProcess(code);
    if (!process || !process.id) continue;
    const minutes = Number(value) * 60;
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO capacity_by_process (process_id, day, minutes)
       VALUES ($1,$2,$3)
       ON CONFLICT (process_id, day) DO UPDATE SET minutes = EXCLUDED.minutes`,
      [process.id, today, Number.isFinite(minutes) ? Math.round(minutes) : 0]
    );
  }

  const settings = snapshot.meta?.settings || {};
  const extra = settings.extraTime || {};
  const percentRaw = Number(extra.percent);
  const minimumRaw = Number(extra.minimum);
  const percentValue = Number.isFinite(percentRaw)
    ? Math.max(0, Math.round(percentRaw * 100) / 100)
    : DEFAULT_EXTRA_PERCENT;
  const minimumValue = Number.isFinite(minimumRaw)
    ? Math.max(0, Math.round(minimumRaw * 100) / 100)
    : DEFAULT_EXTRA_MINIMUM;
  const extraEnabled = percentValue > 0 || minimumValue > 0;
  await client.query(
    `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
     VALUES (1,$1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           percent = EXCLUDED.percent,
           minimum_hours = EXCLUDED.minimum_hours,
           updated_at = NOW()` ,
    [extraEnabled, percentValue, minimumValue]
  );

  const logLimit = Number(settings.logLimit);
  if (Number.isFinite(logLimit) && logLimit > 0) {
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at)
       VALUES (1,$1,NOW())
       ON CONFLICT (id) DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()` ,
      [Math.round(logLimit)]
    );
  } else {
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at)
       VALUES (1,50,NOW())
       ON CONFLICT (id) DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()` ,
      [50]
    );
  }

  if (isPlainObject(settings.tableColumns)) {
    for (const [key, width] of Object.entries(settings.tableColumns)) {
      const columnKey = sanitizeString(key);
      if (!columnKey) continue;
      const widthValue = parseInteger(width, null);
      if (widthValue === null) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO settings_column_widths (column_key, width_px, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (column_key) DO UPDATE SET width_px = EXCLUDED.width_px, updated_at = NOW()` ,
        [columnKey, widthValue]
      );
    }
  }

  if (isPlainObject(settings.crmStageMapping)) {
    for (const [crmStage, mappedProcess] of Object.entries(settings.crmStageMapping)) {
      const stageKey = sanitizeString(crmStage);
      if (!stageKey) continue;
      const process = ensureProcess(mappedProcess);
      const processId = process?.id || null;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO settings_mapping (crm_stage, planner_process_id, is_ignored, updated_at)
         VALUES ($1,$2,FALSE,NOW())
         ON CONFLICT (crm_stage) DO UPDATE
           SET planner_process_id = EXCLUDED.planner_process_id,
               is_ignored = EXCLUDED.is_ignored,
               updated_at = NOW()` ,
        [stageKey, processId]
      );
    }
  }

  const adminSettings = settings.admin || {};
  const allowForce = parseBoolean(adminSettings.allowForceOverwrite, false);
  const snapshotRetention = parseInteger(adminSettings.snapshotRetention, 50);
  let historyLimit = parseInteger(adminSettings.historyLimit, 50);
  if (!Number.isFinite(historyLimit) || historyLimit <= 0) {
    historyLimit = 50;
  }
  historyLimit = Math.max(1, Math.min(historyLimit, 500));
  let historyDailyLimit = parseInteger(adminSettings.historyDailyLimit, 3);
  if (!Number.isFinite(historyDailyLimit) || historyDailyLimit <= 0) {
    historyDailyLimit = 3;
  }
  historyDailyLimit = Math.max(1, Math.min(historyDailyLimit, historyLimit));
  await client.query(
    `INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, history_limit, history_daily_limit, updated_at)
     VALUES (1,$1,$2,$3,$4,NOW())
     ON CONFLICT (id) DO UPDATE
       SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
           snapshot_retention = EXCLUDED.snapshot_retention,
           history_limit = EXCLUDED.history_limit,
           history_daily_limit = EXCLUDED.history_daily_limit,
           updated_at = NOW()` ,
    [
      allowForce,
      Number.isFinite(snapshotRetention) ? snapshotRetention : 50,
      historyLimit,
      historyDailyLimit
    ]
  );

  const ignoredStatuses = Array.isArray(snapshot.ignoredStates) ? snapshot.ignoredStates : [];
  for (const status of ignoredStatuses) {
    const statusKey = sanitizeString(status);
    if (!statusKey) continue;
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO excluded_statuses (status_key, created_at)
       VALUES ($1,NOW())
       ON CONFLICT (status_key) DO NOTHING` ,
      [statusKey]
    );
  }

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
      const conflictEtag = computeEtag(currentHash);
      if (conflictEtag) {
        res.set('ETag', conflictEtag);
      }
      res.set('Cache-Control', 'no-store');
      logSaveEvent('warn', 'save conflict', {
        requestId,
        expectedHash,
        currentHash,
        rev: current?.rev || 0
      });
      res.status(409).json({
        error: 'Conflict',
        conflict: true,
        expectedHash,
        currentHash,
        hash: currentHash,
        rev: current?.rev || 0,
        etag: conflictEtag
      });
      return;
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
  const actor = typeof req.query.actor === 'string' ? req.query.actor.trim() : '';
  const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
  const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';

  const conditions = [];
  const params = [];

  if (actor) {
    params.push(`%${actor.toLowerCase()}%`);
    conditions.push(`(LOWER(COALESCE(r.actor, s.meta->>'actor')) LIKE $${params.length})`);
  }

  if (source) {
    params.push(`%${source.toLowerCase()}%`);
    conditions.push(`(LOWER(COALESCE(r.source, s.meta->>'source')) LIKE $${params.length})`);
  }

  if (from) {
    params.push(new Date(from));
    conditions.push(`s.created_at >= $${params.length}`);
  }

  if (to) {
    params.push(new Date(to));
    conditions.push(`s.created_at <= $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(
      `SELECT s.rev, s.hash, s.created_at, s.meta, r.actor, r.source, r.note
         FROM planner_state_snapshots AS s
         LEFT JOIN revisions AS r ON r.rev = s.rev
        ${whereClause}
        ORDER BY s.created_at DESC, s.rev DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}`,
      params
    );
    const items = rows.map(mapHistoryRow);
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
      `SELECT s.rev, s.hash, s.created_at, s.meta, s.snapshot, r.actor, r.source, r.note
         FROM planner_state_snapshots AS s
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
    const meta = parseJsonColumn(row.meta, null);
    const snapshot = parseJsonColumn(row.snapshot, null);
    let baseRev = null;
    let baseHash = null;
    let baseSnapshot = {};
    try {
      const { rows: prevRows } = await pool.query(
        `SELECT rev, hash, snapshot
           FROM planner_state_snapshots
          WHERE rev < $1
          ORDER BY rev DESC
          LIMIT 1`,
        [row.rev]
      );
      if (prevRows.length) {
        baseRev = Number(prevRows[0].rev || 0) || null;
        baseHash = prevRows[0].hash || null;
        baseSnapshot = parseJsonColumn(prevRows[0].snapshot, {}) || {};
      }
    } catch (err) {
      console.warn('Failed to load previous snapshot for diff', err);
    }
    const diff = buildSnapshotDiff(baseSnapshot || {}, snapshot || {});
    const actor = row.actor || (meta && meta.actor ? meta.actor : null);
    const source = row.source || (meta && meta.source ? meta.source : null);
    const note = row.note || (meta && meta.note ? meta.note : null);
    const etag = computeEtag(row.hash || null);
    res.json({
      rev: Number(row.rev || 0),
      hash: row.hash || null,
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
      const result = await pool.query('TRUNCATE planner_state_snapshots RESTART IDENTITY');
      const removed = Number(result?.rowCount) || 0;
      logSaveEvent('info', 'history cleared (no snapshots to keep)', { requestId, removed });
      res.json({ ok: true, removed, keptRev: null, keptHash: null });
      return;
    }

    const result = await pool.query(
      'DELETE FROM planner_state_snapshots WHERE rev <> $1',
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
    const { rev, result } = await runWithRevision(actor, source, note, async (client, nextRev) => {
      await insertSnapshotRow(client, nextRev, latest.snapshot, latest.stateString, latest.hash, meta);
      return await loadLatestSnapshot(client);
    });
    const stored = result || await loadLatestSnapshot();
    const etag = computeEtag(stored?.hash || latest.hash);
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
        hash: latest.hash,
        meta
      };
      broadcastRevision({ rev, hash: latest.hash, etag });
      res.status(201).json({ ok: true, rev, hash: latest.hash, etag });
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
      `SELECT s.rev, s.snapshot, s.hash, s.meta, s.created_at
         FROM planner_state_snapshots AS s
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
    const snapshot = parseJsonColumn(row.snapshot, {});
    const stateString = JSON.stringify(snapshot);
    const hash = computeSnapshotHash(stateString);
    const actor = sanitizeString(req.body?.actor) || 'admin';
    const note = sanitizeString(req.body?.note) || null;
    const rollbackMeta = sanitizeMetaForStorage({
      actor,
      source: 'rollback',
      note: note || undefined,
      rollbackFrom: targetHash,
      baseRev: Number(row.rev || 0),
      previousMeta: parseJsonColumn(row.meta, null)
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
  await ensureSqlHydrated();
  app.listen(PORT, () => {
    console.log(`Planner SQL bridge listening on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
