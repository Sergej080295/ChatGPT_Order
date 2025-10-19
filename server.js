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
const TABLE_SNAPSHOTS = 'planner_state_snapshots';
const TABLE_SCALARS = 'planner_state_scalars';
const TABLE_LIST_ENTRIES = 'planner_state_list_entries';
const TABLE_LIST_ATTRIBUTES = 'planner_state_list_entry_attributes';
const TABLE_ORDER_HEADERS = 'planner_orders';
const TABLE_ORDER_STAGES = 'planner_order_stages';
const TABLE_ORDER_STAGE_ATTRIBUTES = 'planner_order_stage_attributes';
const TABLE_ORDER_STAGE_ROUTES = 'planner_order_stage_routes';
const TABLE_CAPACITY = 'planner_state_capacity';
const TABLE_PARALLEL = 'planner_state_parallel';
const TABLE_ROUTE_OVERRIDES = 'planner_state_route_overrides';
const TABLE_IGNORED_STATES = 'planner_state_ignored_states';
const TABLE_META_VALUES = 'planner_meta_values';
const TABLE_META_HISTORY = 'planner_meta_history_entries';
const TABLE_META_HISTORY_ATTRS = 'planner_meta_history_entry_attributes';
const TABLE_CRM_VALUES = 'planner_state_crm_values';
const TABLE_MODE_VALUES = 'planner_state_mode_scoped_values';
const TABLE_GENERAL_SETTINGS = 'planner_settings';
const SETTINGS_SCOPE_GENERAL = 'general';
const SETTINGS_SCOPE_PREFERENCES = 'preferences';
const GENERAL_PREFERENCE_KEYS = [
  'autosaveOn',
  'autoOptimizeOn',
  'cascadeReadyOn',
  'shiftOnProgress',
  'priorityChangeLoggingOn',
  'routeDateChangeLoggingOn',
  'notificationsMuted'
];
const ORDER_LIST_KEYS = ['t', 'done', 'trash'];
const STATE_LIST_KEYS = ['orders', 'exc', 'res', 'locked'];
const STATE_SCALAR_KEYS = [
  'process',
  'filter',
  'freshness',
  'freshnessManual',
  'lastImportTime',
  'lastManualTime',
  'autosaveOn',
  'autoOptimizeOn',
  'cascadeReadyOn',
  'priorityChangeLoggingOn',
  'routeDateChangeLoggingOn',
  'notificationsMuted',
  'shiftOnProgress'
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

let cachedDefaultGeneralSettings = null;

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

function getDefaultGeneralSettings() {
  if (!cachedDefaultGeneralSettings) {
    const emptySnapshot = buildEmptySnapshot();
    const defaultSettings = isPlainObject(emptySnapshot.meta) && isPlainObject(emptySnapshot.meta.settings)
      ? cloneDeepPlain(emptySnapshot.meta.settings)
      : {};
    const defaultPreferences = {};
    GENERAL_PREFERENCE_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(emptySnapshot, key)) {
        defaultPreferences[key] = Boolean(emptySnapshot[key]);
      } else if (isPlainObject(emptySnapshot.meta) && Object.prototype.hasOwnProperty.call(emptySnapshot.meta, key)) {
        defaultPreferences[key] = Boolean(emptySnapshot.meta[key]);
      } else if (Object.prototype.hasOwnProperty.call(defaultSettings, key)) {
        defaultPreferences[key] = Boolean(defaultSettings[key]);
      } else {
        defaultPreferences[key] = false;
      }
    });
    if (!Object.prototype.hasOwnProperty.call(defaultPreferences, 'notificationsMuted')) {
      defaultPreferences.notificationsMuted = false;
    }
    cachedDefaultGeneralSettings = {
      settings: defaultSettings,
      preferences: defaultPreferences
    };
  }
  return cloneDeepPlain(cachedDefaultGeneralSettings);
}

function extractGeneralSettingsForStorage(snapshot) {
  if (!isPlainObject(snapshot)) {
    return { hasSettings: false, payload: null, meta: null };
  }

  const snapshotMetaSource = isPlainObject(snapshot.meta) ? snapshot.meta : null;
  const workingMeta = snapshotMetaSource ? cloneDeepPlain(snapshotMetaSource) : null;
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

  if (snapshotMetaSource && Object.prototype.hasOwnProperty.call(snapshotMetaSource, 'settings')) {
    const metaValue = snapshotMetaSource.settings;
    delete snapshotMetaSource.settings;
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
    snapshotMetaSource,
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

function applyGeneralSettingsToSnapshot(snapshot, generalSettings) {
  if (!isPlainObject(snapshot)) {
    return snapshot;
  }

  const defaults = getDefaultGeneralSettings();
  const provided = isPlainObject(generalSettings) ? generalSettings : null;

  const settingsSource = (() => {
    if (provided && Object.prototype.hasOwnProperty.call(provided, 'settings')) {
      const candidate = provided.settings;
      if (isPlainObject(candidate)) {
        return candidate;
      }
      return null;
    }
    if (provided) {
      return provided;
    }
    return defaults.settings;
  })();

  const preferencesSource = (() => {
    if (provided && Object.prototype.hasOwnProperty.call(provided, 'preferences')) {
      const candidate = provided.preferences;
      if (isPlainObject(candidate)) {
        return candidate;
      }
    }
    return null;
  })();

  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }

  const effectiveSettings = isPlainObject(settingsSource) ? settingsSource : defaults.settings;
  snapshot.meta.settings = cloneDeepPlain(effectiveSettings);
  snapshot.settings = cloneDeepPlain(effectiveSettings);

  const effectivePreferences = { ...cloneDeepPlain(defaults.preferences) };
  if (isPlainObject(preferencesSource)) {
    Object.entries(preferencesSource).forEach(([key, value]) => {
      const normalized = normalizePreferenceValue(value);
      if (normalized !== null) {
        effectivePreferences[key] = normalized;
      }
    });
  } else if (provided && !Object.prototype.hasOwnProperty.call(provided, 'preferences')) {
    GENERAL_PREFERENCE_KEYS.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(provided, key)) {
        const normalized = normalizePreferenceValue(provided[key]);
        if (normalized !== null) {
          effectivePreferences[key] = normalized;
        }
      }
    });
  }

  GENERAL_PREFERENCE_KEYS.forEach((key) => {
    const value = effectivePreferences[key];
    if (typeof value === 'boolean') {
      snapshot[key] = value;
      snapshot.meta[key] = value;
    }
  });

  if (typeof effectivePreferences.notificationsMuted === 'boolean') {
    snapshot.notificationsMuted = effectivePreferences.notificationsMuted;
    if (isPlainObject(snapshot.meta.settings)) {
      snapshot.meta.settings.notificationsMuted = effectivePreferences.notificationsMuted;
    }
  }

  return snapshot;
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

async function ensureRevisionInfrastructure(runner) {
  const client = runner || pool;
  const { rows } = await client.query("SELECT to_regclass('public.revisions') AS oid");
  const hasRevisionsTable = rows.length > 0 && rows[0].oid !== null;

  await client.query('CREATE SEQUENCE IF NOT EXISTS revisions_rev_seq');

  if (!hasRevisionsTable) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS revisions (
        id BIGSERIAL PRIMARY KEY,
        rev BIGINT NOT NULL DEFAULT nextval('revisions_rev_seq'),
        current_rev BIGINT NOT NULL DEFAULT currval('revisions_rev_seq'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor TEXT,
        source TEXT,
        note TEXT
      )
    `);
    await client.query(`ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS revisions_rev_unique_idx ON revisions (rev)`);
    revisionColumnInfo = null;
  } else {
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS revisions_rev_unique_idx ON revisions (rev)`);
    const { rows: defaultRows } = await client.query(`
      SELECT column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'revisions'
         AND column_name = 'rev'
    `);
    const defaultValue = defaultRows.length ? defaultRows[0].column_default || '' : '';
    if (!defaultValue.includes('revisions_rev_seq')) {
      await client.query(`ALTER TABLE revisions ALTER COLUMN rev SET DEFAULT nextval('revisions_rev_seq')`);
    }
    try {
      await client.query(`ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev`);
    } catch (err) {
      if (err?.code !== '42704' && err?.code !== '42P16' && err?.code !== '42P01') {
        throw err;
      }
    }
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_state_snapshots (
      rev BIGINT PRIMARY KEY REFERENCES revisions(rev) ON DELETE CASCADE,
      hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    await ensureRevisionInfrastructure(client);
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
  await ensureRevisionInfrastructure(runner);
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
    `SELECT rev FROM ${TABLE_SNAPSHOTS} ORDER BY rev DESC, created_at DESC LIMIT 1`
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
  const latest = await loadLatestSnapshot();
  if (latest) {
    lastRevision = Math.max(lastRevision, latest.rev);
    cachedSnapshot = latest;
    return cachedSnapshot;
  }
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const empty = buildEmptySnapshot();
  try {
    const storedSettings = await loadGeneralSettings();
    applyGeneralSettingsToSnapshot(empty, storedSettings);
  } catch (err) {
    console.warn('Failed to hydrate default general settings', err);
  }
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

// storage helpers will be defined below

function parseOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const normalized = String(value).trim();
    return normalized || null;
  }
  return null;
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
}

