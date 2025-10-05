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
  ['отгружено', 'ship'],
  ['рубка', 'shear'],
  ['shear', 'shear']
]);

const CRM_STAGE_LABELS = {
  draw: 'Подготовка в работу',
  proc: 'Закупка',
  shear: 'Рубка',
  laser: 'Лазер',
  bend: 'Гибка',
  weld: 'Сварка',
  mech: 'Мехобработка',
  pack: 'Упаковка',
  ship: 'Отгрузка',
  stage: 'Передел'
};

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';

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

const stageSortIndex = (stageKey) => {
  if (!stageKey) return Number.MAX_SAFE_INTEGER;
  const idx = PLANNER_STAGE_KEYS.indexOf(stageKey);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
};

const dedupeStageRows = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const byKey = new Map();

  rows.forEach((row) => {
    if (!row) return;
    const normalizedKey = normalizePlannerStage(row.stage_key || row.stageKey, row.stage_name || row.stageName);
    const normalizedName = safeString(row.stage_name) || CRM_STAGE_LABELS[normalizedKey] || 'Передел';
    const candidate = {
      ...row,
      stage_key: normalizedKey,
      stage_name: normalizedName
    };
    const candidateTs = row.updated_at ? new Date(row.updated_at).getTime() : 0;

    if (!byKey.has(normalizedKey)) {
      byKey.set(normalizedKey, { row: candidate, ts: candidateTs });
      return;
    }

    const existing = byKey.get(normalizedKey);
    const existingTs = existing.ts || 0;
    if (candidateTs > existingTs || (candidateTs === existingTs && (row.id || 0) > (existing.row.id || 0))) {
      byKey.set(normalizedKey, { row: candidate, ts: candidateTs });
    }
  });

  const normalized = Array.from(byKey.values()).map((entry) => entry.row);
  normalized.sort((a, b) => {
    const idxA = stageSortIndex(a.stage_key);
    const idxB = stageSortIndex(b.stage_key);
    if (idxA !== idxB) return idxA - idxB;
    return (a.id || 0) - (b.id || 0);
  });
  return normalized;
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

const safeString = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
};

const parseDateCandidate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const numericDate = new Date(value);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const iso = new Date(trimmed);
    if (!Number.isNaN(iso.getTime())) {
      return iso;
    }
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      const normalized = new Date(`${match[1]}T00:00:00Z`);
      if (!Number.isNaN(normalized.getTime())) {
        return normalized;
      }
    }
  }
  return null;
};

const toDateOnly = (date) => (date ? date.toISOString().slice(0, 10) : '');

const chooseLaneFromCounts = (counts) => {
  if (!counts || counts.size === 0) return '';
  let chosen = '';
  let bestCount = -1;
  counts.forEach((count, lane) => {
    if (count > bestCount) {
      chosen = lane;
      bestCount = count;
    }
  });
  return chosen;
};

