#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://planner:planner@localhost:5432/planner';
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined
});

let revisionColumnInfo = null;
const PG_UNDEFINED_TABLE = '42P01';
const SHARED_BOOLEAN_PREF_KEYS = [
  'autosaveOn',
  'shiftOnProgress',
  'autoOptimizeOn',
  'cascadeReadyOn'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeStage(code) {
  if (!code) return null;
  return String(code).trim().toLowerCase();
}

function titleFromCode(code) {
  if (!code) return '';
  return code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeSerializeSnapshot(snapshot, stateString = null) {
  if (typeof stateString === 'string') {
    const trimmed = stateString.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch (err) {
        console.warn('Legacy import: provided state string is invalid JSON, re-stringifying snapshot', err);
      }
    }
  }

  if (typeof snapshot === 'string') {
    const trimmed = snapshot.trim();
    if (!trimmed) {
      return '{}';
    }
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch (err) {
      console.warn('Legacy import: snapshot payload string is invalid JSON, falling back to empty object', err);
      return '{}';
    }
  }

  try {
    return JSON.stringify(snapshot ?? {});
  } catch (err) {
    console.error('Legacy import: failed to stringify snapshot, storing empty object instead', err);
    return '{}';
  }
}

function computeSnapshotHash(snapshot) {
  const serialized = safeSerializeSnapshot(snapshot);
  return crypto.createHash('sha1').update(serialized, 'utf8').digest('hex');
}

function orderKeyFromTask(task) {
  if (!task || typeof task !== 'object') return null;
  const identity = sanitizeString(task.orderIdentity);
  if (identity) return `identity:${identity}`;
  const orderId = sanitizeString(task.orderId);
  if (orderId) return `id:${orderId}`;
  const number = sanitizeString(task.orderNumber);
  if (number) return `number:${number}`;
  const uid = sanitizeString(task.uid);
  if (uid) return `uid:${uid}`;
  return null;
}

function extractSharedPreferences(snapshot) {
  if (!isPlainObject(snapshot)) {
    return [];
  }
  const prefs = [];
  for (const key of SHARED_BOOLEAN_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      prefs.push({ key, value: Boolean(snapshot[key]) });
    }
  }
  return prefs;
}

