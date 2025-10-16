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
let ordersTableInfo = null;
let settingsSchemaEnsured = false;

const PG_UNDEFINED_TABLE = '42P01';
const DEFAULT_EXTRA_PERCENT = 5;
const DEFAULT_EXTRA_MINIMUM = 0.25;

const CRM_STAGE_IGNORE = '__ignore__';
const CRM_STAGE_DEFAULT_MAP = new Map([
  ['подготовка в работу', 'draw'],
  ['технологи: подготовка в работу', 'draw'],
  ['техподготовка', 'draw'],
  ['закупка', 'proc'],
  ['покупка', 'proc'],
  ['снабжение', 'proc'],
  ['рубка', 'shear'],
  ['резка', 'shear'],
  ['лазер', 'laser'],
  ['гибка', 'bend'],
  ['сварка', 'weld'],
  ['зенковка', 'mech'],
  ['зенкование', 'mech'],
  ['мехобработка', 'mech'],
  ['мех.обработка', 'mech'],
  ['мех. обработка', 'mech'],
  ['мех-обработка', 'mech'],
  ['мехобр', 'mech'],
  ['мехобр.', 'mech'],
  ['сверловка', 'mech'],
  ['сверление', 'mech'],
  ['сверл', 'mech'],
  ['резьбонарезка', 'mech'],
  ['резьба', 'mech'],
  ['резьб', 'mech'],
  ['пуклевка', 'mech'],
  ['пукл', 'mech'],
  ['заклепка', 'mech'],
  ['заклеп', 'mech'],
  ['кооперация', 'coop'],
  ['кооп', 'coop'],
  ['покраска', 'coop'],
  ['цинкование (кооперация)', 'coop'],
  ['цинкование', 'coop'],
  ['упаковка', 'pack'],
  ['отгрузка', 'ship']
]);
const CRM_PARALLEL_STAGES = new Set(['proc', 'shear', 'coop', 'pack', 'ship']);
const CRM_TASK_PREFIX = 'crm-task::';

const WRITE_CHANNELS = Object.freeze({
  CRM: 'crm',
  PLANNER: 'planner',
  ADMIN: 'admin',
  SYSTEM: 'system'
});

const WRITE_MODES = Object.freeze({
  CRM: 'crm',
  PLANNER: 'planner',
  BOTH: 'both'
});

const DEFAULT_WRITE_MODE = WRITE_MODES.BOTH;

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

function normalizeWriteMode(value) {
  if (value === null || value === undefined) {
    return DEFAULT_WRITE_MODE;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_WRITE_MODE;
  }
  if (normalized === WRITE_MODES.CRM) {
    return WRITE_MODES.CRM;
  }
  if (normalized === WRITE_MODES.PLANNER) {
    return WRITE_MODES.PLANNER;
  }
  return WRITE_MODES.BOTH;
}

function normalizeChannelValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === WRITE_CHANNELS.CRM || normalized.startsWith('crm')) {
    return WRITE_CHANNELS.CRM;
  }
  if (normalized === WRITE_CHANNELS.PLANNER || normalized.startsWith('planner')) {
    return WRITE_CHANNELS.PLANNER;
  }
  if (normalized === WRITE_CHANNELS.ADMIN || normalized.includes('admin')) {
    return WRITE_CHANNELS.ADMIN;
  }
  if (normalized === WRITE_CHANNELS.SYSTEM
      || normalized.includes('system')
      || normalized.includes('startup')
      || normalized.includes('rollback')) {
    return WRITE_CHANNELS.SYSTEM;
  }
  return WRITE_CHANNELS.PLANNER;
}

function normalizeCrmStageLabel(value) {
  return sanitizeString(value);
}

function normalizeCrmStageKey(value) {
  const label = normalizeCrmStageLabel(value);
  return label ? label.toLowerCase() : '';
}

function sanitizeCrmStageMapping(mapping) {
  if (!isPlainObject(mapping)) {
    return {};
  }
  const result = {};
  Object.entries(mapping).forEach(([key, value]) => {
    const normalizedKey = normalizeCrmStageKey(key);
    if (!normalizedKey) return;
    if (value === CRM_STAGE_IGNORE) {
      result[normalizedKey] = CRM_STAGE_IGNORE;
      return;
    }
    const stage = normalizeStage(value);
    if (stage) {
      result[normalizedKey] = stage;
    }
  });
  return result;
}

function clampProgressValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
}