function parseOptionalBoolean(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return normalizePreferenceValue(value);
}

function parseOptionalTimestamp(value) {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

async function clearStateForRevision(client, rev) {
  await client.query(`DELETE FROM ${TABLE_SCALARS} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_CAPACITY} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_PARALLEL} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_ROUTE_OVERRIDES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_IGNORED_STATES} WHERE rev = $1`, [rev]);
  await client.query(
    `DELETE FROM ${TABLE_ORDER_STAGE_ROUTES} WHERE stage_id IN (
       SELECT id FROM ${TABLE_ORDER_STAGES} WHERE rev = $1
     )`,
    [rev]
  );
  await client.query(
    `DELETE FROM ${TABLE_ORDER_STAGE_ATTRIBUTES} WHERE stage_id IN (
       SELECT id FROM ${TABLE_ORDER_STAGES} WHERE rev = $1
     )`,
    [rev]
  );
  await client.query(`DELETE FROM ${TABLE_ORDER_STAGES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_ORDER_HEADERS} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_LIST_ENTRIES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_META_VALUES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_META_HISTORY} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_CRM_VALUES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_MODE_VALUES} WHERE rev = $1`, [rev]);
}

async function persistScalarValues(client, rev, snapshot) {
  await client.query(`DELETE FROM ${TABLE_SCALARS} WHERE rev = $1`, [rev]);
  for (const key of STATE_SCALAR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      continue;
    }
    const normalized = normalizePrimitiveForStorage(snapshot[key]);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_SCALARS} (rev, key, value_type, value_text, value_numeric, value_boolean, value_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rev, key, normalized.type, normalized.text, normalized.numeric, normalized.boolean, null]
    );
  }
}

async function persistCapacity(client, rev, capacity) {
  await client.query(`DELETE FROM ${TABLE_CAPACITY} WHERE rev = $1`, [rev]);
  if (!isPlainObject(capacity)) {
    return;
  }
  for (const [code, value] of Object.entries(capacity)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_CAPACITY} (rev, process_code, minutes) VALUES ($1,$2,$3)`,
      [rev, String(code), numeric]
    );
  }
}

async function persistParallel(client, rev, parallel) {
  await client.query(`DELETE FROM ${TABLE_PARALLEL} WHERE rev = $1`, [rev]);
  if (!isPlainObject(parallel)) {
    return;
  }
  for (const [code, value] of Object.entries(parallel)) {
    const flag = normalizePreferenceValue(value);
    if (flag === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_PARALLEL} (rev, process_code, is_parallel) VALUES ($1,$2,$3)`,
      [rev, String(code), flag]
    );
  }
}

async function persistRouteOverrides(client, rev, overrides) {
  await client.query(`DELETE FROM ${TABLE_ROUTE_OVERRIDES} WHERE rev = $1`, [rev]);
  if (!Array.isArray(overrides)) {
    return;
  }
  for (const entry of overrides) {
    if (!Array.isArray(entry) || entry.length < 2) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = parseOptionalString(entry[0]) || '';
    const payload = isPlainObject(entry[1]) ? entry[1] : {};
    const [parentRaw, stageRaw] = key.split('::');
    const parentOrderId = parseOptionalString(parentRaw) || '';
    const stage = parseOptionalString(stageRaw) || '';
    const startAt = parseDate(payload.start || payload.startAt || payload.start_date);
    const endAt = parseDate(payload.end || payload.endAt || payload.end_date);
    const source = parseOptionalString(payload.source || payload.reason || payload.note);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_ROUTE_OVERRIDES} (rev, parent_order_id, stage, start_at, end_at, source)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [rev, parentOrderId, stage, startAt ? startAt.toISOString() : null, endAt ? endAt.toISOString() : null, source]
    );
  }
}

