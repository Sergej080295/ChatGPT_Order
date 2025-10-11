'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

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

const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb' }));

const sseClients = new Set();
let cachedState = null;
let cachedStateRev = null;
let lastRevision = 0;
let revisionColumnInfo = null;
function normalizeWeakEtag(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const hasWeak = trimmed.length >= 2 && (trimmed[0] === 'W' || trimmed[0] === 'w') && trimmed[1] === '/';
  const withoutWeak = hasWeak ? trimmed.slice(2) : trimmed;
  const stripped = withoutWeak.replace(/^"|"$/g, '');
  return stripped || null;
}

function parseIfMatchHeader(value) {
  if (!value) {
    return { any: false, hash: null };
  }
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') {
      return { any: true, hash: null };
    }
    const normalized = normalizeWeakEtag(token);
    if (normalized && normalized !== '*') {
      return { any: false, hash: normalized };
    }
  }
  return { any: false, hash: null };
}

function parseIfMatchRevision(value) {
  const parsed = parseIfMatchHeader(value);
  if (!parsed.hash) return null;
  const match = /^rev-(\d+)$/.exec(parsed.hash);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function weakEtagForRevision(rev) {
  if (!Number.isFinite(rev) || rev <= 0) return null;
  return `W/"rev-${rev}"`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function readMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort()
    .map((filename) => ({
      filename,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
    }));
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = readMigrations();
    for (const migration of migrations) {
      const { rows } = await client.query('SELECT 1 FROM planner_schema_migrations WHERE filename = $1', [migration.filename]);
      if (rows.length > 0) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO planner_schema_migrations (filename) VALUES ($1)', [migration.filename]);
        await client.query('COMMIT');
        console.log(`Applied migration ${migration.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function getLatestRevision(client) {
  const runner = client || pool;
  const { rows } = await runner.query('SELECT COALESCE(MAX(rev), 0) AS rev FROM revisions');
  const rev = rows.length > 0 ? Number(rows[0].rev || 0) : 0;
  lastRevision = Math.max(lastRevision, rev);
  return rev;
}

async function loadRevisionColumnInfo(runner) {
  if (revisionColumnInfo) {
    return revisionColumnInfo;
  }
  const client = runner || pool;
  const { rows } = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'revisions'
  `);
  const columnNames = rows.map((row) => row.column_name);
  revisionColumnInfo = {
    hasCurrentRev: columnNames.includes('current_rev'),
    hasId: columnNames.includes('id')
  };
  return revisionColumnInfo;
}

async function insertRevisionRow(client, rev, actor, source, note) {
  const info = await loadRevisionColumnInfo(client);
  const payload = [rev, actor || null, source || null, note || null];
  if (info.hasCurrentRev) {
    if (info.hasId) {
      await client.query(
        'INSERT INTO revisions (id, rev, current_rev, actor, source, note) VALUES ($1,$1,$1,$2,$3,$4)',
        payload
      );
    } else {
      await client.query(
        'INSERT INTO revisions (rev, current_rev, actor, source, note) VALUES ($1,$1,$2,$3,$4)',
        payload
      );
    }
  } else if (info.hasId) {
    await client.query(
      'INSERT INTO revisions (id, rev, actor, source, note) VALUES ($1,$1,$2,$3,$4)',
      payload
    );
  } else {
    await client.query(
      'INSERT INTO revisions (rev, actor, source, note) VALUES ($1,$2,$3,$4)',
      payload
    );
  }
}

async function ensureSettingsDefaults(runner) {
  let client = runner;
  let ownedClient = false;
  let startedTransaction = false;
  if (typeof client.release !== 'function') {
    client = await pool.connect();
    ownedClient = true;
  }

  const insertDefaults = async () => {
    await client.query('INSERT INTO settings_autoweight (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await client.query('INSERT INTO settings_journal (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await client.query('INSERT INTO settings_admin (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  };

  try {
    const { rows } = await client.query(`
      SELECT
        EXISTS (SELECT 1 FROM settings_autoweight WHERE id = 1) AS has_autoweight,
        EXISTS (SELECT 1 FROM settings_journal WHERE id = 1) AS has_journal,
        EXISTS (SELECT 1 FROM settings_admin WHERE id = 1) AS has_admin
    `);
    const status = rows[0] || { has_autoweight: false, has_journal: false, has_admin: false };
    if (status.has_autoweight && status.has_journal && status.has_admin) {
      return;
    }

    const { rows: revRows } = await client.query("SELECT current_setting('app.rev', true) AS rev");
    const hasRevisionContext = Boolean(revRows.length > 0 && revRows[0].rev);
    if (hasRevisionContext) {
      await insertDefaults();
      return;
    }

    if (ownedClient) {
      await client.query('BEGIN');
      startedTransaction = true;
    }

    await runWithRevision(
      client,
      'system',
      'bootstrap',
      'ensure settings defaults',
      async () => {
        await insertDefaults();
      }
    );

    if (startedTransaction) {
      await client.query('COMMIT');
      startedTransaction = false;
    }
  } catch (err) {
    if (startedTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Failed to rollback defaults bootstrap transaction', rollbackErr);
      }
    }
    throw err;
  } finally {
    if (ownedClient) {
      client.release();
    }
  }
}
function mapSettingsRows(rows) {
  return rows.map((row) => ({
    crmStage: row.crm_stage,
    plannerProcessId: row.planner_process_id,
    isIgnored: row.is_ignored,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  }));
}

function mapColumnWidths(rows) {
  const result = {};
  rows.forEach((row) => {
    if (!row.column_key) return;
    result[row.column_key] = {
      widthPx: row.width_px,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  });
  return result;
}

function mapExcludedStatuses(rows) {
  return rows.map((row) => ({
    statusKey: row.status_key,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
  }));
}

function mapCustomers(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    crmId: row.crm_id
  }));
}

function mapOrders(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    crmOrderId: row.crm_order_id,
    number: row.number,
    customerId: row.customer_id ? Number(row.customer_id) : null,
    customerName: row.customer_name || null,
    customerCrmId: row.customer_crm_id || null,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null
  }));
}

