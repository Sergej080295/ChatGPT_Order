'use strict';

const path = require('path');
const fsp = require('fs/promises');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
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

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-me';
const JWT_COOKIE = 'auth_token';
const JWT_TTL_SECONDS = Number.parseInt(process.env.JWT_TTL || '86400', 10);

const DEFAULT_BOARD_KEY = 'default';
const DEFAULT_SYNC_SPEED = 'standard';
const SYNC_SPEEDS = new Set(['fast', 'standard', 'calm']);
const DATA_SOURCES = new Set(['csv', 'crm']);

const ROLES = {
  ADMIN: 'admin',
  WORKER: 'worker',
  VIEWER: 'viewer'
};

const STANDARD_STAGES = [
  { stage_key: 'laser', stage_name: 'Лазер' },
  { stage_key: 'bending', stage_name: 'Гибка' },
  { stage_key: 'welding', stage_name: 'Сварка' },
  { stage_key: 'machining', stage_name: 'Мехобработка' },
  { stage_key: 'prep', stage_name: 'Подготовка в работу' }
];

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

const LEGACY_IMPORT_ENABLED = process.env.PLANNER_SKIP_LEGACY_IMPORT !== 'true';
const DEFAULT_ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'Admin123!';

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'text/csv', 'text/*'] }));
app.use(cookieParser());

const sseClients = new Set();
let plannerStateCache = null;

const simpleHash = (str) => {
  if (!str) return '';
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
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
    // ignore
  }
  return null;
};