async function persistIgnoredStates(client, rev, ignored) {
  await client.query(`DELETE FROM ${TABLE_IGNORED_STATES} WHERE rev = $1`, [rev]);
  if (!Array.isArray(ignored)) {
    return;
  }
  for (let index = 0; index < ignored.length; index += 1) {
    const key = parseOptionalString(ignored[index]);
    if (!key) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_IGNORED_STATES} (rev, state_key, ordinal) VALUES ($1,$2,$3)`,
      [rev, key, index]
    );
  }
}

function sanitizeStageOrdersEntry(entry) {
  if (!Array.isArray(entry) || entry.length < 1) {
    return null;
  }
  const stage = parseOptionalString(entry[0]);
  if (!stage) {
    return null;
  }
  const rawList = entry.length > 1 ? entry[1] : [];
  const uids = Array.isArray(rawList)
    ? rawList.map((value) => parseOptionalString(value)).filter((value) => value !== null)
    : [];
  return { stage, uids };
}

function sanitizeLockedEntry(entry) {
  const value = parseOptionalString(entry);
  return value || null;
}

function extractOrderIdentifiers(entry) {
  if (!isPlainObject(entry)) {
    return {
      parentOrderId: null,
      childOrderId: null,
      orderIdentity: null,
      crmOrderId: null,
      crmChildId: null
    };
  }

  const parentOrderId = parseOptionalString(
    entry.parentId
      || entry.parent_id
      || entry.parentOrderId
      || entry.parent_order_id
      || entry.parent
  );
  const childOrderId = parseOptionalString(
    entry.childId
      || entry.child_id
      || entry.childOrderId
      || entry.child_order_id
      || entry.uid
      || entry.id
  );
  const orderIdentity = parseOptionalString(
    entry.orderIdentity
      || entry.orderId
      || entry.order_id
      || entry.orderNumber
      || entry.order_number
      || entry.id
      || entry.uid
      || childOrderId
      || parentOrderId
  );
  const crmOrderId = parseOptionalString(
    entry.crmOrderId
      || entry.crm_order_id
      || entry.crmParentId
      || entry.crm_parent_id
      || entry.crmOrder
      || entry.crmId
  );
  const crmChildId = parseOptionalString(
    entry.crmChildId
      || entry.crm_child_id
      || entry.crmChild
      || entry.crm_child
      || entry.crmChildOrderId
      || entry.crm_child_order_id
  );

  return {
    parentOrderId,
    childOrderId,
    orderIdentity,
    crmOrderId,
    crmChildId
  };
}

function extractOrderColumnValues(entry, identifiers) {
  const uid = parseOptionalString(entry?.uid || entry?.childId || entry?.child_id || identifiers.childOrderId);
  const orderNumber = parseOptionalString(entry?.orderNumber || entry?.orderNo || entry?.number);
  const orderCustomer = parseOptionalString(entry?.orderCustomer || entry?.customer);
  const orderTitle = parseOptionalString(entry?.orderTitle || entry?.title || entry?.name || identifiers.orderIdentity);
  const stage = parseOptionalString(entry?.stage);
  const state = parseOptionalString(entry?.state);
  const status = parseOptionalString(entry?.status);
  const hours = parseOptionalNumber(entry?.hours);
  const extraHoursSource = entry?.extraHours !== undefined ? entry.extraHours : entry?.extra;
  const extraHours = parseOptionalNumber(extraHoursSource);
  const startAt = parseOptionalTimestamp(entry?.startDate || entry?.start);
  const endAt = parseOptionalTimestamp(entry?.endDate || entry?.end);
  const origStartAt = parseOptionalTimestamp(entry?.origStartDate || entry?.origStart || entry?.originalStart);
  const doneMeta = isPlainObject(entry?.doneMeta) ? entry.doneMeta : null;
  const doneAt = parseOptionalTimestamp(
    doneMeta?.when
      || entry?.doneAt
      || entry?.when
      || (isPlainObject(entry?.route) && stage ? entry.route[stage]?.doneAt : null)
  );
  const doneSource = parseOptionalString(doneMeta?.source || entry?.source);
  const progress = parseOptionalNumber(entry?.progress);
  const percent = parseOptionalNumber(
    entry?.percent
      || entry?.percentComplete
      || entry?.progressPercent
      || (isPlainObject(entry?.metrics) ? entry.metrics.percent : null)
  );
  const totalHours = parseOptionalNumber(
    entry?.totalHours
      || entry?.total
      || entry?.hoursTotal
      || entry?.totalPlan
      || (isPlainObject(entry?.metrics) ? entry.metrics.totalHours : null)
  );
  const remainingHours = parseOptionalNumber(
    entry?.remainingHours
      || entry?.remaining
      || entry?.rest
      || entry?.balance
      || (isPlainObject(entry?.metrics) ? entry.metrics.remaining : null)
  );
  const useReserveValue = parseOptionalBoolean(entry?.useReserve);
  const lockedValue = parseOptionalBoolean(entry?.locked || (Array.isArray(entry?.lockedUsers) ? entry.lockedUsers.length > 0 : null));

  return {
    uid,
    orderNumber,
    orderCustomer,
    orderTitle,
    stage,
    state,
    status,
    hours,
    extraHours,
    startAt,
    endAt,
    origStartAt,
    doneAt,
    doneSource,
    progress,
    percent,
    totalHours,
    remainingHours,
    useReserve: useReserveValue === null ? null : !!useReserveValue,
    locked: lockedValue === null ? null : !!lockedValue
  };
}

function extractRouteSegmentsForStorage(entry) {
  if (!isPlainObject(entry) || !isPlainObject(entry.route)) {
    return [];
  }
  const segments = [];
  Object.entries(entry.route).forEach(([key, value]) => {
    const segmentKey = parseOptionalString(key);
    if (!segmentKey || !isPlainObject(value)) {
      return;
    }
    const hours = parseOptionalNumber(value.hours);
    const startAt = parseOptionalTimestamp(value.start);
    const endAt = parseOptionalTimestamp(value.end);
    const origStartAt = parseOptionalTimestamp(value.origStart || value.originalStart);
    const doneAt = parseOptionalTimestamp(value.doneAt);
    if (hours === null && !startAt && !endAt && !origStartAt && !doneAt) {
      return;
    }
    segments.push({
      key: segmentKey,
      hours,
      startAt,
      endAt,
      origStartAt,
      doneAt
    });
  });
  return segments;
}

function mergeRouteSegments(baseRoute, segments) {
  const target = isPlainObject(baseRoute) ? { ...baseRoute } : {};
  segments.forEach((segment) => {
    const key = segment.key;
    if (!key) {
      return;
    }
    const existing = isPlainObject(target[key]) ? { ...target[key] } : {};
    if (segment.hours !== null && segment.hours !== undefined && !Object.prototype.hasOwnProperty.call(existing, 'hours')) {
      existing.hours = Number(segment.hours);
    }
    if (segment.startAt) {
      const iso = new Date(segment.startAt).toISOString();
      if (!existing.start) {
        existing.start = iso;
      }
    }
    if (segment.endAt) {
      const iso = new Date(segment.endAt).toISOString();
      if (!existing.end) {
        existing.end = iso;
      }
    }
    if (segment.origStartAt) {
      const iso = new Date(segment.origStartAt).toISOString();
      if (!existing.origStart) {
        existing.origStart = iso;
      }
    }
    if (segment.doneAt) {
      const iso = new Date(segment.doneAt).toISOString();
      if (!existing.doneAt) {
        existing.doneAt = iso;
      }
    }
    target[key] = existing;
  });
  return target;
}

function applyOrderColumnsToObject(row, baseEntry) {
  const entry = isPlainObject(baseEntry) ? baseEntry : {};
  const assign = (key, value) => {
    if (value === null || value === undefined) {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(entry, key)
        || entry[key] === null
        || entry[key] === undefined
        || entry[key] === '') {
      entry[key] = value;
    }
  };

  assign('parentId', row.parent_order_id);
  assign('childId', row.child_order_id);
  assign('orderId', row.order_identity || row.child_order_id || row.parent_order_id);
  assign('orderIdentity', row.order_identity || row.child_order_id || row.parent_order_id);
  assign('crmOrderId', row.crm_order_id);
  assign('crmChildId', row.crm_child_id);
  assign('uid', row.uid || row.child_order_id || row.order_identity || row.parent_order_id);
  assign('orderNumber', row.order_number);
  assign('orderCustomer', row.order_customer);
  assign('title', row.order_title);
  assign('stage', row.stage);
  assign('state', row.state);
  assign('status', row.status);
  if (row.order_ordinal !== null && row.order_ordinal !== undefined) {
    assign('orderOrdinal', Number(row.order_ordinal));
  }
  if (row.ordinal !== null && row.ordinal !== undefined) {
    assign('stageOrdinal', Number(row.ordinal));
  }

  if (row.hours !== null && row.hours !== undefined) {
    assign('hours', Number(row.hours));
  }
  if (row.extra_hours !== null && row.extra_hours !== undefined) {
    assign('extraHours', Number(row.extra_hours));
    if (!Object.prototype.hasOwnProperty.call(entry, 'extra')) {
      entry.extra = Number(row.extra_hours);
    }
  }
  if (row.progress !== null && row.progress !== undefined) {
    assign('progress', Number(row.progress));
  }
  if (row.percent !== null && row.percent !== undefined) {
    assign('percent', Number(row.percent));
    if (!Object.prototype.hasOwnProperty.call(entry, 'progressPercent')) {
      entry.progressPercent = Number(row.percent);
    }
  }
  if (row.total_hours !== null && row.total_hours !== undefined) {
    const total = Number(row.total_hours);
    assign('totalHours', total);
    if (!Object.prototype.hasOwnProperty.call(entry, 'total')) {
      entry.total = total;
    }
  }
  if (row.remaining_hours !== null && row.remaining_hours !== undefined) {
    const remaining = Number(row.remaining_hours);
    assign('remainingHours', remaining);
    if (!Object.prototype.hasOwnProperty.call(entry, 'remaining')) {
      entry.remaining = remaining;
    }
  }
  if (row.use_reserve !== null) {
    assign('useReserve', !!row.use_reserve);
  }
  if (row.locked !== null) {
    assign('locked', !!row.locked);
  }

  const startIso = row.start_at ? new Date(row.start_at).toISOString() : '';
  const endIso = row.end_at ? new Date(row.end_at).toISOString() : '';
  const origStartIso = row.orig_start_at ? new Date(row.orig_start_at).toISOString() : '';
  const doneIso = row.done_at ? new Date(row.done_at).toISOString() : '';

  if (startIso) {
    assign('startDate', startIso);
    assign('start', startIso);
  }
  if (endIso) {
    assign('endDate', endIso);
    assign('end', endIso);
  }
  if (origStartIso) {
    assign('origStartDate', origStartIso);
    assign('origStart', origStartIso);
  }
  if (doneIso || row.done_source) {
    if (!isPlainObject(entry.doneMeta)) {
      entry.doneMeta = {};
    }
    if (doneIso && !entry.doneMeta.when) {
      entry.doneMeta.when = doneIso;
    }
    if (row.done_source && !entry.doneMeta.source) {
      entry.doneMeta.source = row.done_source;
    }
  }

  return entry;
}

async function persistOrderEntries(client, rev, listKey, entries) {
  const { rows: oldStageRows } = await client.query(
    `SELECT id FROM ${TABLE_ORDER_STAGES} WHERE rev = $1 AND list_key = $2`,
    [rev, listKey]
  );
  const stageIds = oldStageRows.map((row) => row.id);
  if (stageIds.length) {
    await client.query(
      `DELETE FROM ${TABLE_ORDER_STAGE_ROUTES} WHERE stage_id = ANY($1::bigint[])`,
      [stageIds]
    );
    await client.query(
      `DELETE FROM ${TABLE_ORDER_STAGE_ATTRIBUTES} WHERE stage_id = ANY($1::bigint[])`,
      [stageIds]
    );
  }

  await client.query(`DELETE FROM ${TABLE_ORDER_STAGES} WHERE rev = $1 AND list_key = $2`, [rev, listKey]);
  await client.query(`DELETE FROM ${TABLE_ORDER_HEADERS} WHERE rev = $1 AND list_key = $2`, [rev, listKey]);

  if (!Array.isArray(entries) || !entries.length) {
    return;
  }

  const orderCache = new Map();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const identifiers = extractOrderIdentifiers(entry);
    const columnValues = extractOrderColumnValues(entry, identifiers);
    const primaryParentId = identifiers.parentOrderId
      || identifiers.orderIdentity
      || columnValues.orderIdentity
      || columnValues.orderNumber
      || columnValues.uid;

    if (!primaryParentId) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const canonicalParentId = identifiers.parentOrderId || primaryParentId;

    let headerInfo = orderCache.get(canonicalParentId);
    if (!headerInfo) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: headerRows } = await client.query(
        `INSERT INTO ${TABLE_ORDER_HEADERS} (
           rev,
           parent_order_id,
           order_identity,
           crm_order_id,
           order_number,
           order_customer,
           order_title,
           status,
           state,
           progress,
           percent,
           total_hours,
           extra_hours,
           remaining_hours,
           start_at,
           end_at,
           orig_start_at,
           done_at,
           done_source,
           use_reserve,
           locked,
           list_key,
           ordinal
         )
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
         )
         ON CONFLICT (rev, parent_order_id)
         DO UPDATE SET
           order_identity = EXCLUDED.order_identity,
           crm_order_id = COALESCE(EXCLUDED.crm_order_id, ${TABLE_ORDER_HEADERS}.crm_order_id),
           order_number = COALESCE(EXCLUDED.order_number, ${TABLE_ORDER_HEADERS}.order_number),
           order_customer = COALESCE(EXCLUDED.order_customer, ${TABLE_ORDER_HEADERS}.order_customer),
           order_title = COALESCE(EXCLUDED.order_title, ${TABLE_ORDER_HEADERS}.order_title),
           status = COALESCE(EXCLUDED.status, ${TABLE_ORDER_HEADERS}.status),
           state = COALESCE(EXCLUDED.state, ${TABLE_ORDER_HEADERS}.state),
           progress = COALESCE(EXCLUDED.progress, ${TABLE_ORDER_HEADERS}.progress),
           percent = COALESCE(EXCLUDED.percent, ${TABLE_ORDER_HEADERS}.percent),
           total_hours = COALESCE(EXCLUDED.total_hours, ${TABLE_ORDER_HEADERS}.total_hours),
           extra_hours = COALESCE(EXCLUDED.extra_hours, ${TABLE_ORDER_HEADERS}.extra_hours),
           remaining_hours = COALESCE(EXCLUDED.remaining_hours, ${TABLE_ORDER_HEADERS}.remaining_hours),
           start_at = COALESCE(EXCLUDED.start_at, ${TABLE_ORDER_HEADERS}.start_at),
           end_at = COALESCE(EXCLUDED.end_at, ${TABLE_ORDER_HEADERS}.end_at),
           orig_start_at = COALESCE(EXCLUDED.orig_start_at, ${TABLE_ORDER_HEADERS}.orig_start_at),
           done_at = COALESCE(EXCLUDED.done_at, ${TABLE_ORDER_HEADERS}.done_at),
           done_source = COALESCE(EXCLUDED.done_source, ${TABLE_ORDER_HEADERS}.done_source),
           use_reserve = COALESCE(EXCLUDED.use_reserve, ${TABLE_ORDER_HEADERS}.use_reserve),
           locked = COALESCE(EXCLUDED.locked, ${TABLE_ORDER_HEADERS}.locked),
           list_key = EXCLUDED.list_key,
           ordinal = LEAST(${TABLE_ORDER_HEADERS}.ordinal, EXCLUDED.ordinal),
           updated_at = now()
         RETURNING id, ordinal`,
        [
          rev,
          canonicalParentId,
          identifiers.orderIdentity
            || columnValues.orderIdentity
            || columnValues.uid
            || canonicalParentId,
          identifiers.crmOrderId,
          columnValues.orderNumber,
          columnValues.orderCustomer,
          columnValues.orderTitle,
          columnValues.status,
          columnValues.state,
          columnValues.progress,
          columnValues.percent,
          columnValues.totalHours,
          columnValues.extraHours,
          columnValues.remainingHours,
          columnValues.startAt,
          columnValues.endAt,
          columnValues.origStartAt,
          columnValues.doneAt,
          columnValues.doneSource,
          columnValues.useReserve,
          columnValues.locked,
          listKey,
          index
        ]
      );

      const headerRow = headerRows[0];
      if (!headerRow || !headerRow.id) {
        // eslint-disable-next-line no-continue
        continue;
      }
      headerInfo = { id: headerRow.id };
      orderCache.set(canonicalParentId, headerInfo);
    }

    const stageChildId = identifiers.childOrderId
      || columnValues.uid
      || identifiers.orderIdentity
      || columnValues.orderIdentity
      || `${canonicalParentId}::${index}`;

    // eslint-disable-next-line no-await-in-loop
    const { rows: stageRows } = await client.query(
      `INSERT INTO ${TABLE_ORDER_STAGES} (
         rev,
         order_id,
         parent_order_id,
         child_order_id,
         order_identity,
         crm_child_id,
         stage,
         status,
         state,
         progress,
         percent,
         hours,
         extra_hours,
         remaining_hours,
         start_at,
         end_at,
         orig_start_at,
         done_at,
         done_source,
         use_reserve,
         locked,
         list_key,
         ordinal
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
       )
       ON CONFLICT (rev, parent_order_id, child_order_id)
       DO UPDATE SET
         order_id = EXCLUDED.order_id,
         order_identity = EXCLUDED.order_identity,
         crm_child_id = COALESCE(EXCLUDED.crm_child_id, ${TABLE_ORDER_STAGES}.crm_child_id),
         stage = COALESCE(EXCLUDED.stage, ${TABLE_ORDER_STAGES}.stage),
         status = COALESCE(EXCLUDED.status, ${TABLE_ORDER_STAGES}.status),
         state = COALESCE(EXCLUDED.state, ${TABLE_ORDER_STAGES}.state),
         progress = COALESCE(EXCLUDED.progress, ${TABLE_ORDER_STAGES}.progress),
         percent = COALESCE(EXCLUDED.percent, ${TABLE_ORDER_STAGES}.percent),
         hours = COALESCE(EXCLUDED.hours, ${TABLE_ORDER_STAGES}.hours),
         extra_hours = COALESCE(EXCLUDED.extra_hours, ${TABLE_ORDER_STAGES}.extra_hours),
         remaining_hours = COALESCE(EXCLUDED.remaining_hours, ${TABLE_ORDER_STAGES}.remaining_hours),
         start_at = COALESCE(EXCLUDED.start_at, ${TABLE_ORDER_STAGES}.start_at),
         end_at = COALESCE(EXCLUDED.end_at, ${TABLE_ORDER_STAGES}.end_at),
         orig_start_at = COALESCE(EXCLUDED.orig_start_at, ${TABLE_ORDER_STAGES}.orig_start_at),
         done_at = COALESCE(EXCLUDED.done_at, ${TABLE_ORDER_STAGES}.done_at),
         done_source = COALESCE(EXCLUDED.done_source, ${TABLE_ORDER_STAGES}.done_source),
         use_reserve = COALESCE(EXCLUDED.use_reserve, ${TABLE_ORDER_STAGES}.use_reserve),
         locked = COALESCE(EXCLUDED.locked, ${TABLE_ORDER_STAGES}.locked),
         list_key = EXCLUDED.list_key,
         ordinal = EXCLUDED.ordinal,
         updated_at = now()
       RETURNING id`,
      [
        rev,
        headerInfo.id,
        canonicalParentId,
        stageChildId,
        identifiers.orderIdentity
          || columnValues.orderIdentity
          || columnValues.uid
          || stageChildId,
        identifiers.crmChildId,
        columnValues.stage,
        columnValues.status,
        columnValues.state,
        columnValues.progress,
        columnValues.percent,
        columnValues.hours,
        columnValues.extraHours,
        columnValues.remainingHours,
        columnValues.startAt,
        columnValues.endAt,
        columnValues.origStartAt,
        columnValues.doneAt,
        columnValues.doneSource,
        columnValues.useReserve,
        columnValues.locked,
        listKey,
        index
      ]
    );

    const stageRow = stageRows[0];
    if (!stageRow || !stageRow.id) {
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `DELETE FROM ${TABLE_ORDER_STAGE_ROUTES} WHERE stage_id = $1`,
      [stageRow.id]
    );
    const routeSegments = extractRouteSegmentsForStorage(entry);
    for (const segment of routeSegments) {
      if (!segment.key) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_ORDER_STAGE_ROUTES} (stage_id, segment_key, hours, start_at, end_at, orig_start_at, done_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          stageRow.id,
          segment.key,
          segment.hours,
          segment.startAt,
          segment.endAt,
          segment.origStartAt,
          segment.doneAt
        ]
      );
    }

    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `DELETE FROM ${TABLE_ORDER_STAGE_ATTRIBUTES} WHERE stage_id = $1`,
      [stageRow.id]
    );
    const attributeRows = flattenObjectForStorage(entry);
    for (const row of attributeRows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_ORDER_STAGE_ATTRIBUTES} (stage_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          stageRow.id,
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null
        ]
      );
    }
  }
}

async function persistListEntries(client, rev, listKey, entries) {
  await client.query(`DELETE FROM ${TABLE_LIST_ENTRIES} WHERE rev = $1 AND list_key = $2`, [rev, listKey]);
  if (!Array.isArray(entries) || !entries.length) {
    return;
  }

  if (listKey === 'locked') {
    for (let index = 0; index < entries.length; index += 1) {
      const uid = sanitizeLockedEntry(entries[index]);
      if (!uid) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rev, listKey, null, null, uid, index]
      );
    }
    return;
  }

  if (listKey === 'orders') {
    for (let index = 0; index < entries.length; index += 1) {
      const sanitized = sanitizeStageOrdersEntry(entries[index]);
      if (!sanitized) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const orderIdentity = sanitized.stage;
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await client.query(
        `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id` ,
        [rev, listKey, sanitized.stage, null, orderIdentity, index]
      );
      const entryId = rows[0]?.id;
      if (!entryId) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const attributeRows = flattenObjectForStorage({ stage: sanitized.stage, uids: sanitized.uids });
      for (const row of attributeRows) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO ${TABLE_LIST_ATTRIBUTES} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            entryId,
            row.path,
            row.ordinal || 0,
            row.type,
            row.valueText,
            row.valueNumeric,
            row.valueBoolean,
            null
          ]
        );
      }
    }
    return;
  }

  if (listKey === 'exc' || listKey === 'res') {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      let key = null;
      let value = null;

      if (Array.isArray(entry) && entry.length >= 1) {
        key = parseOptionalString(entry[0]);
        value = entry.length > 1 ? entry[1] : null;
      } else if (isPlainObject(entry)) {
        key = parseOptionalString(entry.key || entry.id || entry.name);
        if (Object.prototype.hasOwnProperty.call(entry, 'value')) {
          value = entry.value;
        } else if (Object.prototype.hasOwnProperty.call(entry, 'hours')) {
          value = entry.hours;
        } else {
          value = { ...entry };
        }
      }

      if (!key) {
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const { rows } = await client.query(
        `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id` ,
        [rev, listKey, key, null, key, index]
      );
      const entryId = rows[0]?.id;
      if (!entryId) {
        // eslint-disable-next-line no-continue
        continue;
      }

      const attributeValue = isPlainObject(value) ? value : { value };
      const attributeRows = flattenObjectForStorage(attributeValue);
      for (const row of attributeRows) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO ${TABLE_LIST_ATTRIBUTES} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            entryId,
            row.path,
            row.ordinal || 0,
            row.type,
            row.valueText,
            row.valueNumeric,
            row.valueBoolean,
            null
          ]
        );
      }
    }
    return;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const parentOrderId = parseOptionalString(entry.parentId);
    const childOrderId = parseOptionalString(entry.childId);
    const orderIdentity = parseOptionalString(entry.orderId || entry.orderNumber || entry.orderIdentity);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(
      `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id` ,
      [rev, listKey, parentOrderId, childOrderId, orderIdentity, index]
    );
    const entryId = rows[0]?.id;
    if (!entryId) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const attributeRows = flattenObjectForStorage(entry);
    for (const row of attributeRows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_LIST_ATTRIBUTES} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entryId,
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null
        ]
      );
    }
  }
}

async function persistStructuredValues(client, table, rev, data) {
  await client.query(`DELETE FROM ${table} WHERE rev = $1`, [rev]);
  if (!isPlainObject(data) || !Object.keys(data).length) {
    return;
  }
  const rows = flattenObjectForStorage(data);
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${table} (rev, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        rev,
        row.path,
        row.ordinal || 0,
        row.type,
        row.valueText,
        row.valueNumeric,
        row.valueBoolean,
        null
      ]
    );
  }
}

async function persistMetaHistory(client, rev, history) {
  await client.query(`DELETE FROM ${TABLE_META_HISTORY} WHERE rev = $1`, [rev]);
  if (!Array.isArray(history) || !history.length) {
    return;
  }
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (!isPlainObject(entry)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const actor = parseOptionalString(entry.actor);
    const source = parseOptionalString(entry.source);
    const note = parseOptionalString(entry.note);
    const summary = parseOptionalString(entry.summary);
    const when = parseDate(entry.when || entry.timestamp || entry.createdAt);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(
      `INSERT INTO ${TABLE_META_HISTORY} (rev, ordinal, actor, source, note, summary, event_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [rev, index, actor, source, note, summary, when ? when.toISOString() : null]
    );
    const entryId = rows[0]?.id;
    if (!entryId) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const attributeRows = flattenObjectForStorage(entry);
    for (const row of attributeRows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_META_HISTORY_ATTRS} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          entryId,
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null
        ]
      );
    }
  }
}