function mapOrderProcesses(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    orderId: Number(row.order_id),
    processId: Number(row.process_id),
    processCode: row.process_code,
    processName: row.process_name,
    seq: Number(row.seq),
    plannedStart: row.planned_start ? new Date(row.planned_start).toISOString() : null,
    plannedEnd: row.planned_end ? new Date(row.planned_end).toISOString() : null,
    actualStart: row.actual_start ? new Date(row.actual_start).toISOString() : null,
    actualEnd: row.actual_end ? new Date(row.actual_end).toISOString() : null,
    progress: Number(row.progress),
    isDone: row.is_done === true,
    positionIndex: row.position_index !== null ? Number(row.position_index) : null,
    hiddenByState: row.hidden_by_state === true,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  }));
}

function mapCapacity(rows) {
  return rows.map((row) => ({
    processId: Number(row.process_id),
    day: row.day ? new Date(row.day).toISOString().slice(0, 10) : null,
    minutes: Number(row.minutes)
  }));
}

async function loadStateFromSql(client) {
  const runner = client || pool;
  await ensureSettingsDefaults(runner);
  const rev = await getLatestRevision(runner);

  const [processesRes, autoweightRes, journalRes, columnWidthsRes, mappingRes, adminRes, excludedRes, customersRes, ordersRes, orderProcessesRes, capacityRes] = await Promise.all([
    runner.query('SELECT id, code, name, position, has_hours, is_parallel, is_active FROM processes ORDER BY position, id'),
    runner.query('SELECT enabled, percent, minimum_hours, updated_at FROM settings_autoweight WHERE id = 1'),
    runner.query('SELECT max_rows, updated_at FROM settings_journal WHERE id = 1'),
    runner.query('SELECT column_key, width_px, updated_at FROM settings_column_widths'),
    runner.query('SELECT crm_stage, planner_process_id, is_ignored, updated_at FROM settings_mapping ORDER BY crm_stage'),
    runner.query('SELECT allow_force_overwrite, snapshot_retention, updated_at FROM settings_admin WHERE id = 1'),
    runner.query('SELECT status_key, created_at FROM excluded_statuses ORDER BY status_key'),
    runner.query('SELECT id, name, crm_id FROM customers ORDER BY name, id'),
    runner.query(`
      SELECT o.id, o.crm_order_id, o.number, o.customer_id, o.status, o.created_at, o.updated_at, o.deleted_at,
             c.name AS customer_name, c.crm_id AS customer_crm_id
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        ORDER BY o.created_at, o.id
    `),
    runner.query(`
      SELECT op.id, op.order_id, op.process_id, op.seq, op.planned_start, op.planned_end,
             op.actual_start, op.actual_end, op.progress, op.is_done, op.position_index,
             op.hidden_by_state, op.updated_at,
             p.code AS process_code, p.name AS process_name
        FROM order_process op
        JOIN processes p ON p.id = op.process_id
        ORDER BY p.position, op.position_index NULLS LAST, op.seq, op.id
    `),
    runner.query('SELECT process_id, day, minutes FROM capacity_by_process ORDER BY process_id, day')
  ]);

  const processes = processesRes.rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    name: row.name,
    position: Number(row.position),
    hasHours: row.has_hours === true,
    isParallel: row.is_parallel === true,
    isActive: row.is_active === true
  }));

  const autoweightRow = autoweightRes.rows[0] || null;
  const journalRow = journalRes.rows[0] || null;
  const adminRow = adminRes.rows[0] || null;

  const state = {
    rev,
    processes,
    customers: mapCustomers(customersRes.rows),
    orders: mapOrders(ordersRes.rows),
    orderProcesses: mapOrderProcesses(orderProcessesRes.rows),
    capacityByProcess: mapCapacity(capacityRes.rows),
    settings: {
      autoweight: autoweightRow ? {
        enabled: autoweightRow.enabled === true,
        percent: Number(autoweightRow.percent || 0),
        minimumHours: Number(autoweightRow.minimum_hours || 0),
        updatedAt: autoweightRow.updated_at ? new Date(autoweightRow.updated_at).toISOString() : null
      } : { enabled: false, percent: 0, minimumHours: 0, updatedAt: null },
      journal: journalRow ? {
        maxRows: Number(journalRow.max_rows || 0),
        updatedAt: journalRow.updated_at ? new Date(journalRow.updated_at).toISOString() : null
      } : { maxRows: 0, updatedAt: null },
      columnWidths: mapColumnWidths(columnWidthsRes.rows),
      mapping: mapSettingsRows(mappingRes.rows),
      admin: adminRow ? {
        allowForceOverwrite: adminRow.allow_force_overwrite === true,
        snapshotRetention: Number(adminRow.snapshot_retention || 0),
        updatedAt: adminRow.updated_at ? new Date(adminRow.updated_at).toISOString() : null
      } : { allowForceOverwrite: false, snapshotRetention: 0, updatedAt: null }
    },
    excludedStatuses: mapExcludedStatuses(excludedRes.rows)
  };

  return state;
}