async function ensurePlannerSchema(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_state (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      state TEXT NOT NULL,
      meta JSONB,
      hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
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

  await client.query('CREATE INDEX IF NOT EXISTS planner_activity_log_timestamp_idx ON planner_activity_log (timestamp)');
  await client.query('CREATE INDEX IF NOT EXISTS planner_activity_log_stage_idx ON planner_activity_log (stage)');
  await client.query('ALTER TABLE planner_activity_log ADD COLUMN IF NOT EXISTS orders_summary JSONB');
}

async function ensureCrmSchema(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_orders (
      id BIGSERIAL PRIMARY KEY,
      order_no TEXT NOT NULL,
      title TEXT NOT NULL,
      customer TEXT,
      service_total NUMERIC,
      lane TEXT NOT NULL,
      is_done BOOLEAN NOT NULL DEFAULT false,
      parent_order_id BIGINT NULL,
      board_key TEXT NOT NULL DEFAULT '${DEFAULT_BOARD_KEY}',
      sort_index INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      deleted_at TIMESTAMPTZ NULL,
      version BIGINT NOT NULL DEFAULT 0,
      CONSTRAINT crm_orders_board_ck CHECK (board_key = '${DEFAULT_BOARD_KEY}')
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS crm_stages (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES crm_orders(id) ON DELETE RESTRICT,
      stage_key TEXT NOT NULL,
      stage_name TEXT NOT NULL,
      hours NUMERIC,
      date_start DATE,
      date_end DATE,
      percent NUMERIC,
      is_ready BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT,
      version BIGINT NOT NULL DEFAULT 0
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','worker','viewer')),
      status TEXT NOT NULL DEFAULT 'active',
      settings JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id BIGINT,
      action TEXT NOT NULL,
      by_user TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload_json JSONB
    )
  `);

  await client.query('CREATE INDEX IF NOT EXISTS idx_orders_order_no ON crm_orders(order_no)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON crm_orders(updated_at)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_orders_board_lane ON crm_orders(board_key, lane, sort_index)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_stages_order_id ON crm_stages(order_id)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_stages_updated_at ON crm_stages(updated_at)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity, entity_id)');

  await client.query('CREATE SEQUENCE IF NOT EXISTS crm_version_seq AS BIGINT START WITH 1');

  await ensureDefaultAdmin(client);
}

async function ensureDefaultAdmin(client = pool) {
  const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM users');
  if (rows[0].count > 0) {
    return;
  }
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  await client.query(
    'INSERT INTO users (display_name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    ['Администратор', DEFAULT_ADMIN_EMAIL.toLowerCase(), passwordHash, ROLES.ADMIN]
  );
  console.log(`Created default admin user ${DEFAULT_ADMIN_EMAIL} / ${DEFAULT_ADMIN_PASSWORD}`);
}

async function normalizePlannerState() {
  if (plannerStateCache) {
    return plannerStateCache;
  }

  await ensurePlannerSchema();

  const { rows } = await pool.query('SELECT id, state, meta, hash, updated_at FROM planner_state ORDER BY id LIMIT 1');
  if (rows.length > 0) {
    const row = rows[0];
    plannerStateCache = {
      id: row.id,
      state: row.state,
      meta: row.meta ?? null,
      hash: row.hash,
      updatedAt: new Date(row.updated_at).toISOString()
    };
    return plannerStateCache;
  }

  const legacy = await loadLegacyStateFromDisk();
  const payload = legacy || createInitialState();
  const insert = await pool.query(
    'INSERT INTO planner_state (state, meta, hash, updated_at) VALUES ($1, $2, $3, $4) RETURNING id, state, meta, hash, updated_at',
    [payload.state, payload.meta, payload.hash, payload.updatedAt]
  );
  const row = insert.rows[0];
  plannerStateCache = {
    id: row.id,
    state: row.state,
    meta: row.meta ?? null,
    hash: row.hash,
    updatedAt: new Date(row.updated_at).toISOString()
  };
  return plannerStateCache;
}

async function appendPlannerLog(entry) {
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
}

async function getCrmState(boardKey = DEFAULT_BOARD_KEY) {
  const { rows: orderRows } = await pool.query(
    `SELECT id, order_no, title, customer, service_total, lane, is_done, parent_order_id, board_key, sort_index,
            created_at, updated_at, updated_by, deleted_at, version
       FROM crm_orders
      WHERE board_key = $1 AND deleted_at IS NULL
      ORDER BY lane, sort_index, created_at, id`,
    [boardKey]
  );

  const orderIds = orderRows.map((row) => row.id);
  let stageRows = [];
  if (orderIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_at, updated_by, version
         FROM crm_stages
        WHERE order_id = ANY($1::bigint[])
        ORDER BY date_start NULLS FIRST, id`,
      [orderIds]
    );
    stageRows = rows;
  }

  const stagesByOrder = new Map();
  stageRows.forEach((stage) => {
    if (!stagesByOrder.has(stage.order_id)) {
      stagesByOrder.set(stage.order_id, []);
    }
    stagesByOrder.get(stage.order_id).push(stage);
  });

  let maxTimestamp = 0;
  const lanes = new Set();

  const orders = orderRows.map((order) => {
    const stages = stagesByOrder.get(order.id) || [];
    const startDates = stages.map((s) => (s.date_start ? new Date(s.date_start).getTime() : Number.POSITIVE_INFINITY));
    const endDates = stages.map((s) => (s.date_end ? new Date(s.date_end).getTime() : Number.NEGATIVE_INFINITY));
    const minStart = startDates.length > 0 ? Math.min(...startDates) : null;
    const maxEnd = endDates.length > 0 ? Math.max(...endDates) : null;
    const progressValues = stages
      .map((s) => (typeof s.percent === 'number' ? s.percent : (s.percent ? Number.parseFloat(s.percent) : null)))
      .filter((v) => Number.isFinite(v));
    const avgPercent = progressValues.length > 0
      ? Math.round(progressValues.reduce((acc, val) => acc + val, 0) / progressValues.length)
      : null;

    const updatedAtTs = new Date(order.updated_at).getTime();
    if (updatedAtTs > maxTimestamp) {
      maxTimestamp = updatedAtTs;
    }

    lanes.add(order.lane);

    return {
      id: order.id,
      orderNo: order.order_no,
      title: order.title,
      customer: order.customer,
      serviceTotal: order.service_total != null ? Number(order.service_total) : null,
      lane: order.lane,
      isDone: order.is_done,
      parentOrderId: order.parent_order_id,
      boardKey: order.board_key,
      sortIndex: order.sort_index,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      updatedBy: order.updated_by,
      version: Number(order.version) || 0,
      startDate: minStart ? new Date(minStart).toISOString().slice(0, 10) : null,
      endDate: maxEnd ? new Date(maxEnd).toISOString().slice(0, 10) : null,
      percent: avgPercent,
      stages: stages.map((stage) => ({
        id: stage.id,
        orderId: stage.order_id,
        stageKey: stage.stage_key,
        stageName: stage.stage_name,
        hours: stage.hours != null ? Number(stage.hours) : null,
        dateStart: stage.date_start ? new Date(stage.date_start).toISOString().slice(0, 10) : null,
        dateEnd: stage.date_end ? new Date(stage.date_end).toISOString().slice(0, 10) : null,
        percent: stage.percent != null ? Number(stage.percent) : null,
        isReady: stage.is_ready,
        updatedAt: stage.updated_at,
        updatedBy: stage.updated_by,
        version: Number(stage.version) || 0
      }))
    };
  });

  const snapshotVersionRow = await pool.query('SELECT COALESCE(MAX(version), 0) AS version FROM crm_orders WHERE deleted_at IS NULL');
  const version = Number(snapshotVersionRow.rows[0]?.version || 0);

  return {
    version,
    updatedAt: maxTimestamp ? new Date(maxTimestamp).toISOString() : null,
    boardKey,
    lanes: Array.from(lanes),
    orders
  };
}

