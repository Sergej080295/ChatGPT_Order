const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_PATH = path.join(__dirname, 'state.json');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let currentState = {};
let serializedState = '{}';
let clients = new Set();

function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      if (raw) {
        currentState = JSON.parse(raw);
        serializedState = JSON.stringify(currentState);
      }
    }
  } catch (err) {
    console.error('Failed to load state from disk:', err);
    currentState = {};
    serializedState = '{}';
  }
}

async function persistState(state) {
  serializedState = JSON.stringify(state);
  currentState = state;
  try {
    await fs.promises.writeFile(STATE_PATH, serializedState, 'utf8');
  } catch (err) {
    console.error('Failed to persist state:', err);
    throw err;
  }
}

function broadcastState() {
  for (const res of clients) {
    if (res.writableEnded) continue;
    try {
      res.write(`data: ${serializedState}\n\n`);
    } catch (err) {
      console.warn('Failed to push update to client:', err);
      try { res.end(); } catch (_) { /* noop */ }
      clients.delete(res);
    }
  }
}

app.get('/api/state', (req, res) => {
  res.json(currentState);
});

app.get('/api/state/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  res.write(`data: ${serializedState}\n\n`);
  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.post('/api/state', async (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ ok: false, error: 'Invalid state payload' });
  }
  try {
    await persistState(payload);
    broadcastState();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to save state' });
  }
});

setInterval(() => {
  for (const res of clients) {
    if (res.writableEnded) {
      clients.delete(res);
    } else {
      try {
        res.write(': keep-alive\n\n');
      } catch (err) {
        clients.delete(res);
      }
    }
  }
}, 30000).unref?.();

loadStateFromDisk();

app.listen(PORT, () => {
  console.log(`Planner server listening on port ${PORT}`);
});