async function getCachedState() {
  if (cachedState && cachedStateRev === lastRevision) {
    return cachedState;
  }
  const state = await loadStateFromSql();
  cachedState = state;
  cachedStateRev = state.rev;
  return state;
}

function invalidateCache() {
  cachedState = null;
}
function broadcastRevision(event) {
  const payload = JSON.stringify({ type: 'revision', ...event });
  sseClients.forEach((client) => {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.warn('Failed to push SSE event', err);
    }
  });
}

async function runWithRevision(client, actor, source, note, handler) {
  const { rows } = await client.query('SELECT nextval(\'revisions_rev_seq\') AS rev');
  const rev = Number(rows[0].rev);
  await client.query(`SET LOCAL app.rev = ${rev}`);
  await insertRevisionRow(client, rev, actor, source, note);
  await handler(rev);
  lastRevision = Math.max(lastRevision, rev);
  return rev;
}

async function insertActivity(client, rev, actor, source, action, details) {
  await client.query(
    'INSERT INTO activity_log (rev, ts, actor, source, action, entity_type, entity_id, details) VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)',
    [rev, actor || null, source || action, action, null, null, details || null]
  );
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}
async function applySettingsChanges(client, changes) {
  await ensureSettingsDefaults(client);
  const details = [];
  if (isPlainObject(changes.autoweight)) {
    const enabled = parseBoolean(changes.autoweight.enabled, false);
    const percent = parseInteger(changes.autoweight.percent, 0);
    const minimumHours = parseInteger(changes.autoweight.minimumHours, 0);
    await client.query(
      `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
       VALUES (1,$1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             percent = EXCLUDED.percent,
             minimum_hours = EXCLUDED.minimum_hours,
             updated_at = NOW()`,
      [enabled, percent, minimumHours]
    );
    details.push('settings.autoweight');
  }

  if (isPlainObject(changes.journal)) {
    const maxRows = parseInteger(changes.journal.maxRows, null);
    if (maxRows !== null) {
      await client.query(
        `INSERT INTO settings_journal (id, max_rows, updated_at)
         VALUES (1,$1,NOW())
         ON CONFLICT (id) DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()`,
        [maxRows]
      );
      details.push('settings.journal');
    }
  }

  if (changes.columnWidths) {
    const entries = Array.isArray(changes.columnWidths)
      ? changes.columnWidths
      : isPlainObject(changes.columnWidths)
        ? Object.entries(changes.columnWidths).map(([columnKey, widthPx]) => ({ columnKey, widthPx }))
        : [];
    for (const entry of entries) {
      if (!entry) continue;
      const columnKey = typeof entry.columnKey === 'string' ? entry.columnKey.trim() : String(entry.key || '').trim();
      if (!columnKey) continue;
      const width = parseInteger(entry.widthPx ?? entry.width, null);
      if (width === null) continue;
      await client.query(
        `INSERT INTO settings_column_widths (column_key, width_px, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (column_key) DO UPDATE SET width_px = EXCLUDED.width_px, updated_at = NOW()`,
        [columnKey, width]
      );
    }
    if (entries.length > 0) {
      details.push(`settings.columnWidths(${entries.length})`);
    }
    const removals = Array.isArray(changes.columnWidthsRemove) ? changes.columnWidthsRemove : [];
    if (removals.length > 0) {
      for (const key of removals) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (!normalized) continue;
        await client.query('DELETE FROM settings_column_widths WHERE column_key = $1', [normalized]);
      }
      details.push(`settings.columnWidthsRemoved(${removals.length})`);
    }
  }

  if (changes.mapping) {
    const entries = Array.isArray(changes.mapping.entries)
      ? changes.mapping.entries
      : Array.isArray(changes.mapping)
        ? changes.mapping
        : [];
    for (const entry of entries) {
      if (!entry) continue;
      const crmStageRaw = entry.crmStage ?? entry.crm_stage ?? entry.stage;
      const crmStage = typeof crmStageRaw === 'string' ? crmStageRaw.trim().toLowerCase() : '';
      if (!crmStage) continue;
      const plannerProcessId = entry.plannerProcessId ?? entry.processId ?? entry.planner_process_id ?? null;
      const processId = plannerProcessId === null || plannerProcessId === undefined
        ? null
        : Number(plannerProcessId);
      const isIgnored = parseBoolean(entry.isIgnored ?? entry.ignore, false);
      await client.query(
        `INSERT INTO settings_mapping (crm_stage, planner_process_id, is_ignored, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (crm_stage) DO UPDATE
           SET planner_process_id = EXCLUDED.planner_process_id,
               is_ignored = EXCLUDED.is_ignored,
               updated_at = NOW()`,
        [crmStage, isIgnored ? null : processId, isIgnored]
      );
    }
    const removals = Array.isArray(changes.mapping.remove) ? changes.mapping.remove : [];
    for (const key of removals) {
      const normalized = typeof key === 'string' ? key.trim().toLowerCase() : '';
      if (!normalized) continue;
      await client.query('DELETE FROM settings_mapping WHERE crm_stage = $1', [normalized]);
    }
    if (entries.length > 0 || removals.length > 0) {
      details.push(`settings.mapping(upserts=${entries.length}, removals=${removals.length})`);
    }
  }

  if (isPlainObject(changes.admin)) {
    const allowForce = parseBoolean(changes.admin.allowForceOverwrite, null);
    const retention = parseInteger(changes.admin.snapshotRetention, null);
    const setClauses = [];
    const values = [];
    if (allowForce !== null) {
      setClauses.push(`allow_force_overwrite = $${values.length + 1}`);
      values.push(allowForce);
    }
    if (retention !== null) {
      setClauses.push(`snapshot_retention = $${values.length + 1}`);
      values.push(retention);
    }
    if (setClauses.length > 0) {
      setClauses.push('updated_at = NOW()');
      await client.query(
        `UPDATE settings_admin SET ${setClauses.join(', ')} WHERE id = 1`,
        values
      );
      details.push('settings.admin');
    }
  }

  if (changes.excludedStatuses) {
    const additions = Array.isArray(changes.excludedStatuses.add) ? changes.excludedStatuses.add : [];
    const removals = Array.isArray(changes.excludedStatuses.remove) ? changes.excludedStatuses.remove : [];
    for (const status of additions) {
      const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
      if (!normalized) continue;
      await client.query(
        `INSERT INTO excluded_statuses (status_key, created_at)
         VALUES ($1, NOW())
         ON CONFLICT (status_key) DO NOTHING`,
        [normalized]
      );
    }
    for (const status of removals) {
      const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
      if (!normalized) continue;
      await client.query('DELETE FROM excluded_statuses WHERE status_key = $1', [normalized]);
    }
    if (additions.length > 0 || removals.length > 0) {
      details.push(`settings.excludedStatuses(+${additions.length}/-${removals.length})`);
    }
  }

  if (changes.processes) {
    const entries = Array.isArray(changes.processes.upsert)
      ? changes.processes.upsert
      : Array.isArray(changes.processes)
        ? changes.processes
        : [];
    for (const entry of entries) {
      if (!entry) continue;
      const code = typeof entry.code === 'string' ? entry.code.trim() : '';
      if (!code) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : code;
      const position = parseInteger(entry.position, 0);
      const hasHours = parseBoolean(entry.hasHours ?? entry.has_hours, true);
      const isParallel = parseBoolean(entry.isParallel ?? entry.is_parallel, false);
      const isActive = parseBoolean(entry.isActive ?? entry.is_active, true);
      if (entry.id) {
        await client.query(
          `UPDATE processes
             SET code = $2,
                 name = $3,
                 position = $4,
                 has_hours = $5,
                 is_parallel = $6,
                 is_active = $7
           WHERE id = $1`,
          [Number(entry.id), code, name, position, hasHours, isParallel, isActive]
        );
      } else {
        await client.query(
          `INSERT INTO processes (code, name, position, has_hours, is_parallel, is_active)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name,
                 position = EXCLUDED.position,
                 has_hours = EXCLUDED.has_hours,
                 is_parallel = EXCLUDED.is_parallel,
                 is_active = EXCLUDED.is_active`,
          [code, name, position, hasHours, isParallel, isActive]
        );
      }
    }
    const removals = Array.isArray(changes.processes.remove) ? changes.processes.remove : [];
    for (const id of removals) {
      const normalized = parseInteger(id, null);
      if (normalized === null) continue;
      await client.query('DELETE FROM processes WHERE id = $1', [normalized]);
    }
    if (entries.length > 0 || removals.length > 0) {
      details.push(`processes(upserts=${entries.length}, removals=${removals.length})`);
    }
  }

  return details;
}
async function applyOrderUpsert(client, entry, allowedFields) {
  if (!isPlainObject(entry)) return null;
  const id = parseInteger(entry.id, null);
  const crmOrderId = entry.crmOrderId ?? entry.crm_order_id ?? null;
  const number = entry.number ?? entry.orderNo ?? entry.order_no ?? null;
  const status = entry.status ?? null;
  const customerId = entry.customerId ?? entry.customer_id ?? null;
  const deletedAt = entry.deletedAt ?? entry.deleted_at ?? null;
  const updates = [];
  const values = [];
  if (allowedFields.has('crm_order_id') && crmOrderId !== undefined) {
    updates.push(`crm_order_id = $${values.length + 1}`);
    values.push(crmOrderId);
  }
  if (allowedFields.has('number') && number !== undefined) {
    updates.push(`number = $${values.length + 1}`);
    values.push(number);
  }
  if (allowedFields.has('status') && status !== undefined) {
    updates.push(`status = $${values.length + 1}`);
    values.push(status);
  }
  if (allowedFields.has('customer_id') && customerId !== undefined) {
    updates.push(`customer_id = $${values.length + 1}`);
    values.push(customerId);
  }
  if (allowedFields.has('deleted_at') && deletedAt !== undefined) {
    updates.push(`deleted_at = $${values.length + 1}`);
    values.push(deletedAt ? new Date(deletedAt) : null);
  }
  if (id !== null) {
    if (updates.length > 0) {
      await client.query(`UPDATE orders SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length + 1}`, [...values, id]);
      return 'update';
    }
    return null;
  }
  if (!allowedFields.has('insert')) {
    return null;
  }
  if (!number) {
    return null;
  }
  const insertColumns = ['number'];
  const insertValues = [number];
  if (crmOrderId !== undefined) {
    insertColumns.push('crm_order_id');
    insertValues.push(crmOrderId);
  }
  if (status !== undefined) {
    insertColumns.push('status');
    insertValues.push(status);
  }
  if (customerId !== undefined) {
    insertColumns.push('customer_id');
    insertValues.push(customerId);
  }
  if (deletedAt !== undefined) {
    insertColumns.push('deleted_at');
    insertValues.push(deletedAt ? new Date(deletedAt) : null);
  }
  const placeholders = insertValues.map((_, idx) => `$${idx + 1}`);
  await client.query(
    `INSERT INTO orders (${insertColumns.join(',')}) VALUES (${placeholders.join(',')})`,
    insertValues
  );
  return 'insert';
}

