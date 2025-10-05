'use strict';

const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
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

const wrapAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_COOKIE_NAME = 'planner_token';
const JWT_TTL_SECONDS = Number.parseInt(process.env.JWT_TTL || '86400', 10);
const DEFAULT_ADMIN_EMAIL = process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
const DEFAULT_ADMIN_NAME = process.env.DEFAULT_ADMIN_NAME || 'Admin';

const LEGACY_IMPORT_ENABLED = process.env.PLANNER_SKIP_LEGACY_IMPORT !== 'true';

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'text/*'] }));

app.use(wrapAsync(async (req, _res, next) => {
  const cookieToken = req.cookies?.[JWT_COOKIE_NAME];
  let bearerToken = null;
  const authHeader = req.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice('Bearer '.length).trim();
  }
  const token = cookieToken || bearerToken;
  if (!token) {
    req.user = null;
    next();
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userRow = await getUserById(payload?.sub);
    req.user = serializeUser(userRow);
  } catch (err) {
    req.user = null;
  }
  next();
}));

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

const respondAuthPayload = (res, userRow) => {
  const user = serializeUser(userRow);
  const token = signToken(user);
  attachAuthCookie(res, token);
  res.json({
    user: user.name,
    email: user.email,
    role: user.role,
    token,
    expires_in: JWT_TTL_SECONDS,
  });
};

const sseClients = new Set();

const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

const ORDER_FIELD_CONFIG = {
  orderNumber: { column: 'order_number', roles: ['admin'] },
  customer: { column: 'customer', roles: ['admin'] },
  amount: { column: 'amount', roles: ['admin'] },
  state: { column: 'state', roles: ['admin'] },
  ready: { column: 'ready', roles: ['admin', 'worker'] },
  progress: { column: 'progress', roles: ['admin', 'worker'] },
  parentOrderId: { column: 'parent_order_id', roles: ['admin'] },
  boardKey: { column: 'board_key', roles: ['admin'] },
  meta: { column: 'meta', roles: ['admin'] },
};

const STAGE_FIELD_CONFIG = {
  name: { column: 'name', roles: ['admin'] },
  ready: { column: 'ready', roles: ['admin', 'worker'] },
  progress: { column: 'progress', roles: ['admin', 'worker'] },
  plannedStart: { column: 'planned_start', roles: ['admin'] },
  plannedEnd: { column: 'planned_end', roles: ['admin'] },
  position: { column: 'position', roles: ['admin'] },
  meta: { column: 'meta', roles: ['admin'] },
};

const isFieldAllowed = (config, key, role) => {
  const descriptor = config[key];
  if (!descriptor) return false;
  return descriptor.roles.includes(role);
};

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'да'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'нет'].includes(normalized)) return false;
  }
  return Boolean(value);
};

const normalizeProgress = (value) => {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(100, Math.max(0, Math.round(num)));
};

const normalizeAmount = (value) => {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
};

const normalizeMeta = (value) => {
  if (value == null) return null;
  if (typeof value === 'object') {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  return null;
};

const normalizeDateTime = (value) => {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
};

const nowIso = () => new Date().toISOString();

const serializeUser = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
  };
};

const signToken = (user) => jwt.sign({
  sub: user.id,
  role: user.role,
  name: user.name,
  email: user.email,
}, JWT_SECRET, { expiresIn: JWT_TTL_SECONDS });

const attachAuthCookie = (res, token) => {
  res.cookie(JWT_COOKIE_NAME, token, {
    ...AUTH_COOKIE_OPTIONS,
    maxAge: JWT_TTL_SECONDS * 1000,
  });
};

const clearAuthCookie = (res) => {
  res.clearCookie(JWT_COOKIE_NAME, AUTH_COOKIE_OPTIONS);
};

const mapOrderRow = (row) => ({
  id: row.id,
  orderNumber: row.order_number,
  customer: row.customer,
  amount: row.amount != null ? Number(row.amount) : null,
  state: row.state,
  ready: row.ready,
  progress: row.progress,
  parentOrderId: row.parent_order_id,
  boardKey: row.board_key,
  meta: row.meta ?? null,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
});