async function loadScalarValues(executor, rev) {
  const result = {};
  const { rows } = await executor.query(
    `SELECT key, value_type, value_text, value_numeric, value_boolean
       FROM ${TABLE_SCALARS}
      WHERE rev = $1`,
    [rev]
  );
  rows.forEach((row) => {
    if (row.value_type === 'number') {
      result[row.key] = Number(row.value_numeric);
    } else if (row.value_type === 'boolean') {
      result[row.key] = row.value_boolean === null ? false : !!row.value_boolean;
    } else if (row.value_type === 'null') {
      result[row.key] = null;
    } else if (row.value_type === 'string') {
      result[row.key] = row.value_text == null ? '' : row.value_text;
    } else {
      result[row.key] = row.value_text;
    }
  });
  return result;
}

async function loadCapacityMap(executor, rev) {
  const map = {};
  const { rows } = await executor.query(
    `SELECT process_code, minutes FROM ${TABLE_CAPACITY} WHERE rev = $1`,
    [rev]
  );
  rows.forEach((row) => {
    map[row.process_code] = Number(row.minutes);
  });
  return map;
}

async function loadParallelMap(executor, rev) {
  const map = {};
  const { rows } = await executor.query(
    `SELECT process_code, is_parallel FROM ${TABLE_PARALLEL} WHERE rev = $1`,
    [rev]
  );
  rows.forEach((row) => {
    map[row.process_code] = !!row.is_parallel;
  });
  return map;
}

