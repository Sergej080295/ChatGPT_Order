'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const { createDataLayer, STAGE_CATALOG, normalizeStageCode } = require('./src/data-layer');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
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

const dataLayer = createDataLayer(pool);

const app = express();
app.use(compression());
app.use(express.json({ limit: '2mb' }));

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await dataLayer.ensureSchema();
  res.json({ status: 'ok' });
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const { board, search } = req.query;
  const includeStages = req.query.includeStages !== '0';
  const orders = await dataLayer.listOrders({
    board: board ? String(board).trim() : undefined,
    search: search ? String(search).trim() : undefined,
    includeStages
  });
  res.json({ orders });
}));

app.get('/api/orders/:orderId', asyncRoute(async (req, res) => {
  const { orderId } = req.params;
  const includeStages = req.query.includeStages !== '0';
  const order = await dataLayer.getOrder(orderId, { includeStages });
  if (!order) {
    res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    return;
  }
  res.json({ order });
}));

app.post('/api/orders', asyncRoute(async (req, res) => {
  const created = await dataLayer.createOrder(req.body || {});
  await dataLayer.appendJournalEntry('order.created', { orderId: created.id, title: created.title });
  res.status(201).json({ order: created });
}));

app.patch('/api/orders/:orderId', asyncRoute(async (req, res) => {
  const { orderId } = req.params;
  const updated = await dataLayer.updateOrder(orderId, req.body || {});
  if (!updated) {
    res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    return;
  }
  await dataLayer.appendJournalEntry('order.updated', { orderId: updated.id });
  res.json({ order: updated });
}));

app.delete('/api/orders/:orderId', asyncRoute(async (req, res) => {
  const { orderId } = req.params;
  await dataLayer.deleteOrder(orderId);
  await dataLayer.appendJournalEntry('order.deleted', { orderId });
  res.status(204).end();
}));

app.get('/api/stages', asyncRoute(async (req, res) => {
  const overview = {};
  await Promise.all(
    STAGE_CATALOG.map(async (stage) => {
      const tasks = await dataLayer.listStageTasks(stage.code, { includeOrders: true });
      overview[stage.code] = tasks;
    })
  );
  res.json({ stages: overview, catalog: STAGE_CATALOG });
}));

app.get('/api/stages/catalog', (_req, res) => {
  res.json({ stages: STAGE_CATALOG });
});

app.get('/api/stages/:stageCode', asyncRoute(async (req, res) => {
  const code = normalizeStageCode(req.params.stageCode);
  if (!code) {
    res.status(400).json({ error: 'INVALID_STAGE' });
    return;
  }
  const tasks = await dataLayer.listStageTasks(code, { includeOrders: true });
  res.json({ stage: code, tasks });
}));

app.post('/api/orders/:orderId/stages', asyncRoute(async (req, res) => {
  const { orderId } = req.params;
  const order = await dataLayer.getOrder(orderId, { includeStages: false });
  if (!order) {
    res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    return;
  }
  const created = await dataLayer.createStageTask(orderId, req.body || {});
  await dataLayer.appendJournalEntry('stage.created', { orderId, stageId: created.id, stage: created.stageCode });
  res.status(201).json({ stage: created });
}));

app.patch('/api/stages/:stageId', asyncRoute(async (req, res) => {
  const { stageId } = req.params;
  const updated = await dataLayer.updateStageTask(stageId, req.body || {});
  if (!updated) {
    res.status(404).json({ error: 'STAGE_NOT_FOUND' });
    return;
  }
  await dataLayer.appendJournalEntry('stage.updated', { stageId: updated.id, orderId: updated.orderId });
  res.json({ stage: updated });
}));

app.delete('/api/stages/:stageId', asyncRoute(async (req, res) => {
  const { stageId } = req.params;
  await dataLayer.deleteStageTask(stageId);
  await dataLayer.appendJournalEntry('stage.deleted', { stageId });
  res.status(204).end();
}));

app.get('/api/settings', asyncRoute(async (_req, res) => {
  const settings = await dataLayer.listSettings();
  res.json({ settings });
}));

app.put('/api/settings', asyncRoute(async (req, res) => {
  const next = await dataLayer.updateSettings(req.body || {});
  await dataLayer.appendJournalEntry('settings.updated', { keys: Object.keys(req.body || {}) });
  res.json({ settings: next });
}));

app.get('/api/journal', asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '50', 10) || 50, 1), 200);
  const entries = await dataLayer.listJournal(limit);
  res.json({ entries });
}));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(PUBLIC_DIR, 'CRM.html'));
    return;
  }
  next();
});

app.use((err, _req, res, _next) => {
  console.error('Request failed', err);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PlanCore server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