const mapStageRow = (row) => ({
  id: row.id,
  orderId: row.order_id,
  name: row.name,
  ready: row.ready,
  progress: row.progress,
  plannedStart: row.planned_start ? new Date(row.planned_start).toISOString() : null,
  plannedEnd: row.planned_end ? new Date(row.planned_end).toISOString() : null,
  position: row.position,
  meta: row.meta ?? null,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
});

const fetchCrmState = async (boardKey = 'default') => {
  const { rows: orderRows } = await pool.query(
    `SELECT id, order_number, customer, amount, state, ready, progress, parent_order_id, board_key, meta, updated_by, updated_at, created_at
     FROM crm_orders
     WHERE board_key = $1
     ORDER BY created_at ASC, id ASC`,
    [boardKey]
  );

  const orderIds = orderRows.map((row) => row.id);
  let stageRows = [];
  if (orderIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT id, order_id, name, ready, progress, planned_start, planned_end, position, meta, updated_by, updated_at, created_at
       FROM crm_stages
       WHERE order_id = ANY($1::bigint[])
       ORDER BY order_id ASC, position ASC, id ASC`,
      [orderIds]
    );
    stageRows = rows;
  }

  const stageMap = new Map();
  stageRows.forEach((row) => {
    const list = stageMap.get(row.order_id) || [];
    list.push(mapStageRow(row));
    stageMap.set(row.order_id, list);
  });

  const orders = orderRows.map((row) => ({
    ...mapOrderRow(row),
    stages: stageMap.get(row.id) || [],
  }));

  return { boardKey, orders };
};

const simpleHash = (str) => {
  if (!str) return '';
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
};

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

let cachedState = null;

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

const ensureDatabase = async () => {
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
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'planner_state' AND column_name = 'data'
      ) THEN
        BEGIN
          EXECUTE 'ALTER TABLE planner_state RENAME COLUMN data TO state';
        EXCEPTION WHEN duplicate_column THEN
          NULL;
        END;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'planner_state' AND column_name = 'state_json'
      ) THEN
        BEGIN
          EXECUTE 'ALTER TABLE planner_state RENAME COLUMN state_json TO state';
        EXCEPTION WHEN duplicate_column THEN
          NULL;
        END;
      END IF;
    END$$;
  `);
  await pool.query('ALTER TABLE planner_state ADD COLUMN IF NOT EXISTS state TEXT');
  await pool.query('ALTER TABLE planner_state ADD COLUMN IF NOT EXISTS meta JSONB');
  await pool.query('ALTER TABLE planner_state ADD COLUMN IF NOT EXISTS hash TEXT');
  await pool.query('ALTER TABLE planner_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
  const fallbackState = createInitialState();
  await pool.query('UPDATE planner_state SET state = $1 WHERE state IS NULL', [fallbackState.state]);
  await pool.query('UPDATE planner_state SET meta = COALESCE(meta, $1::jsonb)', [JSON.stringify(fallbackState.meta)]);
  await pool.query('UPDATE planner_state SET updated_at = COALESCE(updated_at, NOW())');
  const { rows: plannerRows } = await pool.query("SELECT id, state, hash FROM planner_state WHERE hash IS NULL OR hash = ''");
  for (const row of plannerRows) {
    const computedHash = simpleHash(row.state || '');
    await pool.query('UPDATE planner_state SET hash = $1 WHERE id = $2', [computedHash, row.id]);
  }
  await pool.query("ALTER TABLE planner_state ALTER COLUMN state SET NOT NULL");
  await pool.query("ALTER TABLE planner_state ALTER COLUMN hash SET NOT NULL");
  await pool.query("ALTER TABLE planner_state ALTER COLUMN updated_at SET NOT NULL");

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'worker', 'viewer')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_orders (
      id BIGSERIAL PRIMARY KEY,
      order_number TEXT NOT NULL,
      customer TEXT,
      amount NUMERIC(12,2),
      state TEXT NOT NULL DEFAULT 'new',
      ready BOOLEAN NOT NULL DEFAULT FALSE,
      progress INTEGER NOT NULL DEFAULT 0,
      parent_order_id BIGINT REFERENCES crm_orders(id) ON DELETE SET NULL,
      board_key TEXT NOT NULL DEFAULT 'default',
      meta JSONB,
      updated_by BIGINT REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS crm_orders_board_idx ON crm_orders (board_key)');
  await pool.query('CREATE INDEX IF NOT EXISTS crm_orders_state_idx ON crm_orders (state)');
  await pool.query('CREATE INDEX IF NOT EXISTS crm_orders_parent_idx ON crm_orders (parent_order_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_stages (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES crm_orders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      ready BOOLEAN NOT NULL DEFAULT FALSE,
      progress INTEGER NOT NULL DEFAULT 0,
      planned_start TIMESTAMPTZ,
      planned_end TIMESTAMPTZ,
      position INTEGER NOT NULL DEFAULT 0,
      meta JSONB,
      updated_by BIGINT REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS crm_stages_order_idx ON crm_stages (order_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS crm_stages_position_idx ON crm_stages (order_id, position)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id BIGSERIAL PRIMARY KEY,
      entity TEXT NOT NULL,
      entity_id BIGINT,
      action TEXT NOT NULL,
      payload JSONB,
      user_id BIGINT REFERENCES users(id),
      user_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const ensureDefaultAdmin = async () => {
  const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
  if (rows.length > 0) {
    return;
  }
  const email = DEFAULT_ADMIN_EMAIL.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
    [email, passwordHash, DEFAULT_ADMIN_NAME, 'admin']
  );
  console.log(`Seeded default admin user ${email}`);
};

const getUserByEmail = async (email) => {
  if (!email) return null;
  const { rows } = await pool.query('SELECT id, email, password_hash, name, role FROM users WHERE email = $1 LIMIT 1', [email]);
  return rows[0] ?? null;
};

const getUserById = async (id) => {
  if (!id) return null;
  const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ?? null;
};

const readStateFromDatabase = async () => {
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

const insertInitialState = async (client) => {
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

const normalizeStoredState = async () => {
  if (cachedState) {
    return cachedState;
  }

  await ensureDatabase();
  await ensureDefaultAdmin();

  const existing = await readStateFromDatabase();
  if (existing) {
    cachedState = existing;
    return cachedState;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, state, meta, hash, updated_at FROM planner_state ORDER BY id LIMIT 1 FOR UPDATE');
    let row;
    if (rows.length === 0) {
      row = await insertInitialState(client);
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
    cachedState = row;
    return cachedState;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const appendLog = async (entry) => {
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

const appendCrmActivity = async (entry, client = pool) => {
  await client.query(
    `INSERT INTO activity_log (entity, entity_id, action, payload, user_id, user_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.entity,
      entry.entityId ?? null,
      entry.action,
      entry.payload ?? null,
      entry.userId ?? null,
      entry.userName ?? null,
    ]
  );
};

const broadcast = (payload) => {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => {
    res.write(data);
  });
};

const broadcastPlannerState = (state, meta, updatedAt) => {
  broadcast({ type: 'planner-state', state, meta, updatedAt });
};

const broadcastCrmEvent = (event) => {
  broadcast({ type: 'crm-update', event });
};

app.post('/api/auth/login', wrapAsync(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const userRow = await getUserByEmail(normalizedEmail);
  if (!userRow) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const ok = await bcrypt.compare(String(password), userRow.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  respondAuthPayload(res, userRow);
}));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: req.user.name,
    email: req.user.email,
    role: req.user.role,
  });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/events', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });

  const current = cachedState || await normalizeStoredState();
  res.write(`data: ${JSON.stringify({ type: 'planner-state', state: current.state, meta: current.meta, updatedAt: current.updatedAt })}\n\n`);
});

app.get('/api/state', async (_req, res) => {
  const current = cachedState || await normalizeStoredState();
  res.type('application/json').send(current.state);
});

app.get('/api/crm/state', requireAuth, wrapAsync(async (req, res) => {
  const boardKey = typeof req.query.board === 'string' && req.query.board.trim() ? req.query.board.trim() : 'default';
  const snapshot = await fetchCrmState(boardKey);
  res.json(snapshot);
}));

app.put('/api/crm/orders', requireRole('worker', 'admin'), wrapAsync(async (req, res) => {
  const raw = Array.isArray(req.body?.orders)
    ? req.body.orders
    : Array.isArray(req.body)
      ? req.body
      : req.body
        ? [req.body]
        : [];

  const updates = raw
    .map((item) => (typeof item === 'object' && item !== null ? item : null))
    .filter(Boolean);

  if (updates.length === 0) {
    res.status(400).json({ error: 'No order updates provided' });
    return;
  }

  const client = await pool.connect();
  const updatedOrders = [];
  const pendingEvents = [];
  try {
    await client.query('BEGIN');
    for (const patch of updates) {
      const id = Number(patch.id ?? patch.orderId ?? patch.order_id);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }

      const setClauses = [];
      const values = [];
      const changed = {};

      for (const [key, descriptor] of Object.entries(ORDER_FIELD_CONFIG)) {
        if (!isFieldAllowed(ORDER_FIELD_CONFIG, key, req.user.role)) continue;
        if (!(key in patch)) continue;

        let value = patch[key];
        switch (key) {
          case 'ready':
            value = normalizeBoolean(value);
            break;
          case 'progress': {
            const normalized = normalizeProgress(value);
            if (normalized == null) {
              continue;
            }
            value = normalized;
            break;
          }
          case 'amount': {
            const normalized = normalizeAmount(value);
            if (normalized == null && value !== null) {
              continue;
            }
            value = normalized;
            break;
          }
          case 'meta': {
            const normalized = normalizeMeta(value);
            if (normalized == null && value !== null) {
              continue;
            }
            value = normalized;
            break;
          }
          case 'parentOrderId':
            value = value == null || value === '' ? null : Number(value);
            if (value != null && !Number.isFinite(value)) {
              continue;
            }
            break;
          case 'orderNumber':
          case 'state':
          case 'boardKey':
            value = value == null ? null : String(value).trim();
            break;
          case 'customer':
            value = value == null ? null : String(value).trim();
            break;
          default:
            if (value == null) {
              value = null;
            }
            break;
        }

        const column = descriptor.column;
        values.push(value);
        setClauses.push(`${column} = $${values.length}`);
        changed[key] = value;
      }

      if (setClauses.length === 0) {
        continue;
      }

      setClauses.push(`updated_by = $${values.length + 1}`);
      values.push(req.user.id);
      setClauses.push('updated_at = NOW()');

      const { rows } = await client.query(
        `UPDATE crm_orders SET ${setClauses.join(', ')} WHERE id = $${values.length + 1}
         RETURNING id, order_number, customer, amount, state, ready, progress, parent_order_id, board_key, meta, updated_by, updated_at, created_at`,
        [...values, id]
      );

      if (rows.length === 0) {
        continue;
      }

      const order = mapOrderRow(rows[0]);
      updatedOrders.push(order);

      await appendCrmActivity({
        entity: 'order',
        entityId: order.id,
        action: 'update',
        payload: { changed },
        userId: req.user.id,
        userName: req.user.name,
      }, client);

      pendingEvents.push({
        entity: 'order',
        type: 'update',
        id: order.id,
        changed,
        data: order,
        by: req.user.email,
        timestamp: nowIso(),
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  pendingEvents.forEach((event) => broadcastCrmEvent(event));

  if (updatedOrders.length === 0) {
    res.status(404).json({ error: 'No matching orders updated' });
    return;
  }

  res.json({ updated: updatedOrders.length, orders: updatedOrders });
}));

app.put('/api/crm/stages', requireRole('worker', 'admin'), wrapAsync(async (req, res) => {
  const raw = Array.isArray(req.body?.stages)
    ? req.body.stages
    : Array.isArray(req.body)
      ? req.body
      : req.body
        ? [req.body]
        : [];

  const updates = raw
    .map((item) => (typeof item === 'object' && item !== null ? item : null))
    .filter(Boolean);

  if (updates.length === 0) {
    res.status(400).json({ error: 'No stage updates provided' });
    return;
  }

  const client = await pool.connect();
  const updatedStages = [];
  const pendingEvents = [];
  try {
    await client.query('BEGIN');
    for (const patch of updates) {
      const id = Number(patch.id ?? patch.stageId ?? patch.stage_id);
      if (!Number.isFinite(id) || id <= 0) {
        continue;
      }

      const setClauses = [];
      const values = [];
      const changed = {};

      for (const [key, descriptor] of Object.entries(STAGE_FIELD_CONFIG)) {
        if (!isFieldAllowed(STAGE_FIELD_CONFIG, key, req.user.role)) continue;
        if (!(key in patch)) continue;

        let value = patch[key];
        switch (key) {
          case 'ready':
            value = normalizeBoolean(value);
            break;
          case 'progress': {
            const normalized = normalizeProgress(value);
            if (normalized == null) {
              continue;
            }
            value = normalized;
            break;
          }
          case 'position': {
            const normalized = Number(value);
            if (!Number.isFinite(normalized)) {
              continue;
            }
            value = Math.max(0, Math.round(normalized));
            break;
          }
          case 'meta': {
            const normalized = normalizeMeta(value);
            if (normalized == null && value !== null) {
              continue;
            }
            value = normalized;
            break;
          }
          case 'plannedStart':
          case 'plannedEnd': {
            if (value == null || value === '') {
              value = null;
              break;
            }
            const normalized = normalizeDateTime(value);
            if (normalized == null) {
              continue;
            }
            value = normalized;
            break;
          }
          case 'name':
            value = value == null ? null : String(value).trim();
            break;
          default:
            if (value == null) {
              value = null;
            }
            break;
        }

        const column = descriptor.column;
        values.push(value);
        setClauses.push(`${column} = $${values.length}`);
        changed[key] = value;
      }

      if (setClauses.length === 0) {
        continue;
      }

      setClauses.push(`updated_by = $${values.length + 1}`);
      values.push(req.user.id);
      setClauses.push('updated_at = NOW()');

      const { rows } = await client.query(
        `UPDATE crm_stages SET ${setClauses.join(', ')} WHERE id = $${values.length + 1}
         RETURNING id, order_id, name, ready, progress, planned_start, planned_end, position, meta, updated_by, updated_at, created_at`,
        [...values, id]
      );

      if (rows.length === 0) {
        continue;
      }

      const stage = mapStageRow(rows[0]);
      updatedStages.push(stage);

      await appendCrmActivity({
        entity: 'stage',
        entityId: stage.id,
        action: 'update',
        payload: { changed },
        userId: req.user.id,
        userName: req.user.name,
      }, client);

      pendingEvents.push({
        entity: 'stage',
        type: 'update',
        id: stage.id,
        orderId: stage.orderId,
        changed,
        data: stage,
        by: req.user.email,
        timestamp: nowIso(),
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  pendingEvents.forEach((event) => broadcastCrmEvent(event));

  if (updatedStages.length === 0) {
    res.status(404).json({ error: 'No matching stages updated' });
    return;
  }

  res.json({ updated: updatedStages.length, stages: updatedStages });
}));

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

app.put('/api/state', async (req, res) => {
  const { state, meta } = extractStateFromBody(req.body);
  if (!state) {
    res.status(400).send('Invalid state payload');
    return;
  }

  const current = cachedState || await normalizeStoredState();
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
    cachedState = null;
    const latest = await normalizeStoredState();
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

  cachedState = {
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
    user: meta?.user ?? null,
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
  await appendLog(logEntry);

  broadcastPlannerState(state, meta || null, updatedAt);
  res.json({ ok: true, hash, updatedAt });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
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

normalizeStoredState().then(() => {
  serverInstance = app.listen(PORT, () => {
    console.log(`Planner server running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to bootstrap state', err);
  process.exit(1);
});