function buildOrderProcessAssignments(entry, allowedFields) {
  const assignments = [];
  const values = [];
  if (allowedFields.has('process_id') && entry.processId !== undefined) {
    assignments.push(`process_id = $${assignments.length + 1}`);
    values.push(Number(entry.processId));
  }
  if (allowedFields.has('order_id') && entry.orderId !== undefined) {
    assignments.push(`order_id = $${assignments.length + 1}`);
    values.push(Number(entry.orderId));
  }
  if (allowedFields.has('seq') && entry.seq !== undefined) {
    assignments.push(`seq = $${assignments.length + 1}`);
    values.push(Number(entry.seq));
  }
  if (allowedFields.has('planned_start') && entry.plannedStart !== undefined) {
    assignments.push(`planned_start = $${assignments.length + 1}`);
    values.push(entry.plannedStart ? new Date(entry.plannedStart) : null);
  }
  if (allowedFields.has('planned_end') && entry.plannedEnd !== undefined) {
    assignments.push(`planned_end = $${assignments.length + 1}`);
    values.push(entry.plannedEnd ? new Date(entry.plannedEnd) : null);
  }
  if (allowedFields.has('actual_start') && entry.actualStart !== undefined) {
    assignments.push(`actual_start = $${assignments.length + 1}`);
    values.push(entry.actualStart ? new Date(entry.actualStart) : null);
  }
  if (allowedFields.has('actual_end') && entry.actualEnd !== undefined) {
    assignments.push(`actual_end = $${assignments.length + 1}`);
    values.push(entry.actualEnd ? new Date(entry.actualEnd) : null);
  }
  if (allowedFields.has('progress') && entry.progress !== undefined) {
    assignments.push(`progress = $${assignments.length + 1}`);
    values.push(Number(entry.progress));
  }
  if (allowedFields.has('is_done') && entry.isDone !== undefined) {
    assignments.push(`is_done = $${assignments.length + 1}`);
    values.push(parseBoolean(entry.isDone));
  }
  if (allowedFields.has('position_index') && entry.positionIndex !== undefined) {
    assignments.push(`position_index = $${assignments.length + 1}`);
    values.push(entry.positionIndex === null || entry.positionIndex === undefined ? null : Number(entry.positionIndex));
  }
  if (allowedFields.has('hidden_by_state') && entry.hiddenByState !== undefined) {
    assignments.push(`hidden_by_state = $${assignments.length + 1}`);
    values.push(parseBoolean(entry.hiddenByState));
  }
  return { assignments, values };
}

