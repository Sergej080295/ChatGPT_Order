#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'planner.db');
const STATIC_ROOT = process.env.STATIC_ROOT || __dirname;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false }));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function readPlannerVersion(){
  const htmlPath = path.join(__dirname, 'Planner_v2.html');
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const match = html.match(/const\s+VERSION\s*=\s*'([^']+)'/);
    return match ? match[1] : 'unknown';
  } catch (err) {
    console.warn('Unable to read Planner_v2.html to detect version', err.message);
    return 'unknown';
  }
}

const PLANNER_VERSION = readPlannerVersion();

function ensureSchema(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS planner_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planner_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planner_tasks (
      uid TEXT PRIMARY KEY,
      stage TEXT NOT NULL,
      order_id TEXT,
      child_id TEXT,
      parent_id TEXT,
      hours REAL,
      extra_hours REAL,
      start_date TEXT,
      end_date TEXT,
      start_missing INTEGER NOT NULL DEFAULT 0,
      end_missing INTEGER NOT NULL DEFAULT 0,
      state TEXT,
      status TEXT,
      use_reserve INTEGER NOT NULL DEFAULT 0,
      progress REAL,
      orig_start_date TEXT,
      route_json TEXT
    );

    CREATE TABLE IF NOT EXISTS planner_done (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT,
      stage TEXT,
      order_id TEXT,
      parent_id TEXT,
      child_id TEXT,
      hours REAL,
      extra REAL,
      start_date TEXT,
      end_date TEXT,
      completed_at TEXT,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS planner_trash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT,
      stage TEXT,
      order_id TEXT,
      parent_id TEXT,
      child_id TEXT,
      hours REAL,
      extra REAL,
      start_date TEXT,
      end_date TEXT,
      removed_at TEXT,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS planner_exceptions (
      date_key TEXT PRIMARY KEY,
      capacity REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planner_reserves (
      date_key TEXT PRIMARY KEY,
      reserved REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planner_route_overrides (
      route_key TEXT PRIMARY KEY,
      start_date TEXT,
      end_date TEXT
    );

    CREATE TABLE IF NOT EXISTS planner_locked (
      uid TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS planner_orders (
      stage TEXT PRIMARY KEY,
      order_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planner_capacity (
      stage TEXT PRIMARY KEY,
      capacity REAL
    );

    CREATE TABLE IF NOT EXISTS planner_parallel (
      stage TEXT PRIMARY KEY,
      slots INTEGER
    );

    CREATE TABLE IF NOT EXISTS planner_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

ensureSchema();

function toStringOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBooleanInt(value) {
  return value ? 1 : 0;
}

function toIsoOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) return trimmed;
    return date.toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeRoute(route) {
  if (!route || typeof route !== 'object') return null;
  const out = {};
  for (const [stage, data] of Object.entries(route)) {
    if (!data) {
      out[stage] = null;
      continue;
    }
    out[stage] = {
      hours: toNumberOrNull(data.hours),
      start: toIsoOrNull(data.start),
      end: toIsoOrNull(data.end)
    };
  }
  return out;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('state payload must be an object');
  }
  const state = {
    ...raw,
    t: Array.isArray(raw.t) ? raw.t : [],
    done: Array.isArray(raw.done) ? raw.done : [],
    trash: Array.isArray(raw.trash) ? raw.trash : [],
    exc: Array.isArray(raw.exc) ? raw.exc : [],
    res: Array.isArray(raw.res) ? raw.res : [],
    routeOverrides: Array.isArray(raw.routeOverrides) ? raw.routeOverrides : [],
    locked: Array.isArray(raw.locked) ? raw.locked : [],
    orders: Array.isArray(raw.orders) ? raw.orders : [],
    capByProc: raw.capByProc && typeof raw.capByProc === 'object' ? raw.capByProc : {},
    parallelByProc: raw.parallelByProc && typeof raw.parallelByProc === 'object' ? raw.parallelByProc : {},
    autosaveOn: !!raw.autosaveOn,
    autoOptimizeOn: !!raw.autoOptimizeOn,
    shiftOnProgress: raw.shiftOnProgress === undefined ? true : !!raw.shiftOnProgress,
    filter: typeof raw.filter === 'string' ? raw.filter : '',
    freshness: typeof raw.freshness === 'string' ? raw.freshness : '',
    lastImportTime: typeof raw.lastImportTime === 'string' ? raw.lastImportTime : '',
    process: typeof raw.process === 'string' ? raw.process : ''
  };
  return state;
}

function persistState(normalized, version, rawPayload) {
  const now = new Date().toISOString();
  const payloadText = JSON.stringify(rawPayload ?? normalized);

  const insertHistory = db.prepare(
    'INSERT INTO planner_history (version, payload, created_at) VALUES (?, ?, ?)'
  );
  const upsertState = db.prepare(`
    INSERT INTO planner_state (id, version, payload, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  const deleteTasks = db.prepare('DELETE FROM planner_tasks');
  const insertTask = db.prepare(`
    INSERT OR REPLACE INTO planner_tasks
    (uid, stage, order_id, child_id, parent_id, hours, extra_hours, start_date, end_date,
     start_missing, end_missing, state, status, use_reserve, progress, orig_start_date, route_json)
    VALUES (@uid, @stage, @order_id, @child_id, @parent_id, @hours, @extra_hours, @start_date, @end_date,
            @start_missing, @end_missing, @state, @status, @use_reserve, @progress, @orig_start_date, @route_json)
  `);

  const deleteDone = db.prepare('DELETE FROM planner_done');
  const insertDone = db.prepare(`
    INSERT INTO planner_done
    (uid, stage, order_id, parent_id, child_id, hours, extra, start_date, end_date, completed_at, source)
    VALUES (@uid, @stage, @order_id, @parent_id, @child_id, @hours, @extra, @start_date, @end_date, @completed_at, @source)
  `);

  const deleteTrash = db.prepare('DELETE FROM planner_trash');
  const insertTrash = db.prepare(`
    INSERT INTO planner_trash
    (uid, stage, order_id, parent_id, child_id, hours, extra, start_date, end_date, removed_at, source)
    VALUES (@uid, @stage, @order_id, @parent_id, @child_id, @hours, @extra, @start_date, @end_date, @removed_at, @source)
  `);

  const deleteExceptions = db.prepare('DELETE FROM planner_exceptions');
  const insertException = db.prepare('INSERT OR REPLACE INTO planner_exceptions (date_key, capacity) VALUES (?, ?)');

  const deleteReserves = db.prepare('DELETE FROM planner_reserves');
  const insertReserve = db.prepare('INSERT OR REPLACE INTO planner_reserves (date_key, reserved) VALUES (?, ?)');

  const deleteOverrides = db.prepare('DELETE FROM planner_route_overrides');
  const insertOverride = db.prepare('INSERT OR REPLACE INTO planner_route_overrides (route_key, start_date, end_date) VALUES (?, ?, ?)');

  const deleteLocked = db.prepare('DELETE FROM planner_locked');
  const insertLocked = db.prepare('INSERT OR IGNORE INTO planner_locked (uid) VALUES (?)');

  const deleteOrders = db.prepare('DELETE FROM planner_orders');
  const insertOrder = db.prepare('INSERT OR REPLACE INTO planner_orders (stage, order_json) VALUES (?, ?)');

  const deleteCapacity = db.prepare('DELETE FROM planner_capacity');
  const insertCapacity = db.prepare('INSERT OR REPLACE INTO planner_capacity (stage, capacity) VALUES (?, ?)');

  const deleteParallel = db.prepare('DELETE FROM planner_parallel');
  const insertParallel = db.prepare('INSERT OR REPLACE INTO planner_parallel (stage, slots) VALUES (?, ?)');

  const deleteSettings = db.prepare("DELETE FROM planner_settings WHERE key IN ('filter', 'freshness', 'lastImportTime', 'autosaveOn', 'autoOptimizeOn', 'shiftOnProgress', 'process')");
  const insertSetting = db.prepare('INSERT OR REPLACE INTO planner_settings (key, value) VALUES (?, ?)');

  const tx = db.transaction(() => {
    insertHistory.run(version, payloadText, now);
    upsertState.run(version, payloadText, now);

    deleteTasks.run();
    for (const task of normalized.t) {
      const uid = toStringOrNull(task.uid);
      if (!uid) continue;
      insertTask.run({
        uid,
        stage: toStringOrNull(task.stage) || 'unknown',
        order_id: toStringOrNull(task.orderId),
        child_id: toStringOrNull(task.childId),
        parent_id: toStringOrNull(task.parentId),
        hours: toNumberOrNull(task.hours),
        extra_hours: toNumberOrNull(task.extraHours),
        start_date: toIsoOrNull(task.startDate),
        end_date: toIsoOrNull(task.endDate),
        start_missing: toBooleanInt(task.startMissing),
        end_missing: toBooleanInt(task.endMissing),
        state: toStringOrNull(task.state),
        status: toStringOrNull(task.status),
        use_reserve: toBooleanInt(task.useReserve),
        progress: toNumberOrNull(task.progress),
        orig_start_date: toIsoOrNull(task.origStartDate),
        route_json: JSON.stringify(normalizeRoute(task.route))
      });
    }

    deleteDone.run();
    for (const item of normalized.done) {
      const uid = toStringOrNull(item.uid);
      if (!uid) continue;
      insertDone.run({
        uid,
        stage: toStringOrNull(item.stage),
        order_id: toStringOrNull(item.orderId),
        parent_id: toStringOrNull(item.parentId),
        child_id: toStringOrNull(item.childId),
        hours: toNumberOrNull(item.hours),
        extra: toNumberOrNull(item.extra),
        start_date: toIsoOrNull(item.start),
        end_date: toIsoOrNull(item.end),
        completed_at: toIsoOrNull(item.when),
        source: toStringOrNull(item.source)
      });
    }

    deleteTrash.run();
    for (const item of normalized.trash) {
      const uid = toStringOrNull(item.uid);
      if (!uid) continue;
      insertTrash.run({
        uid,
        stage: toStringOrNull(item.stage),
        order_id: toStringOrNull(item.orderId),
        parent_id: toStringOrNull(item.parentId),
        child_id: toStringOrNull(item.childId),
        hours: toNumberOrNull(item.hours),
        extra: toNumberOrNull(item.extra),
        start_date: toIsoOrNull(item.start),
        end_date: toIsoOrNull(item.end),
        removed_at: toIsoOrNull(item.when),
        source: toStringOrNull(item.source)
      });
    }

    deleteExceptions.run();
    for (const entry of normalized.exc) {
      if (!Array.isArray(entry) || entry.length === 0) continue;
      const key = toStringOrNull(entry[0]);
      if (!key) continue;
      insertException.run(key, toNumberOrNull(entry[1]) ?? 0);
    }

    deleteReserves.run();
    for (const entry of normalized.res) {
      if (!Array.isArray(entry) || entry.length === 0) continue;
      const key = toStringOrNull(entry[0]);
      if (!key) continue;
      insertReserve.run(key, toNumberOrNull(entry[1]) ?? 0);
    }

    deleteOverrides.run();
    for (const [key, value] of normalized.routeOverrides) {
      const routeKey = toStringOrNull(key);
      if (!routeKey || !value || typeof value !== 'object') continue;
      insertOverride.run(routeKey, toIsoOrNull(value.start), toIsoOrNull(value.end));
    }

    deleteLocked.run();
    for (const uid of normalized.locked) {
      const clean = toStringOrNull(uid);
      if (!clean) continue;
      insertLocked.run(clean);
    }

    deleteOrders.run();
    for (const [stage, order] of normalized.orders) {
      const st = toStringOrNull(stage);
      if (!st) continue;
      insertOrder.run(st, JSON.stringify(order ?? []));
    }

    deleteCapacity.run();
    for (const [stage, capacity] of Object.entries(normalized.capByProc)) {
      const st = toStringOrNull(stage);
      if (!st) continue;
      insertCapacity.run(st, toNumberOrNull(capacity));
    }

    deleteParallel.run();
    for (const [stage, slots] of Object.entries(normalized.parallelByProc)) {
      const st = toStringOrNull(stage);
      if (!st) continue;
      insertParallel.run(st, toNumberOrNull(slots));
    }

    deleteSettings.run();
    insertSetting.run('filter', normalized.filter || '');
    insertSetting.run('freshness', normalized.freshness || '');
    insertSetting.run('lastImportTime', normalized.lastImportTime || '');
    insertSetting.run('autosaveOn', normalized.autosaveOn ? 'true' : 'false');
    insertSetting.run('autoOptimizeOn', normalized.autoOptimizeOn ? 'true' : 'false');
    insertSetting.run('shiftOnProgress', normalized.shiftOnProgress ? 'true' : 'false');
    insertSetting.run('process', normalized.process || '');
  });

  tx();
  return now;
}

function getCurrentState() {
  const row = db.prepare('SELECT version, payload, updated_at FROM planner_state WHERE id = 1').get();
  if (!row) return null;
  try {
    return {
      version: row.version,
      updatedAt: row.updated_at,
      state: JSON.parse(row.payload)
    };
  } catch (err) {
    console.error('Failed to parse stored state JSON', err);
    return {
      version: row.version,
      updatedAt: row.updated_at,
      state: null,
      parseError: err.message
    };
  }
}

function mapTaskRow(row) {
  const route = row.route_json ? JSON.parse(row.route_json) : null;
  return {
    uid: row.uid,
    stage: row.stage,
    orderId: row.order_id,
    childId: row.child_id,
    parentId: row.parent_id,
    hours: row.hours,
    extraHours: row.extra_hours,
    startDate: row.start_date,
    endDate: row.end_date,
    startMissing: !!row.start_missing,
    endMissing: !!row.end_missing,
    state: row.state,
    status: row.status,
    useReserve: !!row.use_reserve,
    progress: row.progress,
    origStartDate: row.orig_start_date,
    route
  };
}

app.get('/api/version', (req, res) => {
  res.json({ version: PLANNER_VERSION });
});

app.get('/api/state', (req, res) => {
  const data = getCurrentState();
  if (!data) {
    res.json({ version: PLANNER_VERSION, updatedAt: null, state: null });
    return;
  }
  res.json(data);
});

app.get('/api/tasks', (req, res) => {
  const stage = req.query.stage ? String(req.query.stage).trim() : null;
  const stmt = stage
    ? db.prepare('SELECT * FROM planner_tasks WHERE stage = ? ORDER BY (start_date IS NULL), start_date, uid')
    : db.prepare('SELECT * FROM planner_tasks ORDER BY stage, (start_date IS NULL), start_date, uid');
  const rows = stage ? stmt.all(stage) : stmt.all();
  res.json({ items: rows.map(mapTaskRow) });
});

app.get('/api/history', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
  const rows = db.prepare('SELECT id, version, created_at FROM planner_history ORDER BY id DESC LIMIT ?').all(limit);
  res.json({ history: rows });
});

app.post('/api/state', (req, res) => {
  try {
    const { state, version } = req.body || {};
    if (!state) {
      res.status(400).json({ error: 'Missing "state" in request body' });
      return;
    }
    const normalized = normalizeState(state);
    const ver = typeof version === 'string' && version.trim() ? version.trim() : (state.version || PLANNER_VERSION);
    const updatedAt = persistState(normalized, ver, state);
    res.json({ ok: true, version: ver, updatedAt });
  } catch (err) {
    console.error('Failed to persist state', err);
    res.status(400).json({ error: err.message || 'Invalid payload' });
  }
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: PLANNER_VERSION });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(STATIC_ROOT, 'Planner_v2.html'));
});

app.get('/Planner_v2.html', (req, res) => {
  res.sendFile(path.join(STATIC_ROOT, 'Planner_v2.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unexpected error', err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Planner server ${PLANNER_VERSION} listening on port ${PORT}`);
    console.log(`Using database file: ${DB_PATH}`);
  });
}

module.exports = { app, db, persistState, getCurrentState, PLANNER_VERSION };