async function loadIgnoredStates(executor, rev) {
  const { rows } = await executor.query(
    `SELECT state_key
       FROM ${TABLE_IGNORED_STATES}
      WHERE rev = $1
      ORDER BY ordinal`,
    [rev]
  );
  return rows.map((row) => row.state_key);
}

async function loadRouteOverrides(executor, rev) {
  const { rows } = await executor.query(
    `SELECT parent_order_id, stage, start_at, end_at, source
       FROM ${TABLE_ROUTE_OVERRIDES}
      WHERE rev = $1
      ORDER BY parent_order_id, stage`,
    [rev]
  );
  return rows.map((row) => {
    const key = `${row.parent_order_id || ''}::${row.stage || ''}`;
    const value = {};
    if (row.start_at) {
      value.start = new Date(row.start_at).toISOString();
    }
    if (row.end_at) {
      value.end = new Date(row.end_at).toISOString();
    }
    if (row.source) {
      value.source = row.source;
    }
    return [key, value];
  });
}

async function loadOrderEntries(executor, rev, listKey) {
  const { rows } = await executor.query(
    `SELECT stage.id,
            stage.ordinal,
            header.ordinal AS order_ordinal,
            stage.parent_order_id,
            stage.child_order_id,
            stage.child_order_id AS uid,
            stage.order_identity,
            header.crm_order_id,
            stage.crm_child_id,
            header.order_number,
            header.order_customer,
            header.order_title,
            stage.stage,
            COALESCE(stage.state, header.state) AS state,
            COALESCE(stage.status, header.status) AS status,
            COALESCE(stage.hours, header.total_hours) AS hours,
            COALESCE(stage.extra_hours, header.extra_hours) AS extra_hours,
            COALESCE(stage.start_at, header.start_at) AS start_at,
            COALESCE(stage.end_at, header.end_at) AS end_at,
            COALESCE(stage.orig_start_at, header.orig_start_at) AS orig_start_at,
            COALESCE(stage.done_at, header.done_at) AS done_at,
            COALESCE(stage.done_source, header.done_source) AS done_source,
            COALESCE(stage.progress, header.progress) AS progress,
            COALESCE(stage.percent, header.percent) AS percent,
            header.total_hours,
            COALESCE(stage.remaining_hours, header.remaining_hours) AS remaining_hours,
            COALESCE(stage.use_reserve, header.use_reserve) AS use_reserve,
            COALESCE(stage.locked, header.locked) AS locked
       FROM ${TABLE_ORDER_STAGES} stage
  LEFT JOIN ${TABLE_ORDER_HEADERS} header
         ON header.id = stage.order_id
      WHERE stage.rev = $1 AND stage.list_key = $2
      ORDER BY stage.ordinal`,
    [rev, listKey]
  );
  if (!rows.length) {
    return [];
  }

  const orderIds = rows.map((row) => row.id);
  const { rows: attrRows } = await executor.query(
    `SELECT stage_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean
       FROM ${TABLE_ORDER_STAGE_ATTRIBUTES}
      WHERE stage_id = ANY($1::bigint[])
      ORDER BY stage_id, char_length(attr_path), attr_path, ordinal`,
    [orderIds]
  );
  const grouped = new Map();
  attrRows.forEach((row) => {
    if (!grouped.has(row.stage_id)) {
      grouped.set(row.stage_id, []);
    }
    grouped.get(row.stage_id).push({
      path: row.attr_path,
      value_type: row.value_type,
      value_text: row.value_text,
      value_numeric: row.value_numeric,
      value_boolean: row.value_boolean,
      ordinal: row.ordinal
    });
  });

  const { rows: routeRows } = await executor.query(
    `SELECT stage_id, segment_key, hours, start_at, end_at, orig_start_at, done_at
       FROM ${TABLE_ORDER_STAGE_ROUTES}
      WHERE stage_id = ANY($1::bigint[])`,
    [orderIds]
  );
  const routeGrouped = new Map();
  routeRows.forEach((row) => {
    if (!routeGrouped.has(row.stage_id)) {
      routeGrouped.set(row.stage_id, []);
    }
    routeGrouped.get(row.stage_id).push({
      key: parseOptionalString(row.segment_key),
      hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
      startAt: row.start_at || null,
      endAt: row.end_at || null,
      origStartAt: row.orig_start_at || null,
      doneAt: row.done_at || null
    });
  });

  return rows.map((row) => {
    const attrs = grouped.get(row.id) || [];
    const built = buildObjectFromRows(attrs);
    const hydrated = applyOrderColumnsToObject(row, built);
    const segments = (routeGrouped.get(row.id) || []).filter((segment) => segment.key);
    if (segments.length) {
      hydrated.route = mergeRouteSegments(hydrated.route, segments);
    }
    return hydrated;
  });
}

