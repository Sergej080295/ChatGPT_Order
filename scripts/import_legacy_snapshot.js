#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://planner:planner@localhost:5432/planner';
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

let revisionColumnInfo = null;

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
    hasCurrentRev: columnNames.includes('current_rev')
  };
  return revisionColumnInfo;
}

async function insertRevisionRow(client, rev, actor, source, note) {
  const info = await loadRevisionColumnInfo(client);
  if (info.hasCurrentRev) {
    await client.query(
      'INSERT INTO revisions (rev, current_rev, actor, source, note) VALUES ($1,$1,$2,$3,$4) ON CONFLICT (rev) DO NOTHING',
      [rev, actor || null, source || null, note || null]
    );
  } else {
    await client.query(
      'INSERT INTO revisions (rev, actor, source, note) VALUES ($1,$2,$3,$4) ON CONFLICT (rev) DO NOTHING',
      [rev, actor || null, source || null, note || null]
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

(async () => {
  const snapshot = await loadSnapshot();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: revRows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
    const rev = Number(revRows[0].rev);
    await client.query('SET LOCAL app.rev = $1', [rev]);

    await client.query('TRUNCATE order_process, orders, customers RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE processes RESTART IDENTITY CASCADE');
    await client.query('TRUNCATE capacity_by_process');
    await client.query('TRUNCATE settings_column_widths');
    await client.query('TRUNCATE settings_mapping');
    await client.query('TRUNCATE excluded_statuses');
    await client.query('DELETE FROM settings_autoweight');
    await client.query('DELETE FROM settings_journal');
    await client.query('DELETE FROM settings_admin');

    const stageSet = new Map();
    const parallelStages = new Set();

    if (isPlainObject(snapshot.parallelByProc)) {
      Object.keys(snapshot.parallelByProc).forEach((key) => {
        const normalized = normalizeStage(key);
        if (normalized) {
          parallelStages.add(normalized);
        }
      });
    }

    const ensureStage = (code) => {
      const normalized = normalizeStage(code);
      if (!normalized) return;
      if (!stageSet.has(normalized)) {
        stageSet.set(normalized, {
          code: normalized,
          name: titleFromCode(normalized),
          hasHours: true,
          isParallel: parallelStages.has(normalized)
        });
      }
    };

    (snapshot.t || []).forEach((task) => ensureStage(task?.stage));
    (snapshot.done || []).forEach((task) => ensureStage(task?.stage));
    if (isPlainObject(snapshot.capByProc)) {
      Object.keys(snapshot.capByProc).forEach((key) => ensureStage(key));
    }

    const stages = Array.from(stageSet.values());
    stages.sort((a, b) => a.code.localeCompare(b.code));
    const stageIdMap = new Map();
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index];
      const { rows } = await client.query(
        `INSERT INTO processes (code, name, position, has_hours, is_parallel, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE)
         RETURNING id`,
        [stage.code, stage.name || stage.code, index, stage.hasHours, stage.isParallel]
      );
      stageIdMap.set(stage.code, rows[0].id);
    }

    const orderMap = new Map();
    const orderSeqMap = new Map();

    const ensureOrder = (orderId, status) => {
      const key = String(orderId || '').trim();
      if (!key) return null;
      if (!orderMap.has(key)) {
        const number = key;
        orderMap.set(key, { number, status: status || null });
        orderSeqMap.set(key, 0);
      } else if (status && !orderMap.get(key).status) {
        orderMap.get(key).status = status;
      }
      return key;
    };

    (snapshot.t || []).forEach((task) => {
      ensureOrder(task?.orderId, task?.status || task?.state || null);
    });
    (snapshot.done || []).forEach((task) => {
      ensureOrder(task?.orderId, task?.status || task?.state || null);
    });

    const orderIdMap = new Map();
    for (const [orderKey, value] of orderMap.entries()) {
      const { rows } = await client.query(
        `INSERT INTO orders (number, status, created_at, updated_at)
         VALUES ($1,$2,NOW(),NOW())
         RETURNING id`,
        [orderKey, value.status]
      );
      orderIdMap.set(orderKey, rows[0].id);
    }

    const processPositionCounters = new Map();

    const insertStage = async (task, overrides = {}) => {
      if (!task || !task.stage || !task.orderId) return;
      const processKey = normalizeStage(task.stage);
      const processId = stageIdMap.get(processKey);
      const orderKey = ensureOrder(task.orderId, task.status || task.state || null);
      if (!processId || !orderKey) return;
      const orderId = orderIdMap.get(orderKey);
      const seq = orderSeqMap.get(orderKey) || 0;
      orderSeqMap.set(orderKey, seq + 1);
      const positionCounter = processPositionCounters.get(processKey) || 0;
      processPositionCounters.set(processKey, positionCounter + 1);
      const progressValue = Number(task.progress);
      await client.query(
        `INSERT INTO order_process (
          order_id, process_id, seq, planned_start, planned_end, actual_start, actual_end,
          progress, is_done, position_index, hidden_by_state
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          orderId,
          processId,
          seq,
          parseDate(task.startDate),
          parseDate(task.endDate),
          parseDate(overrides.actualStart || task.actualStart),
          parseDate(overrides.actualEnd || task.actualEnd),
          Number.isFinite(progressValue) ? progressValue : 0,
          overrides.isDone === true || (task.state && /готово|done/i.test(task.state)) || false,
          positionCounter,
          false
        ]
      );
    };

    for (const task of snapshot.t || []) {
      await insertStage(task);
    }
    for (const task of snapshot.done || []) {
      await insertStage(task, {
        isDone: true,
        actualEnd: task.when || task.end
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    if (isPlainObject(snapshot.capByProc)) {
      for (const [code, value] of Object.entries(snapshot.capByProc)) {
        const processId = stageIdMap.get(normalizeStage(code));
        if (!processId) continue;
        const minutes = Number(value) * 60;
        await client.query(
          `INSERT INTO capacity_by_process (process_id, day, minutes)
           VALUES ($1,$2,$3)
           ON CONFLICT (process_id, day) DO UPDATE SET minutes = EXCLUDED.minutes`,
          [processId, today, Number.isFinite(minutes) ? Math.round(minutes) : 0]
        );
      }
    }

    await client.query(
      `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
       VALUES (1,FALSE,0,0,NOW())
       ON CONFLICT (id) DO UPDATE SET enabled = FALSE, percent = 0, minimum_hours = 0, updated_at = NOW()`
    );

    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at)
       VALUES (1,50,NOW())
       ON CONFLICT (id) DO UPDATE SET max_rows = 50, updated_at = NOW()`
    );

    await client.query(
      `INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, updated_at)
       VALUES (1,FALSE,50,NOW())
       ON CONFLICT (id) DO UPDATE SET allow_force_overwrite = FALSE, snapshot_retention = 50, updated_at = NOW()`
    );

    await insertRevisionRow(client, rev, 'import-script', 'legacy-import', 'Initial import');

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
