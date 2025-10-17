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
app.use(express.json({ limit: '15mb', strict: false }));
app.use(express.text({ limit: '15mb', type: ['text/plain', 'application/json'] }));

const sseClients = new Set();
let cachedSnapshot = null;

function sanitizeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function normalizeStage(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

function computeHash(input) {
  return crypto.createHash('sha1').update(input || '', 'utf8').digest('hex');
}

function computeEtag(hash) {
  if (!hash) return null;
  return `W/"${hash}"`;
}

function safeJsonStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? {});
  } catch (err) {
    console.warn('Failed to stringify JSON payload, using fallback', err);
    return fallback;
  }
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      return value;
    }
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const text = value.trim();
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function toNullableString(value) {
  const text = sanitizeString(value);
  return text ? text : null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed
      .replace(/%/g, '')
      .replace(/\s+/g, '')
      .replace(',', '.');
    const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseFloat(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePercent(value) {
  const num = normalizeNumber(value);
  return num === null ? null : num;
}

function numbersEqual(a, b) {
  const left = normalizeNumber(a);
  const right = normalizeNumber(b);
  if (left === null && right === null) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return Math.abs(left - right) < 0.0001;
}

function getDeep(record, path) {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  if (!path) {
    return undefined;
  }
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let current = record;
  for (const rawPart of parts) {
    const part = rawPart && rawPart.toString ? rawPart.toString() : rawPart;
    if (!part) {
      return undefined;
    }
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function pickField(record, keys) {
  if (!Array.isArray(keys)) {
    return null;
  }
  for (const key of keys) {
    const value = getDeep(record, key);
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    return value;
  }
  return null;
}

function extractOrderMetadata(payload) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const meta = {};
  meta.crmOrderId = toNullableString(
    pickField(record, [
      'crmOrderId',
      'crm_id',
      'orderId',
      'order_id',
      'id',
      'uid',
      'identity',
      'orderIdentity'
    ])
  );
  meta.orderNumber = toNullableString(
    pickField(record, ['orderNumber', 'number', 'orderNo', 'docNumber', 'code', 'order_code'])
  );
  meta.title = toNullableString(
    pickField(record, ['orderTitle', 'title', 'name', 'subject', 'orderName', 'displayTitle'])
  );
  meta.customer = toNullableString(
    pickField(record, [
      'customer',
      'client',
      'company',
      'organization',
      'customerName',
      'clientName',
      'buyer'
    ])
  );
  meta.status = toNullableString(
    pickField(record, ['status', 'state', 'orderStatus', 'stage', 'stageName', 'stageTitle'])
  );
  meta.priority = toNullableString(pickField(record, ['priority', 'orderPriority', 'importance']));
  meta.dueDate = toNullableString(
    pickField(record, [
      'dueDate',
      'deadline',
      'finishPlan',
      'finishDatePlan',
      'endDatePlan',
      'expectedDate',
      'due',
      'deadlineDate'
    ])
  );
  meta.plannedStart = toNullableString(
    pickField(record, [
      'plannedStart',
      'startPlan',
      'startDatePlan',
      'datePlanStart',
      'planStart',
      'plannedStartDate',
      'startPlanned'
    ])
  );
  meta.plannedFinish = toNullableString(
    pickField(record, [
      'plannedFinish',
      'finishPlan',
      'finishDatePlan',
      'datePlanFinish',
      'planFinish',
      'plannedFinishDate',
      'finishPlanned'
    ])
  );
  meta.readyPercent = normalizePercent(
    pickField(record, [
      'readyPercent',
      'progress',
      'ready',
      'completeness',
      'donePercent',
      'percentComplete',
      'completion'
    ])
  );
  meta.manager = toNullableString(
    pickField(record, ['manager', 'responsible', 'owner', 'assignee', 'responsibleName'])
  );
  meta.updatedBy = toNullableString(pickField(record, ['updatedBy', 'lastEditor', 'modifiedBy', 'changedBy']));
  meta.updatedText = toNullableString(
    pickField(record, ['updatedAt', 'modifiedAt', 'updated', 'lastUpdate', 'timestamp'])
  );
  return meta;
}

function extractTaskMetadata(payload) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const meta = {};
  meta.crmOrderId = toNullableString(
    pickField(record, ['crmOrderId', 'orderId', 'order_id', 'orderIdentity', 'identity', 'id'])
  );
  meta.orderNumber = toNullableString(
    pickField(record, ['orderNumber', 'number', 'orderNo', 'docNumber', 'code', 'order_code'])
  );
  meta.stageName = toNullableString(
    pickField(record, ['stageName', 'stageTitle', 'stage', 'name', 'displayStage', 'operation'])
  );
  meta.status = toNullableString(pickField(record, ['status', 'state', 'taskStatus', 'stageStatus']));
  meta.priority = toNullableString(pickField(record, ['priority', 'taskPriority', 'importance']));
  meta.executor = toNullableString(
    pickField(record, ['executor', 'performer', 'assignee', 'worker', 'responsible', 'operator'])
  );
  meta.plannedStart = toNullableString(
    pickField(record, [
      'planStart',
      'plannedStart',
      'startPlan',
      'startPlanDate',
      'plannedStartDate',
      'planStartDate',
      'startPlanned'
    ])
  );
  meta.plannedFinish = toNullableString(
    pickField(record, [
      'planFinish',
      'plannedFinish',
      'finishPlan',
      'finishPlanDate',
      'plannedFinishDate',
      'planFinishDate',
      'finishPlanned'
    ])
  );
  meta.actualStart = toNullableString(
    pickField(record, ['factStart', 'actualStart', 'startFact', 'startActual', 'startedAt'])
  );
  meta.actualFinish = toNullableString(
    pickField(record, ['factFinish', 'actualFinish', 'finishFact', 'finishActual', 'finishedAt'])
  );
  meta.dueDate = toNullableString(
    pickField(record, ['dueDate', 'deadline', 'finishDate', 'expectedDate', 'due', 'deadlineDate'])
  );
  meta.expectedPercent = normalizePercent(
    pickField(record, ['expectedPercent', 'planPercent', 'targetPercent', 'plannedPercent'])
  );
  meta.progressPercent = normalizePercent(
    pickField(record, [
      'progress',
      'readyPercent',
      'donePercent',
      'percentComplete',
      'completion',
      'factPercent'
    ])
  );
  return meta;
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
        extraTime: { percent: 5, minimum: 0.25 },
        crmStageMapping: {},
        logLimit: 50,
        admin: { allowForceOverwrite: false, writeMode: 'both' },
        updatedAt: ''
      },
      ignoredStates: [],
      storage: { local: false, remote: true, remotePreferred: true, mode: 'remote' }
    },
    modeScoped: {}
  };
}