async function loadListEntries(executor, rev, listKey) {
  const { rows } = await executor.query(
    `SELECT id, ordinal, parent_order_id, child_order_id, order_identity
       FROM ${TABLE_LIST_ENTRIES}
      WHERE rev = $1 AND list_key = $2
      ORDER BY ordinal`,
    [rev, listKey]
  );
  if (!rows.length) {
    return [];
  }

  if (listKey === 'locked') {
    return rows
      .map((row) => parseOptionalString(row.order_identity) || parseOptionalString(row.parent_order_id))
      .filter((value) => value);
  }

  const entryIds = rows.map((row) => row.id);
  const { rows: attrRows } = await executor.query(
    `SELECT entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean
       FROM ${TABLE_LIST_ATTRIBUTES}
      WHERE entry_id = ANY($1::bigint[])
      ORDER BY entry_id, char_length(attr_path), attr_path, ordinal`,
    [entryIds]
  );
  const grouped = new Map();
  attrRows.forEach((row) => {
    if (!grouped.has(row.entry_id)) {
      grouped.set(row.entry_id, []);
    }
    grouped.get(row.entry_id).push({
      path: row.attr_path,
      value_type: row.value_type,
      value_text: row.value_text,
      value_numeric: row.value_numeric,
      value_boolean: row.value_boolean,
      ordinal: row.ordinal
    });
  });

  if (listKey === 'orders') {
    return rows
      .map((row) => {
        const attrs = grouped.get(row.id) || [];
        const built = buildObjectFromRows(attrs);
        const stage = parseOptionalString(built.stage)
          || parseOptionalString(row.parent_order_id)
          || parseOptionalString(row.order_identity);
        if (!stage) {
          return null;
        }
        const uidsSource = Array.isArray(built.uids) ? built.uids : [];
        const uids = uidsSource
          .map((value) => parseOptionalString(value))
          .filter((value) => value);
        return [stage, uids];
      })
      .filter((value) => Array.isArray(value) && value.length === 2);
  }

  if (listKey === 'exc' || listKey === 'res') {
    return rows
      .map((row) => {
        const key = parseOptionalString(row.parent_order_id)
          || parseOptionalString(row.order_identity)
          || null;
        if (!key) {
          return null;
        }
        const attrs = grouped.get(row.id) || [];
        const built = buildObjectFromRows(attrs);
        if (isPlainObject(built) && Object.prototype.hasOwnProperty.call(built, 'value') && Object.keys(built).length === 1) {
          return [key, built.value];
        }
        if (isPlainObject(built) && Object.keys(built).length) {
          return [key, built];
        }
        if (built && !isPlainObject(built)) {
          return [key, built];
        }
        return [key, null];
      })
      .filter((value) => Array.isArray(value) && value.length === 2);
  }

  return rows.map((row) => {
    const attrs = grouped.get(row.id) || [];
    const built = buildObjectFromRows(attrs);
    if (isPlainObject(built) && Object.keys(built).length) {
      return built;
    }
    const fallback = {};
    if (row.parent_order_id) {
      fallback.parentId = row.parent_order_id;
    }
    if (row.child_order_id) {
      fallback.childId = row.child_order_id;
    }
    if (row.order_identity) {
      fallback.orderId = row.order_identity;
    }
    return fallback;
  });
}

async function loadStructuredValues(executor, table, rev, fallback = null) {
  const { rows } = await executor.query(
    `SELECT path, value_type, value_text, value_numeric, value_boolean, ordinal
       FROM ${table}
      WHERE rev = $1
      ORDER BY char_length(path), path, ordinal`,
    [rev]
  );
  if (!rows.length) {
    if (fallback === null) {
      return {};
    }
    return cloneDeepPlain(fallback);
  }
  return buildObjectFromRows(rows);
}

async function loadMetaHistory(executor, rev) {
  const { rows } = await executor.query(
    `SELECT id, ordinal, actor, source, note, summary, event_time
       FROM ${TABLE_META_HISTORY}
      WHERE rev = $1
      ORDER BY ordinal`,
    [rev]
  );
  if (!rows.length) {
    return [];
  }
  const entryIds = rows.map((row) => row.id);
  const { rows: attrRows } = await executor.query(
    `SELECT entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean
       FROM ${TABLE_META_HISTORY_ATTRS}
      WHERE entry_id = ANY($1::bigint[])
      ORDER BY entry_id, char_length(attr_path), attr_path, ordinal`,
    [entryIds]
  );
  const grouped = new Map();
  attrRows.forEach((row) => {
    if (!grouped.has(row.entry_id)) {
      grouped.set(row.entry_id, []);
    }
    grouped.get(row.entry_id).push({
      path: row.attr_path,
      value_type: row.value_type,
      value_text: row.value_text,
      value_numeric: row.value_numeric,
      value_boolean: row.value_boolean,
      ordinal: row.ordinal
    });
  });
  return rows.map((row) => {
    const entry = buildObjectFromRows(grouped.get(row.id) || []);
    const result = isPlainObject(entry) ? entry : {};
    if (row.actor && !result.actor) {
      result.actor = row.actor;
    }
    if (row.source && !result.source) {
      result.source = row.source;
    }
    if (row.note && !result.note) {
      result.note = row.note;
    }
    if (row.summary && !result.summary) {
      result.summary = row.summary;
    }
    if (row.event_time && !result.when) {
      result.when = new Date(row.event_time).toISOString();
    }
    return result;
  });
}