async function applyOrderProcessUpsert(client, entry, allowedFields) {
  if (!isPlainObject(entry)) return null;
  const id = parseInteger(entry.id, null);
  const { assignments, values } = buildOrderProcessAssignments(entry, allowedFields);
  if (id !== null) {
    if (assignments.length === 0) {
      return null;
    }
    assignments.push(`updated_at = NOW()`);
    await client.query(
      `UPDATE order_process SET ${assignments.join(', ')} WHERE id = $${values.length + 1}`,
      [...values, id]
    );
    return 'update';
  }
  if (!allowedFields.has('insert')) {
    return null;
  }
  if (entry.orderId === undefined || entry.processId === undefined) {
    return null;
  }
  const insertColumns = ['order_id', 'process_id'];
  const insertValues = [Number(entry.orderId), Number(entry.processId)];
  const optionalAssignments = buildOrderProcessAssignments(entry, new Set([
    'seq', 'planned_start', 'planned_end', 'actual_start', 'actual_end', 'progress', 'is_done', 'position_index', 'hidden_by_state'
  ]));
  optionalAssignments.assignments.forEach((assignment, idx) => {
    const column = assignment.split('=')[0].trim();
    insertColumns.push(column);
    insertValues.push(optionalAssignments.values[idx]);
  });
  const placeholders = insertValues.map((_, idx) => `$${idx + 1}`);
  await client.query(
    `INSERT INTO order_process (${insertColumns.join(',')}) VALUES (${placeholders.join(',')})`,
    insertValues
  );
  return 'insert';
}
async function applyCrmChanges(client, changes) {
  const details = [];
  const allowedOrderFields = new Set(['crm_order_id', 'status', 'deleted_at', 'customer_id']);
  const allowedProcessFields = new Set(['actual_start', 'actual_end', 'progress', 'is_done', 'hidden_by_state']);

  const orders = Array.isArray(changes.orders) ? changes.orders : [];
  let orderUpdates = 0;
  for (const entry of orders) {
    const action = await applyOrderUpsert(client, entry, allowedOrderFields);
    if (action) orderUpdates += 1;
  }
  if (orderUpdates > 0) {
    details.push(`orders(${orderUpdates})`);
  }

  const processes = Array.isArray(changes.orderProcesses) ? changes.orderProcesses : [];
  let processUpdates = 0;
  for (const entry of processes) {
    const action = await applyOrderProcessUpsert(client, entry, allowedProcessFields);
    if (action) processUpdates += 1;
  }
  if (processUpdates > 0) {
    details.push(`orderProcesses(${processUpdates})`);
  }

  return details;
}

