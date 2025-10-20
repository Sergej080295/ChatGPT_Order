'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const Database = require('better-sqlite3');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SQLITE_FILE = path.join(DATA_DIR, 'planner.db');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'planner-state.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb' }));

const db = new Database(SQLITE_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

let globalRevision = 0;
const sseClients = new Set();
const heartbeatTimers = new Map();

function nowIso() {
  return new Date().toISOString();
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lanes TEXT NOT NULL CHECK(json_valid(lanes)),
      position INTEGER,
      payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS crm_orders_meta (
      order_key TEXT PRIMARY KEY,
      order_id INTEGER,
      board_id TEXT,
      crm_order_id TEXT,
      position INTEGER,
      payload TEXT CHECK(payload IS NULL OR json_valid(payload)),
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL,
      FOREIGN KEY(board_id) REFERENCES crm_boards(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      position INTEGER,
      has_hours INTEGER NOT NULL DEFAULT 0,
      is_parallel INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crm_order_id TEXT UNIQUE,
      number TEXT NOT NULL,
      customer_id INTEGER,
      status TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS order_process (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      process_id INTEGER NOT NULL,
      seq INTEGER,
      planned_start TEXT,
      planned_end TEXT,
      actual_start TEXT,
      actual_end TEXT,
      progress INTEGER,
      is_done INTEGER NOT NULL DEFAULT 0,
      position_index INTEGER,
      hidden_by_state INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(process_id) REFERENCES processes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS capacity_by_process (
      process_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(process_id, day),
      FOREIGN KEY(process_id) REFERENCES processes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings_shared_preferences (
      pref_key TEXT PRIMARY KEY,
      bool_value INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS planner_tasks_payload (
      uid TEXT PRIMARY KEY,
      order_key TEXT,
      stage_code TEXT,
      is_done INTEGER NOT NULL DEFAULT 0,
      sort_index INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL CHECK(json_valid(payload)),
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS planner_stage_orders (
      stage_code TEXT PRIMARY KEY,
      order_uids TEXT NOT NULL CHECK(json_valid(order_uids)),
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS planner_misc_state (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL CHECK(json_valid(payload)),
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS planner_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stage_order_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_code TEXT NOT NULL,
      order_uids TEXT NOT NULL CHECK(json_valid(order_uids)),
      created_at TEXT NOT NULL
    );
  `);
}

function tableIsEmpty(tableName) {
  return db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get() === undefined;
}

function upsertProcess(process) {
  const existing = db.prepare('SELECT id FROM processes WHERE code = ?').get(process.code);
  if (existing) {
    db.prepare(
      `UPDATE processes SET name = @name, position = @position, has_hours = @has_hours, is_parallel = @is_parallel,
       is_active = @is_active, updated_at = @updated_at, row_version = row_version + 1 WHERE code = @code`
    ).run({ ...process, updated_at: nowIso() });
    return existing.id;
  }
  const stmt = db.prepare(
    `INSERT INTO processes (code, name, position, has_hours, is_parallel, is_active, updated_at, row_version)
     VALUES (@code,@name,@position,@has_hours,@is_parallel,@is_active,@updated_at,0)`
  );
  const info = stmt.run({ ...process, updated_at: nowIso() });
  return info.lastInsertRowid;
}

function seedInitialData() {
  const hasOrders = !tableIsEmpty('orders');
  if (hasOrders) {
    return;
  }

  const now = nowIso();
  const processesSeed = [
    { code: 'prep', name: 'Подготовка', position: 1, has_hours: 1, is_parallel: 0, is_active: 1 },
    { code: 'laser', name: 'Лазер', position: 2, has_hours: 1, is_parallel: 0, is_active: 1 },
    { code: 'bend', name: 'Гибка', position: 3, has_hours: 1, is_parallel: 0, is_active: 1 },
    { code: 'weld', name: 'Сварка', position: 4, has_hours: 1, is_parallel: 0, is_active: 1 },
    { code: 'paint', name: 'Покраска', position: 5, has_hours: 1, is_parallel: 0, is_active: 1 },
    { code: 'ship', name: 'Отгрузка', position: 6, has_hours: 0, is_parallel: 0, is_active: 1 }
  ];

  const processIdByCode = new Map();
  for (const process of processesSeed) {
    const id = upsertProcess(process);
    processIdByCode.set(process.code, id);
  }

  const orderStmt = db.prepare(
    `INSERT INTO orders (crm_order_id, number, customer_id, status, created_at, updated_at, deleted_at, row_version)
     VALUES (@crm_order_id,@number,@customer_id,@status,@created_at,@updated_at,NULL,0)`
  );

  const orderProcessStmt = db.prepare(
    `INSERT INTO order_process (
       order_id, process_id, seq, planned_start, planned_end, actual_start, actual_end,
       progress, is_done, position_index, hidden_by_state, updated_at, row_version
     ) VALUES (@order_id,@process_id,@seq,@planned_start,@planned_end,@actual_start,@actual_end,
               @progress,@is_done,@position_index,@hidden_by_state,@updated_at,0)`
  );

  const ordersSeed = [
    {
      crm_order_id: 'crm-1001',
      number: '1001',
      customer_id: 1,
      status: 'in_progress',
      created_at: now,
      stages: [
        { code: 'prep', start: -2, end: -1, progress: 100, done: true },
        { code: 'laser', start: -1, end: 1, progress: 80, done: false },
        { code: 'bend', start: 1, end: 3, progress: 0, done: false },
        { code: 'weld', start: 3, end: 5, progress: 0, done: false }
      ]
    },
    {
      crm_order_id: 'crm-1002',
      number: '1002',
      customer_id: 2,
      status: 'in_progress',
      created_at: now,
      stages: [
        { code: 'prep', start: -1, end: 0, progress: 100, done: true },
        { code: 'laser', start: 0, end: 2, progress: 60, done: false },
        { code: 'bend', start: 2, end: 4, progress: 0, done: false },
        { code: 'weld', start: 4, end: 6, progress: 0, done: false },
        { code: 'ship', start: 6, end: 7, progress: 0, done: false }
      ]
    }
  ];

  const stageOrdersStmt = db.prepare(
    `INSERT INTO planner_stage_orders (stage_code, order_uids, updated_at, row_version)
     VALUES (@stage_code,@order_uids,@updated_at,0)
     ON CONFLICT(stage_code) DO UPDATE SET order_uids = excluded.order_uids, updated_at = excluded.updated_at, row_version = planner_stage_orders.row_version + 1`
  );

  for (const order of ordersSeed) {
    const info = orderStmt.run({
      crm_order_id: order.crm_order_id,
      number: order.number,
      customer_id: order.customer_id,
      status: order.status,
      created_at: order.created_at,
      updated_at: now
    });
    const orderId = info.lastInsertRowid;
    let seq = 0;
    for (const stage of order.stages) {
      const processId = processIdByCode.get(stage.code);
      if (!processId) continue;
      orderProcessStmt.run({
        order_id: orderId,
        process_id: processId,
        seq: seq++,
        planned_start: offsetDate(stage.start),
        planned_end: offsetDate(stage.end),
        actual_start: stage.done ? offsetDate(stage.start) : null,
        actual_end: stage.done ? offsetDate(stage.end) : null,
        progress: stage.progress,
        is_done: stage.done ? 1 : 0,
        position_index: seq,
        hidden_by_state: 0,
        updated_at: now
      });
    }
  }

  for (const [code, processId] of processIdByCode.entries()) {
    const orderIds = db
      .prepare('SELECT order_id FROM order_process WHERE process_id = ? ORDER BY planned_start IS NULL, planned_start, order_id')
      .all(processId)
      .map((row) => row.order_id);
    if (!orderIds.length) {
      continue;
    }
    stageOrdersStmt.run({
      stage_code: code,
      order_uids: JSON.stringify(orderIds.map((id) => `order-${id}`)),
      updated_at: now
    });
  }

  db.prepare(
    `INSERT INTO planner_settings (id, settings_json, updated_at, row_version)
     VALUES (1, json('{}'), @updated_at, 0)
     ON CONFLICT(id) DO NOTHING`
  ).run({ updated_at: now });
}

function offsetDate(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString();
}

function tryImportLegacySnapshot() {
  if (!fs.existsSync(LEGACY_STATE_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(LEGACY_STATE_FILE, 'utf8');
    const snapshot = JSON.parse(raw);
    if (!snapshot || typeof snapshot !== 'object') {
      return;
    }
    const boards = Array.isArray(snapshot.crm?.boards) ? snapshot.crm.boards : [];
    if (boards.length) {
      const insertBoard = db.prepare(
        `INSERT INTO crm_boards (id, name, lanes, position, payload, updated_at, row_version)
         VALUES (@id,@name,@lanes,@position,@payload,@updated_at,0)
         ON CONFLICT(id) DO NOTHING`
      );
      const now = nowIso();
      for (const board of boards) {
        if (!board || typeof board !== 'object' || !board.id) continue;
        const lanes = Array.isArray(board.lanes) ? board.lanes : [];
        insertBoard.run({
          id: String(board.id),
          name: String(board.name || 'CRM доска'),
          lanes: JSON.stringify(lanes),
          position: Number.isFinite(board.position) ? board.position : null,
          payload: JSON.stringify(board),
          updated_at: now
        });
      }
    }
  } catch (err) {
    console.warn('Failed to import legacy snapshot:', err);
  }
}

ensureSchema();
tryImportLegacySnapshot();
seedInitialData();

function validateJsonValue(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch (err) {
      throw new Error(`Field ${fieldName} must contain valid JSON`);
    }
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    throw new Error(`Field ${fieldName} must be serialisable to JSON`);
  }
}

function broadcastChanges(payload) {
  globalRevision += 1;
  const event = { rev: globalRevision, ...payload };
  const message = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (err) {
      console.warn('Failed to notify SSE client', err);
    }
  }
}

function registerHeartbeat(res) {
  const timer = setInterval(() => {
    try {
      res.write(':keep-alive\n\n');
    } catch (err) {
      clearInterval(timer);
    }
  }, 15000);
  heartbeatTimers.set(res, timer);
}

function clearHeartbeat(res) {
  const timer = heartbeatTimers.get(res);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(res);
  }
}

function buildOrderPayload(row) {
  return {
    id: row.id,
    crm_order_id: row.crm_order_id,
    number: row.number,
    customer_id: row.customer_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    row_version: row.row_version
  };
}

function buildOrderProcessPayload(row, processesById) {
  return {
    id: row.id,
    order_id: row.order_id,
    process_id: row.process_id,
    process_code: processesById?.get(row.process_id)?.code || null,
    seq: row.seq,
    planned_start: row.planned_start,
    planned_end: row.planned_end,
    actual_start: row.actual_start,
    actual_end: row.actual_end,
    progress: row.progress,
    is_done: !!row.is_done,
    position_index: row.position_index,
    hidden_by_state: !!row.hidden_by_state,
    updated_at: row.updated_at,
    row_version: row.row_version
  };
}

app.get('/api/processes', (_req, res) => {
  const rows = db
    .prepare('SELECT id, code, name, position, has_hours, is_parallel, is_active, row_version FROM processes ORDER BY position, id')
    .all();
  res.json({ items: rows });
});

app.get('/api/orders', (req, res) => {
  const updatedAfter = req.query.updatedAfter ? new Date(req.query.updatedAfter) : null;
  const limit = req.query.limit ? Math.max(1, Math.min(500, Number.parseInt(req.query.limit, 10) || 0)) : null;
  const params = [];
  let sql = 'SELECT * FROM orders';
  if (updatedAfter && !Number.isNaN(updatedAfter.valueOf())) {
    sql += ' WHERE updated_at > ?';
    params.push(updatedAfter.toISOString());
  }
  sql += ' ORDER BY updated_at ASC, id ASC';
  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  const rows = db.prepare(sql).all(params).map(buildOrderPayload);
  res.json({ items: rows });
});

app.get('/api/orders/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item: buildOrderPayload(row) });
});

app.patch('/api/orders/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const body = req.body || {};
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  const allowedFields = ['number', 'customer_id', 'status', 'deleted_at'];
  const updates = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates[field] = body[field];
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'no_mutations' });
    return;
  }
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!current) {
        return null;
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      const columns = [];
      const params = [];
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'customer_id') {
          params.push(value === null || value === undefined ? null : Number.parseInt(value, 10));
        } else if (key === 'deleted_at') {
          params.push(value ? new Date(value).toISOString() : null);
        } else {
          params.push(value);
        }
        columns.push(`${key} = ?`);
      }
      const updatedAt = nowIso();
      columns.push('updated_at = ?');
      params.push(updatedAt);
      columns.push('row_version = row_version + 1');
      params.push(id);
      db.prepare(`UPDATE orders SET ${columns.join(', ')} WHERE id = ?`).run(params);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    });
    const result = txn();
    if (result === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (result && result.conflict) {
      res.status(409).json({ error: 'version_conflict', current: buildOrderPayload(result.conflict) });
      return;
    }
    const payload = buildOrderPayload(result);
    broadcastChanges({ orders: [{ id: payload.id, row_version: payload.row_version, data: payload }] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update order', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/order-process', (req, res) => {
  const updatedAfter = req.query.updatedAfter ? new Date(req.query.updatedAfter) : null;
  const orderId = req.query.orderId ? Number.parseInt(req.query.orderId, 10) : null;
  const params = [];
  let sql = 'SELECT * FROM order_process';
  const whereClauses = [];
  if (orderId && Number.isInteger(orderId)) {
    whereClauses.push('order_id = ?');
    params.push(orderId);
  }
  if (updatedAfter && !Number.isNaN(updatedAfter.valueOf())) {
    whereClauses.push('updated_at > ?');
    params.push(updatedAfter.toISOString());
  }
  if (whereClauses.length) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  sql += ' ORDER BY order_id, seq';
  const rows = db.prepare(sql).all(params);
  const processesById = new Map(
    db.prepare('SELECT id, code FROM processes').all().map((row) => [row.id, row])
  );
  res.json({
    items: rows.map((row) => buildOrderProcessPayload(row, processesById))
  });
});

app.patch('/api/order-process/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const body = req.body || {};
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  const allowedFields = [
    'planned_start',
    'planned_end',
    'actual_start',
    'actual_end',
    'progress',
    'is_done',
    'position_index',
    'hidden_by_state'
  ];
  const updates = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates[field] = body[field];
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'no_mutations' });
    return;
  }
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM order_process WHERE id = ?').get(id);
      if (!current) {
        return null;
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      const columns = [];
      const params = [];
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'progress' || key === 'position_index') {
          params.push(value === null || value === undefined ? null : Number.parseInt(value, 10));
        } else if (key === 'is_done' || key === 'hidden_by_state') {
          params.push(value ? 1 : 0);
        } else if (value === null || value === undefined || value === '') {
          params.push(null);
        } else {
          params.push(new Date(value).toISOString());
        }
        columns.push(`${key} = ?`);
      }
      const updatedAt = nowIso();
      columns.push('updated_at = ?');
      params.push(updatedAt);
      columns.push('row_version = row_version + 1');
      params.push(id);
      db.prepare(`UPDATE order_process SET ${columns.join(', ')} WHERE id = ?`).run(params);
      return db.prepare('SELECT * FROM order_process WHERE id = ?').get(id);
    });
    const result = txn();
    if (result === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (result && result.conflict) {
      res.status(409).json({
        error: 'version_conflict',
        current: buildOrderProcessPayload(result.conflict)
      });
      return;
    }
    const processesById = new Map(
      db.prepare('SELECT id, code FROM processes').all().map((row) => [row.id, row])
    );
    const payload = buildOrderProcessPayload(result, processesById);
    broadcastChanges({ order_process: [{ id: payload.id, row_version: payload.row_version, data: payload }] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update order process', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/planner/stage-orders', (req, res) => {
  const sinceVersion = req.query.sinceVersion ? Number.parseInt(req.query.sinceVersion, 10) : null;
  const params = [];
  let sql = 'SELECT * FROM planner_stage_orders';
  if (Number.isInteger(sinceVersion) && sinceVersion >= 0) {
    sql += ' WHERE row_version > ?';
    params.push(sinceVersion);
  }
  sql += ' ORDER BY stage_code';
  const rows = db.prepare(sql).all(params).map((row) => ({
    stage_code: row.stage_code,
    order_uids: JSON.parse(row.order_uids),
    updated_at: row.updated_at,
    row_version: row.row_version
  }));
  res.json({ items: rows });
});

app.patch('/api/planner/stage-orders/:stageCode', (req, res) => {
  const stageCode = String(req.params.stageCode || '').trim();
  if (!stageCode) {
    res.status(400).json({ error: 'invalid_stage_code' });
    return;
  }
  const body = req.body || {};
  if (!Array.isArray(body.order_uids)) {
    res.status(400).json({ error: 'order_uids_required' });
    return;
  }
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  const serialized = validateJsonValue(body.order_uids, 'order_uids');
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM planner_stage_orders WHERE stage_code = ?').get(stageCode);
      if (!current) {
        if (expectedVersion !== 0) {
          return { conflict: null };
        }
        const updatedAt = nowIso();
        db.prepare(
          `INSERT INTO planner_stage_orders (stage_code, order_uids, updated_at, row_version)
           VALUES (@stage_code,@order_uids,@updated_at,0)`
        ).run({ stage_code: stageCode, order_uids: serialized, updated_at: updatedAt });
        return db.prepare('SELECT * FROM planner_stage_orders WHERE stage_code = ?').get(stageCode);
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      const updatedAt = nowIso();
      db.prepare(
        `UPDATE planner_stage_orders SET order_uids = @order_uids, updated_at = @updated_at,
         row_version = row_version + 1 WHERE stage_code = @stage_code`
      ).run({ stage_code: stageCode, order_uids: serialized, updated_at: updatedAt });
      return db.prepare('SELECT * FROM planner_stage_orders WHERE stage_code = ?').get(stageCode);
    });
    if (txn && txn.conflict !== undefined) {
      const conflict = txn.conflict;
      res.status(409).json({
        error: 'version_conflict',
        current: conflict
          ? {
              stage_code: conflict.stage_code,
              order_uids: JSON.parse(conflict.order_uids),
              updated_at: conflict.updated_at,
              row_version: conflict.row_version
            }
          : null
      });
      return;
    }
    const row = txn;
    const payload = {
      stage_code: row.stage_code,
      order_uids: JSON.parse(row.order_uids),
      updated_at: row.updated_at,
      row_version: row.row_version
    };
    broadcastChanges({ stage_orders: [payload] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update stage order', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/settings/shared', (_req, res) => {
  const rows = db.prepare('SELECT pref_key, bool_value, updated_at, row_version FROM settings_shared_preferences').all();
  res.json({
    items: rows.map((row) => ({
      pref_key: row.pref_key,
      bool_value: !!row.bool_value,
      updated_at: row.updated_at,
      row_version: row.row_version
    }))
  });
});

app.patch('/api/settings/shared', (req, res) => {
  const body = req.body || {};
  const prefKey = typeof body.pref_key === 'string' ? body.pref_key.trim() : '';
  if (!prefKey) {
    res.status(400).json({ error: 'pref_key_required' });
    return;
  }
  if (typeof body.bool_value !== 'boolean') {
    res.status(400).json({ error: 'bool_value_required' });
    return;
  }
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM settings_shared_preferences WHERE pref_key = ?').get(prefKey);
      if (!current) {
        if (expectedVersion !== 0) {
          return { conflict: null };
        }
        db.prepare(
          `INSERT INTO settings_shared_preferences (pref_key, bool_value, updated_at, row_version)
           VALUES (@pref_key,@bool_value,@updated_at,0)`
        ).run({ pref_key: prefKey, bool_value: body.bool_value ? 1 : 0, updated_at: nowIso() });
        return db.prepare('SELECT * FROM settings_shared_preferences WHERE pref_key = ?').get(prefKey);
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      db.prepare(
        `UPDATE settings_shared_preferences
         SET bool_value = @bool_value, updated_at = @updated_at, row_version = row_version + 1
         WHERE pref_key = @pref_key`
      ).run({ pref_key: prefKey, bool_value: body.bool_value ? 1 : 0, updated_at: nowIso() });
      return db.prepare('SELECT * FROM settings_shared_preferences WHERE pref_key = ?').get(prefKey);
    });
    if (txn && txn.conflict !== undefined) {
      const conflict = txn.conflict;
      res.status(409).json({
        error: 'version_conflict',
        current: conflict
          ? {
              pref_key: conflict.pref_key,
              bool_value: !!conflict.bool_value,
              updated_at: conflict.updated_at,
              row_version: conflict.row_version
            }
          : null
      });
      return;
    }
    const row = txn;
    const payload = {
      pref_key: row.pref_key,
      bool_value: !!row.bool_value,
      updated_at: row.updated_at,
      row_version: row.row_version
    };
    broadcastChanges({ settings_shared: [payload] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update shared setting', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/settings/misc/:key', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) {
    res.status(400).json({ error: 'invalid_key' });
    return;
  }
  const row = db.prepare('SELECT * FROM planner_misc_state WHERE key = ?').get(key);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    item: {
      key: row.key,
      payload: JSON.parse(row.payload),
      updated_at: row.updated_at,
      row_version: row.row_version
    }
  });
});

app.patch('/api/settings/misc/:key', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) {
    res.status(400).json({ error: 'invalid_key' });
    return;
  }
  const body = req.body || {};
  const payloadJson = validateJsonValue(body.payload, 'payload');
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM planner_misc_state WHERE key = ?').get(key);
      if (!current) {
        if (expectedVersion !== 0) {
          return { conflict: null };
        }
        db.prepare(
          `INSERT INTO planner_misc_state (key, payload, updated_at, row_version)
           VALUES (@key,@payload,@updated_at,0)`
        ).run({ key, payload: payloadJson, updated_at: nowIso() });
        return db.prepare('SELECT * FROM planner_misc_state WHERE key = ?').get(key);
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      db.prepare(
        `UPDATE planner_misc_state
         SET payload = @payload, updated_at = @updated_at, row_version = row_version + 1
         WHERE key = @key`
      ).run({ key, payload: payloadJson, updated_at: nowIso() });
      return db.prepare('SELECT * FROM planner_misc_state WHERE key = ?').get(key);
    });
    if (txn && txn.conflict !== undefined) {
      const conflict = txn.conflict;
      res.status(409).json({
        error: 'version_conflict',
        current: conflict
          ? {
              key: conflict.key,
              payload: JSON.parse(conflict.payload),
              updated_at: conflict.updated_at,
              row_version: conflict.row_version
            }
          : null
      });
      return;
    }
    const row = txn;
    const payload = {
      key: row.key,
      payload: JSON.parse(row.payload),
      updated_at: row.updated_at,
      row_version: row.row_version
    };
    broadcastChanges({ settings_misc: [payload] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update misc setting', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/crm/boards', (req, res) => {
  const updatedAfter = req.query.updatedAfter ? new Date(req.query.updatedAfter) : null;
  const params = [];
  let sql = 'SELECT * FROM crm_boards';
  if (updatedAfter && !Number.isNaN(updatedAfter.valueOf())) {
    sql += ' WHERE updated_at > ?';
    params.push(updatedAfter.toISOString());
  }
  sql += ' ORDER BY position, id';
  const rows = db.prepare(sql).all(params).map((row) => ({
    id: row.id,
    name: row.name,
    lanes: JSON.parse(row.lanes),
    position: row.position,
    payload: row.payload ? JSON.parse(row.payload) : null,
    updated_at: row.updated_at,
    row_version: row.row_version
  }));
  res.json({ items: rows });
});

app.patch('/api/crm/boards/:id', (req, res) => {
  const boardId = String(req.params.id || '').trim();
  if (!boardId) {
    res.status(400).json({ error: 'invalid_id' });
    return;
  }
  const body = req.body || {};
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'name')) {
    updates.name = String(body.name || 'CRM доска');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'position')) {
    updates.position = Number.isFinite(body.position) ? Number(body.position) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'lanes')) {
    updates.lanes = validateJsonValue(body.lanes, 'lanes');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'payload')) {
    updates.payload = validateJsonValue(body.payload, 'payload');
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'no_mutations' });
    return;
  }
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM crm_boards WHERE id = ?').get(boardId);
      if (!current) {
        if (expectedVersion !== 0) {
          return { conflict: null };
        }
        const now = nowIso();
        db.prepare(
          `INSERT INTO crm_boards (id, name, lanes, position, payload, updated_at, row_version)
           VALUES (@id,@name,@lanes,@position,@payload,@updated_at,0)`
        ).run({
          id: boardId,
          name: updates.name || 'CRM доска',
          lanes: updates.lanes || validateJsonValue([], 'lanes'),
          position: updates.position || 0,
          payload: updates.payload,
          updated_at: now
        });
        return db.prepare('SELECT * FROM crm_boards WHERE id = ?').get(boardId);
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      const columns = [];
      const params = [];
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'lanes' || key === 'payload') {
          params.push(value ?? null);
        } else {
          params.push(value);
        }
        columns.push(`${key} = ?`);
      }
      columns.push('updated_at = ?');
      params.push(nowIso());
      columns.push('row_version = row_version + 1');
      params.push(boardId);
      db.prepare(`UPDATE crm_boards SET ${columns.join(', ')} WHERE id = ?`).run(params);
      return db.prepare('SELECT * FROM crm_boards WHERE id = ?').get(boardId);
    });
    if (txn && txn.conflict !== undefined) {
      const conflict = txn.conflict;
      res.status(409).json({
        error: 'version_conflict',
        current: conflict
          ? {
              id: conflict.id,
              name: conflict.name,
              lanes: JSON.parse(conflict.lanes),
              position: conflict.position,
              payload: conflict.payload ? JSON.parse(conflict.payload) : null,
              updated_at: conflict.updated_at,
              row_version: conflict.row_version
            }
          : null
      });
      return;
    }
    const row = txn;
    const payload = {
      id: row.id,
      name: row.name,
      lanes: JSON.parse(row.lanes),
      position: row.position,
      payload: row.payload ? JSON.parse(row.payload) : null,
      updated_at: row.updated_at,
      row_version: row.row_version
    };
    broadcastChanges({ crm_boards: [payload] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update CRM board', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/crm/orders-meta', (req, res) => {
  const updatedAfter = req.query.updatedAfter ? new Date(req.query.updatedAfter) : null;
  const params = [];
  let sql = 'SELECT * FROM crm_orders_meta';
  if (updatedAfter && !Number.isNaN(updatedAfter.valueOf())) {
    sql += ' WHERE updated_at > ?';
    params.push(updatedAfter.toISOString());
  }
  sql += ' ORDER BY updated_at ASC, order_key';
  const rows = db.prepare(sql).all(params).map((row) => ({
    order_key: row.order_key,
    order_id: row.order_id,
    board_id: row.board_id,
    crm_order_id: row.crm_order_id,
    position: row.position,
    payload: row.payload ? JSON.parse(row.payload) : null,
    updated_at: row.updated_at,
    row_version: row.row_version
  }));
  res.json({ items: rows });
});

app.patch('/api/crm/orders-meta/:orderKey', (req, res) => {
  const orderKey = String(req.params.orderKey || '').trim();
  if (!orderKey) {
    res.status(400).json({ error: 'invalid_order_key' });
    return;
  }
  const body = req.body || {};
  const expectedVersion = Number.isInteger(body.ifVersion) ? body.ifVersion : null;
  if (expectedVersion === null) {
    res.status(400).json({ error: 'ifVersion_required' });
    return;
  }
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'order_id')) {
    updates.order_id = Number.isFinite(body.order_id) ? Number(body.order_id) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'board_id')) {
    updates.board_id = body.board_id ? String(body.board_id) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'crm_order_id')) {
    updates.crm_order_id = body.crm_order_id ? String(body.crm_order_id) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'position')) {
    updates.position = Number.isFinite(body.position) ? Number(body.position) : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'payload')) {
    updates.payload = validateJsonValue(body.payload, 'payload');
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'no_mutations' });
    return;
  }
  try {
    const txn = db.transaction(() => {
      const current = db.prepare('SELECT * FROM crm_orders_meta WHERE order_key = ?').get(orderKey);
      if (!current) {
        if (expectedVersion !== 0) {
          return { conflict: null };
        }
        db.prepare(
          `INSERT INTO crm_orders_meta (order_key, order_id, board_id, crm_order_id, position, payload, updated_at, row_version)
           VALUES (@order_key,@order_id,@board_id,@crm_order_id,@position,@payload,@updated_at,0)`
        ).run({
          order_key: orderKey,
          order_id: updates.order_id || null,
          board_id: updates.board_id || null,
          crm_order_id: updates.crm_order_id || null,
          position: updates.position || 0,
          payload: updates.payload,
          updated_at: nowIso()
        });
        return db.prepare('SELECT * FROM crm_orders_meta WHERE order_key = ?').get(orderKey);
      }
      if (current.row_version !== expectedVersion) {
        return { conflict: current };
      }
      const columns = [];
      const params = [];
      for (const [key, value] of Object.entries(updates)) {
        if (key === 'payload') {
          params.push(value ?? null);
        } else {
          params.push(value);
        }
        columns.push(`${key} = ?`);
      }
      columns.push('updated_at = ?');
      params.push(nowIso());
      columns.push('row_version = row_version + 1');
      params.push(orderKey);
      db.prepare(`UPDATE crm_orders_meta SET ${columns.join(', ')} WHERE order_key = ?`).run(params);
      return db.prepare('SELECT * FROM crm_orders_meta WHERE order_key = ?').get(orderKey);
    });
    if (txn && txn.conflict !== undefined) {
      const conflict = txn.conflict;
      res.status(409).json({
        error: 'version_conflict',
        current: conflict
          ? {
              order_key: conflict.order_key,
              order_id: conflict.order_id,
              board_id: conflict.board_id,
              crm_order_id: conflict.crm_order_id,
              position: conflict.position,
              payload: conflict.payload ? JSON.parse(conflict.payload) : null,
              updated_at: conflict.updated_at,
              row_version: conflict.row_version
            }
          : null
      });
      return;
    }
    const row = txn;
    const payload = {
      order_key: row.order_key,
      order_id: row.order_id,
      board_id: row.board_id,
      crm_order_id: row.crm_order_id,
      position: row.position,
      payload: row.payload ? JSON.parse(row.payload) : null,
      updated_at: row.updated_at,
      row_version: row.row_version
    };
    broadcastChanges({ crm_orders_meta: [payload] });
    res.json({ item: payload });
  } catch (err) {
    console.error('Failed to update CRM order meta', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ rev: globalRevision })}\n\n`);
  registerHeartbeat(res);
  sseClients.add(res);
  req.on('close', () => {
    clearHeartbeat(res);
    sseClients.delete(res);
  });
});

app.use(express.static(PUBLIC_DIR, { fallthrough: true }));

app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
    return;
  }
  next();
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`Planner API listening on port ${PORT}`);
});