function mapCrmStageName(label, customMap) {
  const normalizedKey = normalizeCrmStageKey(label);
  if (!normalizedKey) {
    return null;
  }
  if (customMap && Object.prototype.hasOwnProperty.call(customMap, normalizedKey)) {
    const mapped = customMap[normalizedKey];
    if (mapped === CRM_STAGE_IGNORE) {
      return null;
    }
    if (mapped) {
      return normalizeStage(mapped);
    }
  }
  const fallback = CRM_STAGE_DEFAULT_MAP.get(normalizedKey);
  if (fallback) {
    return fallback;
  }
  if (
    normalizedKey.includes('кооп')
    || normalizedKey.includes('кооперац')
    || normalizedKey.includes('покрас')
  ) {
    return 'coop';
  }
  if (
    normalizedKey.includes('мехобр')
    || normalizedKey.includes('зенк')
    || normalizedKey.includes('сверл')
    || normalizedKey.includes('резьб')
    || normalizedKey.includes('пукл')
    || normalizedKey.includes('заклеп')
  ) {
    return 'mech';
  }
  return null;
}

function buildCrmTaskUid(orderInfo, stageInfo, stageKey) {
  const parts = [
    orderInfo.identity,
    orderInfo.crmOrderId,
    orderInfo.orderId,
    orderInfo.orderNumber,
    orderInfo.title,
    stageInfo?.id,
    stageInfo?.crmStageId,
    stageInfo?.name,
    stageKey
  ].map((part) => sanitizeString(part)).filter(Boolean);
  const base = parts.length ? parts.join('|') : `${stageKey}::${Math.random().toString(16).slice(2, 10)}`;
  const hash = crypto.createHash('sha1').update(base, 'utf8').digest('hex').slice(0, 12);
  return `${CRM_TASK_PREFIX}${hash}::${stageKey}`;
}

function deriveCrmTasksFromSnapshot(snapshot, { existingTasks = [] } = {}) {
  if (!isPlainObject(snapshot?.crm) || !Array.isArray(snapshot.crm.boards)) {
    return [];
  }

  const customMapping = sanitizeCrmStageMapping(snapshot?.meta?.settings?.crmStageMapping);
  const existingKeys = new Set();
  existingTasks.forEach((task) => {
    if (!task) return;
    const stageKey = normalizeStage(task.stage);
    if (!stageKey) return;
    const identity = sanitizeString(task.orderIdentity)
      || sanitizeString(task.uid)
      || sanitizeString(task.orderId)
      || sanitizeString(task.orderNumber)
      || sanitizeString(task.title)
      || sanitizeString(task.orderTitle);
    if (!identity) return;
    existingKeys.add(`${identity}::${stageKey}`);
  });

  const tasks = [];

  snapshot.crm.boards.forEach((board) => {
    if (!board || !Array.isArray(board.orders)) return;
    const boardId = sanitizeString(board.id);
    const laneFallback = Array.isArray(board.lanes) && board.lanes.length
      ? sanitizeString(board.lanes[0])
      : '';
    board.orders.forEach((order) => {
      if (!order) return;
      const identity = sanitizeString(order.orderIdentity)
        || sanitizeString(order.id)
        || sanitizeString(order.orderId)
        || sanitizeString(order.orderNo)
        || sanitizeString(order.title);
      const orderNumber = sanitizeString(order.orderNumber)
        || sanitizeString(order.orderNo)
        || sanitizeString(order.orderId);
      const orderCustomer = sanitizeString(order.orderCustomer)
        || sanitizeString(order.customer);
      const title = sanitizeString(order.title);
      const parentId = sanitizeString(order.parentId);
      const lane = sanitizeString(order.status) || sanitizeString(order.lane) || laneFallback;
      const crmOrderId = sanitizeString(order.id) || sanitizeString(order.orderId);
      const stageList = Array.isArray(order.stages) ? order.stages : [];

      stageList.forEach((stageEntry) => {
        if (!stageEntry) return;
        const stageKey = mapCrmStageName(stageEntry.stageKey || stageEntry.name, customMapping);
        if (!stageKey) return;
        const dedupeKey = identity ? `${identity}::${stageKey}` : null;
        if (dedupeKey && existingKeys.has(dedupeKey)) {
          return;
        }

        const start = parseDate(stageEntry.start || stageEntry.startDate);
        const end = parseDate(stageEntry.end || stageEntry.endDate);
        const origStart = parseDate(stageEntry.originalStart || stageEntry.origStart);
        const origEnd = parseDate(stageEntry.originalEnd || stageEntry.origEnd);
        const doneAt = parseDate(stageEntry.doneAt);
        const hoursRaw = Number(stageEntry.hours ?? stageEntry.value ?? 0);
        const hours = CRM_PARALLEL_STAGES.has(stageKey)
          ? 0
          : (Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 0);
        const progress = clampProgressValue(
          stageEntry.progress != null ? stageEntry.progress : (stageEntry.done ? 100 : 0)
        );
        const isDone = Boolean(stageEntry.done || stageEntry.isReady || progress >= 100);

        const orderInfo = {
          identity,
          crmOrderId,
          orderId: sanitizeString(order.orderId) || orderNumber || crmOrderId || identity || '',
          orderNumber: orderNumber || '',
          orderCustomer: orderCustomer || '',
          title: title || '',
          parentId: parentId || '',
          boardId: boardId || '',
          lane: lane || ''
        };

        const uid = buildCrmTaskUid(orderInfo, stageEntry, stageKey);
        const task = {
          uid,
          orderId: orderInfo.orderId,
          orderNumber: orderInfo.orderNumber,
          orderCustomer: orderInfo.orderCustomer,
          orderIdentity: orderInfo.identity || '',
          orderTitle: orderInfo.title,
          stage: stageKey,
          parentId: orderInfo.parentId,
          childId: '',
          hours,
          extraHours: 0,
          startDate: start,
          endDate: end,
          startMissing: !start,
          endMissing: !end,
          state: orderInfo.lane,
          status: isDone ? 'Готово (CRM)' : 'CRM',
          useReserve: Boolean(stageEntry.useReserve),
          progress,
          origStartDate: origStart,
          origEndDate: origEnd,
          route: {
            [stageKey]: {
              hours,
              start,
              end,
              ...(origStart ? { origStart } : {}),
              ...(origEnd ? { origEnd } : {}),
              ...(doneAt ? { doneAt } : {}),
              ...(isDone ? { done: true } : {})
            }
          },
          crmMeta: {
            boardId: orderInfo.boardId,
            crmOrderId,
            orderId: orderInfo.orderId,
            orderIdentity: orderInfo.identity || '',
            stageKey,
            stageId: stageEntry.id || stageEntry.crmStageId || '',
            stageName: sanitizeString(stageEntry.name) || stageKey,
            lane: orderInfo.lane
          },
          crmOrigin: true
        };

        if (isDone) {
          const doneMoment = doneAt || end || start;
          if (doneMoment) {
            const doneDate = parseDate(doneMoment) || null;
            if (doneDate) {
              task.doneMeta = { when: doneDate, source: 'crm' };
            }
          }
        }

        if (dedupeKey) {
          existingKeys.add(dedupeKey);
        }
        tasks.push(task);
      });
    });
  });

  return tasks;
}