const plannerBroadcast = (payload) => {
  const data = JSON.stringify(payload);
  const line = `data: ${data}\n\n`;
  const stale = [];
  sseClients.forEach((client) => {
    try {
      client.res.write(line);
    } catch (err) {
      stale.push(client);
    }
  });
  stale.forEach((client) => sseClients.delete(client));
};

async function nextCrmVersion() {
  const { rows } = await pool.query("SELECT nextval('crm_version_seq') AS version");
  return Number(rows[0].version);
}

async function recordActivity({ entity, entityId, action, by, payload }, db = pool) {
  await db.query(
    'INSERT INTO activity_log (entity, entity_id, action, by_user, payload_json) VALUES ($1, $2, $3, $4, $5)',
    [entity, entityId ?? null, action, by ?? null, payload ? JSON.stringify(payload) : null]
  );
}

async function applyAutoOptimization(actorEmail = 'system', boardKey = DEFAULT_BOARD_KEY) {
  const { rows } = await pool.query(
    `SELECT o.id, o.lane, o.sort_index,
            MIN(s.date_start) AS min_start,
            MIN(o.created_at) AS created_at
       FROM crm_orders o
       LEFT JOIN crm_stages s ON s.order_id = o.id
      WHERE o.board_key = $1 AND o.deleted_at IS NULL
      GROUP BY o.id, o.lane, o.sort_index`,
    [boardKey]
  );

  const byLane = new Map();
  rows.forEach((row) => {
    if (!byLane.has(row.lane)) {
      byLane.set(row.lane, []);
    }
    byLane.get(row.lane).push(row);
  });

  const updates = [];
  const changedOrders = [];
  const laneOrder = [];

  const sortedLaneNames = Array.from(byLane.keys()).sort((a, b) => a.localeCompare(b, 'ru'));

  sortedLaneNames.forEach((lane) => {
    const laneOrders = byLane.get(lane);
    laneOrders.sort((a, b) => {
      const aDate = a.min_start ? new Date(a.min_start).getTime() : new Date(a.created_at).getTime();
      const bDate = b.min_start ? new Date(b.min_start).getTime() : new Date(b.created_at).getTime();
      if (aDate === bDate) {
        return a.id - b.id;
      }
      return aDate - bDate;
    });
    laneOrders.forEach((order, index) => {
      const newIndex = index;
      if (order.sort_index !== newIndex) {
        updates.push({ id: order.id, sort_index: newIndex });
        changedOrders.push(order.id);
      }
    });
    laneOrder.push({ lane, orderIds: laneOrders.map((o) => o.id) });
  });

  if (updates.length === 0) {
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const update of updates) {
      await client.query(
        'UPDATE crm_orders SET sort_index = $1, updated_at = NOW(), version = version + 1 WHERE id = $2',
        [update.sort_index, update.id]
      );
    }
    await recordActivity({
      entity: 'order',
      entityId: null,
      action: 'auto_optimize',
      by: actorEmail,
      payload: { boardKey, changedOrders }
    }, client);
    const version = await nextCrmVersion();
    await client.query('COMMIT');
    plannerBroadcast({
      type: 'reorder',
      entity: 'order',
      id: null,
      changed: { boardKey, laneOrder },
      by: actorEmail,
      timestamp: new Date().toISOString(),
      version
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function toCsvValue(value) {
  if (value == null) {
    return '';
  }
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows, headers) {
  const lines = [];
  lines.push(headers.map(toCsvValue).join(','));
  rows.forEach((row) => {
    lines.push(headers.map((key) => toCsvValue(row[key])).join(','));
  });
  return `${lines.join('\n')}\n`;
}

function normalizeSyncSpeed(value) {
  if (!value) return DEFAULT_SYNC_SPEED;
  const lower = String(value).toLowerCase();
  if (SYNC_SPEEDS.has(lower)) {
    return lower;
  }
  return DEFAULT_SYNC_SPEED;
}

function normalizeDataSource(value) {
  if (!value) return 'csv';
  const lower = String(value).toLowerCase();
  if (DATA_SOURCES.has(lower)) {
    return lower;
  }
  return 'csv';
}

async function loadUserById(id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT id, display_name, email, role, status, settings FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    role: user.role,
    status: user.status,
    settings: user.settings ?? {}
  };
}

function setJwtCookie(res, token) {
  const expires = new Date(Date.now() + JWT_TTL_SECONDS * 1000);
  res.cookie(JWT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: JWT_TTL_SECONDS * 1000,
    expires
  });
}

async function authenticate(email, password) {
  const { rows } = await pool.query('SELECT id, display_name, email, password_hash, role, status, settings FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  if (user.status !== 'active') {
    throw new Error('User inactive');
  }
  return user;
}

async function updateUserSettings(userId, settings) {
  const merged = settings || {};
  await pool.query('UPDATE users SET settings = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(merged), userId]);
}

function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

app.use(async (req, _res, next) => {
  const token = req.cookies[JWT_COOKIE] || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null);
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await loadUserById(decoded.id);
      if (user) {
        req.user = sanitizeUser(user);
      }
    } catch (err) {
      // ignore invalid token
    }
  }
  next();
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(422).json({ error: 'email_and_password_required' });
    return;
  }
  try {
    const user = await authenticate(String(email).toLowerCase(), password);
    if (!user) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_TTL_SECONDS });
    setJwtCookie(res, token);
    res.json({
      user: user.display_name,
      role: user.role,
      token,
      expires_in: JWT_TTL_SECONDS
    });
  } catch (err) {
    res.status(403).json({ error: 'user_inactive' });
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  res.clearCookie(JWT_COOKIE, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await loadUserById(req.user.id);
  res.json({ user: sanitizeUser(user) });
});

