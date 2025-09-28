const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'planner-state.json');
const STATIC_ROOT = path.join(__dirname, 'public');

app.use(express.json({ limit: '20mb' }));
app.use(express.static(STATIC_ROOT));

async function readState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

async function writeState(payload) {
  await fs.writeFile(STATE_FILE, payload, 'utf8');
}

app.get('/api/state', async (req, res) => {
  try {
    const data = await readState();
    if (!data) {
      return res.status(204).end();
    }
    res.type('application/json').send(data);
  } catch (err) {
    console.error('Failed to read state', err);
    res.status(500).json({ error: 'Failed to read state' });
  }
});

app.post('/api/state', async (req, res) => {
  try {
    const snapshot = JSON.stringify(req.body ?? {});
    await writeState(snapshot);
    res.status(204).end();
  } catch (err) {
    console.error('Failed to persist state', err);
    res.status(500).json({ error: 'Failed to persist state' });
  }
});

app.get('/', (req, res) => {
  res.redirect('/Planner_Codex_v2.html');
});

app.listen(PORT, () => {
  console.log(`Planner server listening on port ${PORT}`);
});
