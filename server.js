const fsp = require('fs/promises');
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'planner-state.json');
const LOG_FILE = path.join(__dirname, 'planner-activity.log');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'text/*'] }));

const sseClients = new Set();

const ensureDir = async (filePath) => {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true }).catch(() => {});
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
  meta: {
    versions: {},
    history: [],
    lastAuthors: {},
    csvTimestamp: '',
    manualTimestamp: ''
  }
};

let cachedState = null;

const normalizeStoredState = async () => {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.state === 'string') {
      cachedState = parsed;
      return cachedState;
    }
  } catch (err) {
    // ignore and recreate
  }
  const stateString = JSON.stringify(DEFAULT_STATE);
  const initial = {
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
  await ensureDir(DATA_FILE);
  await fsp.writeFile(DATA_FILE, JSON.stringify(initial, null, 2), 'utf8');
  cachedState = initial;
  return cachedState;
};

const appendLog = async (entry) => {
  const line = JSON.stringify(entry);
  await ensureDir(LOG_FILE);
  await fsp.appendFile(LOG_FILE, `${line}\n`).catch((err) => {
    console.error('log append failed', err);
  });
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
  cachedState = {
    state,
    meta: meta || null,
    updatedAt,
    hash
  };

  await ensureDir(DATA_FILE);
  await fsp.writeFile(DATA_FILE, JSON.stringify(cachedState, null, 2), 'utf8');

  const logEntry = {
    timestamp: updatedAt,
    stage,
    version: incomingVersion ?? null,
    user: meta?.user ?? null,
    session: meta?.session ?? null,
    source: meta?.source ?? null,
    summary: meta?.diff ? undefined : meta?.summary ?? null,
    ip: req.ip
  };
  if (meta?.diff) {
    logEntry.diff = meta.diff;
  }
  await appendLog(logEntry);

  broadcast({ state, meta: meta || null, updatedAt });
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

normalizeStoredState().then(() => {
  app.listen(PORT, () => {
    console.log(`Planner server running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to bootstrap state', err);
  process.exit(1);
});