app.put('/api/me/preferences', requireAuth, async (req, res) => {
  const { dataSource, syncSpeed } = req.body || {};
  const user = await loadUserById(req.user.id);
  const currentSettings = user.settings || {};
  const updated = {
    ...currentSettings,
    dataSource: normalizeDataSource(dataSource ?? currentSettings.dataSource),
    syncSpeed: normalizeSyncSpeed(syncSpeed ?? currentSettings.syncSpeed)
  };
  await updateUserSettings(req.user.id, updated);
  res.json({ settings: updated });
});

function extractStateFromBody(body) {
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
}

app.get('/api/state', requireAuth, async (_req, res) => {
  const current = plannerStateCache || await normalizePlannerState();
  res.type('application/json').send(current.state);
});

app.put('/api/state', requireAuth, async (req, res) => {
  const { state, meta } = extractStateFromBody(req.body);
  if (!state) {
    res.status(400).send('Invalid state payload');
    return;
  }

  const current = plannerStateCache || await normalizePlannerState();
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
    plannerStateCache = null;
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

  plannerStateCache = {
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

  plannerBroadcast({
    type: 'state-updated',
    entity: 'planner',
    id: stateId,
    changed: { mode: 'csv', state, meta: nextMeta },
    by: req.user?.email ?? 'system',
    timestamp: updatedAt,
    version: Date.now()
  });

  res.json({ ok: true, hash, updatedAt });
});

function canWorkerEditOrder(changes) {
  const keys = Object.keys(changes);
  return keys.every((key) => ['is_done', 'lane'].includes(key));
}

function canWorkerEditStage(changes) {
  const keys = Object.keys(changes);
  return keys.every((key) => ['percent', 'is_ready'].includes(key));
}

app.get('/api/crm/state', requireAuth, async (_req, res) => {
  const snapshot = await getCrmState(DEFAULT_BOARD_KEY);
  res.json(snapshot);
});

app.put('/api/crm/orders', requireAuth, async (req, res) => {
  const payload = req.body || {};
  const id = payload.id ? Number(payload.id) : null;
  const orderNo = payload.orderNo || payload.order_no;
  const title = payload.title;
  const lane = payload.lane;
  const customer = payload.customer ?? null;
  const serviceTotal = payload.serviceTotal ?? payload.service_total ?? null;
  const isDone = payload.isDone ?? payload.is_done ?? null;
  const parentOrderId = payload.parentOrderId ?? payload.parent_order_id ?? null;
  const boardKey = payload.boardKey ?? payload.board_key ?? DEFAULT_BOARD_KEY;

  if (!orderNo || !title || !lane) {
    res.status(422).json({ error: 'missing_required_fields' });
    return;
  }

  if (boardKey !== DEFAULT_BOARD_KEY) {
    res.status(422).json({ error: 'board_not_supported' });
    return;
  }

  const actor = req.user?.email ?? 'system';
  const role = req.user?.role ?? ROLES.VIEWER;

  const client = await pool.connect();
  let affectedOrderId = id;
  try {
    await client.query('BEGIN');

    if (id) {
      const { rows } = await client.query('SELECT * FROM crm_orders WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'order_not_found' });
        await client.query('ROLLBACK');
        return;
      }
      const existing = rows[0];
      const changes = {};
      if (existing.order_no !== orderNo) changes.order_no = orderNo;
      if (existing.title !== title) changes.title = title;
      if (existing.lane !== lane) changes.lane = lane;
      if (existing.customer !== customer) changes.customer = customer;
      if ((existing.service_total ?? null) !== (serviceTotal != null ? Number(serviceTotal) : null)) changes.service_total = serviceTotal;
      if (isDone != null && existing.is_done !== Boolean(isDone)) changes.is_done = Boolean(isDone);
      if ((existing.parent_order_id ?? null) !== (parentOrderId ?? null)) changes.parent_order_id = parentOrderId;

      if (role === ROLES.WORKER && !canWorkerEditOrder(changes)) {
        res.status(403).json({ error: 'forbidden' });
        await client.query('ROLLBACK');
        return;
      }

      if (Object.keys(changes).length === 0) {
        await client.query('ROLLBACK');
        res.json({ order: existing });
        return;
      }

      const updateColumns = [];
      const values = [];
      let idx = 1;
      for (const [key, value] of Object.entries(changes)) {
        updateColumns.push(`${key} = $${idx}`);
        if (key === 'service_total' && value != null) {
          values.push(Number(value));
        } else if (key === 'is_done') {
          values.push(Boolean(value));
        } else {
          values.push(value);
        }
        idx += 1;
      }
      updateColumns.push(`updated_at = NOW()`);
      updateColumns.push(`updated_by = $${idx}`);
      values.push(actor);
      idx += 1;
      updateColumns.push(`version = version + 1`);
      values.push(id);

      const query = `UPDATE crm_orders SET ${updateColumns.join(', ')} WHERE id = $${idx}`;
      await client.query(query, [...values, id]);

      await recordActivity({
        entity: 'order',
        entityId: id,
        action: 'update',
        by: actor,
        payload: changes
      });
    } else {
      if (role !== ROLES.ADMIN) {
        res.status(403).json({ error: 'forbidden' });
        await client.query('ROLLBACK');
        return;
      }
      const { rows } = await client.query(
        `INSERT INTO crm_orders (order_no, title, customer, service_total, lane, is_done, parent_order_id, board_key, sort_index, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
         RETURNING id`,
        [orderNo, title, customer, serviceTotal != null ? Number(serviceTotal) : null, lane, Boolean(isDone), parentOrderId, boardKey, actor]
      );
      const newOrderId = rows[0].id;
      affectedOrderId = newOrderId;
      for (const stage of STANDARD_STAGES) {
        await client.query(
          `INSERT INTO crm_stages (order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_by)
           VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, false, $4)`,
          [newOrderId, stage.stage_key, stage.stage_name, actor]
        );
      }
      await recordActivity({
        entity: 'order',
        entityId: newOrderId,
        action: 'create',
        by: actor,
        payload: { order_no: orderNo, title, lane }
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to save order', err);
    res.status(500).json({ error: 'failed_to_save_order' });
    return;
  } finally {
    client.release();
  }

  const snapshot = await getCrmState(DEFAULT_BOARD_KEY);
  const version = await nextCrmVersion();
  plannerBroadcast({
    type: 'update',
    entity: 'order',
    id: affectedOrderId ?? null,
    changed: { boardKey, state: snapshot },
    by: actor,
    timestamp: new Date().toISOString(),
    version
  });

  try {
    await applyAutoOptimization(actor, boardKey);
  } catch (err) {
    console.error('Auto optimization failed', err);
  }

  res.json({ ok: true });
});

app.put('/api/crm/stages', requireAuth, async (req, res) => {
  const payload = req.body || {};
  const id = payload.id ? Number(payload.id) : null;
  const orderId = payload.orderId ?? payload.order_id;
  const stageKey = payload.stageKey ?? payload.stage_key;
  const stageName = payload.stageName ?? payload.stage_name;
  const hours = payload.hours != null ? Number(payload.hours) : null;
  const dateStart = payload.dateStart ?? payload.date_start ?? null;
  const dateEnd = payload.dateEnd ?? payload.date_end ?? null;
  const percent = payload.percent != null ? Number(payload.percent) : null;
  const isReady = payload.isReady ?? payload.is_ready;

  if (!orderId || (!id && (!stageKey || !stageName))) {
    res.status(422).json({ error: 'missing_required_fields' });
    return;
  }

  const actor = req.user?.email ?? 'system';
  const role = req.user?.role ?? ROLES.VIEWER;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (id) {
      const { rows } = await client.query('SELECT * FROM crm_stages WHERE id = $1', [id]);
      if (rows.length === 0) {
        res.status(404).json({ error: 'stage_not_found' });
        await client.query('ROLLBACK');
        return;
      }
      const existing = rows[0];
      const changes = {};
      if (stageKey && existing.stage_key !== stageKey) changes.stage_key = stageKey;
      if (stageName && existing.stage_name !== stageName) changes.stage_name = stageName;
      if (hours != null && Number(existing.hours ?? 0) !== hours) changes.hours = hours;
      if ((existing.date_start ?? null) !== (dateStart ?? null)) changes.date_start = dateStart;
      if ((existing.date_end ?? null) !== (dateEnd ?? null)) changes.date_end = dateEnd;
      if (percent != null && Number(existing.percent ?? 0) !== percent) changes.percent = percent;
      if (isReady != null && existing.is_ready !== Boolean(isReady)) changes.is_ready = Boolean(isReady);

      if (role === ROLES.WORKER && !canWorkerEditStage(changes)) {
        res.status(403).json({ error: 'forbidden' });
        await client.query('ROLLBACK');
        return;
      }

      if (Object.keys(changes).length === 0) {
        await client.query('ROLLBACK');
        res.json({ ok: true });
        return;
      }

      const columns = [];
      const values = [];
      let idx = 1;
      for (const [key, value] of Object.entries(changes)) {
        columns.push(`${key} = $${idx}`);
        values.push(value);
        idx += 1;
      }
      columns.push(`updated_at = NOW()`);
      columns.push(`updated_by = $${idx}`);
      values.push(actor);
      idx += 1;
      columns.push('version = version + 1');

      const query = `UPDATE crm_stages SET ${columns.join(', ')} WHERE id = $${idx}`;
      values.push(id);
      await client.query(query, [...values, id]);

      await recordActivity({
        entity: 'stage',
        entityId: id,
        action: 'update',
        by: actor,
        payload: changes
      });
    } else {
      if (role === ROLES.VIEWER) {
        res.status(403).json({ error: 'forbidden' });
        await client.query('ROLLBACK');
        return;
      }
      const { rows } = await client.query(
        `INSERT INTO crm_stages (order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [orderId, stageKey, stageName, hours, dateStart, dateEnd, percent, Boolean(isReady), actor]
      );
      await recordActivity({
        entity: 'stage',
        entityId: rows[0].id,
        action: 'create',
        by: actor,
        payload: { orderId, stageKey, stageName }
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to save stage', err);
    res.status(500).json({ error: 'failed_to_save_stage' });
    return;
  } finally {
    client.release();
  }

  const version = await nextCrmVersion();
  plannerBroadcast({
    type: 'update',
    entity: 'stage',
    id: id ?? null,
    changed: { boardKey: DEFAULT_BOARD_KEY, orderId },
    by: actor,
    timestamp: new Date().toISOString(),
    version
  });

  try {
    await applyAutoOptimization(actor, DEFAULT_BOARD_KEY);
  } catch (err) {
    console.error('Auto optimization after stage failed', err);
  }

  res.json({ ok: true });
});

app.post('/api/crm/import_csv', requireRole(ROLES.ADMIN), async (req, res) => {
  const body = req.body;
  let csvText = '';
  if (typeof body === 'string') {
    csvText = body;
  } else if (body && typeof body.csv === 'string') {
    csvText = body.csv;
  } else {
    res.status(422).json({ error: 'csv_required' });
    return;
  }

  let rows;
  try {
    rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    res.status(400).json({ error: 'invalid_csv', details: err.message });
    return;
  }

  const ordersByKey = new Map();
  rows.forEach((row) => {
    const key = row['№ заказа'] || row.order_no || row.orderNo;
    if (!key) {
      return;
    }
    if (!ordersByKey.has(key)) {
      ordersByKey.set(key, {
        order_no: key,
        title: row['Название заказа'] || row.title || 'Без названия',
        customer: row['Клиент'] || row.customer || null,
        service_total: row['Сумма услуг'] || row.service_total || null,
        lane: row['Состояние'] || row.lane || 'Новый',
        is_done: row['Статус'] ? row['Статус'].toLowerCase() === 'done' : row.is_done === 'true',
        stages: []
      });
    }
    const order = ordersByKey.get(key);
    const stageName = row['Название передела'] || row.stage_name;
    if (stageName) {
      order.stages.push({
        stage_name: stageName,
        stage_key: (row.stage_key || stageName).toLowerCase().replace(/\s+/g, '_'),
        hours: row['Руб/часов'] || row.hours || null,
        date_start: row['Начало'] || row.date_start || null,
        date_end: row['Конец'] || row.date_end || null,
        percent: row['% выполнения'] || row.percent || null,
        is_ready: (row['Готово'] || row.is_ready || '').toString().toLowerCase() === 'true'
      });
    }
  });

  const client = await pool.connect();
  const actor = req.user?.email ?? 'system';
  try {
    await client.query('BEGIN');
    await client.query('UPDATE crm_orders SET deleted_at = NOW() WHERE board_key = $1 AND deleted_at IS NULL', [DEFAULT_BOARD_KEY]);
    await client.query('DELETE FROM crm_stages WHERE order_id IN (SELECT id FROM crm_orders WHERE deleted_at IS NOT NULL)');

    for (const order of ordersByKey.values()) {
      const { rows: inserted } = await client.query(
        `INSERT INTO crm_orders (order_no, title, customer, service_total, lane, is_done, board_key, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          order.order_no,
          order.title,
          order.customer,
          order.service_total != null ? Number(order.service_total) : null,
          order.lane,
          Boolean(order.is_done),
          DEFAULT_BOARD_KEY,
          actor
        ]
      );
      const orderId = inserted[0].id;
      if (order.stages.length === 0) {
        for (const stage of STANDARD_STAGES) {
          await client.query(
            `INSERT INTO crm_stages (order_id, stage_key, stage_name, updated_by)
             VALUES ($1, $2, $3, $4)`,
            [orderId, stage.stage_key, stage.stage_name, actor]
          );
        }
      } else {
        for (const stage of order.stages) {
          await client.query(
            `INSERT INTO crm_stages (order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              orderId,
              stage.stage_key,
              stage.stage_name,
              stage.hours != null ? Number(stage.hours) : null,
              stage.date_start || null,
              stage.date_end || null,
              stage.percent != null ? Number(stage.percent) : null,
              Boolean(stage.is_ready),
              actor
            ]
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('CSV import failed', err);
    res.status(500).json({ error: 'csv_import_failed', details: err.message });
    return;
  } finally {
    client.release();
  }

  try {
    await applyAutoOptimization(actor, DEFAULT_BOARD_KEY);
  } catch (err) {
    console.error('Auto optimization after import failed', err);
  }

  const version = await nextCrmVersion();
  plannerBroadcast({
    type: 'bulk',
    entity: 'planner',
    id: null,
    changed: { mode: 'crm' },
    by: actor,
    timestamp: new Date().toISOString(),
    version
  });

  res.json({ ok: true, importedOrders: ordersByKey.size });
});

app.get('/api/crm/export_csv', requireAuth, async (req, res) => {
  const snapshot = await getCrmState(DEFAULT_BOARD_KEY);
  const rows = [];
  snapshot.orders.forEach((order) => {
    if (order.stages.length === 0) {
      rows.push({
        order_no: order.orderNo,
        title: order.title,
        customer: order.customer,
        service_total: order.serviceTotal,
        lane: order.lane,
        status: order.isDone ? 'done' : 'new'
      });
      return;
    }
    order.stages.forEach((stage) => {
      rows.push({
        order_no: order.orderNo,
        title: order.title,
        customer: order.customer,
        service_total: order.serviceTotal,
        lane: order.lane,
        status: order.isDone ? 'done' : 'new',
        stage_name: stage.stageName,
        stage_key: stage.stageKey,
        hours: stage.hours,
        date_start: stage.dateStart,
        date_end: stage.dateEnd,
        percent: stage.percent,
        is_ready: stage.isReady
      });
    });
  });

  const csv = buildCsv(rows, [
    'order_no',
    'title',
    'customer',
    'service_total',
    'lane',
    'status',
    'stage_name',
    'stage_key',
    'hours',
    'date_start',
    'date_end',
    'percent',
    'is_ready'
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="crm_export.csv"');
  res.send(csv);
});

app.get('/api/events', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const client = { res, userId: req.user.id, email: req.user.email };
  sseClients.add(client);

  res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);

  const plannerSnapshot = plannerStateCache || await normalizePlannerState();
  res.write(`data: ${JSON.stringify({
    type: 'state-updated',
    entity: 'planner',
    id: plannerSnapshot.id,
    changed: { mode: 'csv', state: plannerSnapshot.state, meta: plannerSnapshot.meta },
    by: 'system',
    timestamp: plannerSnapshot.updatedAt,
    version: Date.now()
  })}\n\n`);

  const crmSnapshot = await getCrmState(DEFAULT_BOARD_KEY);
  res.write(`data: ${JSON.stringify({
    type: 'bulk',
    entity: 'planner',
    id: null,
    changed: { mode: 'crm', state: crmSnapshot },
    by: 'system',
    timestamp: new Date().toISOString(),
    version: crmSnapshot.version
  })}\n\n`);

  req.on('close', () => {
    sseClients.delete(client);
  });
});

setInterval(() => {
  const heartbeat = `data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`;
  const stale = [];
  sseClients.forEach((client) => {
    try {
      client.res.write(heartbeat);
    } catch (err) {
      stale.push(client);
    }
  });
  stale.forEach((client) => sseClients.delete(client));
}, 15000);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

let serverInstance = null;
let shuttingDown = false;

async function bootstrap() {
  await ensurePlannerSchema();
  await ensureCrmSchema();
  await normalizePlannerState();
}

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

bootstrap().then(() => {
  serverInstance = app.listen(PORT, () => {
    console.log(`Planner server running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to bootstrap server', err);
  process.exit(1);
});
