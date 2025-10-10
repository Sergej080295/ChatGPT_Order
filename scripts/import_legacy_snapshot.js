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

const loadSnapshot = async () => {
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
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const normaliseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

async function importSnapshot(snapshot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE stage_completion, stage_exception, order_stage, capacity_by_stage, parallel_limits, customer_order RESTART IDENTITY CASCADE');

    const stageCodes = new Map();
    const allStages = new Set();

    const addStage = (code) => {
      if (!code) return;
      const key = String(code).trim();
      if (!key) return;
      allStages.add(key);
    };

    (snapshot.t || []).forEach((item) => addStage(item?.stage));
    (snapshot.done || []).forEach((item) => addStage(item?.stage));
    if (isPlainObject(snapshot.capByProc)) {
      Object.keys(snapshot.capByProc).forEach(addStage);
    }
    if (Array.isArray(snapshot.orders)) {
      snapshot.orders.forEach((pair) => {
        if (Array.isArray(pair) && pair.length > 0) addStage(pair[0]);
      });
    }

    let sort = 0;
    for (const code of Array.from(allStages)) {
      const name = code;
      const { rows } = await client.query(
        `INSERT INTO stage_type (code, name, sort_order, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, updated_at = NOW()
         RETURNING id`,
        [code, name, sort]
      );
      stageCodes.set(code, rows[0].id);
      sort += 1;
    }

    const orderIdMap = new Map();
    const orders = new Map();

    (snapshot.t || []).forEach((stage) => {
      if (!stage || !stage.orderId) return;
      const orderNo = String(stage.orderId).trim();
      if (!orderNo) return;
      if (!orders.has(orderNo)) {
        orders.set(orderNo, { title: orderNo });
      }
    });

    for (const [orderNo, value] of orders.entries()) {
      const { rows } = await client.query(
        `INSERT INTO customer_order (order_no, title, is_deleted)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (order_no, is_deleted) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
         RETURNING id`,
        [orderNo, value.title]
      );
      orderIdMap.set(orderNo, rows[0].id);
    }

    const stageByUid = new Map();
    for (const stage of snapshot.t || []) {
      if (!stage || !stage.orderId || !stage.stage) continue;
      const orderKey = String(stage.orderId).trim();
      const stageCode = String(stage.stage).trim();
      if (!orderKey || !stageCode) continue;
      const orderId = orderIdMap.get(orderKey);
      const stageTypeId = stageCodes.get(stageCode);
      if (!orderId || !stageTypeId) continue;
      const { rows } = await client.query(
        `INSERT INTO order_stage (
          order_id, stage_type_id, external_uid, hours, extra_hours, start_at, end_at,
          start_missing, end_missing, state, status, progress, use_reserve, orig_start_at, version, payload, is_deleted
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE)
        ON CONFLICT (external_uid) DO UPDATE SET
          order_id = EXCLUDED.order_id,
          stage_type_id = EXCLUDED.stage_type_id,
          hours = EXCLUDED.hours,
          extra_hours = EXCLUDED.extra_hours,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          start_missing = EXCLUDED.start_missing,
          end_missing = EXCLUDED.end_missing,
          state = EXCLUDED.state,
          status = EXCLUDED.status,
          progress = EXCLUDED.progress,
          use_reserve = EXCLUDED.use_reserve,
          orig_start_at = EXCLUDED.orig_start_at,
          version = EXCLUDED.version,
          payload = EXCLUDED.payload,
          is_deleted = FALSE,
          updated_at = NOW()
        RETURNING id`,
        [
          orderId,
          stageTypeId,
          stage.uid || `${orderKey}::${stageCode}`,
          stage.hours ?? null,
          stage.extraHours ?? null,
          normaliseDate(stage.startDate),
          normaliseDate(stage.endDate),
          Boolean(stage.startMissing),
          Boolean(stage.endMissing),
          stage.state ?? null,
          stage.status ?? null,
          stage.progress ?? null,
          Boolean(stage.useReserve),
          normaliseDate(stage.origStartDate),
          Number.isFinite(Number(snapshot.meta?.versions?.[stageCode])) ? Number(snapshot.meta.versions[stageCode]) : 1,
          stage ? stage : null
        ]
      );
      stageByUid.set(stage.uid || `${orderKey}::${stageCode}`, rows[0].id);
    }

    if (isPlainObject(snapshot.capByProc)) {
      for (const [code, value] of Object.entries(snapshot.capByProc)) {
        const stageTypeId = stageCodes.get(code);
        if (!stageTypeId) continue;
        await client.query(
          `INSERT INTO capacity_by_stage (stage_type_id, capacity_per_day, updated_at)
           VALUES ($1,$2,NOW())
           ON CONFLICT (stage_type_id) DO UPDATE SET capacity_per_day = EXCLUDED.capacity_per_day, updated_at = NOW()`,
          [stageTypeId, value]
        );
      }
    }

    if (isPlainObject(snapshot.parallelByProc)) {
      for (const [code, value] of Object.entries(snapshot.parallelByProc)) {
        await client.query(
          `INSERT INTO parallel_limits (code, max_parallel, updated_at)
           VALUES ($1,$2,NOW())
           ON CONFLICT (code) DO UPDATE SET max_parallel = EXCLUDED.max_parallel, updated_at = NOW()`,
          [code, value]
        );
      }
    }

    if (Array.isArray(snapshot.done)) {
      for (const done of snapshot.done) {
        const orderKey = done?.orderId ? String(done.orderId).trim() : '';
        const stageCode = done?.stage ? String(done.stage).trim() : '';
        const stageId = stageByUid.get(done.uid || (orderKey && stageCode ? `${orderKey}::${stageCode}` : ''));
        await client.query(
          `INSERT INTO stage_completion (order_stage_id, completed_at, source, note)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [stageId ?? null, normaliseDate(done.when) || normaliseDate(done.end), done.source || null, done.note || null]
        );
      }
    }

    if (Array.isArray(snapshot.exc)) {
      for (const exc of snapshot.exc) {
        const orderKey = exc?.orderId ? String(exc.orderId).trim() : '';
        const stageCode = exc?.stage ? String(exc.stage).trim() : '';
        const stageId = stageByUid.get(exc.uid || (orderKey && stageCode ? `${orderKey}::${stageCode}` : ''));
        await client.query(
          `INSERT INTO stage_exception (order_stage_id, kind, details, created_at, resolved_at)
           VALUES ($1,$2,$3,$4,$5)`,
          [stageId ?? null, exc.kind || exc.type || 'unknown', exc.details ?? null, normaliseDate(exc.createdAt) || normaliseDate(exc.start), normaliseDate(exc.resolvedAt) || normaliseDate(exc.end)]
        );
      }
    }

    if (isPlainObject(snapshot.meta) && isPlainObject(snapshot.meta.settings)) {
      await client.query(
        `INSERT INTO planner_settings (id, autosave_on, auto_optimize_on, shift_on_progress, storage_mode, extra, updated_at)
         VALUES (1,$1,$2,$3,$4,$5,NOW())
         ON CONFLICT (id) DO UPDATE SET
           autosave_on = EXCLUDED.autosave_on,
           auto_optimize_on = EXCLUDED.auto_optimize_on,
           shift_on_progress = EXCLUDED.shift_on_progress,
           storage_mode = EXCLUDED.storage_mode,
           extra = EXCLUDED.extra,
           updated_at = NOW()`,
        [
          snapshot.meta.settings.autosave ?? null,
          snapshot.meta.settings.autoOptimize ?? null,
          snapshot.meta.settings.shiftOnProgress ?? null,
          snapshot.meta.storage?.mode ?? null,
          snapshot.meta.settings ? snapshot.meta.settings : null
        ]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

(async () => {
  const snapshot = await loadSnapshot();
  await importSnapshot(snapshot);
  console.log('Legacy snapshot imported');
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
