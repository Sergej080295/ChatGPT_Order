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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
  max: Number.parseInt(process.env.PGPOOL_MAX || '10', 10),
  idleTimeoutMillis: Number.parseInt(process.env.PGPOOL_IDLE || '30000', 10)
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error', err);
});

const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb' }));

const sseClients = new Set();

const ensureMigrationTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const loadMigrations = () => {
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
};

const runMigrations = async () => {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = loadMigrations();
    for (const migration of migrations) {
      const { rows } = await client.query(
        'SELECT 1 FROM planner_schema_migrations WHERE filename = $1',
        [migration.filename]
      );
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
};

const withClient = async (cb) => {
  const client = await pool.connect();
  try {
    return await cb(client);
  } finally {
    client.release();
  }
};

const formatEtag = (rev) => `W/"r${rev}"`;

const parseRevision = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith('r')) {
    const num = Number.parseInt(raw.slice(1), 10);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  const weak = raw.startsWith('W/') ? raw.slice(2) : raw;
  const stripped = weak.replace(/^"|"$/g, '');
  if (!stripped) return null;
  if (stripped.startsWith('r')) {
    const num = Number.parseInt(stripped.slice(1), 10);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  const direct = Number.parseInt(stripped, 10);
  return Number.isFinite(direct) && direct >= 0 ? direct : null;
};

const parseIfMatchRevision = (header) => {
  if (!header) return null;
  const items = Array.isArray(header) ? header : [header];
  for (const item of items) {
    if (!item) continue;
    for (const part of String(item).split(',').map((token) => token.trim())) {
      if (!part || part === '*') continue;
      const rev = parseRevision(part);
      if (rev !== null) return rev;
    }
  }
  return null;
};

const fetchCurrentRevision = async (client) => {
  const { rows } = await client.query('SELECT current_rev FROM revisions WHERE id = 1');
  if (!rows.length) {
    return 0;
  }
  return Number.parseInt(rows[0].current_rev, 10) || 0;
};

const fetchAdminSettings = async (client) => {
  const { rows } = await client.query(
    'SELECT allow_force_overwrite, history_retention_count, checkpoint_interval_days FROM settings_admin WHERE id = 1'
  );
  if (!rows.length) {
    return {
      allow_force_overwrite: false,
      history_retention_count: 50,
      checkpoint_interval_days: 1
    };
  }
  const row = rows[0];
  return {
    allow_force_overwrite: row.allow_force_overwrite === true,
    history_retention_count: Number.parseInt(row.history_retention_count, 10) || 50,
    checkpoint_interval_days: Number.parseInt(row.checkpoint_interval_days, 10) || 1
  };
};

const readOrders = async (client) => {
  const { rows } = await client.query(
    'SELECT id, order_no, client, name, deleted_at, created_at, updated_at FROM orders ORDER BY id'
  );
  return rows.map((row) => ({
    id: Number(row.id),
    orderNo: row.order_no,
    client: row.client,
    name: row.name,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
};

const readStages = async (client) => {
  const { rows } = await client.query(
    `SELECT id, order_id, stage_code, start_at, end_at, progress_pct, status, is_done, trash_at, created_at, updated_at
       FROM order_stages
       ORDER BY id`
  );
  return rows.map((row) => ({
    id: Number(row.id),
    orderId: Number(row.order_id),
    stageCode: row.stage_code,
    startAt: row.start_at,
    endAt: row.end_at,
    progressPct: row.progress_pct == null ? null : Number(row.progress_pct),
    status: row.status,
    isDone: row.is_done === true,
    trashAt: row.trash_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
};

const readDependencies = async (client) => {
  const { rows } = await client.query(
    'SELECT order_id, from_stage, to_stage FROM stage_dependencies ORDER BY order_id, from_stage, to_stage'
  );
  return rows.map((row) => ({
    orderId: Number(row.order_id),
    fromStage: row.from_stage,
    toStage: row.to_stage
  }));
};

const readCapacity = async (client) => {
  const { rows } = await client.query(
    'SELECT stage_code, capacity_per_day, parallel_limit, updated_at FROM stage_capacity ORDER BY stage_code'
  );
  return rows.map((row) => ({
    stageCode: row.stage_code,
    capacityPerDay: row.capacity_per_day == null ? null : Number(row.capacity_per_day),
    parallelLimit: row.parallel_limit == null ? null : Number(row.parallel_limit),
    updatedAt: row.updated_at
  }));
};

const readExcludedStatuses = async (client) => {
  const { rows } = await client.query(
    'SELECT status_code, created_at FROM excluded_statuses ORDER BY status_code'
  );
  return rows.map((row) => ({ statusCode: row.status_code, createdAt: row.created_at }));
};

const readSettings = async (client) => {
  const autoweightRow = await client.query(
    'SELECT enabled, percent, minimum_hours, updated_at FROM settings_autoweight WHERE id = 1'
  );
  const journalRow = await client.query(
    'SELECT max_rows, updated_at FROM settings_journal WHERE id = 1'
  );
  const columnsRows = await client.query(
    'SELECT column_key, width_px, updated_at FROM settings_columns ORDER BY column_key'
  );
  const mappingRows = await client.query(
    'SELECT crm_stage_name, planner_stage_code, is_ignored, updated_at FROM settings_crm_mapping ORDER BY LOWER(crm_stage_name)'
  );
  const adminRow = await client.query(
    'SELECT allow_force_overwrite, history_retention_count, checkpoint_interval_days, updated_at FROM settings_admin WHERE id = 1'
  );
  return {
    autoweight: autoweightRow.rows.length
      ? {
          enabled: autoweightRow.rows[0].enabled === true,
          percent: autoweightRow.rows[0].percent == null ? 0 : Number(autoweightRow.rows[0].percent),
          minimumHours: autoweightRow.rows[0].minimum_hours == null
            ? 0
            : Number(autoweightRow.rows[0].minimum_hours),
          updatedAt: autoweightRow.rows[0].updated_at
        }
      : { enabled: false, percent: 0, minimumHours: 0, updatedAt: null },
    journal: journalRow.rows.length
      ? {
          maxRows: Number(journalRow.rows[0].max_rows),
          updatedAt: journalRow.rows[0].updated_at
        }
      : { maxRows: 200, updatedAt: null },
    columns: columnsRows.rows.map((row) => ({
      columnKey: row.column_key,
      widthPx: row.width_px == null ? null : Number(row.width_px),
      updatedAt: row.updated_at
    })),
    crmMapping: mappingRows.rows.map((row) => ({
      crmStageName: row.crm_stage_name,
      plannerStageCode: row.planner_stage_code,
      isIgnored: row.is_ignored === true,
      updatedAt: row.updated_at
    })),
    admin: adminRow.rows.length
      ? {
          allowForceOverwrite: adminRow.rows[0].allow_force_overwrite === true,
          historyRetentionCount: Number(adminRow.rows[0].history_retention_count || 50),
          checkpointIntervalDays: Number(adminRow.rows[0].checkpoint_interval_days || 1),
          updatedAt: adminRow.rows[0].updated_at
        }
      : {
          allowForceOverwrite: false,
          historyRetentionCount: 50,
          checkpointIntervalDays: 1,
          updatedAt: null
        }
  };
};

const buildFullState = async (client, currentRev) => {
  const [orders, stages, dependencies, capacity, excluded, settings] = await Promise.all([
    readOrders(client),
    readStages(client),
    readDependencies(client),
    readCapacity(client),
    readExcludedStatuses(client),
    readSettings(client)
  ]);
  return {
    rev: currentRev,
    etag: formatEtag(currentRev),
    data: {
      orders,
      stages,
      stageDependencies: dependencies,
      stageCapacity: capacity,
      excludedStatuses: excluded,
      settings
    }
  };
};
const selectUpserts = async (client, table, sinceRev, columns) => {
  const colList = columns.join(', ');
  const { rows } = await client.query(
    `SELECT ${colList}, rev_from
       FROM ${table}
      WHERE rev_from > $1
      ORDER BY rev_from, ${columns[0]}`,
    [sinceRev]
  );
  return rows;
};

const selectDeletes = async (client, table, sinceRev, keyColumns) => {
  const keySelect = keyColumns.join(', ');
  const keyConditions = keyColumns
    .map((col) => `t.${col} = newer.${col}`)
    .join(' AND ');
  const { rows } = await client.query(
    `SELECT DISTINCT ON (${keySelect}) ${keySelect}, rev_to
       FROM ${table} t
      WHERE t.rev_to IS NOT NULL
        AND t.rev_to > $1
        AND NOT EXISTS (
          SELECT 1 FROM ${table} newer
           WHERE newer.rev_from > $1
             AND ${keyConditions}
        )
      ORDER BY ${keySelect}, rev_to DESC`,
    [sinceRev]
  );
  return rows;
};

const buildDelta = async (client, sinceRev, currentRev) => {
  if (sinceRev >= currentRev) {
    return {
      rev: currentRev,
      etag: formatEtag(currentRev),
      delta: {
        orders: { upserts: [], deletes: [] },
        stages: { upserts: [], deletes: [] },
        stageDependencies: { upserts: [], deletes: [] },
        stageCapacity: { upserts: [], deletes: [] },
        excludedStatuses: { upserts: [], deletes: [] },
        settings: {
          autoweight: null,
          journal: null,
          columns: { upserts: [], deletes: [] },
          crmMapping: { upserts: [], deletes: [] },
          admin: null
        }
      }
    };
  }

  const [orderUpserts, orderDeletes, stageUpserts, stageDeletes, depUpserts, depDeletes, capUpserts, capDeletes, excUpserts, excDeletes] = await Promise.all([
    selectUpserts(client, 'orders_hist', sinceRev, ['id', 'order_no', 'client', 'name', 'deleted_at', 'created_at', 'updated_at']),
    selectDeletes(client, 'orders_hist', sinceRev, ['id']),
    selectUpserts(client, 'order_stages_hist', sinceRev, [
      'id',
      'order_id',
      'stage_code',
      'start_at',
      'end_at',
      'progress_pct',
      'status',
      'is_done',
      'trash_at',
      'created_at',
      'updated_at'
    ]),
    selectDeletes(client, 'order_stages_hist', sinceRev, ['id']),
    selectUpserts(client, 'stage_dependencies_hist', sinceRev, ['order_id', 'from_stage', 'to_stage']),
    selectDeletes(client, 'stage_dependencies_hist', sinceRev, ['order_id', 'from_stage', 'to_stage']),
    selectUpserts(client, 'stage_capacity_hist', sinceRev, ['stage_code', 'capacity_per_day', 'parallel_limit', 'updated_at']),
    selectDeletes(client, 'stage_capacity_hist', sinceRev, ['stage_code']),
    selectUpserts(client, 'excluded_statuses_hist', sinceRev, ['status_code', 'created_at']),
    selectDeletes(client, 'excluded_statuses_hist', sinceRev, ['status_code'])
  ]);

  const [autoweightHist, journalHist, columnsUpserts, columnsDeletes, mappingUpserts, mappingDeletes, adminHist] = await Promise.all([
    client.query(
      `SELECT id, enabled, percent, minimum_hours, updated_at, rev_from
         FROM settings_autoweight_hist
        WHERE rev_from > $1
        ORDER BY rev_from DESC
        LIMIT 1`,
      [sinceRev]
    ),
    client.query(
      `SELECT id, max_rows, updated_at, rev_from
         FROM settings_journal_hist
        WHERE rev_from > $1
        ORDER BY rev_from DESC
        LIMIT 1`,
      [sinceRev]
    ),
    selectUpserts(client, 'settings_columns_hist', sinceRev, ['column_key', 'width_px', 'updated_at']),
    selectDeletes(client, 'settings_columns_hist', sinceRev, ['column_key']),
    selectUpserts(client, 'settings_crm_mapping_hist', sinceRev, ['crm_stage_name', 'planner_stage_code', 'is_ignored', 'updated_at']),
    selectDeletes(client, 'settings_crm_mapping_hist', sinceRev, ['crm_stage_name']),
    client.query(
      `SELECT id, allow_force_overwrite, history_retention_count, checkpoint_interval_days, updated_at, rev_from
         FROM settings_admin_hist
        WHERE rev_from > $1
        ORDER BY rev_from DESC
        LIMIT 1`,
      [sinceRev]
    )
  ]);

  return {
    rev: currentRev,
    etag: formatEtag(currentRev),
    delta: {
      orders: {
        upserts: orderUpserts.map((row) => ({
          id: Number(row.id),
          orderNo: row.order_no,
          client: row.client,
          name: row.name,
          deletedAt: row.deleted_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revFrom: Number(row.rev_from)
        })),
        deletes: orderDeletes.map((row) => ({ id: Number(row.id), revTo: Number(row.rev_to) }))
      },
      stages: {
        upserts: stageUpserts.map((row) => ({
          id: Number(row.id),
          orderId: Number(row.order_id),
          stageCode: row.stage_code,
          startAt: row.start_at,
          endAt: row.end_at,
          progressPct: row.progress_pct == null ? null : Number(row.progress_pct),
          status: row.status,
          isDone: row.is_done === true,
          trashAt: row.trash_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revFrom: Number(row.rev_from)
        })),
        deletes: stageDeletes.map((row) => ({ id: Number(row.id), revTo: Number(row.rev_to) }))
      },
      stageDependencies: {
        upserts: depUpserts.map((row) => ({
          orderId: Number(row.order_id),
          fromStage: row.from_stage,
          toStage: row.to_stage,
          revFrom: Number(row.rev_from)
        })),
        deletes: depDeletes.map((row) => ({
          orderId: Number(row.order_id),
          fromStage: row.from_stage,
          toStage: row.to_stage,
          revTo: Number(row.rev_to)
        }))
      },
      stageCapacity: {
        upserts: capUpserts.map((row) => ({
          stageCode: row.stage_code,
          capacityPerDay: row.capacity_per_day == null ? null : Number(row.capacity_per_day),
          parallelLimit: row.parallel_limit == null ? null : Number(row.parallel_limit),
          updatedAt: row.updated_at,
          revFrom: Number(row.rev_from)
        })),
        deletes: capDeletes.map((row) => ({ stageCode: row.stage_code, revTo: Number(row.rev_to) }))
      },
      excludedStatuses: {
        upserts: excUpserts.map((row) => ({
          statusCode: row.status_code,
          createdAt: row.created_at,
          revFrom: Number(row.rev_from)
        })),
        deletes: excDeletes.map((row) => ({ statusCode: row.status_code, revTo: Number(row.rev_to) }))
      },
      settings: {
        autoweight: autoweightHist.rows.length
          ? {
              enabled: autoweightHist.rows[0].enabled === true,
              percent: autoweightHist.rows[0].percent == null ? 0 : Number(autoweightHist.rows[0].percent),
              minimumHours: autoweightHist.rows[0].minimum_hours == null
                ? 0
                : Number(autoweightHist.rows[0].minimum_hours),
              updatedAt: autoweightHist.rows[0].updated_at,
              revFrom: Number(autoweightHist.rows[0].rev_from)
            }
          : null,
        journal: journalHist.rows.length
          ? {
              maxRows: Number(journalHist.rows[0].max_rows),
              updatedAt: journalHist.rows[0].updated_at,
              revFrom: Number(journalHist.rows[0].rev_from)
            }
          : null,
        columns: {
          upserts: columnsUpserts.map((row) => ({
            columnKey: row.column_key,
            widthPx: row.width_px == null ? null : Number(row.width_px),
            updatedAt: row.updated_at,
            revFrom: Number(row.rev_from)
          })),
          deletes: columnsDeletes.map((row) => ({ columnKey: row.column_key, revTo: Number(row.rev_to) }))
        },
        crmMapping: {
          upserts: mappingUpserts.map((row) => ({
            crmStageName: row.crm_stage_name,
            plannerStageCode: row.planner_stage_code,
            isIgnored: row.is_ignored === true,
            updatedAt: row.updated_at,
            revFrom: Number(row.rev_from)
          })),
          deletes: mappingDeletes.map((row) => ({ crmStageName: row.crm_stage_name, revTo: Number(row.rev_to) }))
        },
        admin: adminHist.rows.length
          ? {
              allowForceOverwrite: adminHist.rows[0].allow_force_overwrite === true,
              historyRetentionCount: Number(adminHist.rows[0].history_retention_count || 50),
              checkpointIntervalDays: Number(adminHist.rows[0].checkpoint_interval_days || 1),
              updatedAt: adminHist.rows[0].updated_at,
              revFrom: Number(adminHist.rows[0].rev_from)
            }
          : null
      }
    }
  };
};
const applyOrderChanges = async (client, changes, stats) => {
  if (!changes) return;
  if (Array.isArray(changes.upserts)) {
    for (const item of changes.upserts) {
      if (!item || typeof item !== 'object') continue;
      if (item.id) {
        const id = Number(item.id);
        await client.query(
          `UPDATE orders
              SET order_no = $1,
                  client = $2,
                  name = $3,
                  deleted_at = $4,
                  updated_at = NOW()
            WHERE id = $5`,
          [item.orderNo || item.order_no, item.client ?? null, item.name ?? null, item.deletedAt ?? item.deleted_at ?? null, id]
        );
        stats.ordersUpdated += 1;
      } else {
        await client.query(
          `INSERT INTO orders (order_no, client, name, deleted_at)
           VALUES ($1, $2, $3, $4)`,
          [item.orderNo || item.order_no, item.client ?? null, item.name ?? null, item.deletedAt ?? item.deleted_at ?? null]
        );
        stats.ordersInserted += 1;
      }
    }
  }
  if (Array.isArray(changes.deletes)) {
    for (const item of changes.deletes) {
      const id = Number(item && (item.id ?? item));
      if (!Number.isFinite(id)) continue;
      await client.query('DELETE FROM orders WHERE id = $1', [id]);
      stats.ordersDeleted += 1;
    }
  }
};

const applyStageChanges = async (client, changes, stats) => {
  if (!changes) return;
  if (Array.isArray(changes.upserts)) {
    for (const item of changes.upserts) {
      if (!item || typeof item !== 'object') continue;
      const orderId = Number(item.orderId ?? item.order_id);
      if (!Number.isFinite(orderId)) continue;
      if (item.id) {
        const id = Number(item.id);
        await client.query(
          `UPDATE order_stages
              SET order_id = $1,
                  stage_code = $2,
                  start_at = $3,
                  end_at = $4,
                  progress_pct = $5,
                  status = $6,
                  is_done = $7,
                  trash_at = $8,
                  updated_at = NOW()
            WHERE id = $9`,
          [
            orderId,
            item.stageCode || item.stage_code,
            item.startAt ?? item.start_at ?? null,
            item.endAt ?? item.end_at ?? null,
            item.progressPct ?? item.progress_pct ?? null,
            item.status ?? null,
            item.isDone ?? item.is_done ?? false,
            item.trashAt ?? item.trash_at ?? null,
            id
          ]
        );
        stats.stagesUpdated += 1;
      } else {
        await client.query(
          `INSERT INTO order_stages (
              order_id, stage_code, start_at, end_at, progress_pct, status, is_done, trash_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            orderId,
            item.stageCode || item.stage_code,
            item.startAt ?? item.start_at ?? null,
            item.endAt ?? item.end_at ?? null,
            item.progressPct ?? item.progress_pct ?? null,
            item.status ?? null,
            item.isDone ?? item.is_done ?? false,
            item.trashAt ?? item.trash_at ?? null
          ]
        );
        stats.stagesInserted += 1;
      }
    }
  }
  if (Array.isArray(changes.deletes)) {
    for (const item of changes.deletes) {
      const id = Number(item && (item.id ?? item));
      if (!Number.isFinite(id)) continue;
      await client.query('DELETE FROM order_stages WHERE id = $1', [id]);
      stats.stagesDeleted += 1;
    }
  }
};

const applyDependencyChanges = async (client, changes, stats) => {
  if (!changes) return;
  if (Array.isArray(changes.upserts)) {
    for (const item of changes.upserts) {
      if (!item || typeof item !== 'object') continue;
      const orderId = Number(item.orderId ?? item.order_id);
      if (!Number.isFinite(orderId)) continue;
      await client.query(
        `INSERT INTO stage_dependencies (order_id, from_stage, to_stage)
         VALUES ($1, $2, $3)
         ON CONFLICT (order_id, from_stage, to_stage)
         DO UPDATE SET from_stage = EXCLUDED.from_stage`,
        [orderId, item.fromStage || item.from_stage, item.toStage || item.to_stage]
      );
      stats.dependenciesUpserted += 1;
    }
  }
  if (Array.isArray(changes.deletes)) {
    for (const item of changes.deletes) {
      if (!item || typeof item !== 'object') continue;
      const orderId = Number(item.orderId ?? item.order_id);
      if (!Number.isFinite(orderId)) continue;
      await client.query(
        'DELETE FROM stage_dependencies WHERE order_id = $1 AND from_stage = $2 AND to_stage = $3',
        [orderId, item.fromStage || item.from_stage, item.toStage || item.to_stage]
      );
      stats.dependenciesDeleted += 1;
    }
  }
};

const applyCapacityChanges = async (client, changes, stats) => {
  if (!changes) return;
  if (Array.isArray(changes.upserts)) {
    for (const item of changes.upserts) {
      if (!item || typeof item !== 'object') continue;
      await client.query(
        `INSERT INTO stage_capacity (stage_code, capacity_per_day, parallel_limit)
         VALUES ($1, $2, $3)
         ON CONFLICT (stage_code)
         DO UPDATE SET capacity_per_day = EXCLUDED.capacity_per_day,
                       parallel_limit = EXCLUDED.parallel_limit,
                       updated_at = NOW()`,
        [
          item.stageCode || item.stage_code,
          item.capacityPerDay ?? item.capacity_per_day ?? null,
          item.parallelLimit ?? item.parallel_limit ?? null
        ]
      );
      stats.capacityUpserted += 1;
    }
  }
  if (Array.isArray(changes.deletes)) {
    for (const item of changes.deletes) {
      const code = item && (item.stageCode || item.stage_code || item);
      if (!code) continue;
      await client.query('DELETE FROM stage_capacity WHERE stage_code = $1', [code]);
      stats.capacityDeleted += 1;
    }
  }
};

const applyExcludedChanges = async (client, changes, stats) => {
  if (!changes) return;
  if (Array.isArray(changes.upserts)) {
    for (const item of changes.upserts) {
      const code = item && (item.statusCode || item.status_code || item);
      if (!code) continue;
      await client.query(
        `INSERT INTO excluded_statuses (status_code)
         VALUES ($1)
         ON CONFLICT (status_code) DO NOTHING`,
        [code]
      );
      stats.excludedUpserted += 1;
    }
  }
  if (Array.isArray(changes.deletes)) {
    for (const item of changes.deletes) {
      const code = item && (item.statusCode || item.status_code || item);
      if (!code) continue;
      await client.query('DELETE FROM excluded_statuses WHERE status_code = $1', [code]);
      stats.excludedDeleted += 1;
    }
  }
};

const applySettingsChanges = async (client, changes, stats) => {
  if (!changes) return;
  if (changes.autoweight && typeof changes.autoweight === 'object') {
    const payload = changes.autoweight;
    await client.query(
      `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id)
       DO UPDATE SET enabled = EXCLUDED.enabled,
                     percent = EXCLUDED.percent,
                     minimum_hours = EXCLUDED.minimum_hours,
                     updated_at = NOW()`,
      [payload.enabled === true, payload.percent ?? null, payload.minimumHours ?? payload.minimum_hours ?? null]
    );
    stats.settingsChanged += 1;
  }
  if (changes.journal && typeof changes.journal === 'object') {
    const payload = changes.journal;
    await client.query(
      `INSERT INTO settings_journal (id, max_rows)
       VALUES (1, $1)
       ON CONFLICT (id)
       DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()`,
      [payload.maxRows ?? payload.max_rows ?? 200]
    );
    stats.settingsChanged += 1;
  }
  if (changes.columns) {
    const payload = changes.columns;
    if (Array.isArray(payload.upserts)) {
      for (const item of payload.upserts) {
        if (!item || typeof item !== 'object') continue;
        await client.query(
          `INSERT INTO settings_columns (column_key, width_px)
           VALUES ($1, $2)
           ON CONFLICT (column_key)
           DO UPDATE SET width_px = EXCLUDED.width_px, updated_at = NOW()`,
          [item.columnKey || item.column_key, item.widthPx ?? item.width_px ?? null]
        );
        stats.settingsChanged += 1;
      }
    }
    if (Array.isArray(payload.deletes)) {
      for (const item of payload.deletes) {
        const key = item && (item.columnKey || item.column_key || item);
        if (!key) continue;
        await client.query('DELETE FROM settings_columns WHERE column_key = $1', [key]);
        stats.settingsChanged += 1;
      }
    }
  }
  if (changes.crmMapping) {
    const payload = changes.crmMapping;
    if (Array.isArray(payload.upserts)) {
      for (const item of payload.upserts) {
        if (!item || typeof item !== 'object') continue;
        await client.query(
          `INSERT INTO settings_crm_mapping (crm_stage_name, planner_stage_code, is_ignored)
           VALUES ($1, $2, $3)
           ON CONFLICT (crm_stage_name)
           DO UPDATE SET planner_stage_code = EXCLUDED.planner_stage_code,
                         is_ignored = EXCLUDED.is_ignored,
                         updated_at = NOW()`,
          [
            item.crmStageName || item.crm_stage_name,
            item.plannerStageCode ?? item.planner_stage_code ?? null,
            item.isIgnored === true
          ]
        );
        stats.settingsChanged += 1;
      }
    }
    if (Array.isArray(payload.deletes)) {
      for (const item of payload.deletes) {
        const key = item && (item.crmStageName || item.crm_stage_name || item);
        if (!key) continue;
        await client.query('DELETE FROM settings_crm_mapping WHERE crm_stage_name = $1', [key]);
        stats.settingsChanged += 1;
      }
    }
  }
  if (changes.admin && typeof changes.admin === 'object') {
    const payload = changes.admin;
    await client.query(
      `INSERT INTO settings_admin (id, allow_force_overwrite, history_retention_count, checkpoint_interval_days)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id)
       DO UPDATE SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
                     history_retention_count = EXCLUDED.history_retention_count,
                     checkpoint_interval_days = EXCLUDED.checkpoint_interval_days,
                     updated_at = NOW()`,
      [
        payload.allowForceOverwrite === true,
        payload.historyRetentionCount ?? payload.history_retention_count ?? 50,
        payload.checkpointIntervalDays ?? payload.checkpoint_interval_days ?? 1
      ]
    );
    stats.settingsChanged += 1;
  }
};

const applyChanges = async (client, changes) => {
  const stats = {
    ordersInserted: 0,
    ordersUpdated: 0,
    ordersDeleted: 0,
    stagesInserted: 0,
    stagesUpdated: 0,
    stagesDeleted: 0,
    dependenciesUpserted: 0,
    dependenciesDeleted: 0,
    capacityUpserted: 0,
    capacityDeleted: 0,
    excludedUpserted: 0,
    excludedDeleted: 0,
    settingsChanged: 0
  };

  if (changes && typeof changes === 'object') {
    await applyOrderChanges(client, changes.orders, stats);
    await applyStageChanges(client, changes.stages, stats);
    await applyDependencyChanges(client, changes.stageDependencies, stats);
    await applyCapacityChanges(client, changes.stageCapacity, stats);
    await applyExcludedChanges(client, changes.excludedStatuses, stats);
    await applySettingsChanges(client, changes.settings, stats);
  }

  return stats;
};

const formatStatsSummary = (stats) => {
  const parts = [];
  if (stats.ordersInserted || stats.ordersUpdated || stats.ordersDeleted) {
    parts.push(`orders +${stats.ordersInserted} upd:${stats.ordersUpdated} del:${stats.ordersDeleted}`);
  }
  if (stats.stagesInserted || stats.stagesUpdated || stats.stagesDeleted) {
    parts.push(`stages +${stats.stagesInserted} upd:${stats.stagesUpdated} del:${stats.stagesDeleted}`);
  }
  if (stats.dependenciesUpserted || stats.dependenciesDeleted) {
    parts.push(`deps ${stats.dependenciesUpserted}/${stats.dependenciesDeleted}`);
  }
  if (stats.capacityUpserted || stats.capacityDeleted) {
    parts.push(`capacity ${stats.capacityUpserted}/${stats.capacityDeleted}`);
  }
  if (stats.excludedUpserted || stats.excludedDeleted) {
    parts.push(`excluded ${stats.excludedUpserted}/${stats.excludedDeleted}`);
  }
  if (stats.settingsChanged) {
    parts.push(`settings ${stats.settingsChanged}`);
  }
  return parts.join(', ');
};

const sendSse = (payload) => {
  const text = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(text);
    } catch (err) {
      console.warn('Failed to deliver SSE payload', err);
    }
  }
};
app.get('/api/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
    try {
      res.end();
    } catch (_err) {
      /* ignore */
    }
  });
  const client = await pool.connect();
  try {
    const currentRev = await fetchCurrentRevision(client);
    res.write(`data: ${JSON.stringify({ rev: currentRev, etag: formatEtag(currentRev) })}\n\n`);
  } finally {
    client.release();
  }
});

app.get('/api/state', async (req, res) => {
  const sinceRevRaw = req.query.since_rev ?? req.query.sinceRev ?? null;
  const sinceRev = sinceRevRaw == null ? null : Number.parseInt(String(sinceRevRaw), 10);
  await withClient(async (client) => {
    const currentRev = await fetchCurrentRevision(client);
    res.setHeader('ETag', formatEtag(currentRev));
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (sinceRev === null || Number.isNaN(sinceRev)) {
      const payload = await buildFullState(client, currentRev);
      res.json(payload);
      return;
    }
    const payload = await buildDelta(client, sinceRev, currentRev);
    res.json(payload);
  });
});

app.get('/api/settings', async (_req, res) => {
  await withClient(async (client) => {
    const currentRev = await fetchCurrentRevision(client);
    const settings = await readSettings(client);
    res.setHeader('ETag', formatEtag(currentRev));
    res.json({ rev: currentRev, etag: formatEtag(currentRev), settings });
  });
});

const validateChangesPayload = (body) => {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid payload' };
  }
  const baseRev = Number.parseInt(body.base_rev ?? body.baseRev, 10);
  if (!Number.isFinite(baseRev) || baseRev < 0) {
    return { error: 'base_rev is required' };
  }
  const changes = body.changes;
  if (!changes || typeof changes !== 'object') {
    return { error: 'changes object is required' };
  }
  const actor = typeof body.actor === 'string' ? body.actor : null;
  const source = typeof body.source === 'string' ? body.source : null;
  const summary = typeof body.summary === 'string' ? body.summary : null;
  const forceOverwrite = body.forceOverwrite === true || body.force_overwrite === true
    || (body.meta && body.meta.forceOverwrite === true);
  return { baseRev, changes, actor, source, summary, forceOverwrite };
};

const setSequenceToMax = async (client, table, column) => {
  const seqRes = await client.query(
    `SELECT pg_get_serial_sequence($1, $2) AS seq`,
    [table, column]
  );
  const seqName = seqRes.rows[0]?.seq;
  if (!seqName) return;
  await client.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${column}) FROM ${table}), 0))`,
    [seqName]
  );
};

const snapshotAtRevision = async (client, table, columns, targetRev) => {
  const colList = columns.join(', ');
  const rows = await client.query(
    `SELECT ${colList}
       FROM ${table}_hist
      WHERE rev_from <= $1
        AND (rev_to IS NULL OR rev_to >= $1)
      ORDER BY ${columns[0]}`,
    [targetRev]
  );
  return rows.rows;
};

const rebuildFromRevision = async (client, targetRev) => {
  await client.query('DELETE FROM stage_dependencies');
  await client.query('DELETE FROM order_stages');
  await client.query('DELETE FROM orders');
  await client.query('DELETE FROM stage_capacity');
  await client.query('DELETE FROM excluded_statuses');
  await client.query('DELETE FROM settings_columns');
  await client.query('DELETE FROM settings_crm_mapping');
  await client.query('DELETE FROM settings_autoweight');
  await client.query('DELETE FROM settings_journal');
  await client.query('DELETE FROM settings_admin');

  const orders = await snapshotAtRevision(client, 'orders', ['id', 'order_no', 'client', 'name', 'deleted_at', 'created_at', 'updated_at'], targetRev);
  for (const row of orders) {
    await client.query(
      `INSERT INTO orders (id, order_no, client, name, deleted_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)` ,
      [row.id, row.order_no, row.client, row.name, row.deleted_at, row.created_at, row.updated_at]
    );
  }
  await setSequenceToMax(client, 'orders', 'id');

  const stages = await snapshotAtRevision(
    client,
    'order_stages',
    ['id', 'order_id', 'stage_code', 'start_at', 'end_at', 'progress_pct', 'status', 'is_done', 'trash_at', 'created_at', 'updated_at'],
    targetRev
  );
  for (const row of stages) {
    await client.query(
      `INSERT INTO order_stages (
        id, order_id, stage_code, start_at, end_at, progress_pct, status, is_done, trash_at, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)` ,
      [
        row.id,
        row.order_id,
        row.stage_code,
        row.start_at,
        row.end_at,
        row.progress_pct,
        row.status,
        row.is_done,
        row.trash_at,
        row.created_at,
        row.updated_at
      ]
    );
  }
  await setSequenceToMax(client, 'order_stages', 'id');

  const dependencies = await snapshotAtRevision(client, 'stage_dependencies', ['order_id', 'from_stage', 'to_stage'], targetRev);
  for (const row of dependencies) {
    await client.query(
      `INSERT INTO stage_dependencies (order_id, from_stage, to_stage) VALUES ($1,$2,$3)` ,
      [row.order_id, row.from_stage, row.to_stage]
    );
  }

  const capacity = await snapshotAtRevision(client, 'stage_capacity', ['stage_code', 'capacity_per_day', 'parallel_limit', 'updated_at'], targetRev);
  for (const row of capacity) {
    await client.query(
      `INSERT INTO stage_capacity (stage_code, capacity_per_day, parallel_limit, updated_at)
       VALUES ($1,$2,$3,$4)` ,
      [row.stage_code, row.capacity_per_day, row.parallel_limit, row.updated_at]
    );
  }

  const excluded = await snapshotAtRevision(client, 'excluded_statuses', ['status_code', 'created_at'], targetRev);
  for (const row of excluded) {
    await client.query(
      `INSERT INTO excluded_statuses (status_code, created_at) VALUES ($1,$2)` ,
      [row.status_code, row.created_at]
    );
  }

  const columns = await snapshotAtRevision(client, 'settings_columns', ['column_key', 'width_px', 'updated_at'], targetRev);
  for (const row of columns) {
    await client.query(
      `INSERT INTO settings_columns (column_key, width_px, updated_at) VALUES ($1,$2,$3)` ,
      [row.column_key, row.width_px, row.updated_at]
    );
  }

  const crmMapping = await snapshotAtRevision(client, 'settings_crm_mapping', ['crm_stage_name', 'planner_stage_code', 'is_ignored', 'updated_at'], targetRev);
  for (const row of crmMapping) {
    await client.query(
      `INSERT INTO settings_crm_mapping (crm_stage_name, planner_stage_code, is_ignored, updated_at)
       VALUES ($1,$2,$3,$4)` ,
      [row.crm_stage_name, row.planner_stage_code, row.is_ignored, row.updated_at]
    );
  }

  const autoweight = await snapshotAtRevision(client, 'settings_autoweight', ['id', 'enabled', 'percent', 'minimum_hours', 'updated_at'], targetRev);
  if (autoweight.length) {
    const row = autoweight[0];
    await client.query(
      `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
       VALUES ($1,$2,$3,$4,$5)` ,
      [row.id, row.enabled, row.percent, row.minimum_hours, row.updated_at]
    );
  }

  const journal = await snapshotAtRevision(client, 'settings_journal', ['id', 'max_rows', 'updated_at'], targetRev);
  if (journal.length) {
    const row = journal[0];
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at) VALUES ($1,$2,$3)` ,
      [row.id, row.max_rows, row.updated_at]
    );
  }

  const admin = await snapshotAtRevision(
    client,
    'settings_admin',
    ['id', 'allow_force_overwrite', 'history_retention_count', 'checkpoint_interval_days', 'updated_at'],
    targetRev
  );
  if (admin.length) {
    const row = admin[0];
    await client.query(
      `INSERT INTO settings_admin (id, allow_force_overwrite, history_retention_count, checkpoint_interval_days, updated_at)
       VALUES ($1,$2,$3,$4,$5)` ,
      [row.id, row.allow_force_overwrite, row.history_retention_count, row.checkpoint_interval_days, row.updated_at]
    );
  }
};

const logActivity = async (client, rev, actor, source, action, summary) => {
  await client.query(
    `INSERT INTO activity_log (rev, actor, source, action, summary)
     VALUES ($1,$2,$3,$4,$5)` ,
    [rev, actor, source, action, summary]
  );
};

const buildHistoryList = async (client, limit, offset) => {
  const { rows } = await client.query(
    `SELECT rev, ts, actor, source, action, summary
       FROM activity_log
      ORDER BY rev DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows.map((row) => ({
    rev: Number(row.rev),
    timestamp: row.ts,
    actor: row.actor,
    source: row.source,
    action: row.action,
    summary: row.summary
  }));
};

const buildSnapshot = async (client, targetRev) => {
  const [orders, stages, stageDependencies, stageCapacity, excludedStatuses, settings] = await Promise.all([
    snapshotAtRevision(client, 'orders', ['id', 'order_no', 'client', 'name', 'deleted_at', 'created_at', 'updated_at'], targetRev),
    snapshotAtRevision(
      client,
      'order_stages',
      ['id', 'order_id', 'stage_code', 'start_at', 'end_at', 'progress_pct', 'status', 'is_done', 'trash_at', 'created_at', 'updated_at'],
      targetRev
    ),
    snapshotAtRevision(client, 'stage_dependencies', ['order_id', 'from_stage', 'to_stage'], targetRev),
    snapshotAtRevision(client, 'stage_capacity', ['stage_code', 'capacity_per_day', 'parallel_limit', 'updated_at'], targetRev),
    snapshotAtRevision(client, 'excluded_statuses', ['status_code', 'created_at'], targetRev),
    (async () => {
      const autoweight = await snapshotAtRevision(client, 'settings_autoweight', ['id', 'enabled', 'percent', 'minimum_hours', 'updated_at'], targetRev);
      const journal = await snapshotAtRevision(client, 'settings_journal', ['id', 'max_rows', 'updated_at'], targetRev);
      const columns = await snapshotAtRevision(client, 'settings_columns', ['column_key', 'width_px', 'updated_at'], targetRev);
      const mapping = await snapshotAtRevision(client, 'settings_crm_mapping', ['crm_stage_name', 'planner_stage_code', 'is_ignored', 'updated_at'], targetRev);
      const admin = await snapshotAtRevision(client, 'settings_admin', ['id', 'allow_force_overwrite', 'history_retention_count', 'checkpoint_interval_days', 'updated_at'], targetRev);
      return {
        autoweight,
        journal,
        columns,
        crmMapping: mapping,
        admin
      };
    })()
  ]);
  return {
    orders,
    stages,
    stageDependencies,
    stageCapacity,
    excludedStatuses,
    settings
  };
};
app.put('/api/changes', async (req, res) => {
  const validation = validateChangesPayload(req.body);
  if (validation.error) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { baseRev, changes, actor, source, summary, forceOverwrite } = validation;
  const ifMatchRev = parseIfMatchRevision(req.headers['if-match'] ?? req.headers['If-Match']);
  if (ifMatchRev !== null && ifMatchRev !== baseRev) {
    res.status(412).json({ error: 'Precondition Failed', expected: ifMatchRev });
    return;
  }

  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query('SELECT current_rev FROM revisions WHERE id = 1 FOR UPDATE');
      const currentRev = rows.length ? Number(rows[0].current_rev) : 0;
      const adminSettings = await fetchAdminSettings(client);
      const allowForce = adminSettings.allow_force_overwrite === true;
      if (currentRev !== baseRev && !(allowForce && forceOverwrite)) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'Conflict', currentRev, allowForceOverwrite: allowForce });
        return;
      }
      const nextRev = currentRev + 1;
      await client.query('UPDATE revisions SET current_rev = $1 WHERE id = 1', [nextRev]);
      await client.query("SELECT set_config('planner.current_rev', $1::text, true)", [String(nextRev)]);
      const stats = await applyChanges(client, changes);
      const finalSummary = summary || formatStatsSummary(stats) || 'no changes';
      await logActivity(client, nextRev, actor, source, 'apply-changes', finalSummary);
      await client.query('COMMIT');

      const delta = await buildDelta(client, currentRev, nextRev);
      res.setHeader('ETag', formatEtag(nextRev));
      res.json({ rev: nextRev, etag: formatEtag(nextRev), delta, summary: finalSummary });
      sendSse({ rev: nextRev, etag: formatEtag(nextRev), summary: finalSummary });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Failed to apply changes', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
});

app.get('/api/admin/history', async (req, res) => {
  const limit = Number.parseInt(req.query.limit, 10);
  const offset = Number.parseInt(req.query.offset, 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  await withClient(async (client) => {
    const currentRev = await fetchCurrentRevision(client);
    const items = await buildHistoryList(client, safeLimit, safeOffset);
    res.json({ rev: currentRev, etag: formatEtag(currentRev), items });
  });
});

app.get('/api/admin/history/:rev', async (req, res) => {
  const targetRev = Number.parseInt(req.params.rev, 10);
  if (!Number.isFinite(targetRev) || targetRev < 0) {
    res.status(400).json({ error: 'Invalid revision' });
    return;
  }
  await withClient(async (client) => {
    const currentRev = await fetchCurrentRevision(client);
    if (targetRev > currentRev) {
      res.status(404).json({ error: 'Revision not found' });
      return;
    }
    const snapshot = await buildSnapshot(client, targetRev);
    res.json({ rev: targetRev, data: snapshot });
  });
});

app.post('/api/admin/rollback', async (req, res) => {
  const targetRev = Number.parseInt(req.body?.target_rev ?? req.body?.targetRev ?? req.body?.targetHash ?? req.body?.target, 10);
  if (!Number.isFinite(targetRev) || targetRev < 0) {
    res.status(400).json({ error: 'Invalid target revision' });
    return;
  }
  const note = typeof req.body?.note === 'string' ? req.body.note : null;
  const actor = typeof req.body?.actor === 'string' ? req.body.actor : 'admin';
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query('SELECT current_rev FROM revisions WHERE id = 1 FOR UPDATE');
      const currentRev = rows.length ? Number(rows[0].current_rev) : 0;
      if (targetRev > currentRev) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Revision not found' });
        return;
      }
      const nextRev = currentRev + 1;
      await client.query('UPDATE revisions SET current_rev = $1 WHERE id = 1', [nextRev]);
      await client.query("SELECT set_config('planner.current_rev', $1::text, true)", [String(nextRev)]);
      await rebuildFromRevision(client, targetRev);
      await logActivity(
        client,
        nextRev,
        actor,
        'rollback',
        'rollback',
        note ? `rollback to ${targetRev}: ${note}` : `rollback to ${targetRev}`
      );
      await client.query(
        `INSERT INTO checkpoints (rev, note) VALUES ($1, $2)
         ON CONFLICT (rev) DO UPDATE SET note = EXCLUDED.note`,
        [nextRev, note]
      );
      await client.query('COMMIT');
      const delta = await buildDelta(client, currentRev, nextRev);
      res.setHeader('ETag', formatEtag(nextRev));
      res.json({ rev: nextRev, etag: formatEtag(nextRev), delta });
      sendSse({ rev: nextRev, etag: formatEtag(nextRev), summary: `rollback to ${targetRev}` });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Failed to rollback', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
});

app.post('/api/admin/checkpoint', async (req, res) => {
  await withClient(async (client) => {
    const currentRev = await fetchCurrentRevision(client);
    const note = typeof req.body?.note === 'string' ? req.body.note : null;
    await client.query(
      `INSERT INTO checkpoints (rev, note)
       VALUES ($1,$2)
       ON CONFLICT (rev) DO UPDATE SET note = EXCLUDED.note`,
      [currentRev, note]
    );
    res.json({ rev: currentRev, etag: formatEtag(currentRev) });
  });
});

app.use(express.static(PUBLIC_DIR));

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
});

const start = async () => {
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`Planner server listening on port ${PORT}`);
  });
};

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exitCode = 1;
});