function normalizeSnapshotCollections(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return buildEmptySnapshot();
  }
  const base = buildEmptySnapshot();
  const output = { ...base, ...snapshot };

  const arrayKeys = ['t', 'done', 'trash', 'exc', 'res', 'orders', 'routeOverrides', 'locked', 'ignoredStates'];
  for (const key of arrayKeys) {
    if (!Array.isArray(output[key])) {
      output[key] = [];
    }
  }

  if (!output.crm || typeof output.crm !== 'object') {
    output.crm = { boards: [], currentBoardId: null };
  }
  if (!Array.isArray(output.crm.boards)) {
    output.crm.boards = [];
  }
  if (!output.meta || typeof output.meta !== 'object') {
    output.meta = buildEmptySnapshot().meta;
  } else if (!output.meta.settings || typeof output.meta.settings !== 'object') {
    output.meta.settings = buildEmptySnapshot().meta.settings;
  }

  return output;
}

function readMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
  return files.map((filename) => ({
    filename,
    fullPath: path.join(MIGRATIONS_DIR, filename),
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
  }));
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

async function isMigrationApplied(client, filename) {
  const { rows } = await client.query(
    'SELECT 1 FROM planner_schema_migrations WHERE filename = $1',
    [filename]
  );
  return rows.length > 0;
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = readMigrations();
    for (const migration of migrations) {
      // eslint-disable-next-line no-await-in-loop
      const applied = await isMigrationApplied(client, migration.filename);
      if (applied) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO planner_schema_migrations (filename) VALUES ($1)',
          [migration.filename]
        );
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

async function ensureCoreSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_settings (
      key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_orders (
      uid TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      lane_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE pc_orders
      ADD COLUMN IF NOT EXISTS crm_order_id TEXT,
      ADD COLUMN IF NOT EXISTS order_number TEXT,
      ADD COLUMN IF NOT EXISTS title TEXT,
      ADD COLUMN IF NOT EXISTS customer TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS priority TEXT,
      ADD COLUMN IF NOT EXISTS due_date TEXT,
      ADD COLUMN IF NOT EXISTS planned_start TEXT,
      ADD COLUMN IF NOT EXISTS planned_finish TEXT,
      ADD COLUMN IF NOT EXISTS ready_percent NUMERIC,
      ADD COLUMN IF NOT EXISTS manager TEXT,
      ADD COLUMN IF NOT EXISTS updated_by TEXT,
      ADD COLUMN IF NOT EXISTS updated_text TEXT
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_order_tasks (
      uid TEXT PRIMARY KEY,
      order_uid TEXT,
      stage_code TEXT,
      bucket TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE pc_order_tasks
      ADD COLUMN IF NOT EXISTS crm_order_id TEXT,
      ADD COLUMN IF NOT EXISTS order_number TEXT,
      ADD COLUMN IF NOT EXISTS stage_name TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS priority TEXT,
      ADD COLUMN IF NOT EXISTS executor TEXT,
      ADD COLUMN IF NOT EXISTS planned_start TEXT,
      ADD COLUMN IF NOT EXISTS planned_finish TEXT,
      ADD COLUMN IF NOT EXISTS actual_start TEXT,
      ADD COLUMN IF NOT EXISTS actual_finish TEXT,
      ADD COLUMN IF NOT EXISTS due_date TEXT,
      ADD COLUMN IF NOT EXISTS expected_percent NUMERIC,
      ADD COLUMN IF NOT EXISTS progress_percent NUMERIC
  `);
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_bucket_idx ON pc_order_tasks(bucket)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_order_idx ON pc_order_tasks(order_uid)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_orders_crm_order_idx ON pc_orders(crm_order_id)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_orders_number_idx ON pc_orders(order_number)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_stage_idx ON pc_order_tasks(stage_code)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_crm_idx ON pc_order_tasks(crm_order_id)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_stage_sequences (
      stage_code TEXT PRIMARY KEY,
      task_uids TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_revisions (
      rev BIGSERIAL PRIMARY KEY,
      hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function upsertSetting(client, key, value) {
  await client.query(
    `INSERT INTO pc_settings (key, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload,
           updated_at = NOW()` ,
    [key, JSON.stringify(value ?? null)]
  );
}

function resolveOrderUid(order, fallbackIndex) {
  if (!order || typeof order !== 'object') {
    return `order-${fallbackIndex}`;
  }
  const candidates = [
    order.uid,
    order.identity,
    order.orderIdentity,
    order.orderId,
    order.id,
    order.orderNumber,
    order.number,
    order.code
  ];
  for (const candidate of candidates) {
    const normalized = sanitizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return `order-${fallbackIndex}`;
}

function resolveTaskUid(task, fallbackIndex) {
  if (!task || typeof task !== 'object') {
    return `task-${fallbackIndex}`;
  }
  const candidates = [task.uid, task.id, task.identity];
  for (const candidate of candidates) {
    const normalized = sanitizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return `task-${fallbackIndex}`;
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

  return (record) => {
    if (!record || typeof record !== 'object') {
      return { key: null, merged: [] };
    }

    const identity = sanitizeString(record.orderIdentity);
    const crmOrderId = sanitizeString(record.orderId || record.crmOrderId);
    const numberPrimary = sanitizeString(record.orderNumber || record.number || record.orderNo);
    const numberAlt = sanitizeString(record.orderIdNumber || record.orderRef);
    const title = sanitizeString(record.orderTitle || record.title || record.orderName);
    const customer = sanitizeString(record.orderCustomer || record.customer);
    const uid = sanitizeString(record.uid);

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

function extractStorageParts(snapshot) {
  const normalized = normalizeSnapshotCollections(snapshot);
  const boards = [];
  const orders = [];
  const orderKeyToUid = new Map();
  const resolveKey = createOrderKeyResolver();

  normalized.crm.boards.forEach((board, boardIndex) => {
    const boardId = sanitizeString(board?.id) || `crm-board-${boardIndex + 1}`;
    const boardCopy = { ...board, id: boardId };
    const laneOrders = Array.isArray(board?.orders) ? board.orders : [];
    boardCopy.orders = [];
    boards.push({
      id: boardCopy.id,
      name: sanitizeString(boardCopy.name) || 'Список заказов',
      lanes: Array.isArray(boardCopy.lanes) ? boardCopy.lanes : []
    });

    laneOrders.forEach((order, orderIndex) => {
      const uid = resolveOrderUid(order, orders.length + 1);
      const payload = order && typeof order === 'object' ? { ...order, uid } : { uid };
      const keySource = {
        uid,
        orderId: payload.orderId || payload.crmOrderId,
        orderNumber: payload.orderNumber || payload.number,
        orderTitle: payload.orderTitle || payload.title,
        orderCustomer: payload.orderCustomer || payload.customer,
        orderIdentity: payload.orderIdentity || payload.identity
      };
      const resolution = resolveKey(keySource);
      if (resolution.key) {
        orderKeyToUid.set(resolution.key, uid);
        if (resolution.merged && resolution.merged.length) {
          resolution.merged.forEach((alias) => orderKeyToUid.set(alias, uid));
        }
      }
      const meta = extractOrderMetadata(payload);
      orders.push({
        uid,
        boardId,
        laneId: sanitizeString(order?.laneId || order?.lane || null) || null,
        position: orderIndex,
        payload,
        meta
      });
    });
  });

  const buckets = [
    ['t', 'active'],
    ['done', 'done'],
    ['trash', 'trash'],
    ['exc', 'exception'],
    ['res', 'reserve']
  ];

  const tasks = [];
  for (const [key] of buckets) {
    const list = Array.isArray(normalized[key]) ? normalized[key] : [];
    list.forEach((task, index) => {
      const uid = resolveTaskUid(task, tasks.length + 1);
      const payload = task && typeof task === 'object' ? { ...task, uid } : { uid };
      const keySource = {
        uid,
        orderId: payload.orderId || payload.crmOrderId,
        orderNumber: payload.orderNumber || payload.number,
        orderTitle: payload.orderTitle || payload.title,
        orderCustomer: payload.orderCustomer || payload.customer,
        orderIdentity: payload.orderIdentity || payload.identity
      };
      const resolution = resolveKey(keySource);
      const orderUid = resolution.key ? orderKeyToUid.get(resolution.key) || null : null;
      const meta = extractTaskMetadata(payload);
      tasks.push({
        uid,
        orderUid,
        stage: normalizeStage(task?.stage),
        bucket: key,
        position: index,
        payload,
        meta
      });
    });
  }

  const stageSequences = Array.isArray(normalized.orders)
    ? normalized.orders
        .map((entry) => {
          if (!Array.isArray(entry) || entry.length < 2) return null;
          const stage = normalizeStage(entry[0]);
          if (!stage) return null;
          const ids = Array.isArray(entry[1])
            ? entry[1].map((uid) => sanitizeString(uid)).filter(Boolean)
            : [];
          return { stage, ids };
        })
        .filter(Boolean)
    : [];

  const baseSnapshot = JSON.parse(JSON.stringify(normalized));
  baseSnapshot.crm = { ...baseSnapshot.crm, boards: [] };
  baseSnapshot.t = [];
  baseSnapshot.done = [];
  baseSnapshot.trash = [];
  baseSnapshot.exc = [];
  baseSnapshot.res = [];
  baseSnapshot.orders = [];

  return { baseSnapshot, boards, orders, tasks, stageSequences };
}

function assembleSnapshot(baseSnapshot, boards, orders, tasks, stageSequences) {
  const snapshot = normalizeSnapshotCollections(baseSnapshot);
  const boardMap = new Map();
  snapshot.crm.boards = boards.map((board) => {
    const entry = {
      id: board.id,
      name: board.name,
      lanes: Array.isArray(board.lanes) ? board.lanes : [],
      orders: []
    };
    boardMap.set(entry.id, entry);
    return entry;
  });

  orders.sort((a, b) => {
    if (a.boardId === b.boardId) {
      return a.position - b.position;
    }
    return a.boardId.localeCompare(b.boardId);
  });

  orders.forEach((order) => {
    const board = boardMap.get(order.boardId);
    if (!board) return;
    const payload = order.payload && typeof order.payload === 'object'
      ? { ...order.payload, uid: order.uid }
      : { uid: order.uid };
    payload.laneId = order.laneId;
    board.orders.push(payload);
  });

  const bucketMap = new Map([
    ['t', []],
    ['done', []],
    ['trash', []],
    ['exc', []],
    ['res', []]
  ]);

  tasks.sort((a, b) => {
    if (a.bucket === b.bucket) {
      return a.position - b.position;
    }
    return a.bucket.localeCompare(b.bucket);
  });

  tasks.forEach((task) => {
    const list = bucketMap.get(task.bucket);
    if (!list) return;
    const payload = task.payload && typeof task.payload === 'object'
      ? { ...task.payload, uid: task.uid }
      : { uid: task.uid };
    if (task.orderUid) {
      payload.orderIdentity = payload.orderIdentity || task.orderUid;
    }
    if (task.stage) {
      payload.stage = task.stage;
    }
    list.push(payload);
  });

  snapshot.t = bucketMap.get('t');
  snapshot.done = bucketMap.get('done');
  snapshot.trash = bucketMap.get('trash');
  snapshot.exc = bucketMap.get('exc');
  snapshot.res = bucketMap.get('res');

  snapshot.orders = stageSequences.map((entry) => [entry.stage, entry.ids]);

  return snapshot;
}

async function getLatestRevision(client) {
  const runner = client || pool;
  const { rows } = await runner.query('SELECT COALESCE(MAX(rev),0) AS rev FROM pc_revisions');
  return Number(rows[0]?.rev || 0);
}

async function loadSnapshotFromDatabase() {
  const client = await pool.connect();
  try {
    await ensureCoreSchema(client);

    const baseRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_base']);
    const boardsRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['crm_boards']);
    const hashRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_hash']);

    const baseSnapshot = baseRow.rows.length
      ? safeJsonParse(baseRow.rows[0].payload, buildEmptySnapshot())
      : buildEmptySnapshot();
    const boards = boardsRow.rows.length
      ? safeJsonParse(boardsRow.rows[0].payload, [])
      : [];

    const ordersRes = await client.query(
      `SELECT uid, board_id, lane_id, position, payload,
              crm_order_id, order_number, title, customer, status, priority,
              due_date, planned_start, planned_finish, ready_percent,
              manager, updated_by, updated_text
         FROM pc_orders`
    );
    const orders = [];
    const orderUpdates = [];
    for (const row of ordersRes.rows) {
      const payload = safeJsonParse(row.payload, {});
      const meta = extractOrderMetadata(payload);
      const storedCrmId = toNullableString(row.crm_order_id);
      const storedNumber = toNullableString(row.order_number);
      const storedTitle = toNullableString(row.title);
      const storedCustomer = toNullableString(row.customer);
      const storedStatus = toNullableString(row.status);
      const storedPriority = toNullableString(row.priority);
      const storedDue = toNullableString(row.due_date);
      const storedPlanStart = toNullableString(row.planned_start);
      const storedPlanFinish = toNullableString(row.planned_finish);
      const storedManager = toNullableString(row.manager);
      const storedUpdatedBy = toNullableString(row.updated_by);
      const storedUpdatedText = toNullableString(row.updated_text);
      const storedReady = row.ready_percent;
      const readyPercent = meta.readyPercent ?? null;
      const needsUpdate =
        storedCrmId !== (meta.crmOrderId || null) ||
        storedNumber !== (meta.orderNumber || null) ||
        storedTitle !== (meta.title || null) ||
        storedCustomer !== (meta.customer || null) ||
        storedStatus !== (meta.status || null) ||
        storedPriority !== (meta.priority || null) ||
        storedDue !== (meta.dueDate || null) ||
        storedPlanStart !== (meta.plannedStart || null) ||
        storedPlanFinish !== (meta.plannedFinish || null) ||
        !numbersEqual(storedReady, readyPercent) ||
        storedManager !== (meta.manager || null) ||
        storedUpdatedBy !== (meta.updatedBy || null) ||
        storedUpdatedText !== (meta.updatedText || null);
      if (needsUpdate) {
        orderUpdates.push([
          meta.crmOrderId || null,
          meta.orderNumber || null,
          meta.title || null,
          meta.customer || null,
          meta.status || null,
          meta.priority || null,
          meta.dueDate || null,
          meta.plannedStart || null,
          meta.plannedFinish || null,
          readyPercent,
          meta.manager || null,
          meta.updatedBy || null,
          meta.updatedText || null,
          sanitizeString(row.uid)
        ]);
      }
      orders.push({
        uid: sanitizeString(row.uid),
        boardId: sanitizeString(row.board_id),
        laneId: sanitizeString(row.lane_id || null) || null,
        position: Number(row.position) || 0,
        payload
      });
    }

    for (const params of orderUpdates) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE pc_orders
            SET crm_order_id = $1,
                order_number = $2,
                title = $3,
                customer = $4,
                status = $5,
                priority = $6,
                due_date = $7,
                planned_start = $8,
                planned_finish = $9,
                ready_percent = $10,
                manager = $11,
                updated_by = $12,
                updated_text = $13,
                updated_at = NOW()
          WHERE uid = $14`,
        params
      );
    }

    const tasksRes = await client.query(
      `SELECT uid, order_uid, stage_code, bucket, position, payload,
              crm_order_id, order_number, stage_name, status, priority, executor,
              planned_start, planned_finish, actual_start, actual_finish,
              due_date, expected_percent, progress_percent
         FROM pc_order_tasks`
    );
    const tasks = [];
    const taskUpdates = [];
    for (const row of tasksRes.rows) {
      const payload = safeJsonParse(row.payload, {});
      const meta = extractTaskMetadata(payload);
      const storedCrmId = toNullableString(row.crm_order_id);
      const storedNumber = toNullableString(row.order_number);
      const storedStageName = toNullableString(row.stage_name);
      const storedStatus = toNullableString(row.status);
      const storedPriority = toNullableString(row.priority);
      const storedExecutor = toNullableString(row.executor);
      const storedPlanStart = toNullableString(row.planned_start);
      const storedPlanFinish = toNullableString(row.planned_finish);
      const storedActualStart = toNullableString(row.actual_start);
      const storedActualFinish = toNullableString(row.actual_finish);
      const storedDue = toNullableString(row.due_date);
      const storedExpected = row.expected_percent;
      const storedProgress = row.progress_percent;
      const expectedPercent = meta.expectedPercent ?? null;
      const progressPercent = meta.progressPercent ?? null;
      const needsUpdate =
        storedCrmId !== (meta.crmOrderId || null) ||
        storedNumber !== (meta.orderNumber || null) ||
        storedStageName !== (meta.stageName || null) ||
        storedStatus !== (meta.status || null) ||
        storedPriority !== (meta.priority || null) ||
        storedExecutor !== (meta.executor || null) ||
        storedPlanStart !== (meta.plannedStart || null) ||
        storedPlanFinish !== (meta.plannedFinish || null) ||
        storedActualStart !== (meta.actualStart || null) ||
        storedActualFinish !== (meta.actualFinish || null) ||
        storedDue !== (meta.dueDate || null) ||
        !numbersEqual(storedExpected, expectedPercent) ||
        !numbersEqual(storedProgress, progressPercent);
      if (needsUpdate) {
        taskUpdates.push([
          meta.crmOrderId || null,
          meta.orderNumber || null,
          meta.stageName || null,
          meta.status || null,
          meta.priority || null,
          meta.executor || null,
          meta.plannedStart || null,
          meta.plannedFinish || null,
          meta.actualStart || null,
          meta.actualFinish || null,
          meta.dueDate || null,
          expectedPercent,
          progressPercent,
          sanitizeString(row.uid)
        ]);
      }
      tasks.push({
        uid: sanitizeString(row.uid),
        orderUid: sanitizeString(row.order_uid || null) || null,
        stage: normalizeStage(row.stage_code),
        bucket: sanitizeString(row.bucket) || 't',
        position: Number(row.position) || 0,
        payload
      });
    }

    for (const params of taskUpdates) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE pc_order_tasks
            SET crm_order_id = $1,
                order_number = $2,
                stage_name = $3,
                status = $4,
                priority = $5,
                executor = $6,
                planned_start = $7,
                planned_finish = $8,
                actual_start = $9,
                actual_finish = $10,
                due_date = $11,
                expected_percent = $12,
                progress_percent = $13,
                updated_at = NOW()
          WHERE uid = $14`,
        params
      );
    }

    const stageRes = await client.query('SELECT stage_code, task_uids FROM pc_stage_sequences');
    const stageSequences = stageRes.rows.map((row) => ({
      stage: normalizeStage(row.stage_code),
      ids: Array.isArray(row.task_uids)
        ? row.task_uids.map((uid) => sanitizeString(uid)).filter(Boolean)
        : []
    })).filter((entry) => entry.stage);

    const snapshot = assembleSnapshot(baseSnapshot, boards, orders, tasks, stageSequences);
    const stateString = safeJsonStringify(snapshot, '{}');
    const storedHash = hashRow.rows.length
      ? sanitizeString(hashRow.rows[0].payload?.hash || hashRow.rows[0].payload?.HASH)
      : null;
    const hash = storedHash || computeHash(stateString);
    const rev = await getLatestRevision(client);

    return { snapshot, stateString, hash, rev };
  } finally {
    client.release();
  }
}

async function getCachedSnapshot() {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const loaded = await loadSnapshotFromDatabase();
  cachedSnapshot = loaded;
  return loaded;
}

async function persistSnapshotWithSql({ snapshot, stateString }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCoreSchema(client);

    const parsed = typeof snapshot === 'string' ? safeJsonParse(snapshot, {}) : snapshot;
    const storage = extractStorageParts(parsed);
    const normalizedState = assembleSnapshot(
      storage.baseSnapshot,
      storage.boards,
      storage.orders,
      storage.tasks,
      storage.stageSequences
    );
    const finalString = stateString || safeJsonStringify(normalizedState, '{}');
    const hash = computeHash(finalString);

    const currentRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_hash']);
    const currentHash = currentRow.rows.length
      ? sanitizeString(currentRow.rows[0].payload?.hash || currentRow.rows[0].payload?.HASH)
      : null;

    if (currentHash && currentHash === hash) {
      await client.query('ROLLBACK');
      return { snapshot: normalizedState, stateString: finalString, hash, rev: await getLatestRevision(client) };
    }

    await client.query('DELETE FROM pc_order_tasks');
    await client.query('DELETE FROM pc_orders');
    await client.query('DELETE FROM pc_stage_sequences');

    for (const order of storage.orders) {
      const meta = order.meta || extractOrderMetadata(order.payload);
      await client.query(
        `INSERT INTO pc_orders (
           uid, board_id, lane_id, position, payload,
           crm_order_id, order_number, title, customer, status, priority,
           due_date, planned_start, planned_finish, ready_percent,
           manager, updated_by, updated_text,
           created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())`,
        [
          order.uid,
          order.boardId,
          order.laneId,
          order.position,
          JSON.stringify(order.payload ?? {}),
          meta?.crmOrderId || null,
          meta?.orderNumber || null,
          meta?.title || null,
          meta?.customer || null,
          meta?.status || null,
          meta?.priority || null,
          meta?.dueDate || null,
          meta?.plannedStart || null,
          meta?.plannedFinish || null,
          meta?.readyPercent ?? null,
          meta?.manager || null,
          meta?.updatedBy || null,
          meta?.updatedText || null
        ]
      );
    }

    for (const task of storage.tasks) {
      const meta = task.meta || extractTaskMetadata(task.payload);
      await client.query(
        `INSERT INTO pc_order_tasks (
           uid, order_uid, stage_code, bucket, position, payload,
           crm_order_id, order_number, stage_name, status, priority, executor,
           planned_start, planned_finish, actual_start, actual_finish,
           due_date, expected_percent, progress_percent,
           created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())`,
        [
          task.uid,
          task.orderUid,
          task.stage,
          task.bucket,
          task.position,
          JSON.stringify(task.payload ?? {}),
          meta?.crmOrderId || null,
          meta?.orderNumber || null,
          meta?.stageName || null,
          meta?.status || null,
          meta?.priority || null,
          meta?.executor || null,
          meta?.plannedStart || null,
          meta?.plannedFinish || null,
          meta?.actualStart || null,
          meta?.actualFinish || null,
          meta?.dueDate || null,
          meta?.expectedPercent ?? null,
          meta?.progressPercent ?? null
        ]
      );
    }

    for (const entry of storage.stageSequences) {
      await client.query(
        `INSERT INTO pc_stage_sequences (stage_code, task_uids, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (stage_code) DO UPDATE
           SET task_uids = EXCLUDED.task_uids,
               updated_at = NOW()` ,
        [entry.stage, entry.ids]
      );
    }

    await upsertSetting(client, 'snapshot_base', storage.baseSnapshot);
    await upsertSetting(client, 'crm_boards', storage.boards);
    await upsertSetting(client, 'snapshot_hash', { hash });

    const revResult = await client.query('INSERT INTO pc_revisions (hash) VALUES ($1) RETURNING rev', [hash]);
    const rev = Number(revResult.rows[0]?.rev || 0);

    await client.query('COMMIT');
    const assembled = { snapshot: normalizedState, stateString: finalString, hash, rev };
    cachedSnapshot = assembled;
    return assembled;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function broadcastRevision({ rev, hash }) {
  const payload = JSON.stringify({ type: 'revision', rev, hash, etag: computeEtag(hash) });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.warn('Failed to push SSE payload', err);
    }
  }
}

function extractHashFromHeader(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (!token) continue;
    const normalized = token.startsWith('W/') ? token.slice(2) : token;
    const stripped = normalized.replace(/^"|"$/g, '');
    if (stripped) {
      return stripped;
    }
  }
  return null;
}

function extractSnapshotPayload(body) {
  if (body == null) {
    return { snapshot: buildEmptySnapshot(), stateString: JSON.stringify(buildEmptySnapshot()), meta: {} };
  }

  if (typeof body === 'string') {
    const parsed = safeJsonParse(body, {});
    return extractSnapshotPayload(parsed);
  }

  if (Buffer.isBuffer(body)) {
    return extractSnapshotPayload(body.toString('utf8'));
  }

  if (typeof body === 'object') {
    const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
    if (typeof body.state === 'string') {
      const snapshot = safeJsonParse(body.state, {});
      return { snapshot, stateString: body.state, meta };
    }
    if (body.state && typeof body.state === 'object') {
      const stateString = safeJsonStringify(body.state, '{}');
      return { snapshot: body.state, stateString, meta };
    }
    if (body.snapshot && typeof body.snapshot === 'object') {
      const stateString = safeJsonStringify(body.snapshot, '{}');
      return { snapshot: body.snapshot, stateString, meta };
    }
    const stateString = safeJsonStringify(body, '{}');
    const snapshot = safeJsonParse(stateString, {});
    return { snapshot, stateString, meta };
  }

  return { snapshot: buildEmptySnapshot(), stateString: JSON.stringify(buildEmptySnapshot()), meta: {} };
}

app.get('/api/state', async (req, res) => {
  try {
    const snapshot = await getCachedSnapshot();
    const etag = computeEtag(snapshot.hash);
    if (etag) {
      const headerHash = extractHashFromHeader(req.headers['if-none-match']);
      if (headerHash && headerHash === snapshot.hash) {
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
  try {
    const { snapshot, stateString } = extractSnapshotPayload(req.body);
    const current = await getCachedSnapshot();
    const ifMatch = extractHashFromHeader(req.headers['if-match']);
    if (ifMatch && current.hash && ifMatch !== current.hash && ifMatch !== '*') {
      res.status(412).json({ error: 'Precondition Failed', expected: current.hash });
      return;
    }

    const latest = await persistSnapshotWithSql({ snapshot, stateString });
    const etag = computeEtag(latest.hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');
    broadcastRevision({ rev: latest.rev, hash: latest.hash });
    res.status(200).json({ ok: true, rev: latest.rev, hash: latest.hash, etag });
  } catch (err) {
    console.error('PUT /api/state failed', err);
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

  try {
    const snapshot = await getCachedSnapshot();
    if (snapshot && snapshot.hash) {
      const payload = JSON.stringify({
        type: 'revision',
        rev: snapshot.rev,
        hash: snapshot.hash,
        etag: computeEtag(snapshot.hash)
      });
      res.write(`data: ${payload}\n\n`);
    }
  } catch (err) {
    console.warn('Failed to send initial SSE payload', err);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html', 'htm'] }));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const indexPath = path.join(PUBLIC_DIR, 'CRM.html');
  fs.createReadStream(indexPath)
    .on('error', () => next())
    .pipe(res);
});

(async () => {
  try {
    await runMigrations();
    await getCachedSnapshot();
    app.listen(PORT, () => {
      console.log(`Planner SQL bridge listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to bootstrap application', err);
    process.exit(1);
  }
})();
