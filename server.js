'use strict';

const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
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

const LEGACY_IMPORT_ENABLED = process.env.PLANNER_SKIP_LEGACY_IMPORT !== 'true';

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'text/*'] }));

const sseClients = new Set();

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

const broadcast = (payload) => {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => {
    res.write(data);
  });
};

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
  res.write(`data: ${JSON.stringify({ state: current.state, meta: current.meta, updatedAt: current.updatedAt })}\n\n`);
});

app.get('/api/state', async (_req, res) => {
  const current = cachedState || await normalizeStoredState();
  res.type('application/json').send(current.state);
});

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

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const clonePlainObject = (value) => {
  if (!isPlainObject(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
};

const mergeSettingsSnapshot = (currentStateObj, nextStateObj, meta) => {
  if (!isPlainObject(nextStateObj)) {
    return { stateObj: nextStateObj, touched: false };
  }

  const metaSettings = meta?.settings;
  if (!metaSettings || (!Array.isArray(metaSettings.entries) && metaSettings.replace !== true)) {
    return { stateObj: nextStateObj, touched: false };
  }

  const currentSettings = clonePlainObject(currentStateObj?.meta?.settings);
  const incomingSettings = clonePlainObject(nextStateObj?.meta?.settings);
  if (!Object.keys(incomingSettings).length && !Object.keys(currentSettings).length) {
    return { stateObj: nextStateObj, touched: false };
  }

  const plan = new Map();
  const ensurePlan = (key, defaults = {}) => {
    if (!plan.has(key)) {
      plan.set(key, { type: 'value', values: new Map(), whole: undefined, allowReplace: false, ...defaults });
    }
    return plan.get(key);
  };

  const readIncoming = (rootKey, fallback) => {
    const value = incomingSettings[rootKey];
    if (value === undefined) {
      return fallback;
    }
    return isPlainObject(value) ? clonePlainObject(value) : value;
  };

  const entries = Array.isArray(metaSettings.entries) ? metaSettings.entries : [];
  entries.forEach((entry) => {
    if (!entry) return;
    if (entry.kind && entry.stage) {
      const rootKey = entry.kind === 'parallel' ? 'parallel' : 'capacity';
      const stageKey = String(entry.stage || '').trim();
      if (!stageKey) return;
      const targetPlan = ensurePlan(rootKey, { type: 'object' });
      const nextValue = entry.to ?? readIncoming(rootKey, {})?.[stageKey];
      if (nextValue === undefined) return;
      targetPlan.values.set(stageKey, Number.isFinite(nextValue) ? nextValue : nextValue);
      return;
    }
    if (typeof entry.key !== 'string') {
      return;
    }
    const keyPath = entry.key.split('.');
    const rootKey = keyPath.shift();
    if (!rootKey) {
      return;
    }
    if (rootKey === 'tableColumn') {
      const columnKey = keyPath[0];
      if (!columnKey) return;
      const targetPlan = ensurePlan('tableColumns', { type: 'object' });
      const tableColumnsIncoming = readIncoming('tableColumns', {});
      const value = entry.value ?? tableColumnsIncoming?.[columnKey];
      if (value === undefined) return;
      targetPlan.values.set(columnKey, value);
      return;
    }
    if (rootKey === 'extraTime') {
      const extraKey = keyPath[0];
      if (!extraKey) return;
      const targetPlan = ensurePlan('extraTime', { type: 'object' });
      const extraIncoming = readIncoming('extraTime', {});
      const value = entry.value ?? extraIncoming?.[extraKey];
      if (value === undefined) return;
      targetPlan.values.set(extraKey, value);
      return;
    }
    if (rootKey === 'crmStageMapping') {
      const targetPlan = ensurePlan('crmStageMapping', { type: 'object', allowReplace: true });
      const mappingValue = entry.value ?? readIncoming('crmStageMapping', {});
      if (isPlainObject(mappingValue)) {
        targetPlan.whole = clonePlainObject(mappingValue);
      }
      return;
    }
    const targetPlan = ensurePlan(rootKey, { type: 'value' });
    const value = entry.value ?? readIncoming(rootKey, undefined);
    if (value !== undefined) {
      targetPlan.value = value;
    }
  });

  if (plan.size === 0) {
    return { stateObj: nextStateObj, touched: false };
  }

  const mergedSettings = clonePlainObject(currentSettings);
  const allowGlobalReplace = metaSettings.replace === true;

  plan.forEach((targetPlan, key) => {
    if (targetPlan.type === 'object') {
      const replaceMode = allowGlobalReplace && (targetPlan.allowReplace || targetPlan.whole);
      const base = replaceMode ? {} : clonePlainObject(mergedSettings[key]);
      const nextObject = { ...base };
      if (isPlainObject(targetPlan.whole)) {
        Object.entries(targetPlan.whole).forEach(([childKey, childValue]) => {
          nextObject[childKey] = childValue;
        });
      }
      targetPlan.values.forEach((value, childKey) => {
        if (value === undefined && replaceMode) {
          delete nextObject[childKey];
        } else if (value !== undefined) {
          nextObject[childKey] = value;
        }
      });
      mergedSettings[key] = nextObject;
    } else if (Object.prototype.hasOwnProperty.call(targetPlan, 'value')) {
      const value = targetPlan.value;
      mergedSettings[key] = isPlainObject(value) ? clonePlainObject(value) : value;
    }
  });

  if (incomingSettings.updatedAt) {
    mergedSettings.updatedAt = incomingSettings.updatedAt;
  }

  if (!isPlainObject(nextStateObj.meta)) {
    nextStateObj.meta = {};
  }
  nextStateObj.meta.settings = mergedSettings;

  return { stateObj: nextStateObj, touched: true };
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
  let nextStateString = state;
  if (meta?.stage === 'settings') {
    try {
      const { stateObj, touched } = mergeSettingsSnapshot(currentStateObj, nextStateObj, meta);
      if (touched) {
        nextStateString = JSON.stringify(stateObj);
      }
    } catch (err) {
      console.error('Failed to merge settings snapshot, falling back to incoming state', err);
    }
  }

  const hash = simpleHash(nextStateString);
  const nextMeta = meta || null;
  const stateId = current.id;

  if (!stateId) {
    res.status(500).send('State store not initialized');
    return;
  }

  const updateResult = await pool.query(
    'UPDATE planner_state SET state = $1, meta = $2, hash = $3, updated_at = $4 WHERE id = $5 AND hash = $6',
    [nextStateString, nextMeta, hash, updatedAt, stateId, current.hash]
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
    state: nextStateString,
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

  broadcast({ state: nextStateString, meta: nextMeta, updatedAt });
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