async function loadMetaHistoryForRevisions(executor, revs) {
  const { rows } = await executor.query(
    `SELECT id, rev, ordinal, actor, source, note, summary, event_time
       FROM ${TABLE_META_HISTORY}
      WHERE rev = ANY($1::bigint[])
      ORDER BY rev, ordinal`,
    [revs]
  );
  if (!rows.length) {
    return new Map();
  }
  const entryIds = rows.map((row) => row.id);
  const { rows: attrRows } = await executor.query(
    `SELECT entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean
       FROM ${TABLE_META_HISTORY_ATTRS}
      WHERE entry_id = ANY($1::bigint[])
      ORDER BY entry_id, char_length(attr_path), attr_path, ordinal`,
    [entryIds]
  );
  const grouped = new Map();
  attrRows.forEach((row) => {
    if (!grouped.has(row.entry_id)) {
      grouped.set(row.entry_id, []);
    }
    grouped.get(row.entry_id).push({
      path: row.attr_path,
      value_type: row.value_type,
      value_text: row.value_text,
      value_numeric: row.value_numeric,
      value_boolean: row.value_boolean,
      ordinal: row.ordinal
    });
  });
  const result = new Map();
  rows.forEach((row) => {
    const entry = buildObjectFromRows(grouped.get(row.id) || []);
    const payload = isPlainObject(entry) ? entry : {};
    if (row.actor && !payload.actor) {
      payload.actor = row.actor;
    }
    if (row.source && !payload.source) {
      payload.source = row.source;
    }
    if (row.note && !payload.note) {
      payload.note = row.note;
    }
    if (row.summary && !payload.summary) {
      payload.summary = row.summary;
    }
    if (row.event_time && !payload.when) {
      payload.when = new Date(row.event_time).toISOString();
    }
    const rev = Number(row.rev || 0);
    if (!result.has(rev)) {
      result.set(rev, []);
    }
    result.get(rev).push(payload);
  });
  return result;
}

async function loadSnapshotDataObject(runner, rev) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  const snapshot = buildEmptySnapshot();
  const scalarValues = await loadScalarValues(executor, rev);
  Object.entries(scalarValues).forEach(([key, value]) => {
    snapshot[key] = value;
  });
  snapshot.capByProc = await loadCapacityMap(executor, rev);
  snapshot.parallelByProc = await loadParallelMap(executor, rev);
  snapshot.ignoredStates = await loadIgnoredStates(executor, rev);
  snapshot.routeOverrides = await loadRouteOverrides(executor, rev);
  snapshot.crm = await loadStructuredValues(executor, TABLE_CRM_VALUES, rev, snapshot.crm);
  snapshot.modeScoped = await loadStructuredValues(executor, TABLE_MODE_VALUES, rev, snapshot.modeScoped);
  for (const listKey of ORDER_LIST_KEYS) {
    snapshot[listKey] = await loadOrderEntries(executor, rev, listKey);
  }
  for (const listKey of STATE_LIST_KEYS) {
    snapshot[listKey] = await loadListEntries(executor, rev, listKey);
  }
  return snapshot;
}

async function loadSnapshotMetaObject(runner, rev) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  const rows = await executor.query(
    `SELECT path, value_type, value_text, value_numeric, value_boolean, ordinal
       FROM ${TABLE_META_VALUES}
      WHERE rev = $1
      ORDER BY char_length(path), path, ordinal`,
    [rev]
  );
  const meta = buildObjectFromRows(rows.rows || []);
  const history = await loadMetaHistory(executor, rev);
  if (history.length) {
    if (!isPlainObject(meta) || !Object.keys(meta).length) {
      return { history };
    }
    meta.history = history;
  }
  return isPlainObject(meta) && Object.keys(meta).length ? meta : history.length ? { history } : null;
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

  await client.query(
    `DELETE FROM ${TABLE_GENERAL_SETTINGS} WHERE scope = ANY($1::text[])`,
    [[SETTINGS_SCOPE_GENERAL, SETTINGS_SCOPE_PREFERENCES]]
  );

  const actor = options?.actor || null;
  const sanitized = sanitizeGeneralSettingsPayload(payload);
  if (!sanitized) {
    return;
  }

  if (sanitized.settings === null) {
    await client.query(
      `INSERT INTO ${TABLE_GENERAL_SETTINGS} (scope, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [SETTINGS_SCOPE_GENERAL, '', 0, 'null', null, null, null, null, actor]
    );
  } else if (isPlainObject(sanitized.settings)) {
    const rows = flattenObjectForStorage(sanitized.settings);
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_GENERAL_SETTINGS} (scope, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          SETTINGS_SCOPE_GENERAL,
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null,
          actor
        ]
      );
    }
  }

  if (isPlainObject(sanitized.preferences)) {
    for (const [key, value] of Object.entries(sanitized.preferences)) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_GENERAL_SETTINGS} (scope, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_by)
         VALUES ($1,$2,0,'boolean',NULL,NULL,$3,NULL,$4)
         ON CONFLICT (scope, path, ordinal) DO UPDATE
           SET value_boolean = EXCLUDED.value_boolean,
               value_type = EXCLUDED.value_type,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by`,
        [SETTINGS_SCOPE_PREFERENCES, key, Boolean(value), actor]
      );
    }
  }
}

async function loadGeneralSettings(runner) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  try {
    const { rows: settingRows } = await executor.query(
      `SELECT path, ordinal, value_type, value_text, value_numeric, value_boolean
         FROM ${TABLE_GENERAL_SETTINGS}
        WHERE scope = $1
        ORDER BY char_length(path), path, ordinal`,
      [SETTINGS_SCOPE_GENERAL]
    );
    const { rows: preferenceRows } = await executor.query(
      `SELECT path, value_boolean
         FROM ${TABLE_GENERAL_SETTINGS}
        WHERE scope = $1`,
      [SETTINGS_SCOPE_PREFERENCES]
    );

    if (!settingRows.length && !preferenceRows.length) {
      return null;
    }

    let settings = null;
    if (settingRows.length === 1 && settingRows[0].path === '' && settingRows[0].value_type === 'null') {
      settings = null;
    } else if (settingRows.length) {
      settings = buildObjectFromRows(settingRows.map((row) => ({
        path: row.path,
        value_type: row.value_type,
        value_text: row.value_text,
        value_numeric: row.value_numeric,
        value_boolean: row.value_boolean,
        ordinal: row.ordinal
      })));
    }

    const preferences = {};
    preferenceRows.forEach((row) => {
      preferences[row.path] = !!row.value_boolean;
    });

    const result = {};
    if (settings !== null) {
      if (isPlainObject(settings) && Object.keys(settings).length) {
        result.settings = settings;
      }
    } else {
      result.settings = null;
    }

    if (Object.keys(preferences).length) {
      result.preferences = preferences;
    }

    return Object.keys(result).length ? result : null;
  } catch (err) {
    if (err && err.code === PG_UNDEFINED_TABLE) {
      return null;
    }
    throw err;
  }
}