async function applyPlannerChanges(client, changes) {
  const details = [];
  const allowedOrderFields = new Set(['status', 'deleted_at']);
  const allowedProcessFields = new Set([
    'process_id', 'order_id', 'seq', 'planned_start', 'planned_end', 'progress', 'is_done', 'position_index', 'hidden_by_state'
  ]);

  const orders = Array.isArray(changes.orders) ? changes.orders : [];
  let orderUpdates = 0;
  for (const entry of orders) {
    const action = await applyOrderUpsert(client, entry, allowedOrderFields);
    if (action) orderUpdates += 1;
  }
  if (orderUpdates > 0) {
    details.push(`orders(${orderUpdates})`);
  }

  const upserts = Array.isArray(changes.orderProcesses?.upsert)
    ? changes.orderProcesses.upsert
    : Array.isArray(changes.orderProcesses)
      ? changes.orderProcesses
      : [];
  let processUpserts = 0;
  for (const entry of upserts) {
    const action = await applyOrderProcessUpsert(client, entry, allowedProcessFields);
    if (action) processUpserts += 1;
  }
  const deletions = Array.isArray(changes.orderProcesses?.delete)
    ? changes.orderProcesses.delete
    : [];
  for (const id of deletions) {
    const normalized = parseInteger(id, null);
    if (normalized === null) continue;
    await client.query('DELETE FROM order_process WHERE id = $1', [normalized]);
    processUpserts += 1;
  }
  if (processUpserts > 0) {
    details.push(`orderProcesses(${processUpserts})`);
  }

  return details;
}

async function applyAdminChanges(client, changes) {
  const details = [];
  if (changes.capacityByProcess) {
    const entries = Array.isArray(changes.capacityByProcess) ? changes.capacityByProcess : [];
    for (const entry of entries) {
      if (!entry) continue;
      const processId = parseInteger(entry.processId ?? entry.process_id, null);
      if (processId === null) continue;
      const day = entry.day ? new Date(entry.day) : null;
      const minutes = parseInteger(entry.minutes, null);
      if (!day || minutes === null) continue;
      await client.query(
        `INSERT INTO capacity_by_process (process_id, day, minutes)
         VALUES ($1,$2,$3)
         ON CONFLICT (process_id, day) DO UPDATE SET minutes = EXCLUDED.minutes`,
        [processId, day, minutes]
      );
    }
    details.push(`capacityByProcess(${entries.length})`);
  }
  if (changes.capacityByProcessRemove) {
    const entries = Array.isArray(changes.capacityByProcessRemove) ? changes.capacityByProcessRemove : [];
    for (const entry of entries) {
      const processId = parseInteger(entry.processId ?? entry.process_id, null);
      if (processId === null) continue;
      const day = entry.day ? new Date(entry.day) : null;
      if (!day) continue;
      await client.query('DELETE FROM capacity_by_process WHERE process_id = $1 AND day = $2', [processId, day]);
    }
    if (entries.length > 0) {
      details.push(`capacityByProcessRemoved(${entries.length})`);
    }
  }
  return details;
}

async function applyChangesByStage(client, stage, changes) {
  switch (stage) {
    case 'settings':
      return applySettingsChanges(client, changes || {});
    case 'crm':
      return applyCrmChanges(client, changes || {});
    case 'planner':
      return applyPlannerChanges(client, changes || {});
    case 'admin':
      return applyAdminChanges(client, changes || {});
    default:
      return [];
  }
}

async function fetchAdminSettings(client) {
  await ensureSettingsDefaults(client);
  const { rows } = await client.query('SELECT allow_force_overwrite FROM settings_admin WHERE id = 1');
  return rows.length > 0 && rows[0].allow_force_overwrite === true;
}

function parseBaseRev(baseRev) {
  if (baseRev === null || baseRev === undefined || baseRev === '') return null;
  const num = Number.parseInt(baseRev, 10);
  return Number.isFinite(num) ? num : null;
}