async function syncSharedPreferences(client, snapshot) {
  const prefs = extractSharedPreferences(snapshot);
  try {
    await client.query('DELETE FROM settings_shared_preferences');
  } catch (err) {
    if (err && err.code === PG_UNDEFINED_TABLE) {
      return;
    }
    throw err;
  }

  if (!prefs.length) {
    return;
  }

  for (const pref of prefs) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO settings_shared_preferences (pref_key, bool_value, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (pref_key) DO UPDATE
         SET bool_value = EXCLUDED.bool_value,
             updated_at = NOW()` ,
      [pref.key, pref.value]
    );
  }
}

async function loadRevisionColumnInfo(client) {
  if (revisionColumnInfo) {
    return revisionColumnInfo;
  }
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
  const actorValue = actor || null;
  const sourceValue = source || null;
  const noteValue = note || null;

  if (info.hasCurrentRev) {
    if (info.hasId) {
      await client.query(
        'INSERT INTO revisions (id, rev, current_rev, actor, source, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [rev, rev, rev, actorValue, sourceValue, noteValue]
      );
    } else {
      await client.query(
        'INSERT INTO revisions (rev, current_rev, actor, source, note) VALUES ($1,$2,$3,$4,$5)',
        [rev, rev, actorValue, sourceValue, noteValue]
      );
    }
  } else if (info.hasId) {
    await client.query(
      'INSERT INTO revisions (id, rev, actor, source, note) VALUES ($1,$2,$3,$4,$5)',
      [rev, rev, actorValue, sourceValue, noteValue]
    );
  } else {
    await client.query(
      'INSERT INTO revisions (rev, actor, source, note) VALUES ($1,$2,$3,$4)',
      [rev, actorValue, sourceValue, noteValue]
    );
  }
}

async function loadSnapshot() {
  const legacyPath = path.resolve(__dirname, '..', 'planner-state.json');
  if (!fs.existsSync(legacyPath)) {
    throw new Error('planner-state.json not found');
  }
  const raw = await fs.promises.readFile(legacyPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.state !== 'string') {
    throw new Error('planner-state.json missing { state }');
  }
  return JSON.parse(parsed.state);
}

function sanitizeMetaForStorage(meta) {
  if (!isPlainObject(meta)) return null;
  const result = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (value === null) {
      result[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      try {
        result[key] = JSON.parse(JSON.stringify(value));
      } catch (_err) {
        /* ignore */
      }
      continue;
    }
    if (isPlainObject(value)) {
      const nested = sanitizeMetaForStorage(value);
      if (nested !== null) {
        result[key] = nested;
      }
    }
  }
  return Object.keys(result).length ? result : null;
}

function serializeMeta(meta) {
  const sanitized = sanitizeMetaForStorage(meta);
  if (sanitized === null) {
    return null;
  }
  try {
    return JSON.stringify(sanitized);
  } catch (err) {
    console.warn('Legacy import: failed to serialize meta payload, discarding meta', err);
    return null;
  }
}

(async () => {
  const snapshot = await loadSnapshot();
  const stateString = JSON.stringify(snapshot);
  const hash = computeSnapshotHash(stateString);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: revRows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
    const rev = Number(revRows[0].rev);
    await client.query(`SET LOCAL app.rev = ${rev}`);
    await insertRevisionRow(client, rev, 'import-script', 'legacy-import', 'Initial import');

    const tasks = Array.isArray(snapshot.t) ? snapshot.t : [];
    const done = Array.isArray(snapshot.done) ? snapshot.done : [];
    const trash = Array.isArray(snapshot.trash) ? snapshot.trash : [];

    const parallelSet = new Set();
    if (isPlainObject(snapshot.parallelByProc)) {
      Object.keys(snapshot.parallelByProc).forEach((key) => {
        const normalized = normalizeStage(key);
        if (normalized) parallelSet.add(normalized);
      });
    }

    const stageMap = new Map();
    const ensureStage = (code) => {
      const normalized = normalizeStage(code);
      if (!normalized) return null;
      if (!stageMap.has(normalized)) {
        stageMap.set(normalized, {
          code: normalized,
          name: titleFromCode(normalized),
          isParallel: parallelSet.has(normalized),
          id: null
        });
      }
      return stageMap.get(normalized);
    };

    tasks.forEach((task) => ensureStage(task?.stage));
    done.forEach((task) => ensureStage(task?.stage));
    if (isPlainObject(snapshot.capByProc)) {
      Object.keys(snapshot.capByProc).forEach((code) => ensureStage(code));
    }
    if (isPlainObject(snapshot.meta?.settings?.capacity)) {
      Object.keys(snapshot.meta.settings.capacity).forEach((code) => ensureStage(code));
    }
    if (isPlainObject(snapshot.meta?.settings?.crmStageMapping)) {
      Object.values(snapshot.meta.settings.crmStageMapping).forEach((code) => ensureStage(code));
    }

    await client.query('TRUNCATE order_process RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE orders RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE customers RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE processes RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE capacity_by_process');
    await client.query('TRUNCATE settings_column_widths');
    await client.query('TRUNCATE settings_mapping');
    await client.query('TRUNCATE excluded_statuses');
    await client.query('DELETE FROM settings_autoweight');
    await client.query('DELETE FROM settings_journal');
    await client.query('DELETE FROM settings_admin');
    await syncSharedPreferences(client, snapshot);

    const processes = Array.from(stageMap.values());
    processes.sort((a, b) => a.code.localeCompare(b.code));
    for (let index = 0; index < processes.length; index += 1) {
      const stage = processes[index];
      const { rows } = await client.query(
        `INSERT INTO processes (code, name, position, has_hours, is_parallel, is_active)
         VALUES ($1,$2,$3,TRUE,$4,TRUE)
         RETURNING id`,
        [stage.code, stage.name || stage.code, index, stage.isParallel]
      );
      stage.id = rows[0].id;
    }

    const customerNames = new Set();
    const collectCustomer = (task) => {
      if (!task) return;
      const name = sanitizeString(task.orderCustomer);
      if (name) customerNames.add(name);
    };
    tasks.forEach(collectCustomer);
    done.forEach(collectCustomer);
    trash.forEach(collectCustomer);

    const customerIdMap = new Map();
    const sortedCustomers = Array.from(customerNames.values()).sort();
    for (const name of sortedCustomers) {
      const { rows } = await client.query(
        'INSERT INTO customers (name) VALUES ($1) RETURNING id',
        [name]
      );
      customerIdMap.set(name, rows[0].id);
    }

    const orderData = new Map();
    const collectOrderData = (task, options = {}) => {
      if (!task || typeof task !== 'object') return;
      const key = orderKeyFromTask(task);
      if (!key) return;
      const existing = orderData.get(key) || {
        key,
        crmOrderId: null,
        number: null,
        customerName: null,
        status: null,
        deleted: false,
        deletedAt: null,
        createdAt: null,
        updatedAt: null
      };
      const crmOrderId = sanitizeString(task.orderId);
      if (crmOrderId) existing.crmOrderId = existing.crmOrderId || crmOrderId;
      const number = sanitizeString(task.orderNumber);
      if (number) existing.number = existing.number || number;
      const customerName = sanitizeString(task.orderCustomer);
      if (customerName) existing.customerName = existing.customerName || customerName;
      const status = sanitizeString(task.status) || sanitizeString(task.state);
      if (status) existing.status = status;
      const start = parseDate(task.startDate || task.start);
      if (start && !existing.createdAt) existing.createdAt = start;
      const end = parseDate(task.endDate || task.end);
      if (end) existing.updatedAt = end;
      if (options.isDone) {
        existing.status = existing.status || 'done';
        const doneAt = parseDate(task.doneMeta?.when || task.when || end || start);
        if (doneAt) existing.updatedAt = doneAt;
      }
      if (options.deleted) {
        existing.deleted = true;
        const deletedAt = parseDate(task.when || task.end || task.endDate || task.startDate);
        if (deletedAt) existing.deletedAt = deletedAt;
      }
      orderData.set(key, existing);
    };

    tasks.forEach((task) => collectOrderData(task));
    done.forEach((task) => collectOrderData(task, { isDone: true }));
    trash.forEach((task) => collectOrderData(task, { deleted: true }));

    const orderIdMap = new Map();
    for (const data of orderData.values()) {
      const customerId = data.customerName ? customerIdMap.get(data.customerName) || null : null;
      const createdAt = data.createdAt || new Date().toISOString();
      const updatedAt = data.updatedAt || createdAt;
      const number = data.number || data.crmOrderId || data.key;
      const { rows } = await client.query(
        `INSERT INTO orders (crm_order_id, number, customer_id, status, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          data.crmOrderId || null,
          number,
          customerId,
          data.status || null,
          createdAt,
          updatedAt,
          data.deleted ? (data.deletedAt || updatedAt) : null
        ]
      );
      orderIdMap.set(data.key, rows[0].id);
    }

    const seqByOrder = new Map();
    const positionByProcess = new Map();
    const insertTask = async (task, options = {}) => {
      if (!task) return;
      const key = orderKeyFromTask(task);
      if (!key) return;
      const orderId = orderIdMap.get(key);
      if (!orderId) return;
      const processKey = normalizeStage(task.stage);
      const process = stageMap.get(processKey);
      if (!process || !process.id) return;
      const seq = seqByOrder.get(key) || 0;
      seqByOrder.set(key, seq + 1);
      const position = positionByProcess.get(process.code) || 0;
      positionByProcess.set(process.code, position + 1);
      const routeSeg = task.route && task.stage ? task.route[task.stage] : null;
      const plannedStart = parseDate(task.startDate || routeSeg?.start);
      const plannedEnd = parseDate(task.endDate || routeSeg?.end);
      const actualStart = parseDate(routeSeg?.start);
      const actualEnd = parseDate(routeSeg?.doneAt || task.doneMeta?.when || routeSeg?.end || task.when);
      const progressRaw = Number(task.progress);
      const progress = Number.isFinite(progressRaw) ? progressRaw : 0;
      const isDone = options.isDone || Boolean(task.doneMeta?.when) || progress >= 100;
      await client.query(
        `INSERT INTO order_process (
           order_id, process_id, seq, planned_start, planned_end,
           actual_start, actual_end, progress, is_done,
           position_index, hidden_by_state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)` ,
        [
          orderId,
          process.id,
          seq,
          plannedStart,
          plannedEnd,
          actualStart,
          actualEnd,
          progress,
          isDone,
          position,
          false
        ]
      );
    };

    for (const task of tasks) {
      // eslint-disable-next-line no-await-in-loop
      await insertTask(task, { isDone: false });
    }
    for (const task of done) {
      // eslint-disable-next-line no-await-in-loop
      await insertTask(task, { isDone: true });
    }
    const today = new Date().toISOString().slice(0, 10);
    const capacitySource = isPlainObject(snapshot.capByProc)
      ? snapshot.capByProc
      : snapshot.meta?.settings?.capacity || {};
    for (const [code, value] of Object.entries(capacitySource || {})) {
      const process = stageMap.get(normalizeStage(code));
      if (!process || !process.id) continue;
      const minutes = Number(value) * 60;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO capacity_by_process (process_id, day, minutes)
         VALUES ($1,$2,$3)
         ON CONFLICT (process_id, day) DO UPDATE SET minutes = EXCLUDED.minutes`,
        [process.id, today, Number.isFinite(minutes) ? Math.round(minutes) : 0]
      );
    }

    const settings = snapshot.meta?.settings || {};
    const extra = settings.extraTime || {};
    const percent = Number(extra.percent || 0);
    const minimum = Number(extra.minimum || 0);
    const extraEnabled = percent > 0 || minimum > 0;
    await client.query(
      `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
       VALUES (1,$1,$2,$3,NOW())
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             percent = EXCLUDED.percent,
             minimum_hours = EXCLUDED.minimum_hours,
             updated_at = NOW()` ,
      [extraEnabled, Math.round(percent), Math.round(minimum)]
    );

    const logLimit = Number(settings.logLimit);
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at)
       VALUES (1,$1,NOW())
       ON CONFLICT (id) DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()` ,
      [Number.isFinite(logLimit) && logLimit > 0 ? Math.round(logLimit) : 50]
    );

    const adminSettings = settings.admin || {};
    const allowForce = adminSettings.allowForceOverwrite === true;
    const snapshotRetentionRaw = Number(adminSettings.snapshotRetention);
    const snapshotRetention = Number.isFinite(snapshotRetentionRaw) ? snapshotRetentionRaw : 50;
    let historyLimit = Number(adminSettings.historyLimit);
    if (!Number.isFinite(historyLimit) || historyLimit <= 0) {
      historyLimit = 50;
    }
    historyLimit = Math.max(1, Math.min(historyLimit, 500));
    let historyDailyLimit = Number(adminSettings.historyDailyLimit);
    if (!Number.isFinite(historyDailyLimit) || historyDailyLimit <= 0) {
      historyDailyLimit = 3;
    }
    historyDailyLimit = Math.max(1, Math.min(historyDailyLimit, historyLimit));
    await client.query(
      `INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, history_limit, history_daily_limit, updated_at)
       VALUES (1,$1,$2,$3,$4,NOW())
       ON CONFLICT (id) DO UPDATE
         SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
             snapshot_retention = EXCLUDED.snapshot_retention,
             history_limit = EXCLUDED.history_limit,
             history_daily_limit = EXCLUDED.history_daily_limit,
             updated_at = NOW()` ,
      [allowForce, snapshotRetention, historyLimit, historyDailyLimit]
    );

    if (isPlainObject(settings.tableColumns)) {
      for (const [key, width] of Object.entries(settings.tableColumns)) {
        const columnKey = sanitizeString(key);
        if (!columnKey) continue;
        const widthValue = Number(width);
        if (!Number.isFinite(widthValue)) continue;
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO settings_column_widths (column_key, width_px, updated_at)
           VALUES ($1,$2,NOW())
           ON CONFLICT (column_key) DO UPDATE SET width_px = EXCLUDED.width_px, updated_at = NOW()` ,
          [columnKey, Math.round(widthValue)]
        );
      }
    }

    if (isPlainObject(settings.crmStageMapping)) {
      for (const [crmStage, mappedStage] of Object.entries(settings.crmStageMapping)) {
        const stageKey = sanitizeString(crmStage);
        if (!stageKey) continue;
        const process = stageMap.get(normalizeStage(mappedStage));
        const processId = process?.id || null;
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO settings_mapping (crm_stage, planner_process_id, is_ignored, updated_at)
           VALUES ($1,$2,FALSE,NOW())
           ON CONFLICT (crm_stage) DO UPDATE
             SET planner_process_id = EXCLUDED.planner_process_id,
                 is_ignored = EXCLUDED.is_ignored,
                 updated_at = NOW()` ,
          [stageKey, processId]
        );
      }
    }

    const ignoredStatuses = Array.isArray(snapshot.ignoredStates) ? snapshot.ignoredStates : [];
    for (const status of ignoredStatuses) {
      const statusKey = sanitizeString(status);
      if (!statusKey) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO excluded_statuses (status_key, created_at)
         VALUES ($1,NOW())
         ON CONFLICT (status_key) DO NOTHING` ,
        [statusKey]
      );
    }

    const snapshotMetaRaw = {
      actor: 'import-script',
      source: 'legacy-import',
      summary: 'Initial import',
      originalMeta: snapshot.meta?.lastChange || null
    };

    const snapshotJson = safeSerializeSnapshot(snapshot, stateString);
    const metaJson = serializeMeta(snapshotMetaRaw);

    await client.query(
      `INSERT INTO planner_state_snapshots (rev, snapshot, meta, hash)
       VALUES ($1,$2::jsonb,$3::jsonb,$4)
       ON CONFLICT (rev) DO UPDATE
         SET snapshot = EXCLUDED.snapshot,
             meta = EXCLUDED.meta,
             hash = EXCLUDED.hash,
             created_at = NOW()` ,
      [rev, snapshotJson, metaJson, hash]
    );

    await client.query('COMMIT');
    console.log('Legacy snapshot imported into SQL schema');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