const extractServerId = (task, identity) => {
  const candidates = [
    task?.serverId,
    task?.orderServerId,
    task?.order_id,
    identity,
    task?.parentId,
    task?.orderIdentity,
    task?.uid,
    task?.orderId
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
    const match = String(candidate).match(/srv-(\d+)/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
};

const collectPlannerTasks = (stateObj) => {
  if (!stateObj || typeof stateObj !== 'object') return [];
  const buckets = [];
  if (Array.isArray(stateObj.t)) buckets.push(...stateObj.t);
  if (Array.isArray(stateObj.done)) buckets.push(...stateObj.done);
  return buckets.filter((item) => item && typeof item === 'object');
};

const finalizeOrderAggregates = (ordersMap) => {
  const results = [];
  ordersMap.forEach((aggregate) => {
    const lane = chooseLaneFromCounts(aggregate.laneCounts);
    const stageEntries = [];

    aggregate.stageMap.forEach((stage) => {
      let hours = null;
      if (stage.hasHours) {
        const normalizedHours = Number(stage.hours);
        hours = Number.isFinite(normalizedHours) ? Number(normalizedHours.toFixed(2)) : null;
      }

      let startDate = '';
      if (stage.startDates.length) {
        const earliest = new Date(Math.min(...stage.startDates.map((d) => d.getTime())));
        startDate = toDateOnly(earliest);
      }

      let endDate = '';
      if (stage.endDates.length) {
        const latest = new Date(Math.max(...stage.endDates.map((d) => d.getTime())));
        endDate = toDateOnly(latest);
      }

      let percent = null;
      if (stage.percentValues.length) {
        const avg = stage.percentValues.reduce((sum, val) => sum + val, 0) / stage.percentValues.length;
        percent = Math.max(0, Math.min(100, Math.round(avg)));
      }

      const ready = stage.hasReady ? stage.readyFlags.some(Boolean) : null;

      if (stage.hasStart && startDate) {
        aggregate.startDates.push(parseDateCandidate(`${startDate}T00:00:00Z`));
      }
      if (stage.hasEnd && endDate) {
        aggregate.endDates.push(parseDateCandidate(`${endDate}T00:00:00Z`));
      }
      if (stage.percentValues.length) {
        aggregate.percentValues.push(percent ?? 0);
      }
      if (stage.hasReady) {
        aggregate.readyFlags.push(ready === true);
      }

      stageEntries.push({
        stageKey: stage.stageKey,
        stageName: CRM_STAGE_LABELS[stage.stageKey] || stage.stageKey,
        hours,
        hasHours: stage.hasHours,
        dateStart: startDate,
        hasStart: stage.hasStart && !!startDate,
        dateEnd: endDate,
        hasEnd: stage.hasEnd && !!endDate,
        percent: percent ?? 0,
        hasPercent: stage.percentValues.length > 0,
        isReady: ready === null ? false : ready,
        hasReady: stage.hasReady
      });
    });

    stageEntries.sort((a, b) => {
      const aIdx = PLANNER_STAGE_KEYS.indexOf(a.stageKey);
      const bIdx = PLANNER_STAGE_KEYS.indexOf(b.stageKey);
      if (aIdx === -1 && bIdx === -1) return a.stageKey.localeCompare(b.stageKey);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });

    let orderPercent = null;
    if (aggregate.percentValues.length) {
      const avg = aggregate.percentValues.reduce((sum, val) => sum + val, 0) / aggregate.percentValues.length;
      orderPercent = Math.max(0, Math.min(100, Math.round(avg)));
    }

    let orderStart = '';
    if (aggregate.startDates.length) {
      const earliest = new Date(Math.min(...aggregate.startDates.map((d) => d.getTime())));
      orderStart = toDateOnly(earliest);
    }

    let orderEnd = '';
    if (aggregate.endDates.length) {
      const latest = new Date(Math.max(...aggregate.endDates.map((d) => d.getTime())));
      orderEnd = toDateOnly(latest);
    }

    let orderIsDone = null;
    if (aggregate.readyFlags.length && aggregate.readyFlags.length === stageEntries.length) {
      orderIsDone = aggregate.readyFlags.every(Boolean);
    }
    const laneLower = lane.toLowerCase();
    if (laneLower && (laneLower.includes('отгруж') || laneLower.includes('готов'))) {
      orderIsDone = true;
    }

    results.push({
      identity: aggregate.identity,
      serverId: aggregate.serverId,
      orderNo: aggregate.orderNo,
      hasOrderNo: aggregate.hasOrderNo,
      title: aggregate.title,
      hasTitle: aggregate.hasTitle,
      customer: aggregate.customer,
      hasCustomer: aggregate.hasCustomer,
      lane,
      hasLane: aggregate.laneCounts.size > 0,
      stages: stageEntries,
      stageKeys: aggregate.stageKeys,
      start: orderStart,
      hasStart: !!orderStart,
      end: orderEnd,
      hasEnd: !!orderEnd,
      percent: orderPercent ?? 0,
      hasPercent: aggregate.percentValues.length > 0,
      isDone: orderIsDone ?? false,
      hasDone: orderIsDone !== null
    });
  });
  return results;
};

const deriveOrdersFromPlannerState = (stateObj) => {
  const tasks = collectPlannerTasks(stateObj);
  const ordersMap = new Map();

  tasks.forEach((task) => {
    const identityRaw = task.parentId ?? task.orderIdentity ?? task.orderId ?? task.orderNumber ?? task.uid;
    const identity = safeString(identityRaw);
    if (!identity) return;

    if (!ordersMap.has(identity)) {
      ordersMap.set(identity, {
        identity,
        serverId: null,
        orderNo: '',
        hasOrderNo: false,
        title: '',
        hasTitle: false,
        customer: '',
        hasCustomer: false,
        laneCounts: new Map(),
        stageMap: new Map(),
        stageKeys: new Set(),
        startDates: [],
        endDates: [],
        percentValues: [],
        readyFlags: []
      });
    }

    const aggregate = ordersMap.get(identity);
    if (!aggregate.serverId) {
      const serverId = extractServerId(task, identity);
      if (serverId) aggregate.serverId = serverId;
    }

    const orderNoCandidate = safeString(task.orderNumber);
    if (orderNoCandidate) {
      aggregate.orderNo = orderNoCandidate;
      aggregate.hasOrderNo = true;
    }

    const titleCandidate = safeString(task.orderId);
    if (titleCandidate) {
      aggregate.title = titleCandidate;
      aggregate.hasTitle = true;
    }

    const customerCandidate = safeString(task.orderCustomer);
    if (customerCandidate) {
      aggregate.customer = customerCandidate;
      aggregate.hasCustomer = true;
    }

    const laneCandidate = safeString(task.state);
    if (laneCandidate) {
      aggregate.laneCounts.set(laneCandidate, (aggregate.laneCounts.get(laneCandidate) || 0) + 1);
    }

    const stageKey = normalizePlannerStage(task.stage, task.stageName);
    aggregate.stageKeys.add(stageKey);

    let stage = aggregate.stageMap.get(stageKey);
    if (!stage) {
      stage = {
        stageKey,
        hours: 0,
        hasHours: false,
        startDates: [],
        hasStart: false,
        endDates: [],
        hasEnd: false,
        percentValues: [],
        readyFlags: [],
        hasPercent: false,
        hasReady: false
      };
      aggregate.stageMap.set(stageKey, stage);
    }

    const routeSeg = task?.route?.[stageKey];

    const routeHours = numberOrNull(routeSeg?.hours);
    let hoursAdded = false;
    if (routeHours !== null) {
      stage.hours += routeHours;
      stage.hasHours = true;
      hoursAdded = true;
    }

    const taskHours = numberOrNull(task.hours);
    if (taskHours !== null && !hoursAdded) {
      stage.hours += taskHours;
      stage.hasHours = true;
      hoursAdded = true;
    }

    const extraHours = numberOrNull(task.extraHours);
    if (extraHours !== null && !hoursAdded) {
      stage.hours += extraHours;
      stage.hasHours = true;
    }

    const startCandidates = [task.startDate, task.start, routeSeg?.start];
    startCandidates.forEach((candidate) => {
      const parsed = parseDateCandidate(candidate);
      if (parsed) {
        stage.startDates.push(parsed);
        stage.hasStart = true;
      }
    });

    const endCandidates = [task.endDate, task.end, routeSeg?.end];
    endCandidates.forEach((candidate) => {
      const parsed = parseDateCandidate(candidate);
      if (parsed) {
        stage.endDates.push(parsed);
        stage.hasEnd = true;
      }
    });

    const progress = numberOrNull(task.progress);
    if (progress !== null) {
      stage.percentValues.push(progress);
      stage.hasPercent = true;
    }

    const statusText = safeString(task.status).toLowerCase();
    if (task.isDone === true) {
      stage.readyFlags.push(true);
      stage.hasReady = true;
    }
    if (progress !== null && progress >= 100) {
      stage.readyFlags.push(true);
      stage.hasReady = true;
    }
    if (statusText && /готов|done|complete|заверш/i.test(statusText)) {
      stage.readyFlags.push(true);
      stage.hasReady = true;
    }
    if (routeSeg?.doneAt) {
      const done = parseDateCandidate(routeSeg.doneAt);
      if (done) {
        stage.readyFlags.push(true);
        stage.hasReady = true;
      }
    }
    if (task.doneMeta?.when) {
      const done = parseDateCandidate(task.doneMeta.when);
      if (done) {
        stage.readyFlags.push(true);
        stage.hasReady = true;
      }
    }
  });

  return finalizeOrderAggregates(ordersMap);
};

const toMillis = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
};

const safeDate = (value) => {
  const millis = toMillis(value);
  if (millis === null) return null;
  return new Date(millis).toISOString();
};

const computeBoardAnchorMillis = (board) => {
  let latest = 0;
  const consider = (candidate) => {
    const millis = toMillis(candidate);
    if (millis !== null && millis > latest) {
      latest = millis;
    }
  };

  (board?.orders || []).forEach((order) => {
    consider(order.updatedAt);
    consider(order.createdAt);
    consider(order.start);
    consider(order.end);
    (order.stages || []).forEach((stage) => {
      consider(stage.updatedAt);
      consider(stage.dateStart);
      consider(stage.dateEnd);
    });
  });

  return latest;
};

const computeBoardAnchorIso = (board) => {
  const millis = computeBoardAnchorMillis(board);
  if (!millis) {
    return ISO_EPOCH;
  }
  return new Date(millis).toISOString();
};

const buildPlannerStateFromCrm = (board) => {
  const anchorIso = computeBoardAnchorIso(board);
  const anchorMillis = toMillis(anchorIso) ?? 0;
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
            ...(stage.isReady ? { doneAt: stage.updatedAt ? safeDate(stage.updatedAt) : anchorIso } : {})
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
          ? { when: stage.updatedAt ? safeDate(stage.updatedAt) : anchorIso, source: 'crm' }
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
            ...(order.isDone ? { doneAt: order.updatedAt ? safeDate(order.updatedAt) : anchorIso } : {})
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
          ? { when: order.updatedAt ? safeDate(order.updatedAt) : anchorIso, source: 'crm' }
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
    freshness: anchorIso,
    freshnessCsv: anchorIso,
    freshnessManual: '',
    lastImportTime: anchorIso,
    lastManualTime: '',
    autosaveOn: true,
    autoOptimizeOn: true,
    shiftOnProgress: true,
    meta: {
      versions: {},
      lastAuthors: {},
      csvTimestamp: anchorIso,
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
      version: anchorMillis || 0,
      source: 'crm',
      generatedAt: anchorIso,
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
    const rawStages = stagesByOrder.get(row.id) || [];
    const normalizedStages = dedupeStageRows(rawStages);
    const aggregates = computeOrderAggregates(row, normalizedStages);
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
      stages: normalizedStages.map((stage) => ({
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

  const normalizedOrderNo = safeString(orderNo);
  const normalizedTitle = safeString(title);

  if (!normalizedOrderNo || !normalizedTitle) {
    const err = new Error('orderNo and title are required');
    err.status = 422;
    throw err;
  }

  const normalizedCustomer = safeString(customer);
  const customerValue = normalizedCustomer ? normalizedCustomer : null;
  const numericTotal = numberOrNull(serviceTotal);
  const board = safeString(boardKey) || 'default';
  const done = boolFrom(isDone);
  const laneValue = safeString(lane) || DEFAULT_CRM_LANES[0];
  const parentIdNormalized = parentOrderId == null ? null : Number(parentOrderId);
  const notesValueRaw = notes == null ? null : String(notes);
  const notesValue = notesValueRaw ? notesValueRaw.trim() : null;

  let result;
  let orderChanged = false;

  if (id) {
    const existingRes = await pool.query(
      `SELECT id, order_no, title, customer, service_total, lane, is_done, parent_order_id, board_key, notes
         FROM crm_orders
        WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (existingRes.rowCount === 0) {
      const notFound = new Error('Order not found');
      notFound.status = 404;
      throw notFound;
    }

    const existingRow = existingRes.rows[0];
    const existingOrderNo = safeString(existingRow.order_no);
    const existingTitle = safeString(existingRow.title);
    const existingServiceTotal = existingRow.service_total === null ? null : Number(existingRow.service_total);
    const existingParentId = existingRow.parent_order_id == null ? null : Number(existingRow.parent_order_id);
    const existingLane = (existingRow.lane || DEFAULT_CRM_LANES[0]).trim() || DEFAULT_CRM_LANES[0];
    const existingCustomer = existingRow.customer == null ? null : safeString(existingRow.customer);
    const existingBoard = safeString(existingRow.board_key) || 'default';
    const existingNotesRaw = existingRow.notes == null ? null : String(existingRow.notes);
    const existingNotes = existingNotesRaw ? existingNotesRaw.trim() : null;

    const nextServiceTotal = numericTotal === null ? null : Number(numericTotal);

    const changed = (
      existingOrderNo !== normalizedOrderNo
      || existingTitle !== normalizedTitle
      || (existingCustomer || null) !== customerValue
      || existingServiceTotal !== nextServiceTotal
      || existingLane !== laneValue
      || boolFrom(existingRow.is_done) !== done
      || existingParentId !== parentIdNormalized
      || existingBoard !== board
      || (existingNotes || null) !== notesValue
    );

    if (!changed) {
      return {
        id: Number(existingRow.id),
        changed: false,
        applied: {
          orderNo: existingOrderNo,
          title: existingTitle,
          customer: existingCustomer || '',
          serviceTotal: existingServiceTotal === null ? '' : existingServiceTotal,
          lane: existingLane,
          isDone: boolFrom(existingRow.is_done),
          parentOrderId: existingParentId,
          boardKey: existingBoard,
          notes: existingNotes || ''
        }
      };
    }

    orderChanged = true;
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
      [
        normalizedOrderNo,
        normalizedTitle,
        customerValue,
        nextServiceTotal,
        laneValue,
        done,
        parentIdNormalized,
        board,
        notesValue,
        now,
        user?.email ?? null,
        id
      ]
    );
  } else {
    orderChanged = true;
    result = await pool.query(
      `INSERT INTO crm_orders
        (order_no, title, customer, service_total, lane, is_done, parent_order_id, board_key, notes, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`,
      [
        normalizedOrderNo,
        normalizedTitle,
        customerValue,
        numericTotal === null ? null : Number(numericTotal),
        laneValue,
        done,
        parentIdNormalized,
        board,
        notesValue,
        now,
        user?.email ?? null
      ]
    );
  }

  const orderId = Number(result.rows[0].id);

  const applied = {
    orderNo: normalizedOrderNo,
    title: normalizedTitle,
    customer: customerValue || '',
    serviceTotal: numericTotal === null ? '' : Number(numericTotal),
    lane: laneValue,
    isDone: done,
    parentOrderId: parentIdNormalized,
    boardKey: board,
    notes: notesValue || ''
  };

  if (orderChanged) {
    const activityPayload = {
      ...payload,
      orderNo: normalizedOrderNo,
      title: normalizedTitle,
      customer: applied.customer,
      serviceTotal: numericTotal === null ? null : Number(numericTotal),
      lane: laneValue,
      isDone: done,
      parentOrderId: parentIdNormalized,
      boardKey: board,
      notes: notesValue || ''
    };

    await recordActivity({
      entity: 'order',
      entityId: orderId,
      action: id ? 'update' : 'create',
      userEmail: user?.email ?? null,
      payload: activityPayload
    });

    broadcastEvent({
      type: 'update',
      entity: 'order',
      id: orderId,
      changed: {
        orderNo: normalizedOrderNo,
        title: normalizedTitle,
        customer: applied.customer,
        serviceTotal: numericTotal === null ? null : Number(numericTotal),
        lane: laneValue,
        isDone: done,
        parentOrderId: parentIdNormalized,
        boardKey: board,
        notes: notesValue || ''
      },
      by: user?.email ?? null
    });
  }

  return { id: orderId, changed: orderChanged, applied };
};

const syncStages = async (orderId, stages, user, opts = {}) => {
  if (!Array.isArray(stages)) {
    return { changed: false, stageIdsByKey: new Map() };
  }
  const { trimMissing = true } = opts;
  const existingRes = await pool.query(
    'SELECT id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready FROM crm_stages WHERE order_id = $1',
    [orderId]
  );
  const existingIds = new Set();
  const existingById = new Map();
  const existingByKey = new Map();
  existingRes.rows.forEach((row) => {
    existingIds.add(row.id);
    existingById.set(row.id, row);
    const key = normalizePlannerStage(row.stage_key, row.stage_name);
    if (!existingByKey.has(key)) {
      existingByKey.set(key, []);
    }
    existingByKey.get(key).push(row);
  });

  const seenIds = new Set();
  const pendingBroadcasts = [];
  const stageIdsByKey = new Map();
  let anyChange = false;

  for (const stage of stages) {
    const key = normalizePlannerStage(stage.stageKey, stage.stageName || stage.name || '');
    const nameRaw = stage.stageName || stage.name || CRM_STAGE_LABELS[key] || 'Передел';
    const name = safeString(nameRaw) || CRM_STAGE_LABELS[key] || 'Передел';
    const hoursRaw = numberOrNull(stage.hours ?? stage.value);
    const hoursValue = hoursRaw === null ? null : Number(hoursRaw);
    const startCandidate = stage.dateStart || stage.start || '';
    const endCandidate = stage.dateEnd || stage.end || '';
    const startIso = safeDate(startCandidate);
    const endIso = safeDate(endCandidate);
    const normalizedStart = startIso ? startIso.slice(0, 10) : null;
    const normalizedEnd = endIso ? endIso.slice(0, 10) : null;
    const ready = boolFrom(stage.isReady ?? stage.done);
    const percentValueRaw = numberOrNull(stage.percent ?? stage.progress);
    const percentValue = percentValueRaw !== null ? Number(percentValueRaw) : (ready ? 100 : 0);
    const percentClamped = Number.isFinite(percentValue)
      ? Math.max(0, Math.min(100, percentValue))
      : 0;

    let stageId = stage.id != null ? Number(stage.id) : null;
    let existingRow = stageId && existingById.has(stageId) ? existingById.get(stageId) : null;

    if (!existingRow) {
      const candidates = existingByKey.get(key) || [];
      for (const candidate of candidates) {
        if (!seenIds.has(candidate.id)) {
          stageId = candidate.id;
          existingRow = candidate;
          break;
        }
      }
    }

    if (existingRow) {
      const existingHours = existingRow.hours === null ? null : Number(existingRow.hours);
      const existingStart = existingRow.date_start ? existingRow.date_start.toISOString().slice(0, 10) : null;
      const existingEnd = existingRow.date_end ? existingRow.date_end.toISOString().slice(0, 10) : null;
      const existingPercent = numberOrNull(existingRow.percent) ?? 0;
      const existingReady = boolFrom(existingRow.is_ready);
      const existingKey = normalizePlannerStage(existingRow.stage_key, existingRow.stage_name);
      const existingName = safeString(existingRow.stage_name || CRM_STAGE_LABELS[existingKey] || 'Передел') || CRM_STAGE_LABELS[existingKey] || 'Передел';

      stageIdsByKey.set(key, Number(stageId));
      seenIds.add(Number(stageId));

      const changed = (
        existingKey !== key
        || existingName !== name
        || existingHours !== hoursValue
        || existingStart !== normalizedStart
        || existingEnd !== normalizedEnd
        || existingPercent !== percentClamped
        || existingReady !== ready
      );

      if (!changed) {
        continue;
      }

      anyChange = true;
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
        [
          key,
          name,
          hoursValue,
          normalizedStart,
          normalizedEnd,
          percentClamped,
          ready,
          new Date(),
          user?.email ?? null,
          stageId,
          orderId
        ]
      );

      pendingBroadcasts.push({
        id: Number(stageId),
        key,
        name,
        hours: hoursValue,
        start: normalizedStart,
        end: normalizedEnd,
        percent: percentClamped,
        ready
      });
      continue;
    }

    const inserted = await pool.query(
      `INSERT INTO crm_stages
        (order_id, stage_key, stage_name, hours, date_start, date_end, percent, is_ready, updated_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
      [
        orderId,
        key,
        name,
        hoursValue,
        normalizedStart,
        normalizedEnd,
        percentClamped,
        ready,
        new Date(),
        user?.email ?? null
      ]
    );
    const newId = Number(inserted.rows[0].id);
    stageIdsByKey.set(key, newId);
    seenIds.add(newId);
    anyChange = true;
    pendingBroadcasts.push({
      id: newId,
      key,
      name,
      hours: hoursValue,
      start: normalizedStart,
      end: normalizedEnd,
      percent: percentClamped,
      ready
    });
  }

  pendingBroadcasts.forEach((entry) => {
    broadcastEvent({
      type: 'update',
      entity: 'stage',
      id: entry.id,
      parentId: orderId,
      changed: {
        stageKey: entry.key,
        stageName: entry.name,
        hours: entry.hours,
        dateStart: entry.start,
        dateEnd: entry.end,
        percent: entry.percent,
        isReady: entry.ready
      },
      by: user?.email ?? null
    });
  });

  if (trimMissing) {
    for (const id of existingIds) {
      if (!seenIds.has(id)) {
        await pool.query('DELETE FROM crm_stages WHERE id = $1', [id]);
        anyChange = true;
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

  return { changed: anyChange, stageIdsByKey };
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

    const orderResult = await upsertOrder(payload, user);
    await syncStages(orderResult.id, stages, user);
    processed.push({ orderNo, orderId: orderResult.id, stages: stages.length });
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

app.post('/api/crm/planner_state', requireRole('admin', 'worker'), async (req, res) => {
  const { state, meta } = extractStateFromBody(req.body);
  if (!state) {
    res.status(400).json({ error: 'Invalid state payload' });
    return;
  }

  let parsedState;
  if (typeof state === 'string') {
    try {
      parsedState = JSON.parse(state);
    } catch (err) {
      res.status(400).json({ error: 'State must be valid JSON' });
      return;
    }
  } else if (typeof state === 'object' && state !== null) {
    parsedState = state;
  } else {
    res.status(400).json({ error: 'State must be a JSON object' });
    return;
  }

  if (!parsedState || typeof parsedState !== 'object') {
    res.status(400).json({ error: 'State must be a JSON object' });
    return;
  }

  try {
    const plannerOrders = deriveOrdersFromPlannerState(parsedState);
    const current = await fetchCrmState();
    const existingOrders = current.board.orders || [];

    const ordersById = new Map();
    const ordersByOrderNo = new Map();
    const stagesByOrderId = new Map();

    existingOrders.forEach((order) => {
      const numericId = Number(order.id);
      if (Number.isInteger(numericId)) {
        ordersById.set(numericId, order);
      }
      if (order.orderNo) {
        ordersByOrderNo.set(order.orderNo, order);
      }
      const stageMap = new Map();
      (order.stages || []).forEach((stage) => {
        const key = normalizePlannerStage(stage.stageKey, stage.stageName);
        stageMap.set(key, {
          id: stage.id,
          stageKey: key,
          stageName: stage.stageName || CRM_STAGE_LABELS[key] || key,
          hours: numberOrNull(stage.hours),
          dateStart: stage.dateStart || '',
          dateEnd: stage.dateEnd || '',
          percent: numberOrNull(stage.percent) ?? 0,
          isReady: boolFrom(stage.isReady)
        });
      });
      stagesByOrderId.set(numericId, stageMap);
    });

    const touchedOrders = new Set();

    for (const order of plannerOrders) {
      let existing = null;
      let targetId = order.serverId && ordersById.has(order.serverId) ? order.serverId : null;
      if (targetId != null) {
        existing = ordersById.get(targetId);
      } else if (order.hasOrderNo && ordersByOrderNo.has(order.orderNo)) {
        existing = ordersByOrderNo.get(order.orderNo);
        targetId = Number(existing.id);
      }

      const fallbackIdentity = order.identity || order.orderNo || order.title || `ORD-${Date.now()}`;
      const existingCustomer = existing?.customer || '';
      const existingTitle = existing?.title || '';
      const existingOrderNo = existing?.orderNo || '';

      let resolvedOrderNo = order.hasOrderNo ? order.orderNo : existingOrderNo;
      if (!resolvedOrderNo) {
        resolvedOrderNo = order.hasTitle ? order.title : fallbackIdentity;
      }
      let resolvedTitle = order.hasTitle ? order.title : existingTitle;
      if (!resolvedTitle) {
        resolvedTitle = resolvedOrderNo;
      }
      const resolvedCustomer = order.hasCustomer ? order.customer : existingCustomer;
      const resolvedLaneRaw = order.hasLane ? order.lane : (existing?.lane || DEFAULT_CRM_LANES[0]);
      const resolvedLane = safeString(resolvedLaneRaw) || DEFAULT_CRM_LANES[0];
      const resolvedDone = order.hasDone ? order.isDone : (existing?.isDone ?? false);

      const payload = {
        id: existing?.id ?? null,
        orderNo: resolvedOrderNo,
        title: resolvedTitle,
        customer: resolvedCustomer,
        serviceTotal: existing?.serviceTotal ?? null,
        lane: resolvedLane,
        isDone: resolvedDone,
        parentOrderId: existing?.parentOrderId ?? null,
        boardKey: existing?.boardKey || 'default',
        notes: existing?.notes ?? ''
      };

      const orderResult = await upsertOrder(payload, req.user);
      const savedOrderId = orderResult.id;
      if (orderResult.changed) {
        touchedOrders.add(savedOrderId);
      }

      const existingStageMap = stagesByOrderId.get(savedOrderId) || new Map();
      const nextStagesMap = new Map();

      order.stages.forEach((stage) => {
        const key = stage.stageKey;
        const existingStage = existingStageMap.get(key);
        const stageName = existingStage?.stageName || CRM_STAGE_LABELS[key] || stage.stageName || key;

        const mergedStage = {
          id: existingStage?.id ?? null,
          stageKey: key,
          stageName,
          hours: stage.hasHours ? stage.hours : (existingStage?.hours ?? null),
          dateStart: stage.hasStart ? stage.dateStart : (existingStage?.dateStart || ''),
          dateEnd: stage.hasEnd ? stage.dateEnd : (existingStage?.dateEnd || ''),
          percent: stage.hasPercent ? stage.percent : (existingStage?.percent ?? 0),
          isReady: stage.hasReady ? stage.isReady : boolFrom(existingStage?.isReady)
        };

        nextStagesMap.set(key, mergedStage);
      });

      existingStageMap.forEach((existingStage, key) => {
        if (!nextStagesMap.has(key)) {
          nextStagesMap.set(key, {
            id: existingStage.id,
            stageKey: existingStage.stageKey || key,
            stageName: existingStage.stageName || CRM_STAGE_LABELS[key] || key,
            hours: existingStage.hours ?? null,
            dateStart: existingStage.dateStart || '',
            dateEnd: existingStage.dateEnd || '',
            percent: existingStage.percent ?? 0,
            isReady: boolFrom(existingStage.isReady)
          });
        }
      });

      const nextStages = Array.from(nextStagesMap.values());
      const stageResult = await syncStages(savedOrderId, nextStages, req.user, { trimMissing: true });

      if (stageResult.stageIdsByKey) {
        stageResult.stageIdsByKey.forEach((stageId, key) => {
          if (nextStagesMap.has(key)) {
            const entry = nextStagesMap.get(key);
            entry.id = stageId;
          }
        });
      }

      if (stageResult.changed) {
        touchedOrders.add(savedOrderId);
      }

      const appliedOrder = {
        ...(existing || {}),
        id: savedOrderId,
        orderNo: orderResult.applied?.orderNo ?? payload.orderNo,
        title: orderResult.applied?.title ?? payload.title,
        customer: orderResult.applied?.customer ?? payload.customer ?? '',
        serviceTotal: orderResult.applied?.serviceTotal ?? (existing?.serviceTotal ?? ''),
        lane: orderResult.applied?.lane ?? payload.lane,
        isDone: orderResult.applied?.isDone ?? payload.isDone,
        parentOrderId: orderResult.applied?.parentOrderId ?? payload.parentOrderId ?? null,
        boardKey: orderResult.applied?.boardKey ?? payload.boardKey ?? 'default',
        notes: orderResult.applied?.notes ?? payload.notes ?? ''
      };

      ordersById.set(savedOrderId, appliedOrder);
      if (existing?.orderNo && existing.orderNo !== appliedOrder.orderNo) {
        ordersByOrderNo.delete(existing.orderNo);
      }
      ordersByOrderNo.set(appliedOrder.orderNo, ordersById.get(savedOrderId));
      stagesByOrderId.set(savedOrderId, nextStagesMap);
    }

    if (touchedOrders.size === 0) {
      res.json({ ok: true, state: current.plannerState, board: current.board, lanes: current.lanes, touched: [] });
      return;
    }

    const updated = await fetchCrmState();
    broadcastEvent({
      type: meta?.autoOptimize ? 'reorder' : 'state-updated',
      entity: 'planner',
      mode: 'crm',
      id: 'crm',
      changed: { hash: simpleHash(updated.plannerState?.state || '') },
      state: updated.plannerState,
      board: updated.board,
      lanes: updated.lanes,
      by: req.user?.email ?? null
    });

    res.json({ ok: true, state: updated.plannerState, board: updated.board, lanes: updated.lanes, touched: Array.from(touchedOrders) });
  } catch (err) {
    console.error('Failed to apply CRM planner state', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
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

    const orderResult = await upsertOrder(order, req.user);
    let stageChanged = false;
    if (Array.isArray(stages ?? order.stages)) {
      const stagePayload = stages ?? order.stages;
      const stageResult = await syncStages(orderResult.id, stagePayload, req.user, { trimMissing: trimMissingStages !== false });
      stageChanged = stageResult.changed;
    }

    if (!orderResult.changed && !stageChanged) {
      res.json({ ok: true, orderId: orderResult.id, state: await fetchCrmState() });
      return;
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
    res.json({ ok: true, orderId: orderResult.id, state: updated });
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
    const stageResult = await syncStages(orderId, stages, req.user, { trimMissing: trimMissingStages !== false });

    if (!stageResult.changed) {
      res.json({ ok: true, state: await fetchCrmState() });
      return;
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