async function resetSequence(client, tableName, column) {
  const { rows } = await client.query('SELECT pg_get_serial_sequence($1, $2) AS seq', [tableName, column]);
  if (rows.length === 0 || !rows[0].seq) {
    return;
  }
  await client.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${column}) FROM ${tableName}), 0))`,
    [rows[0].seq]
  );
}

async function snapshotTableAtRevision(client, tableName, keyColumns, targetRev) {
  const columnsSql = keyColumns.map((column) => `${column}`).join(', ');
  const { rows } = await client.query(
    `SELECT DISTINCT ON (${columnsSql}) *
       FROM ${tableName}_hist
      WHERE rev <= $1
      ORDER BY ${columnsSql}, rev DESC, changed_at DESC`,
    [targetRev]
  );
  return rows;
}

async function buildSnapshotForRevision(client, targetRev) {
  const orders = await snapshotTableAtRevision(client, 'orders', ['id'], targetRev);
  const orderProcesses = await snapshotTableAtRevision(client, 'order_process', ['id'], targetRev);
  const capacities = await snapshotTableAtRevision(client, 'capacity_by_process', ['process_id', 'day'], targetRev);
  const autoWeight = await snapshotTableAtRevision(client, 'settings_autoweight', ['id'], targetRev);
  const journal = await snapshotTableAtRevision(client, 'settings_journal', ['id'], targetRev);
  const columnWidths = await snapshotTableAtRevision(client, 'settings_column_widths', ['column_key'], targetRev);
  const mapping = await snapshotTableAtRevision(client, 'settings_mapping', ['crm_stage'], targetRev);
  const admin = await snapshotTableAtRevision(client, 'settings_admin', ['id'], targetRev);
  const excluded = await snapshotTableAtRevision(client, 'excluded_statuses', ['status_key'], targetRev);

  return {
    orders,
    orderProcesses,
    capacities,
    autoWeight,
    journal,
    columnWidths,
    mapping,
    admin,
    excluded
  };
}

async function applySnapshot(client, snapshot) {
  await client.query('DELETE FROM order_process');
  await client.query('DELETE FROM orders');
  await client.query('DELETE FROM capacity_by_process');
  await client.query('DELETE FROM settings_column_widths');
  await client.query('DELETE FROM settings_mapping');
  await client.query('DELETE FROM excluded_statuses');
  await client.query('DELETE FROM settings_autoweight');
  await client.query('DELETE FROM settings_journal');
  await client.query('DELETE FROM settings_admin');

  for (const row of snapshot.orders) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO orders (id, crm_order_id, number, customer_id, status, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.id, row.crm_order_id, row.number, row.customer_id, row.status, row.created_at, row.updated_at, row.deleted_at]
    );
  }

  for (const row of snapshot.orderProcesses) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO order_process (id, order_id, process_id, seq, planned_start, planned_end, actual_start, actual_end,
        progress, is_done, position_index, hidden_by_state, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        row.id,
        row.order_id,
        row.process_id,
        row.seq,
        row.planned_start,
        row.planned_end,
        row.actual_start,
        row.actual_end,
        row.progress,
        row.is_done,
        row.position_index,
        row.hidden_by_state,
        row.updated_at
      ]
    );
  }

  for (const row of snapshot.capacities) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO capacity_by_process (process_id, day, minutes) VALUES ($1,$2,$3)`,
      [row.process_id, row.day, row.minutes]
    );
  }

  for (const row of snapshot.autoWeight) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [row.id, row.enabled, row.percent, row.minimum_hours, row.updated_at]
    );
  }

  for (const row of snapshot.journal) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at) VALUES ($1,$2,$3)`,
      [row.id, row.max_rows, row.updated_at]
    );
  }

  for (const row of snapshot.admin) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, updated_at)
       VALUES ($1,$2,$3,$4)`,
      [row.id, row.allow_force_overwrite, row.snapshot_retention, row.updated_at]
    );
  }

  for (const row of snapshot.columnWidths) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO settings_column_widths (column_key, width_px, updated_at) VALUES ($1,$2,$3)`,
      [row.column_key, row.width_px, row.updated_at]
    );
  }

  for (const row of snapshot.mapping) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO settings_mapping (crm_stage, planner_process_id, is_ignored, updated_at)
       VALUES ($1,$2,$3,$4)`,
      [row.crm_stage, row.planner_process_id, row.is_ignored, row.updated_at]
    );
  }

  for (const row of snapshot.excluded) {
    if (row.op === 'D') continue;
    await client.query(
      `INSERT INTO excluded_statuses (status_key, created_at) VALUES ($1,$2)`,
      [row.status_key, row.created_at]
    );
  }

  await resetSequence(client, 'orders', 'id');
  await resetSequence(client, 'order_process', 'id');
  await ensureSettingsDefaults(client);
}
app.get('/api/state', async (req, res) => {
  try {
    const state = await getCachedState();
    const etag = weakEtagForRevision(state.rev);
    if (etag && req.headers['if-none-match']) {
      const match = parseIfMatchHeader(req.headers['if-none-match']);
      if (match.hash && match.hash.toLowerCase() === etag.replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase()) {
        res.status(304).end();
        return;
      }
    }
    if (etag) {
      res.setHeader('ETag', etag);
    }
    res.json(state);
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
  try {
    const state = await getCachedState();
    res.write(`data: ${JSON.stringify({ type: 'revision', rev: state.rev, source: 'bootstrap' })}\n\n`);
  } catch (err) {
    console.error('Initial SSE push failed', err);
  }
});

app.put('/api/state', async (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }
  const stage = typeof req.body.stage === 'string' ? req.body.stage.trim().toLowerCase() : null;
  if (!stage || !['crm', 'planner', 'settings', 'admin'].includes(stage)) {
    res.status(400).json({ error: 'Invalid stage' });
    return;
  }
  const baseRevFromBody = parseBaseRev(req.body.baseRev ?? req.body.base_rev ?? null);
  const baseRevFromHeader = parseIfMatchRevision(req.headers['if-match']);
  const baseRev = baseRevFromBody !== null ? baseRevFromBody : baseRevFromHeader;
  const forceOverwriteRequested = req.body.forceOverwrite === true || req.body.force_overwrite === true;
  const actor = typeof req.body.actor === 'string' ? req.body.actor : null;
  const source = typeof req.body.source === 'string' ? req.body.source : stage;
  const note = typeof req.body.note === 'string' ? req.body.note : null;
  const changes = req.body.changes || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentRev = await getLatestRevision(client);
    const allowForceOverwrite = await fetchAdminSettings(client);
    const expectedRev = baseRev !== null ? baseRev : currentRev;
    if (!forceOverwriteRequested || !allowForceOverwrite) {
      if (expectedRev !== currentRev) {
        await client.query('ROLLBACK');
        res.status(412).json({ error: 'Precondition Failed', currentRev });
        return;
      }
    }

    const rev = await runWithRevision(client, actor, source, note, async (newRev) => {
      const details = await applyChangesByStage(client, stage, changes);
      if (details.length > 0) {
        await insertActivity(client, newRev, actor, source, stage, details.join('; '));
      } else {
        await insertActivity(client, newRev, actor, source, stage, 'no-op');
      }
    });

    await client.query('COMMIT');
    invalidateCache();
    const etag = weakEtagForRevision(rev);
    if (etag) {
      res.setHeader('ETag', etag);
    }
    broadcastRevision({ rev, actor, source, note });
    res.json({ rev });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/state failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});