function classifyWriteChannel({ channel = null, source = null } = {}) {
  const explicit = normalizeChannelValue(channel);
  if (explicit) {
    return explicit;
  }
  const derived = normalizeChannelValue(source);
  if (derived) {
    return derived;
  }
  return WRITE_CHANNELS.PLANNER;
}

function isWriteChannelAllowed(writeMode, channel) {
  const normalizedMode = normalizeWriteMode(writeMode);
  const normalizedChannel = channel ? channel : WRITE_CHANNELS.PLANNER;
  if (normalizedChannel === WRITE_CHANNELS.SYSTEM || normalizedChannel === WRITE_CHANNELS.ADMIN) {
    return true;
  }
  if (normalizedMode === WRITE_MODES.BOTH) {
    return true;
  }
  if (normalizedMode === WRITE_MODES.CRM) {
    return normalizedChannel === WRITE_CHANNELS.CRM;
  }
  if (normalizedMode === WRITE_MODES.PLANNER) {
    return normalizedChannel === WRITE_CHANNELS.PLANNER;
  }
  return true;
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
        admin: { allowForceOverwrite: false, snapshotRetention: 50, writeMode: DEFAULT_WRITE_MODE },
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

async function ensureHistoryTrigger(client, tableName) {
  const triggerName = `${tableName}_history_trg`;
  const tableReg = `public.${tableName}`;
  try {
    const { rows } = await client.query(
      'SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = to_regclass($2)',
      [triggerName, tableReg]
    );
    if (rows.length) {
      return;
    }
    const { rows: fnRows } = await client.query(
      "SELECT to_regprocedure('generic_history_trigger()') AS proc"
    );
    if (!fnRows.length || !fnRows[0].proc) {
      return;
    }
    await client.query(`
      CREATE TRIGGER ${triggerName}
        AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION generic_history_trigger()
    `);
  } catch (err) {
    console.warn(`Failed to ensure history trigger for ${tableName}`, err);
  }
}

async function ensurePlannerSettingsSchema(client) {
  if (settingsSchemaEnsured) {
    return;
  }
  const runner = client || pool;

  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_admin (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      allow_force_overwrite BOOLEAN NOT NULL DEFAULT FALSE,
      snapshot_retention INTEGER NOT NULL DEFAULT 50,
      history_limit INTEGER NOT NULL DEFAULT 50,
      history_daily_limit INTEGER NOT NULL DEFAULT 3,
      write_mode TEXT NOT NULL DEFAULT 'both',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_admin_hist (
      id SMALLINT,
      allow_force_overwrite BOOLEAN,
      snapshot_retention INTEGER,
      history_limit INTEGER,
      history_daily_limit INTEGER,
      write_mode TEXT,
      updated_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(
    'ALTER TABLE settings_admin ADD COLUMN IF NOT EXISTS history_limit INTEGER'
  );
  await runner.query(
    'ALTER TABLE settings_admin ADD COLUMN IF NOT EXISTS history_daily_limit INTEGER'
  );
  await runner.query(
    "ALTER TABLE settings_admin ADD COLUMN IF NOT EXISTS write_mode TEXT"
  );
  await runner.query(
    'ALTER TABLE settings_admin_hist ADD COLUMN IF NOT EXISTS history_limit INTEGER'
  );
  await runner.query(
    'ALTER TABLE settings_admin_hist ADD COLUMN IF NOT EXISTS history_daily_limit INTEGER'
  );
  await runner.query(
    "ALTER TABLE settings_admin_hist ADD COLUMN IF NOT EXISTS write_mode TEXT"
  );
  await runner.query(
    'ALTER TABLE settings_admin ALTER COLUMN history_limit SET DEFAULT 50'
  );
  await runner.query(
    'ALTER TABLE settings_admin ALTER COLUMN history_daily_limit SET DEFAULT 3'
  );
  await runner.query(
    "UPDATE settings_admin SET write_mode = 'both' WHERE write_mode IS NULL OR write_mode NOT IN ('crm','planner','both')"
  );
  await runner.query(
    "ALTER TABLE settings_admin ALTER COLUMN write_mode SET DEFAULT 'both'"
  );
  await runner.query(
    'ALTER TABLE settings_admin ALTER COLUMN write_mode SET NOT NULL'
  );
  await runner.query(
    'ALTER TABLE settings_admin ALTER COLUMN updated_at SET DEFAULT NOW()'
  );
  await runner.query(
    'UPDATE settings_admin SET history_limit = 50 WHERE history_limit IS NULL'
  );
  await runner.query(
    'UPDATE settings_admin SET history_daily_limit = 3 WHERE history_daily_limit IS NULL'
  );
  await runner.query(
    'ALTER TABLE settings_admin ALTER COLUMN history_limit SET NOT NULL'
  );
  await runner.query(
    'ALTER TABLE settings_admin ALTER COLUMN history_daily_limit SET NOT NULL'
  );

  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_journal (
      id SMALLINT PRIMARY KEY,
      max_rows INTEGER NOT NULL DEFAULT 50,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_journal_hist (
      id SMALLINT,
      max_rows INTEGER,
      updated_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_column_widths (
      column_key TEXT PRIMARY KEY,
      width_px INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_column_widths_hist (
      column_key TEXT,
      width_px INTEGER,
      updated_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_mapping (
      crm_stage TEXT PRIMARY KEY,
      planner_process_id SMALLINT REFERENCES processes(id) ON DELETE SET NULL,
      is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_mapping_hist (
      crm_stage TEXT,
      planner_process_id SMALLINT,
      is_ignored BOOLEAN,
      updated_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS excluded_statuses (
      status_key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS excluded_statuses_hist (
      status_key TEXT,
      created_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_autoweight (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      percent NUMERIC(10,2) NOT NULL DEFAULT 0,
      minimum_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_autoweight_hist (
      id SMALLINT,
      enabled BOOLEAN,
      percent NUMERIC(10,2),
      minimum_hours NUMERIC(10,2),
      updated_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_shared_preferences (
      pref_key TEXT PRIMARY KEY,
      bool_value BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS settings_shared_preferences_hist (
      pref_key TEXT,
      bool_value BOOLEAN,
      updated_at TIMESTAMPTZ,
      rev BIGINT NOT NULL REFERENCES revisions(rev),
      op CHAR(1) NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runner.query(
    `INSERT INTO settings_shared_preferences (pref_key, bool_value)
      VALUES
        ('autosaveOn', TRUE),
        ('shiftOnProgress', TRUE),
        ('autoOptimizeOn', TRUE),
        ('cascadeReadyOn', TRUE)
      ON CONFLICT (pref_key) DO NOTHING`
  );

  const tablesWithHistory = [
    'settings_admin',
    'settings_journal',
    'settings_column_widths',
    'settings_mapping',
    'excluded_statuses',
    'settings_autoweight',
    'settings_shared_preferences'
  ];

  for (const tableName of tablesWithHistory) {
    // eslint-disable-next-line no-await-in-loop
    await ensureHistoryTrigger(runner, tableName);
  }

  settingsSchemaEnsured = true;
}

async function ensurePlannerSnapshotsSchema(client) {
  const runner = client || pool;
  await runner.query(`
    CREATE TABLE IF NOT EXISTS planner_state_snapshots (
      id BIGSERIAL PRIMARY KEY,
      rev BIGINT NOT NULL REFERENCES revisions(rev) ON DELETE CASCADE,
      snapshot JSONB NOT NULL,
      meta JSONB,
      hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await runner.query(`
    ALTER TABLE planner_state_snapshots
      ADD COLUMN IF NOT EXISTS snapshot JSONB,
      ADD COLUMN IF NOT EXISTS meta JSONB,
      ADD COLUMN IF NOT EXISTS hash TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await runner.query(`
    UPDATE planner_state_snapshots
       SET snapshot = '{}'::jsonb
     WHERE snapshot IS NULL
  `);
  await runner.query(`
    UPDATE planner_state_snapshots
       SET created_at = NOW()
     WHERE created_at IS NULL
  `);
  await runner.query(`
    ALTER TABLE planner_state_snapshots
      ALTER COLUMN snapshot SET NOT NULL
  `);
  await runner.query(`
    ALTER TABLE planner_state_snapshots
      ALTER COLUMN snapshot SET DEFAULT '{}'::jsonb
  `);
  await runner.query(`
    ALTER TABLE planner_state_snapshots
      ALTER COLUMN created_at SET NOT NULL
  `);
  await runner.query(`
    ALTER TABLE planner_state_snapshots
      ALTER COLUMN created_at SET DEFAULT NOW()
  `);
  await runner.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS planner_state_snapshots_rev_key
      ON planner_state_snapshots(rev)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS planner_state_snapshots_created_idx
      ON planner_state_snapshots(created_at DESC)
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
  await ensurePlannerSettingsSchema(client);
  await ensurePlannerSnapshotsSchema(client);
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
    const autoweight = await loadAutoweightSettings(client);
    normalizeExtraTimeSettings(snapshotObj, autoweight);
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
    channel: null,
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
  const channel = sanitizeString(working.channel);
  delete working.channel;

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

  if (channel) {
    response.channel = channel;
    working.channel = channel;
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

function validateSnapshotStructure(snapshot) {
  const missing = [];
  if (!Array.isArray(snapshot?.t)) missing.push('tasks');
  if (!Array.isArray(snapshot?.done)) missing.push('done');
  if (!Array.isArray(snapshot?.trash)) missing.push('trash');
  if (!Array.isArray(snapshot?.orders)) missing.push('orders');
  return { ok: missing.length === 0, missing };
}

function normalizeSnapshotCollections(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }

  const ensureArray = (key) => {
    if (!Array.isArray(snapshot[key])) {
      snapshot[key] = [];
    }
  };

  ensureArray('t');
  ensureArray('done');
  ensureArray('trash');
  ensureArray('exc');
  ensureArray('res');
  ensureArray('routeOverrides');
  ensureArray('orders');
  ensureArray('locked');
  ensureArray('ignoredStates');

  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }
  if (!Array.isArray(snapshot.meta.history)) {
    snapshot.meta.history = [];
  }
  if (!isPlainObject(snapshot.meta.versions)) {
    snapshot.meta.versions = {};
  }
  if (!isPlainObject(snapshot.meta.settings)) {
    snapshot.meta.settings = {};
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
  await ensurePlannerSnapshotsSchema(client);
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
    channel = null
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
  normalizeSnapshotCollections(parsedSnapshot);

  const serialized = safeSerializeSnapshot(parsedSnapshot);
  const storedMeta = sanitizeMetaForStorage(meta);
  const normalizedHash = computeSnapshotHash(serialized);
  if (hash && hash !== normalizedHash) {
    logSaveEvent('warn', 'provided hash does not match normalized snapshot', { expected: normalizedHash, provided: hash });
  }
  const effectiveHash = normalizedHash;

  const { rev, result } = await runWithRevision(actor, source, note, async (client, nextRev) => {
    await ensurePlannerSettingsSchema(client);
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

function resetOrdersTableInfo() {
  ordersTableInfo = null;
}

async function getOrdersTableInfo(client, { forceReload = false } = {}) {
  if (!forceReload && ordersTableInfo) {
    return ordersTableInfo;
  }

  const { rows } = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
  `);

  const columnSet = new Set(rows.map((row) => row.column_name));
  ordersTableInfo = {
    columns: columnSet,
    has(column) {
      return columnSet.has(column);
    }
  };

  return ordersTableInfo;
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

async function getCurrentWriteMode(runner) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  try {
    const { rows } = await executor.query(
      'SELECT write_mode FROM settings_admin WHERE id = 1'
    );
    if (rows.length && rows[0] && rows[0].write_mode) {
      return normalizeWriteMode(rows[0].write_mode);
    }
    return DEFAULT_WRITE_MODE;
  } catch (err) {
    if (err && err.code === PG_UNDEFINED_TABLE) {
      return DEFAULT_WRITE_MODE;
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

async function loadAutoweightSettings(runner) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  try {
    const { rows } = await executor.query(
      'SELECT enabled, percent, minimum_hours FROM settings_autoweight WHERE id = 1'
    );
    if (!rows.length) {
      return null;
    }
    const row = rows[0];
    const percentRaw = row.percent === null || row.percent === undefined ? null : Number(row.percent);
    const minimumRaw = row.minimum_hours === null || row.minimum_hours === undefined
      ? null
      : Number(row.minimum_hours);
    const enabledRaw = row.enabled;
    let enabled = null;
    if (enabledRaw === null || enabledRaw === undefined) {
      enabled = null;
    } else if (typeof enabledRaw === 'boolean') {
      enabled = enabledRaw;
    } else if (typeof enabledRaw === 'number') {
      enabled = enabledRaw !== 0;
    } else if (typeof enabledRaw === 'string') {
      const normalized = enabledRaw.trim().toLowerCase();
      enabled = ['1', 't', 'true', 'yes', 'on'].includes(normalized);
    } else {
      enabled = Boolean(enabledRaw);
    }
    const percent = Number.isFinite(percentRaw)
      ? Math.max(0, Math.round(percentRaw * 100) / 100)
      : DEFAULT_EXTRA_PERCENT;
    const minimum = Number.isFinite(minimumRaw)
      ? Math.max(0, Math.round(minimumRaw * 100) / 100)
      : DEFAULT_EXTRA_MINIMUM;
    if (enabled === null) {
      enabled = percent > 0 || minimum > 0;
    }
    return {
      enabled,
      percent,
      minimum
    };
  } catch (err) {
    if (err && err.code === PG_UNDEFINED_TABLE) {
      return null;
    }
    throw err;
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
      meta: hydrationMeta,
      channel: WRITE_CHANNELS.SYSTEM
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

function createOrderKeyResolver() {
  const aliasToCanonical = new Map();
  const canonicalToAliases = new Map();
  let fallbackCounter = 0;

  const registerAlias = (alias, canonical) => {
    if (!alias) return;
    aliasToCanonical.set(alias, canonical);
    if (!canonicalToAliases.has(canonical)) {
      canonicalToAliases.set(canonical, new Set());
    }
    canonicalToAliases.get(canonical).add(alias);
  };

  const mergeCanonicals = (source, target) => {
    if (!source || !target || source === target) return;
    const aliases = canonicalToAliases.get(source);
    if (aliases) {
      aliases.forEach((alias) => {
        aliasToCanonical.set(alias, target);
        if (!canonicalToAliases.has(target)) {
          canonicalToAliases.set(target, new Set());
        }
        canonicalToAliases.get(target).add(alias);
      });
      canonicalToAliases.delete(source);
    }
    registerAlias(source, target);
  };

  return (task) => {
    if (!task || typeof task !== 'object') {
      return { key: null, merged: [] };
    }

    const identity = sanitizeString(task.orderIdentity);
    const crmOrderId = sanitizeString(task.orderId || task.crmOrderId);
    const numberPrimary = sanitizeString(task.orderNumber || task.number || task.orderNo);
    const numberAlt = sanitizeString(task.orderIdNumber || task.orderRef);
    const title = sanitizeString(task.orderTitle || task.title || task.orderName);
    const customer = sanitizeString(task.orderCustomer);
    const uid = sanitizeString(task.uid);

    const aliases = [];
    if (identity) aliases.push(`identity:${identity}`);
    if (crmOrderId) aliases.push(`crm:${crmOrderId}`);
    if (numberPrimary) aliases.push(`number:${numberPrimary}`);
    if (numberAlt && numberAlt !== numberPrimary) aliases.push(`number:${numberAlt}`);
    if (title && customer) aliases.push(`title:${title}::${customer}`);
    if (title) aliases.push(`title:${title}`);
    if (customer) aliases.push(`customer:${customer}`);
    if (uid) aliases.push(`uid:${uid}`);

    let canonical = null;
    const seenCanonicals = new Set();
    for (const alias of aliases) {
      const existing = aliasToCanonical.get(alias);
      if (existing) {
        if (!canonical) {
          canonical = existing;
        }
        seenCanonicals.add(existing);
      }
    }

    if (!canonical) {
      canonical = aliases.find((alias) => !alias.startsWith('uid:')) || aliases[0] || null;
    }

    if (!canonical) {
      fallbackCounter += 1;
      canonical = `generated:${fallbackCounter}`;
    }

    const merged = [];
    seenCanonicals.forEach((seen) => {
      if (seen !== canonical) {
        merged.push(seen);
        mergeCanonicals(seen, canonical);
      }
    });

    aliases.forEach((alias) => registerAlias(alias, canonical));
    registerAlias(canonical, canonical);

    return { key: canonical, merged };
  };
}

function mergeOrderRecords(target, source) {
  if (!target) return source;
  if (!source) return target;

  const toDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  if (!target.crmOrderId && source.crmOrderId) target.crmOrderId = source.crmOrderId;
  if (!target.number && source.number) target.number = source.number;
  if (!target.customerName && source.customerName) target.customerName = source.customerName;
  if (!target.status && source.status) target.status = source.status;
  if (!target.title && source.title) target.title = source.title;
  if (target.priority === null || target.priority === undefined) target.priority = source.priority ?? target.priority;
  else if ((source.priority ?? null) !== null && (target.priority ?? null) === null) target.priority = source.priority;

  if (!target.dueDate && source.dueDate) target.dueDate = source.dueDate;

  const createdTarget = toDate(target.createdAt);
  const createdSource = toDate(source.createdAt);
  if (createdTarget && createdSource) {
    target.createdAt = createdTarget < createdSource ? createdTarget : createdSource;
  } else if (!createdTarget && createdSource) {
    target.createdAt = createdSource;
  }

  const updatedTarget = toDate(target.updatedAt);
  const updatedSource = toDate(source.updatedAt);
  if (updatedTarget && updatedSource) {
    target.updatedAt = updatedTarget > updatedSource ? updatedTarget : updatedSource;
  } else if (!updatedTarget && updatedSource) {
    target.updatedAt = updatedSource;
  }

  if (source.deleted) target.deleted = true;
  const deletedSource = toDate(source.deletedAt);
  const deletedTarget = toDate(target.deletedAt);
  if (deletedSource && (!deletedTarget || deletedSource > deletedTarget)) {
    target.deletedAt = deletedSource;
  }

  return target;
}

async function applySnapshotToSql(client, snapshot) {
  await ensurePlannerSettingsSchema(client);
  const previousWriteMode = await getCurrentWriteMode(client);
  const baseTasks = Array.isArray(snapshot.t) ? snapshot.t : [];
  const crmTasks = deriveCrmTasksFromSnapshot(snapshot, { existingTasks: baseTasks });
  const tasks = baseTasks.concat(crmTasks);
  const done = Array.isArray(snapshot.done) ? snapshot.done : [];
  const trash = Array.isArray(snapshot.trash) ? snapshot.trash : [];

  const resolveOrderKey = createOrderKeyResolver();

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

  const ordersInfo = await getOrdersTableInfo(client);

  const orderData = new Map();
  const ensureRecord = (key) => {
    if (!key) return null;
    if (orderData.has(key)) {
      return orderData.get(key);
    }
    const record = {
      key,
      crmOrderId: null,
      number: null,
      customerName: null,
      status: null,
      deleted: false,
      deletedAt: null,
      createdAt: null,
      updatedAt: null,
      title: null,
      priority: null,
      dueDate: null
    };
    orderData.set(key, record);
    return record;
  };

  const collectOrderData = (task, options = {}) => {
    if (!task || typeof task !== 'object') return;
    const resolution = resolveOrderKey(task);
    const key = resolution.key;
    if (!key) return;

    if (Array.isArray(resolution.merged) && resolution.merged.length) {
      for (const aliasKey of resolution.merged) {
        if (!aliasKey || aliasKey === key) continue;
        if (!orderData.has(aliasKey)) continue;
        const aliasRecord = orderData.get(aliasKey);
        orderData.delete(aliasKey);
        const target = ensureRecord(key);
        mergeOrderRecords(target, aliasRecord);
      }
    }

    const existing = ensureRecord(key);
    const crmOrderId = sanitizeString(task.orderId);
    if (crmOrderId) existing.crmOrderId = existing.crmOrderId || crmOrderId;
    const number = sanitizeString(task.orderNumber);
    if (number) existing.number = existing.number || number;
    const customerName = sanitizeString(task.orderCustomer);
    if (customerName) existing.customerName = existing.customerName || customerName;
    const title = sanitizeString(
      task.orderTitle
        || task.title
        || task.orderName
        || task.name
        || task.project
    );
    if (title) {
      existing.title = existing.title || title;
    }
    const status = sanitizeString(task.status) || sanitizeString(task.state);
    if (status) existing.status = status;
    const start = parseDate(task.startDate || task.start);
    if (start && !existing.createdAt) existing.createdAt = start;
    const end = parseDate(task.endDate || task.end);
    if (end) existing.updatedAt = end;
    const due = parseDate(task.orderDueDate || task.dueDate || task.deadline);
    if (due && !existing.dueDate) {
      existing.dueDate = due;
    }
    const priority = parseInteger(task.orderPriority ?? task.priority, null);
    if (priority !== null && !Number.isNaN(priority)) {
      existing.priority = existing.priority ?? priority;
    }
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
  let fallbackOrderCounter = 0;
  for (const data of orderData.values()) {
    const customerId = data.customerName ? customerMap.get(data.customerName) || null : null;
    const createdAt = data.createdAt || new Date();
    const updatedAt = data.updatedAt || createdAt;
    let number = data.number || data.crmOrderId || data.title || null;
    if (!number || (typeof number === 'string' && !number.trim())) {
      number = data.key;
    }
    if (!number || (typeof number === 'string' && !number.trim())) {
      fallbackOrderCounter += 1;
      number = `order-${fallbackOrderCounter}`;
    }
    if (typeof number === 'string') {
      const trimmed = number.trim();
      number = trimmed || `order-${fallbackOrderCounter || 1}`;
    }
    const deletedAt = data.deleted ? (data.deletedAt || updatedAt) : null;
    const title = data.title || number;
    const priority = Number.isFinite(data.priority) ? data.priority : null;
    const dueDate = data.dueDate || null;

    const columns = [];
    const values = [];
    const placeholders = [];
    let paramIndex = 1;
    const addColumn = (column, value) => {
      if (!ordersInfo.has(column)) return;
      columns.push(column);
      placeholders.push(`$${paramIndex}`);
      values.push(value === undefined ? null : value);
      paramIndex += 1;
    };

    addColumn('crm_order_id', data.crmOrderId || null);
    addColumn('number', number);
    addColumn('order_no', number);
    addColumn('customer_id', customerId);
    addColumn('status', data.status || null);
    addColumn('title', title || null);
    addColumn('client', data.customerName || null);
    addColumn('priority', priority);
    addColumn('due_date', dueDate);
    addColumn('created_at', createdAt);
    addColumn('updated_at', updatedAt);
    addColumn('deleted_at', deletedAt);
    addColumn('is_deleted', Boolean(data.deleted));

    if (!columns.length) {
      throw new Error('orders table has no known columns for insertion');
    }

    const sql = `INSERT INTO orders (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`;
    const { rows } = await client.query(sql, values);
    orderIdMap.set(data.key, rows[0].id);
  }

  const seqByOrder = new Map();
  const positionByProcess = new Map();
  const insertTask = async (task, options = {}) => {
    if (!task) return;
    const resolution = resolveOrderKey(task);
    const key = resolution.key;
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
  const extraEnabled = typeof extra.enabled === 'boolean'
    ? extra.enabled
    : (percentValue > 0 || minimumValue > 0);
  if (!isPlainObject(settings.extraTime)) {
    settings.extraTime = {};
  }
  settings.extraTime.percent = percentValue;
  settings.extraTime.minimum = minimumValue;
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
       VALUES (1,$1,NOW())
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
  const writeMode = normalizeWriteMode(adminSettings.writeMode || previousWriteMode);
  await client.query(
    `INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, history_limit, history_daily_limit, write_mode, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,NOW())
     ON CONFLICT (id) DO UPDATE
       SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
           snapshot_retention = EXCLUDED.snapshot_retention,
           history_limit = EXCLUDED.history_limit,
           history_daily_limit = EXCLUDED.history_daily_limit,
           write_mode = EXCLUDED.write_mode,
           updated_at = NOW()` ,
    [
      allowForce,
      Number.isFinite(snapshotRetention) ? snapshotRetention : 50,
      historyLimit,
      historyDailyLimit,
      writeMode
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

    const structure = validateSnapshotStructure(snapshot);
    if (!structure.ok) {
      logSaveEvent('warn', 'snapshot missing required sections', { requestId, missing: structure.missing });
      res.status(422).json({ error: 'Unprocessable snapshot', missing: structure.missing });
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

    await ensurePlannerSettingsSchema();
    const channel = classifyWriteChannel({
      channel: normalizedMeta.channel
        || sanitizeString(requestMeta?.channel)
        || sanitizeString(requestMeta?.meta?.channel),
      source: normalizedMeta.source
        || sanitizeString(requestMeta?.source)
        || sanitizeString(requestMeta?.meta?.source)
    });
    const writeMode = await getCurrentWriteMode();
    if (!isWriteChannelAllowed(writeMode, channel)) {
      logSaveEvent('warn', 'write rejected due to mode', { requestId, channel, writeMode });
      res.status(403).json({ error: 'Write mode restriction', channel, writeMode });
      return;
    }

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
      summary: summary || undefined,
      channel
    });

    logSaveEvent('info', 'save request received', {
      requestId,
      actor,
      source,
      channel,
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
      channel
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
      note: note || undefined,
      channel: WRITE_CHANNELS.ADMIN
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
      previousMeta: parseJsonColumn(row.meta, null),
      channel: WRITE_CHANNELS.ADMIN
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
      meta: rollbackMeta,
      channel: WRITE_CHANNELS.ADMIN
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
