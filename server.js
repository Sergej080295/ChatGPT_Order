'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const express = require('express');
const jwt = require('jsonwebtoken');
const Papa = require('papaparse');
const { Pool } = require('pg');

const app = express();

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
  max: Number.parseInt(process.env.PGPOOL_MAX || '10', 10),
  idleTimeoutMillis: Number.parseInt(process.env.PGPOOL_IDLE || '30000', 10)
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

const JWT_SECRET = process.env.JWT_SECRET || 'planner-secret';
const JWT_TTL_SECONDS = Number.parseInt(process.env.JWT_TTL || `${24 * 60 * 60}`, 10);

const COOKIE_NAME = process.env.AUTH_COOKIE || 'planner_token';

const LEGACY_IMPORT_ENABLED = process.env.PLANNER_SKIP_LEGACY_IMPORT !== 'true';

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'text/csv', 'text/*'] }));
app.use(cookieParser());

const sseClients = new Set();
let globalEventVersion = 0;

const simpleHash = (str) => {
  if (!str) return '';
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0; // eslint-disable-line no-bitwise
  }
  return hash.toString(16);
};

const broadcastEvent = (payload) => {
  globalEventVersion += 1;
  const enriched = {
    version: globalEventVersion,
    timestamp: new Date().toISOString(),
    ...payload
  };
  const data = `data: ${JSON.stringify(enriched)}\n\n`;
  sseClients.forEach((client) => {
    try {
      client.res.write(data);
    } catch (err) {
      console.warn('SSE broadcast failed', err);
    }
  });
};

const DEFAULT_CRM_LANES = [
  'Не запланированное',
  'Клиент',
  'Отдел продаж',
  'Технологи',
  'Производство',
  'Закупка',
  'Упаковка',
  'Готово (Ож. отгрузки)',
  'Отгружено'
];

const PLANNER_STAGE_KEYS = ['draw', 'proc', 'shear', 'laser', 'bend', 'weld', 'mech', 'pack', 'ship'];

const CRM_STAGE_ALIASES = new Map([
  ['laser', 'laser'],
  ['лазер', 'laser'],
  ['резка', 'laser'],
  ['rezka', 'laser'],
  ['cut', 'laser'],
  ['bend', 'bend'],
  ['гибка', 'bend'],
  ['сгиб', 'bend'],
  ['draw', 'draw'],
  ['подготовка', 'draw'],
  ['подготовка в работу', 'draw'],
  ['подготовка к работе', 'draw'],
  ['технологи', 'proc'],
  ['proc', 'proc'],
  ['технологический отдел', 'proc'],
  ['закупка', 'proc'],
  ['purchase', 'proc'],
  ['weld', 'weld'],
  ['сварка', 'weld'],
  ['mech', 'mech'],
  ['мех', 'mech'],
  ['мехобработка', 'mech'],
  ['pack', 'pack'],
  ['упаковка', 'pack'],
  ['ship', 'ship'],
  ['отгрузка', 'ship'],
  ['отгружено', 'ship']
]);

const DEFAULT_STATE = {
  t: [],
  orders: [],
  locked: [],
  ignoredStates: [],
  meta: {
    versions: {},
    history: [],
    lastAuthors: {},
    csvTimestamp: '',
    manualTimestamp: '',
    ignoredStates: []
  }
};

const createInitialState = () => {
  const stateString = JSON.stringify(DEFAULT_STATE);
  return {
    state: stateString,
    meta: {
      stage: null,
      version: 0,
      user: 'system',
      session: null,
      diff: null
    },
    updatedAt: new Date().toISOString(),
    hash: simpleHash(stateString)
  };
};

const loadLegacyStateFromDisk = async () => {
  if (!LEGACY_IMPORT_ENABLED) {
    return null;
  }
  const legacyPath = path.join(__dirname, 'planner-state.json');
  try {
    const raw = await fsp.readFile(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.state === 'string') {
      return {
        state: parsed.state,
        meta: parsed.meta ?? null,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        hash: parsed.hash ?? simpleHash(parsed.state)
      };
    }
  } catch (err) {
    // ignore legacy import failure
  }
  return null;
};

let cachedPlannerState = null;

const ensurePlannerTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS planner_state (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      state TEXT NOT NULL,
      meta JSONB,
      hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS planner_activity_log (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stage TEXT,
      version INTEGER,
      user_name TEXT,
      session TEXT,
      source TEXT,
      summary TEXT,
      diff JSONB,
      orders_summary JSONB,
      ip TEXT
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS planner_activity_log_timestamp_idx ON planner_activity_log (timestamp)');
  await pool.query('CREATE INDEX IF NOT EXISTS planner_activity_log_stage_idx ON planner_activity_log (stage)');
  await pool.query('ALTER TABLE planner_activity_log ADD COLUMN IF NOT EXISTS orders_summary JSONB');
};

const readPlannerState = async () => {
  const { rows } = await pool.query('SELECT id, state, meta, hash, updated_at FROM planner_state ORDER BY id LIMIT 1');
  if (rows.length > 0) {
    const row = rows[0];
    return {
      id: row.id,
      state: row.state,
      meta: row.meta ?? null,
      hash: row.hash,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
  return null;
};

const insertInitialPlannerState = async (client) => {
  const legacy = await loadLegacyStateFromDisk();
  const payload = legacy || createInitialState();
  const { rows } = await client.query(
    'INSERT INTO planner_state (state, meta, hash, updated_at) VALUES ($1, $2, $3, $4) RETURNING id, state, meta, hash, updated_at',
    [payload.state, payload.meta, payload.hash, payload.updatedAt]
  );
  const row = rows[0];
  return {
    id: row.id,
    state: row.state,
    meta: row.meta ?? null,
    hash: row.hash,
    updatedAt: new Date(row.updated_at).toISOString()
  };
};

const normalizePlannerState = async () => {
  if (cachedPlannerState) {
    return cachedPlannerState;
  }

  await ensurePlannerTables();

  const existing = await readPlannerState();
  if (existing) {
    cachedPlannerState = existing;
    return cachedPlannerState;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, state, meta, hash, updated_at FROM planner_state ORDER BY id LIMIT 1 FOR UPDATE');
    let row;
    if (rows.length === 0) {
      row = await insertInitialPlannerState(client);
    } else {
      const existingRow = rows[0];
      row = {
        id: existingRow.id,
        state: existingRow.state,
        meta: existingRow.meta ?? null,
        hash: existingRow.hash,
        updatedAt: new Date(existingRow.updated_at).toISOString()
      };
    }
    await client.query('COMMIT');
    cachedPlannerState = row;
    return cachedPlannerState;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const appendPlannerLog = async (entry) => {
  await pool.query(
    `INSERT INTO planner_activity_log (timestamp, stage, version, user_name, session, source, summary, diff, orders_summary, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.timestamp,
      entry.stage,
      entry.version,
      entry.user,
      entry.session,
      entry.source,
      entry.summary,
      entry.diff ?? null,
      entry.ordersSummary ?? null,
      entry.ip
    ]
  );
};

const ensureCrmSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_orders (
      id SERIAL PRIMARY KEY,
      order_no TEXT NOT NULL,
      title TEXT NOT NULL,
      customer TEXT,
      service_total NUMERIC,
      lane TEXT NOT NULL,
      is_done BOOLEAN NOT NULL DEFAULT FALSE,
      parent_order_id INT NULL REFERENCES crm_orders(id) ON DELETE SET NULL,
      board_key TEXT NOT NULL DEFAULT 'default',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      deleted_at TIMESTAMPTZ NULL
    )
  `);

  await pool.query('ALTER TABLE crm_orders ADD COLUMN IF NOT EXISTS notes TEXT');

  await pool.query('CREATE INDEX IF NOT EXISTS crm_orders_board_lane_idx ON crm_orders (board_key, lane)');
  await pool.query('CREATE INDEX IF NOT EXISTS crm_orders_updated_idx ON crm_orders (updated_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS crm_orders_order_no_idx ON crm_orders (order_no)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_stages (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL REFERENCES crm_orders(id) ON DELETE CASCADE,
      stage_key TEXT NOT NULL,
      stage_name TEXT NOT NULL,
      hours NUMERIC,
      date_start DATE,
      date_end DATE,
      percent NUMERIC,
      is_ready BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS crm_stages_order_idx ON crm_stages (order_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS crm_stages_updated_idx ON crm_stages (updated_at DESC)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id BIGINT NOT NULL,
      action TEXT NOT NULL,
      by_user TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload_json JSONB
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS activity_log_entity_idx ON activity_log (entity, entity_id)');
};

const ensureDefaultAdmin = async () => {
  const defaultEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com';
  const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'change-me';
  const displayName = process.env.DEFAULT_ADMIN_NAME || 'Administrator';

  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [defaultEmail]);
  if (rows.length > 0) {
    return;
  }

  const passwordHash = await bcrypt.hash(defaultPassword, 10);
  await pool.query(
    'INSERT INTO users (display_name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    [displayName, defaultEmail, passwordHash, 'admin']
  );
  console.log(`Seeded default admin user ${defaultEmail} / ${defaultPassword}`);
};

const getUserById = async (id) => {
  const { rows } = await pool.query('SELECT id, display_name, email, role, status FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
};

const getUserByEmail = async (email) => {
  const { rows } = await pool.query('SELECT id, display_name, email, role, status, password_hash FROM users WHERE email = $1', [email]);
  return rows[0] ?? null;
};

const sanitizeUser = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status
  };
};

const signToken = (user) => {
  return jwt.sign({ sub: String(user.id), role: user.role, email: user.email }, JWT_SECRET, { expiresIn: JWT_TTL_SECONDS });
};

const cookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  maxAge: JWT_TTL_SECONDS * 1000
};

const authenticate = async (req, _res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(Number.parseInt(payload.sub, 10));
    if (!user) {
      req.user = null;
      return next();
    }
    req.user = user;
  } catch (err) {
    req.user = null;
  }
  return next();
};

const requireAuth = (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!roles.includes(req.user.role)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};

app.use(authenticate);

const recordActivity = async ({ entity, entityId, action, userEmail, payload }) => {
  await pool.query(
    'INSERT INTO activity_log (entity, entity_id, action, by_user, payload_json) VALUES ($1, $2, $3, $4, $5)',
    [entity, entityId, action, userEmail ?? null, payload ?? null]
  );
};

const stageKeyFromName = (name) => {
  if (!name) return 'stage';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
};

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num;
};

const boolFrom = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return false;
};

const computeOrderAggregates = (order, stages) => {
  const stageDatesStart = stages.map((s) => (s.date_start ? new Date(s.date_start) : null)).filter(Boolean);
  const stageDatesEnd = stages.map((s) => (s.date_end ? new Date(s.date_end) : null)).filter(Boolean);
  const percentValues = stages.map((s) => Number(s.percent ?? 0)).filter((n) => Number.isFinite(n));
  const readyCount = stages.filter((s) => boolFrom(s.is_ready)).length;
  const totalCount = stages.length;
  return {
    start: stageDatesStart.length ? stageDatesStart.sort((a, b) => a - b)[0].toISOString().slice(0, 10) : '',
    end: stageDatesEnd.length ? stageDatesEnd.sort((a, b) => b - a)[0].toISOString().slice(0, 10) : '',
    percent: percentValues.length ? Math.round(percentValues.reduce((acc, n) => acc + n, 0) / percentValues.length) : 0,
    readyCount,
    totalCount
  };
};

const mergeCrmLanes = (lanes) => {
  const seen = new Set();
  const ordered = [];
  DEFAULT_CRM_LANES.forEach((lane) => {
    if (!seen.has(lane)) {
      ordered.push(lane);
      seen.add(lane);
    }
  });
  (lanes || []).forEach((laneRaw) => {
    const lane = (laneRaw || '').trim();
    if (!lane) return;
    if (!seen.has(lane)) {
      ordered.push(lane);
      seen.add(lane);
    }
  });
  return ordered;
};

const normalizePlannerStage = (stageKey, stageName) => {
  const candidates = [stageKey, stageName, stageKeyFromName(stageName || stageKey || '')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.toString().trim().toLowerCase();
    if (!normalized) continue;
    if (CRM_STAGE_ALIASES.has(normalized)) {
      return CRM_STAGE_ALIASES.get(normalized);
    }
  }
  return 'proc';
};

const safeDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const buildPlannerStateFromCrm = (board) => {
  const nowIso = new Date().toISOString();
  const tasks = [];
  const perStage = new Map(PLANNER_STAGE_KEYS.map((key) => [key, []]));

  (board?.orders || []).forEach((order) => {
    const numericId = order.id != null ? Number(order.id) : null;
    const orderNo = (order.orderNo ?? '').toString().trim();
    const title = (order.title ?? '').toString().trim();
    const customer = (order.customer ?? '').toString().trim();
    const baseKey = numericId != null
      ? `srv-${numericId}`
      : (orderNo
        ? `ord-${simpleHash(orderNo)}`
        : `crm-${simpleHash(`${title}::${customer}` || 'order')}`);
    const displayOrderId = orderNo || title || baseKey;
    const orderNumber = orderNo || displayOrderId;
    const baseIdentity = orderNumber || baseKey;
    const lane = (order.lane || DEFAULT_CRM_LANES[0]).trim() || DEFAULT_CRM_LANES[0];
    const stages = Array.isArray(order.stages) && order.stages.length ? order.stages : [];
    let stageCount = 0;

    stages.forEach((stage) => {
      const plannerStage = normalizePlannerStage(stage.stageKey, stage.stageName);
      const stageIdPart = stage.id != null ? String(stage.id) : (stage.stageKey ? String(stage.stageKey) : crypto.randomUUID());
      const uid = `${baseKey}::${plannerStage}-${stageIdPart}`;
      const startIso = safeDate(stage.dateStart ? `${stage.dateStart}T00:00:00Z` : null);
      const endIso = safeDate(stage.dateEnd ? `${stage.dateEnd}T00:00:00Z` : null);
      const hours = numberOrNull(stage.hours) ?? 0;
      const percent = numberOrNull(stage.percent) ?? 0;
      const stageRoute = {};
      PLANNER_STAGE_KEYS.forEach((key) => {
        if (key === plannerStage) {
          stageRoute[key] = {
            hours,
            start: startIso,
            end: endIso,
            ...(stage.isReady ? { doneAt: stage.updatedAt ? safeDate(stage.updatedAt) : nowIso } : {})
          };
        } else {
          stageRoute[key] = null;
        }
      });

      const task = {
        uid,
        orderId: displayOrderId,
        orderNumber,
        orderCustomer: customer,
        orderIdentity: baseIdentity,
        stage: plannerStage,
        childId: `${baseKey}-${plannerStage}`,
        parentId: baseKey,
        hours,
        extraHours: 0,
        startDate: startIso,
        endDate: endIso,
        startMissing: !startIso,
        endMissing: !endIso,
        state: lane,
        status: stage.isReady || order.isDone ? 'Готово' : percent >= 100 ? 'Готово' : 'В работе',
        useReserve: false,
        progress: percent,
        origStartDate: startIso,
        route: stageRoute,
        isUserNew: false,
        isNew: false,
        isDone: !!(stage.isReady || order.isDone),
        isTrash: false,
        locked: false,
        hiddenByState: false,
        doneMeta: stage.isReady || order.isDone
          ? { when: stage.updatedAt ? safeDate(stage.updatedAt) : nowIso, source: 'crm' }
          : null
      };

      tasks.push(task);
      if (!perStage.has(plannerStage)) {
        perStage.set(plannerStage, []);
      }
      perStage.get(plannerStage).push(uid);
      stageCount += 1;
    });

    if (stageCount === 0) {
      const plannerStage = 'proc';
      const uid = `${baseKey}::${plannerStage}-auto`;
      const startIso = safeDate(order.start ? `${order.start}T00:00:00Z` : null);
      const endIso = safeDate(order.end ? `${order.end}T00:00:00Z` : null);
      const stageRoute = {};
      PLANNER_STAGE_KEYS.forEach((key) => {
        if (key === plannerStage) {
          stageRoute[key] = {
            hours: 0,
            start: startIso,
            end: endIso,
            ...(order.isDone ? { doneAt: order.updatedAt ? safeDate(order.updatedAt) : nowIso } : {})
          };
        } else {
          stageRoute[key] = null;
        }
      });

      const task = {
        uid,
        orderId: displayOrderId,
        orderNumber,
        orderCustomer: customer,
        orderIdentity: baseIdentity,
        stage: plannerStage,
        childId: `${baseKey}-${plannerStage}`,
        parentId: baseKey,
        hours: 0,
        extraHours: 0,
        startDate: startIso,
        endDate: endIso,
        startMissing: !startIso,
        endMissing: !endIso,
        state: lane,
        status: order.isDone ? 'Готово' : 'В работе',
        useReserve: false,
        progress: order.isDone ? 100 : 0,
        origStartDate: startIso,
        route: stageRoute,
        isUserNew: false,
        isNew: false,
        isDone: !!order.isDone,
        isTrash: false,
        locked: false,
        hiddenByState: false,
        doneMeta: order.isDone
          ? { when: order.updatedAt ? safeDate(order.updatedAt) : nowIso, source: 'crm' }
          : null
      };

      tasks.push(task);
      if (!perStage.has(plannerStage)) {
        perStage.set(plannerStage, []);
      }
      perStage.get(plannerStage).push(uid);
    }
  });

  const allTaskUids = tasks.map((task) => task.uid);
  const ordersMatrix = [['orders', allTaskUids]];
  PLANNER_STAGE_KEYS.forEach((stage) => {
    ordersMatrix.push([stage, perStage.get(stage) || []]);
  });

  const baseState = {
    routeOverrides: [],
    t: tasks,
    done: [],
    trash: [],
    exc: [],
    res: [],
    process: 'laser',
    capByProc: { laser: 0, bend: 0, draw: 0, weld: 0, mech: 0, proc: 0 },
    parallelByProc: { proc: 0, shear: 0, pack: 0, ship: 0 },
    filter: 'all',
    locked: [],
    orders: ordersMatrix,
    freshness: nowIso,
    freshnessCsv: nowIso,
    freshnessManual: '',
    lastImportTime: nowIso,
    lastManualTime: '',
    autosaveOn: true,
    autoOptimizeOn: true,
    shiftOnProgress: true,
    meta: {
      versions: {},
      lastAuthors: {},
      csvTimestamp: nowIso,
      manualTimestamp: '',
      history: [],
      storage: { local: true, remote: true, remotePreferred: true, mode: 'remote' },
      settings: {
        capacity: { laser: 0, bend: 0, draw: 0, weld: 0, mech: 0, proc: 0 },
        parallel: { proc: 0, shear: 0, pack: 0, ship: 0 },
        autosave: true,
        shiftOnProgress: true,
        autoOptimize: true
      }
    }
  };

  return {
    state: JSON.stringify(baseState),
    meta: {
      stage: 'crm-sync',
      version: Date.now(),
      source: 'crm',
      generatedAt: nowIso,
      orders: board?.orders?.length ?? 0
    }
  };
};

const fetchCrmState = async () => {
  await ensureCrmSchema();
  const { rows: orderRows } = await pool.query(
    `SELECT id, order_no, title, customer, service_total, lane, is_done, parent_order_id, board_key,
            notes, created_at, updated_at, updated_by
       FROM crm_orders
      WHERE deleted_at IS NULL AND board_key = 'default'
      ORDER BY created_at ASC, id ASC`
  );

  if (orderRows.length === 0) {
    const emptyBoard = {
      id: 'default',
      name: 'Список заказов',
      lanes: [...DEFAULT_CRM_LANES],
      orders: []
    };
    return {
      board: emptyBoard,
      lanes: [...DEFAULT_CRM_LANES],
      plannerState: buildPlannerStateFromCrm(emptyBoard)
    };
  }

  const orderIds = orderRows.map((row) => row.id);
  const { rows: stageRows } = await pool.query(
    `SELECT id, order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_at, updated_by
       FROM crm_stages
      WHERE order_id = ANY($1::int[])
      ORDER BY id ASC`,
    [orderIds]
  );

  const stagesByOrder = new Map();
  stageRows.forEach((stage) => {
    if (!stagesByOrder.has(stage.order_id)) {
      stagesByOrder.set(stage.order_id, []);
    }
    stagesByOrder.get(stage.order_id).push(stage);
  });

  const lanes = mergeCrmLanes(orderRows.map((row) => row.lane));
  const orders = orderRows.map((row) => {
    const stages = stagesByOrder.get(row.id) || [];
    const aggregates = computeOrderAggregates(row, stages);
    const laneValue = (row.lane || DEFAULT_CRM_LANES[0]).trim() || DEFAULT_CRM_LANES[0];
    return {
      id: row.id,
      orderNo: row.order_no,
      title: row.title,
      customer: row.customer,
      serviceTotal: row.service_total === null ? '' : Number(row.service_total),
      lane: laneValue,
      isDone: boolFrom(row.is_done),
      parentOrderId: row.parent_order_id,
      boardKey: row.board_key,
      notes: row.notes ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      start: aggregates.start,
      end: aggregates.end,
      percent: aggregates.percent,
      stages: stages.map((stage) => ({
        id: stage.id,
        orderId: stage.order_id,
        stageKey: stage.stage_key,
        stageName: stage.stage_name,
        hours: stage.hours === null ? null : Number(stage.hours),
        dateStart: stage.date_start ? stage.date_start.toISOString().slice(0, 10) : '',
        dateEnd: stage.date_end ? stage.date_end.toISOString().slice(0, 10) : '',
        percent: stage.percent === null ? 0 : Number(stage.percent),
        isReady: boolFrom(stage.is_ready),
        updatedAt: stage.updated_at,
        updatedBy: stage.updated_by
      })),
      readyCount: aggregates.readyCount,
      totalStages: aggregates.totalCount
    };
  });

  const board = {
    id: 'default',
    name: 'Список заказов',
    lanes,
    orders
  };

  return {
    board,
    lanes,
    updatedAt: orderRows.reduce((latest, row) => {
      const ts = row.updated_at ? new Date(row.updated_at).getTime() : 0;
      return Math.max(latest, ts);
    }, 0) || Date.now(),
    plannerState: buildPlannerStateFromCrm(board)
  };
};

const upsertOrder = async (payload, user) => {
  const now = new Date();
  const {
    id,
    orderNo,
    title,
    customer,
    serviceTotal,
    lane,
    isDone,
    parentOrderId,
    boardKey,
    notes
  } = payload;

  if (!orderNo || !title) {
    const err = new Error('orderNo and title are required');
    err.status = 422;
    throw err;
  }

  const numericTotal = numberOrNull(serviceTotal);
  const board = boardKey || 'default';
  const done = boolFrom(isDone);
  const laneValue = (lane || DEFAULT_CRM_LANES[0]).trim() || DEFAULT_CRM_LANES[0];

  let result;
  if (id) {
    result = await pool.query(
      `UPDATE crm_orders
          SET order_no = $1,
              title = $2,
              customer = $3,
              service_total = $4,
              lane = $5,
              is_done = $6,
              parent_order_id = $7,
              board_key = $8,
              notes = $9,
              updated_at = $10,
              updated_by = $11
        WHERE id = $12
          AND deleted_at IS NULL
      RETURNING id`,
      [orderNo, title, customer || null, numericTotal, laneValue, done, parentOrderId || null, board, notes || null, now, user?.email ?? null, id]
    );
    if (result.rowCount === 0) {
      const notFound = new Error('Order not found');
      notFound.status = 404;
      throw notFound;
    }
  } else {
    result = await pool.query(
      `INSERT INTO crm_orders
        (order_no, title, customer, service_total, lane, is_done, parent_order_id, board_key, notes, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`,
      [orderNo, title, customer || null, numericTotal, laneValue, done, parentOrderId || null, board, notes || null, now, user?.email ?? null]
    );
  }

  const orderId = result.rows[0].id;

  await recordActivity({
    entity: 'order',
    entityId: orderId,
    action: id ? 'update' : 'create',
    userEmail: user?.email ?? null,
    payload: payload
  });

  broadcastEvent({
    type: 'update',
    entity: 'order',
    id: orderId,
    changed: {
      orderNo,
      title,
      customer,
      serviceTotal: numericTotal,
      lane,
      isDone: done,
      parentOrderId: parentOrderId || null,
      boardKey: board,
      notes: notes || null
    },
    by: user?.email ?? null
  });

  return orderId;
};

const syncStages = async (orderId, stages, user, opts = {}) => {
  if (!Array.isArray(stages)) return;
  const { trimMissing = true } = opts;
  const existing = await pool.query('SELECT id FROM crm_stages WHERE order_id = $1', [orderId]);
  const existingIds = new Set(existing.rows.map((row) => row.id));
  const seenIds = new Set();

  for (const stage of stages) {
    const stageId = stage.id ? Number(stage.id) : null;
    const key = stage.stageKey || stageKeyFromName(stage.stageName || stage.name || '');
    const name = stage.stageName || stage.name || 'Передел';
    const hours = numberOrNull(stage.hours ?? stage.value);
    const startDate = stage.dateStart || stage.start || '';
    const endDate = stage.dateEnd || stage.end || '';
    const percent = numberOrNull(stage.percent ?? stage.progress) ?? (boolFrom(stage.isReady ?? stage.done) ? 100 : 0);
    const ready = boolFrom(stage.isReady ?? stage.done);

    if (stageId) {
      await pool.query(
        `UPDATE crm_stages
            SET stage_key = $1,
                stage_name = $2,
                hours = $3,
                date_start = $4,
                date_end = $5,
                percent = $6,
                is_ready = $7,
                updated_at = $8,
                updated_by = $9
          WHERE id = $10
            AND order_id = $11`,
        [key, name, hours, startDate || null, endDate || null, percent, ready, new Date(), user?.email ?? null, stageId, orderId]
      );
      seenIds.add(stageId);
    } else {
      const inserted = await pool.query(
        `INSERT INTO crm_stages
          (order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
        [orderId, key, name, hours, startDate || null, endDate || null, percent, ready, new Date(), user?.email ?? null]
      );
      seenIds.add(inserted.rows[0].id);
    }

    broadcastEvent({
      type: 'update',
      entity: 'stage',
      id: stageId || null,
      parentId: orderId,
      changed: {
        stageKey: key,
        stageName: name,
        hours,
        dateStart: startDate || null,
        dateEnd: endDate || null,
        percent,
        isReady: ready
      },
      by: user?.email ?? null
    });
  }

  if (trimMissing) {
    for (const id of existingIds) {
      if (!seenIds.has(id)) {
        await pool.query('DELETE FROM crm_stages WHERE id = $1', [id]);
        broadcastEvent({
          type: 'update',
          entity: 'stage',
          id,
          parentId: orderId,
          changed: { deleted: true },
          by: user?.email ?? null
        });
      }
    }
  }
};

const softDeleteOrder = async (orderId, user) => {
  const now = new Date();
  const res = await pool.query(
    'UPDATE crm_orders SET deleted_at = $1, updated_at = $1, updated_by = $2 WHERE id = $3 AND deleted_at IS NULL RETURNING id',
    [now, user?.email ?? null, orderId]
  );
  if (res.rowCount === 0) {
    const err = new Error('Order not found');
    err.status = 404;
    throw err;
  }
  await recordActivity({ entity: 'order', entityId: orderId, action: 'delete', userEmail: user?.email ?? null, payload: null });
  broadcastEvent({ type: 'update', entity: 'order', id: orderId, changed: { deleted: true }, by: user?.email ?? null });
  const snapshot = await fetchCrmState();
  broadcastEvent({
    type: 'state-updated',
    entity: 'planner',
    mode: 'crm',
    id: 'crm',
    changed: { hash: simpleHash(snapshot.plannerState?.state || '') },
    state: snapshot.plannerState,
    board: snapshot.board,
    lanes: snapshot.lanes,
    by: user?.email ?? null
  });
};

const parseCsvText = (text) => {
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true
  });
  if (result.errors?.length) {
    const err = new Error(result.errors[0].message || 'CSV parse error');
    err.status = 422;
    throw err;
  }
  return result.data;
};

const exportCrmCsv = async () => {
  const { board } = await fetchCrmState();
  const rows = [];
  board.orders.forEach((order) => {
    if (!order.stages.length) {
      rows.push({
        order_no: order.orderNo,
        title: order.title,
        customer: order.customer,
        service_total: order.serviceTotal,
        lane: order.lane,
        is_done: order.isDone ? 'done' : 'new',
        stage_name: '',
        stage_start: '',
        stage_end: '',
        stage_percent: '',
        stage_ready: '',
        stage_hours: ''
      });
    } else {
      order.stages.forEach((stage) => {
        rows.push({
          order_no: order.orderNo,
          title: order.title,
          customer: order.customer,
          service_total: order.serviceTotal,
          lane: order.lane,
          is_done: order.isDone ? 'done' : 'new',
          stage_name: stage.stageName,
          stage_start: stage.dateStart || '',
          stage_end: stage.dateEnd || '',
          stage_percent: stage.percent,
          stage_ready: stage.isReady ? '1' : '0',
          stage_hours: stage.hours ?? ''
        });
      });
    }
  });
  return Papa.unparse(rows, { newline: '\n' });
};

const importCrmCsv = async (text, user) => {
  const rows = parseCsvText(text);
  const grouped = new Map();

  rows.forEach((row) => {
    const orderNo = row.order_no || row['№ заказа'] || row.orderNo;
    if (!orderNo) {
      return;
    }
    if (!grouped.has(orderNo)) {
      grouped.set(orderNo, []);
    }
    grouped.get(orderNo).push(row);
  });

  const processed = [];

  for (const [orderNo, entries] of grouped.entries()) {
    const first = entries[0];
    const payload = {
      orderNo,
      title: first.title || first['Название заказа'] || orderNo,
      customer: first.customer || first['Клиент'] || '',
      serviceTotal: first.service_total || first['Сумма услуг'] || '',
      lane: first.lane || first['Состояние'] || 'Не запланированное',
      isDone: (first.is_done || '').toString().toLowerCase() === 'done',
      boardKey: 'default',
      notes: first.notes || ''
    };

    const stages = entries
      .map((entry) => {
        const name = entry.stage_name || entry['Передел'] || '';
        if (!name) return null;
        return {
          stageName: name,
          stageKey: stageKeyFromName(name),
          dateStart: entry.stage_start || '',
          dateEnd: entry.stage_end || '',
          percent: numberOrNull(entry.stage_percent) ?? (entry.stage_ready ? 100 : 0),
          isReady: boolFrom(entry.stage_ready),
          hours: numberOrNull(entry.stage_hours)
        };
      })
      .filter(Boolean);

    const orderId = await upsertOrder(payload, user);
    await syncStages(orderId, stages, user);
    processed.push({ orderNo, orderId, stages: stages.length });
  }

  broadcastEvent({ type: 'bulk', entity: 'order', id: null, changed: { imported: processed.length }, by: user?.email ?? null });

  const snapshot = await fetchCrmState();
  broadcastEvent({
    type: 'state-updated',
    entity: 'planner',
    mode: 'crm',
    id: 'crm',
    changed: { hash: simpleHash(snapshot.plannerState?.state || '') },
    state: snapshot.plannerState,
    board: snapshot.board,
    lanes: snapshot.lanes,
    by: user?.email ?? null
  });

  return processed;
};

const extractStateFromBody = (body) => {
  if (!body) return { state: null, meta: null };
  if (typeof body === 'string') {
    return { state: body, meta: null };
  }
  if (typeof body === 'object') {
    if (typeof body.state === 'string') {
      return { state: body.state, meta: body.meta ?? null };
    }
    if (body.state && typeof body.state === 'object') {
      try {
        return { state: JSON.stringify(body.state), meta: body.meta ?? null };
      } catch (err) {
        console.error('state stringify failed', err);
        return { state: null, meta: null };
      }
    }
    try {
      return { state: JSON.stringify(body), meta: null };
    } catch (err) {
      return { state: null, meta: null };
    }
  }
  return { state: null, meta: null };
};

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(422).json({ error: 'Email and password are required' });
    return;
  }

  const user = await getUserByEmail(email);
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  if (user.status !== 'active') {
    res.status(403).json({ error: 'Account disabled' });
    return;
  }

  const token = signToken(user);
  res.cookie(COOKIE_NAME, token, cookieOptions);
  res.json({ user: user.display_name, role: user.role, token, expires_in: JWT_TTL_SECONDS });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: 0 });
  res.json({ ok: true });
});

app.get('/api/events', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const client = { res, user: req.user };
  sseClients.add(client);

  req.on('close', () => {
    sseClients.delete(client);
  });

  try {
    const planner = await normalizePlannerState();
    res.write(`data: ${JSON.stringify({
      type: 'state-snapshot',
      entity: 'planner',
      mode: 'csv',
      version: globalEventVersion,
      state: planner.state,
      meta: planner.meta,
      updatedAt: planner.updatedAt
    })}\n\n`);
  } catch (err) {
    console.error('Failed to stream planner snapshot', err);
  }

  try {
    const crm = await fetchCrmState();
    res.write(`data: ${JSON.stringify({
      type: 'state-snapshot',
      entity: 'planner',
      mode: 'crm',
      version: globalEventVersion,
      state: crm.plannerState,
      board: crm.board,
      lanes: crm.lanes
    })}\n\n`);
  } catch (err) {
    console.error('Failed to stream CRM snapshot', err);
  }
});

app.get('/api/state', requireAuth, async (_req, res) => {
  const current = cachedPlannerState || await normalizePlannerState();
  res.type('application/json').send(current.state);
});

app.put('/api/state', requireRole('admin', 'worker'), async (req, res) => {
  const { state, meta } = extractStateFromBody(req.body);
  if (!state) {
    res.status(400).send('Invalid state payload');
    return;
  }

  const current = cachedPlannerState || await normalizePlannerState();
  let currentStateObj = {};
  try {
    currentStateObj = JSON.parse(current.state || '{}');
  } catch (err) {
    currentStateObj = {};
  }

  let nextStateObj = {};
  try {
    nextStateObj = JSON.parse(state);
  } catch (err) {
    res.status(400).send('State must be valid JSON');
    return;
  }

  const stage = meta?.stage ?? null;
  const incomingVersion = meta?.version ?? (nextStateObj?.meta?.versions?.[stage] ?? null);
  const currentVersion = stage != null ? currentStateObj?.meta?.versions?.[stage] ?? null : null;

  if (incomingVersion != null && currentVersion != null && incomingVersion <= currentVersion) {
    const lastAuthor = currentStateObj?.meta?.lastAuthors?.[stage] ?? null;
    res.status(409).json({
      error: 'Conflict',
      stage,
      currentVersion,
      incomingVersion,
      lastAuthor,
      updatedAt: current.updatedAt
    });
    return;
  }

  const updatedAt = new Date().toISOString();
  const hash = simpleHash(state);
  const nextMeta = meta || null;
  const stateId = current.id;

  if (!stateId) {
    res.status(500).send('State store not initialized');
    return;
  }

  const updateResult = await pool.query(
    'UPDATE planner_state SET state = $1, meta = $2, hash = $3, updated_at = $4 WHERE id = $5 AND hash = $6',
    [state, nextMeta, hash, updatedAt, stateId, current.hash]
  );

  if (updateResult.rowCount === 0) {
    cachedPlannerState = null;
    const latest = await normalizePlannerState();
    let latestStateObj = {};
    try {
      latestStateObj = JSON.parse(latest.state || '{}');
    } catch (err) {
      latestStateObj = {};
    }
    const latestLastAuthor = stage != null ? latestStateObj?.meta?.lastAuthors?.[stage] ?? null : null;
    const latestVersion = stage != null ? latestStateObj?.meta?.versions?.[stage] ?? null : null;
    res.status(409).json({
      error: 'Conflict',
      stage,
      currentVersion: latestVersion ?? currentVersion,
      incomingVersion,
      lastAuthor: latestLastAuthor,
      updatedAt: latest.updatedAt
    });
    return;
  }

  cachedPlannerState = {
    id: stateId,
    state,
    meta: nextMeta,
    updatedAt,
    hash
  };

  const logEntry = {
    timestamp: updatedAt,
    stage,
    version: incomingVersion ?? null,
    user: meta?.user ?? req.user?.email ?? null,
    session: meta?.session ?? null,
    source: meta?.source ?? null,
    summary: meta?.summary ?? null,
    ip: req.ip
  };
  if (meta?.diff) {
    logEntry.diff = meta.diff;
  }
  if (meta?.ordersSummary) {
    logEntry.ordersSummary = meta.ordersSummary;
  }
  await appendPlannerLog(logEntry);

  broadcastEvent({
    type: meta?.autoOptimize ? 'reorder' : 'state-updated',
    entity: 'planner',
    id: 'csv',
    changed: { hash, stage, meta: nextMeta },
    by: req.user?.email ?? null
  });

  res.json({ ok: true, hash, updatedAt });
});

app.get('/api/crm/state', requireAuth, async (_req, res) => {
  const payload = await fetchCrmState();
  res.json(payload);
});

app.get('/api/crm/planner_state', requireAuth, async (_req, res) => {
  const { plannerState } = await fetchCrmState();
  res.json(plannerState);
});

app.post('/api/crm/planner_state', requireRole('admin', 'worker'), async (_req, res) => {
  res.json({ ok: true, readonly: true });
});

app.put('/api/crm/orders', requireRole('admin', 'worker'), async (req, res) => {
  const { order, stages, delete: shouldDelete, trimMissingStages } = req.body || {};
  if (!order) {
    res.status(422).json({ error: 'Order payload required' });
    return;
  }

  try {
    if (shouldDelete && order.id) {
      await softDeleteOrder(order.id, req.user);
      res.json({ ok: true, deleted: order.id });
      return;
    }

    const orderId = await upsertOrder(order, req.user);
    if (Array.isArray(stages ?? order.stages)) {
      const stagePayload = stages ?? order.stages;
      await syncStages(orderId, stagePayload, req.user, { trimMissing: trimMissingStages !== false });
    }
    const updated = await fetchCrmState();
    broadcastEvent({
      type: 'state-updated',
      entity: 'planner',
      mode: 'crm',
      id: 'crm',
      changed: { hash: simpleHash(updated.plannerState?.state || '') },
      state: updated.plannerState,
      board: updated.board,
      lanes: updated.lanes,
      by: req.user?.email ?? null
    });
    res.json({ ok: true, orderId, state: updated });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
    } else {
      console.error('Order upsert failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

app.put('/api/crm/stages', requireRole('admin', 'worker'), async (req, res) => {
  const { orderId, stages, trimMissingStages } = req.body || {};
  if (!orderId) {
    res.status(422).json({ error: 'orderId is required' });
    return;
  }
  try {
    await syncStages(orderId, stages, req.user, { trimMissing: trimMissingStages !== false });
    const updated = await fetchCrmState();
    broadcastEvent({
      type: 'state-updated',
      entity: 'planner',
      mode: 'crm',
      id: 'crm',
      changed: { hash: simpleHash(updated.plannerState?.state || '') },
      state: updated.plannerState,
      board: updated.board,
      lanes: updated.lanes,
      by: req.user?.email ?? null
    });
    res.json({ ok: true, state: updated });
  } catch (err) {
    console.error('Stage update failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/crm/import_csv', requireRole('admin'), async (req, res) => {
  const text = typeof req.body === 'string' ? req.body : req.body?.csv || '';
  if (!text) {
    res.status(400).json({ error: 'CSV body required' });
    return;
  }
  try {
    const processed = await importCrmCsv(text, req.user);
    res.json({ ok: true, processed });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.message });
    } else {
      console.error('CSV import failed', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
});

app.get('/api/crm/export_csv', requireAuth, async (req, res) => {
  try {
    const csv = await exportCrmCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="crm_export.csv"');
    res.send(csv);
  } catch (err) {
    console.error('CSV export failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get(['/crm', '/crm/', '/crm.html', '/CRM.html'], (req, res) => {
  if (!req.user) {
    res.redirect(302, '/login.html');
    return;
  }
  res.sendFile(path.join(__dirname, 'CRM.html'));
});

app.get(['/planner', '/planner/'], (req, res) => {
  if (!req.user) {
    res.redirect(302, '/login.html');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Internal Server Error');
});

let serverInstance = null;
let shuttingDown = false;

const shutdown = async (signal = 'SIGTERM') => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  if (serverInstance) {
    serverInstance.close();
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('Error while closing PostgreSQL pool', err);
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const bootstrap = async () => {
  await ensurePlannerTables();
  await ensureCrmSchema();
  await ensureDefaultAdmin();
  await normalizePlannerState();
};

bootstrap().then(() => {
  serverInstance = app.listen(PORT, () => {
    console.log(`Planner server running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to bootstrap server', err);
  process.exit(1);
});