async function persistSnapshotData(client, rev, snapshot, hash, meta, options = {}) {
  const snapshotSource = isPlainObject(snapshot) ? snapshot : {};
  const workingSnapshot = cloneDeepPlain(snapshotSource);
  const extraction = extractGeneralSettingsForStorage(workingSnapshot);
  const { hasSettings, payload, meta: snapshotMeta } = extraction;

  await client.query(
    `INSERT INTO ${TABLE_SNAPSHOTS} (rev, hash)
     VALUES ($1,$2)
     ON CONFLICT (rev) DO UPDATE
       SET hash = EXCLUDED.hash,
           created_at = NOW()`,
    [rev, hash]
  );

  await clearStateForRevision(client, rev);

  await persistScalarValues(client, rev, workingSnapshot);
  await persistCapacity(client, rev, workingSnapshot.capByProc);
  await persistParallel(client, rev, workingSnapshot.parallelByProc);
  await persistRouteOverrides(client, rev, workingSnapshot.routeOverrides);
  await persistIgnoredStates(client, rev, workingSnapshot.ignoredStates);

  for (const listKey of ORDER_LIST_KEYS) {
    const items = Array.isArray(workingSnapshot[listKey]) ? workingSnapshot[listKey] : [];
    // eslint-disable-next-line no-await-in-loop
    await persistOrderEntries(client, rev, listKey, items);
    delete workingSnapshot[listKey];
  }

  for (const listKey of STATE_LIST_KEYS) {
    const items = Array.isArray(workingSnapshot[listKey]) ? workingSnapshot[listKey] : [];
    // eslint-disable-next-line no-await-in-loop
    await persistListEntries(client, rev, listKey, items);
    delete workingSnapshot[listKey];
  }

  const crmData = isPlainObject(workingSnapshot.crm) ? workingSnapshot.crm : null;
  await persistStructuredValues(client, TABLE_CRM_VALUES, rev, crmData);
  delete workingSnapshot.crm;

  const modeScopedData = isPlainObject(workingSnapshot.modeScoped) ? workingSnapshot.modeScoped : null;
  await persistStructuredValues(client, TABLE_MODE_VALUES, rev, modeScopedData);
  delete workingSnapshot.modeScoped;

  STATE_SCALAR_KEYS.forEach((key) => {
    delete workingSnapshot[key];
  });
  delete workingSnapshot.capByProc;
  delete workingSnapshot.parallelByProc;
  delete workingSnapshot.routeOverrides;
  delete workingSnapshot.ignoredStates;

  const sanitizedSnapshotMeta = sanitizeMetaForStorage(snapshotMeta);
  let metaForStorage = null;
  let historyPayload = [];
  if (isPlainObject(sanitizedSnapshotMeta) && Object.keys(sanitizedSnapshotMeta).length) {
    metaForStorage = { ...sanitizedSnapshotMeta };
    if (Array.isArray(metaForStorage.history)) {
      historyPayload = metaForStorage.history.slice();
      delete metaForStorage.history;
    }
    if (!Object.keys(metaForStorage).length) {
      metaForStorage = null;
    }
  }

  const requestMetaSanitized = sanitizeMetaForStorage(meta);
  if (isPlainObject(requestMetaSanitized) && Object.keys(requestMetaSanitized).length) {
    if (!metaForStorage) {
      metaForStorage = {};
    }
    metaForStorage.lastRequest = requestMetaSanitized;
  }

  await persistStructuredValues(client, TABLE_META_VALUES, rev, metaForStorage);
  await persistMetaHistory(client, rev, historyPayload);

  await persistGeneralSettings(client, payload, { hasSettings, actor: options?.actor || null });
}

async function loadSnapshotRevision(runner, rev) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  const { rows } = await executor.query(
    `SELECT rev, hash FROM ${TABLE_SNAPSHOTS} WHERE rev = $1`,
    [rev]
  );
  if (!rows.length) {
    return null;
  }
  const data = await loadSnapshotDataObject(executor, rev);
  const meta = await loadSnapshotMetaObject(executor, rev);
  const generalSettings = await loadGeneralSettings(executor);
  const stateObject = isPlainObject(data) ? data : {};
  if (isPlainObject(meta)) {
    const metaCopy = cloneDeepPlain(meta);
    if (isPlainObject(stateObject.meta)) {
      stateObject.meta = { ...stateObject.meta, ...metaCopy };
    } else {
      stateObject.meta = metaCopy || {};
    }
  }
  applyGeneralSettingsToSnapshot(stateObject, generalSettings);
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
       FROM ${TABLE_META_VALUES}
      WHERE rev = ANY($1::bigint[])
      ORDER BY rev, char_length(path), path, ordinal`,
    [unique]
  );
  const grouped = new Map();
  rows.forEach((row) => {
    const rev = Number(row.rev || 0);
    if (!grouped.has(rev)) {
      grouped.set(rev, []);
    }
    grouped.get(rev).push(row);
  });
  const historyMap = await loadMetaHistoryForRevisions(executor, unique);
  const result = new Map();
  unique.forEach((rev) => {
    const entries = grouped.get(rev) || [];
    const metaObject = buildObjectFromRows(entries);
    const history = historyMap.get(rev) || [];
    let combined = null;
    if (isPlainObject(metaObject) && Object.keys(metaObject).length) {
      combined = metaObject;
    }
    if (history.length) {
      if (!isPlainObject(combined)) {
        combined = {};
      }
      combined.history = history;
    }
    if (!combined) {
      combined = history.length ? { history } : {};
    }
    result.set(rev, combined);
  });
  return result;
}


function normalizeForcePersistFlag(value) {
  if (value === true) {
    return true;
  }
  if (value === false || value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return false;
    }
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (['true', '1', 'yes', 'on', 'force', 'persist', 'enabled'].includes(normalized)) {
      return true;
    }
  }
  return false;
}

function normalizeRequestMeta(rawMeta) {
  const response = {
    actor: null,
    source: null,
    note: null,
    summary: null,
    meta: null,
    forcePersist: false,
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

  if (normalizeForcePersistFlag(working.forcePersist)) {
    response.forcePersist = true;
  }

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
  delete working.forcePersist;

  if (isPlainObject(working.meta)) {
    if (!response.forcePersist && normalizeForcePersistFlag(working.meta.forcePersist)) {
      response.forcePersist = true;
    }
    if (Object.prototype.hasOwnProperty.call(working.meta, 'forcePersist')) {
      const cleanedMeta = { ...working.meta };
      delete cleanedMeta.forcePersist;
      working.meta = cleanedMeta;
    }
  }

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
    meta = null,
    skipIfUnchanged = false,
    forcePersist = false,
    currentSnapshot = null
  } = options || {};

  const shouldSkipUnchanged = Boolean(skipIfUnchanged && !forcePersist);

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

  if (shouldSkipUnchanged && currentSnapshot && Number(currentSnapshot.rev || 0) > 0) {
    const currentHash = currentSnapshot.hash || null;
    const currentSanitizedMeta = sanitizeMetaForStorage(currentSnapshot.meta || null);
    if (currentHash && currentHash === normalizedHash && valuesEqual(currentSanitizedMeta, storedMeta)) {
      return {
        rev: currentSnapshot.rev,
        snapshot: currentSnapshot.snapshot,
        stateString: currentSnapshot.stateString,
        hash: currentSnapshot.hash,
        meta: currentSnapshot.meta || null,
        didPersist: false
      };
    }
  }
  if (hash && hash !== normalizedHash) {
    logSaveEvent('warn', 'provided hash does not match normalized snapshot', { expected: normalizedHash, provided: hash });
  }
  const effectiveHash = normalizedHash;

  const { rev, result } = await runWithRevision(actor, source, note, async (client, nextRev) => {
    await persistSnapshotData(client, nextRev, parsedSnapshot, effectiveHash, storedMeta, { actor });
    return await loadSnapshotRevision(client, nextRev);
  });

  if (result && Number(result.rev || 0) === rev) {
    return { ...result, didPersist: true };
  }

  return {
    rev,
    snapshot: parsedSnapshot,
    stateString: serialized,
    hash: effectiveHash,
    meta: storedMeta,
    didPersist: true
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
      meta: storedMeta,
      skipIfUnchanged: !normalizedMeta.forcePersist,
      forcePersist: normalizedMeta.forcePersist,
      currentSnapshot: current
    });

    const etag = computeEtag(latest.hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');

    cachedSnapshot = latest;

    const duration = Date.now() - startedAt;
    if (latest.didPersist === false) {
      logSaveEvent('info', 'save skipped (no changes detected)', {
        requestId,
        rev: latest.rev,
        hash: latest.hash || null,
        duration
      });
      res.status(200).json({ ok: true, rev: latest.rev, hash: latest.hash, etag, unchanged: true, persisted: false });
      return;
    }

    broadcastRevision({ rev: latest.rev, hash: latest.hash, etag });
    logSaveEvent('info', 'save completed', {
      requestId,
      rev: latest.rev,
      hash: latest.hash || null,
      duration
    });
    res.status(200).json({ ok: true, rev: latest.rev, hash: latest.hash, etag, conflict: false, persisted: true });
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