app.get('/api/admin/history', async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInteger(req.query.limit, 50)));
  const offset = Math.max(0, parseInteger(req.query.offset, 0));
  try {
    const { rows } = await pool.query(
      `SELECT r.rev, r.ts, r.actor, r.source, r.note,
              COALESCE(o.cnt,0) AS orders,
              COALESCE(op.cnt,0) AS order_process,
              COALESCE(cap.cnt,0) AS capacity,
              COALESCE(sa.cnt,0) AS settings_autoweight,
              COALESCE(sj.cnt,0) AS settings_journal,
              COALESCE(scw.cnt,0) AS settings_column_widths,
              COALESCE(sm.cnt,0) AS settings_mapping,
              COALESCE(sadmin.cnt,0) AS settings_admin,
              COALESCE(ex.cnt,0) AS excluded_statuses
         FROM revisions r
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM orders_hist GROUP BY rev) o ON o.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM order_process_hist GROUP BY rev) op ON op.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM capacity_by_process_hist GROUP BY rev) cap ON cap.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM settings_autoweight_hist GROUP BY rev) sa ON sa.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM settings_journal_hist GROUP BY rev) sj ON sj.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM settings_column_widths_hist GROUP BY rev) scw ON scw.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM settings_mapping_hist GROUP BY rev) sm ON sm.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM settings_admin_hist GROUP BY rev) sadmin ON sadmin.rev = r.rev
         LEFT JOIN (SELECT rev, COUNT(*) AS cnt FROM excluded_statuses_hist GROUP BY rev) ex ON ex.rev = r.rev
        ORDER BY r.rev DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ items: rows, limit, offset });
  } catch (err) {
    console.error('GET /api/admin/history failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/admin/history/:rev', async (req, res) => {
  const rev = parseInteger(req.params.rev, null);
  if (rev === null) {
    res.status(400).json({ error: 'Invalid revision' });
    return;
  }
  try {
    const [metaRes, ordersRes, orderProcRes, capacityRes, autoRes, journalRes, colRes, mapRes, adminRes, excludedRes] = await Promise.all([
      pool.query('SELECT rev, ts, actor, source, note FROM revisions WHERE rev = $1', [rev]),
      pool.query('SELECT * FROM orders_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM order_process_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM capacity_by_process_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM settings_autoweight_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM settings_journal_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM settings_column_widths_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM settings_mapping_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM settings_admin_hist WHERE rev = $1 ORDER BY changed_at', [rev]),
      pool.query('SELECT * FROM excluded_statuses_hist WHERE rev = $1 ORDER BY changed_at', [rev])
    ]);
    if (metaRes.rows.length === 0) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }
    res.json({
      revision: metaRes.rows[0],
      orders: ordersRes.rows,
      orderProcesses: orderProcRes.rows,
      capacityByProcess: capacityRes.rows,
      settings: {
        autoweight: autoRes.rows,
        journal: journalRes.rows,
        columnWidths: colRes.rows,
        mapping: mapRes.rows,
        admin: adminRes.rows
      },
      excludedStatuses: excludedRes.rows
    });
  } catch (err) {
    console.error('GET /api/admin/history/:rev failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/admin/rollback', async (req, res) => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }
  const targetRev = parseInteger(req.body.targetRev ?? req.body.rev, null);
  if (targetRev === null) {
    res.status(400).json({ error: 'Invalid targetRev' });
    return;
  }
  const actor = typeof req.body.actor === 'string' ? req.body.actor : null;
  const source = typeof req.body.source === 'string' ? req.body.source : 'admin';
  const note = typeof req.body.note === 'string' ? req.body.note : `rollback to ${targetRev}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentRev = await getLatestRevision(client);
    if (targetRev > currentRev) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Target revision is in the future' });
      return;
    }
    const snapshot = await buildSnapshotForRevision(client, targetRev);
    const rev = await runWithRevision(client, actor, source, note, async (newRev) => {
      await applySnapshot(client, snapshot);
      await insertActivity(client, newRev, actor, source, 'rollback', `rollback to ${targetRev}`);
    });
    await client.query('COMMIT');
    invalidateCache();
    const etag = weakEtagForRevision(rev);
    if (etag) {
      res.setHeader('ETag', etag);
    }
    broadcastRevision({ rev, actor, source, note });
    res.json({ rev });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/admin/rollback failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});
app.use(express.static(PUBLIC_DIR, { index: 'Planner_Codex_v3.html' }));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
    return;
  }
  next();
});

async function bootstrap() {
  await runMigrations();
  await ensureSettingsDefaults(pool);
  await getCachedState();
  app.listen(PORT, () => {
    console.log(`Planner SQL bridge listening on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
