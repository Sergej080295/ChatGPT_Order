'use strict';

const crypto = require('crypto');

const STAGE_CATALOG = [
  { code: 'draw', name: 'Техподготовка' },
  { code: 'proc', name: 'Закупка' },
  { code: 'shear', name: 'Рубка' },
  { code: 'laser', name: 'Лазер' },
  { code: 'bend', name: 'Гибка' },
  { code: 'weld', name: 'Сварка' },
  { code: 'mech', name: 'Мехобработка' },
  { code: 'coop', name: 'Кооперация' },
  { code: 'pack', name: 'Упаковка' },
  { code: 'ship', name: 'Отгрузка' }
];

const STAGE_NAME_BY_CODE = new Map(STAGE_CATALOG.map((entry) => [entry.code, entry.name]));

function normalizeStageCode(code) {
  if (!code) return null;
  const normalized = String(code).trim().toLowerCase();
  if (!normalized) return null;
  if (STAGE_NAME_BY_CODE.has(normalized)) {
    return normalized;
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix || 'id'}_${crypto.randomUUID()}`;
}

function pickDefined(source, fields) {
  const payload = {};
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
      payload[field] = source[field];
    }
  });
  return payload;
}

function asNullableText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  return String(value);
}

function asNullableNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/%/g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function createDataLayer(pool) {
  let schemaPromise = null;

  async function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DROP TABLE IF EXISTS planner_state_snapshots CASCADE');
          await client.query('DROP TABLE IF EXISTS pc_stage_sequences CASCADE');
          await client.query('DROP TABLE IF EXISTS pc_order_tasks CASCADE');
          await client.query('DROP TABLE IF EXISTS pc_orders CASCADE');
          await client.query('DROP TABLE IF EXISTS pc_settings CASCADE');
          await client.query('DROP TABLE IF EXISTS pc_journal CASCADE');

          await client.query(`
            CREATE TABLE pc_orders (
              id TEXT PRIMARY KEY,
              board_code TEXT NOT NULL,
              lane_code TEXT,
              position INTEGER NOT NULL DEFAULT 0,
              number TEXT,
              title TEXT NOT NULL,
              customer TEXT,
              priority TEXT,
              status TEXT,
              manager TEXT,
              ready_percent NUMERIC,
              expected_percent NUMERIC,
              planned_start TIMESTAMPTZ,
              planned_finish TIMESTAMPTZ,
              actual_start TIMESTAMPTZ,
              actual_finish TIMESTAMPTZ,
              due_date TIMESTAMPTZ,
              notes TEXT,
              meta JSONB NOT NULL DEFAULT '{}'::jsonb,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);

          await client.query(`
            CREATE TABLE pc_order_tasks (
              id TEXT PRIMARY KEY,
              order_id TEXT NOT NULL REFERENCES pc_orders(id) ON DELETE CASCADE,
              stage_code TEXT NOT NULL,
              stage_name TEXT NOT NULL,
              position INTEGER NOT NULL DEFAULT 0,
              status TEXT,
              executor TEXT,
              ready_percent NUMERIC,
              expected_percent NUMERIC,
              planned_start TIMESTAMPTZ,
              planned_finish TIMESTAMPTZ,
              actual_start TIMESTAMPTZ,
              actual_finish TIMESTAMPTZ,
              due_date TIMESTAMPTZ,
              notes TEXT,
              meta JSONB NOT NULL DEFAULT '{}'::jsonb,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);

          await client.query('CREATE INDEX pc_order_tasks_order_idx ON pc_order_tasks(order_id)');
          await client.query('CREATE INDEX pc_order_tasks_stage_idx ON pc_order_tasks(stage_code)');

          await client.query(`
            CREATE TABLE pc_settings (
              key TEXT PRIMARY KEY,
              payload JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);

          await client.query(`
            CREATE TABLE pc_journal (
              id BIGSERIAL PRIMARY KEY,
              kind TEXT NOT NULL,
              payload JSONB NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `);

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      })();
    }
    return schemaPromise;
  }

  async function withClient(fn) {
    await ensureSchema();
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  function mapOrderRow(row) {
    return {
      id: row.id,
      board: row.board_code,
      lane: row.lane_code,
      position: Number.isFinite(row.position) ? Number(row.position) : 0,
      number: row.number,
      title: row.title,
      customer: row.customer,
      priority: row.priority,
      status: row.status,
      manager: row.manager,
      readyPercent: row.ready_percent === null ? null : Number(row.ready_percent),
      expectedPercent: row.expected_percent === null ? null : Number(row.expected_percent),
      plannedStart: row.planned_start ? new Date(row.planned_start).toISOString() : null,
      plannedFinish: row.planned_finish ? new Date(row.planned_finish).toISOString() : null,
      actualStart: row.actual_start ? new Date(row.actual_start).toISOString() : null,
      actualFinish: row.actual_finish ? new Date(row.actual_finish).toISOString() : null,
      dueDate: row.due_date ? new Date(row.due_date).toISOString() : null,
      notes: row.notes,
      meta: row.meta || {},
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  function mapTaskRow(row) {
    return {
      id: row.id,
      orderId: row.order_id,
      stageCode: row.stage_code,
      stageName: row.stage_name,
      position: Number.isFinite(row.position) ? Number(row.position) : 0,
      status: row.status,
      executor: row.executor,
      readyPercent: row.ready_percent === null ? null : Number(row.ready_percent),
      expectedPercent: row.expected_percent === null ? null : Number(row.expected_percent),
      plannedStart: row.planned_start ? new Date(row.planned_start).toISOString() : null,
      plannedFinish: row.planned_finish ? new Date(row.planned_finish).toISOString() : null,
      actualStart: row.actual_start ? new Date(row.actual_start).toISOString() : null,
      actualFinish: row.actual_finish ? new Date(row.actual_finish).toISOString() : null,
      dueDate: row.due_date ? new Date(row.due_date).toISOString() : null,
      notes: row.notes,
      meta: row.meta || {},
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
    };
  }

  async function listOrders(options = {}) {
    return withClient(async (client) => {
      const params = [];
      const where = [];
      if (options.board) {
        params.push(options.board);
        where.push(`board_code = $${params.length}`);
      }
      if (options.search) {
        params.push(`%${options.search.toLowerCase()}%`);
        where.push(`lower(title) LIKE $${params.length}`);
      }
      const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const orderRows = await client.query(
        `SELECT * FROM pc_orders ${whereClause} ORDER BY position ASC, updated_at DESC`,
        params
      );
      const orders = orderRows.rows.map(mapOrderRow);
      if (!options.includeStages || orders.length === 0) {
        return orders;
      }
      const ids = orders.map((order) => order.id);
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
      const taskRows = await client.query(
        `SELECT * FROM pc_order_tasks WHERE order_id IN (${placeholders}) ORDER BY stage_code, position ASC`,
        ids
      );
      const tasks = taskRows.rows.map(mapTaskRow);
      const tasksByOrder = new Map();
      tasks.forEach((task) => {
        if (!tasksByOrder.has(task.orderId)) {
          tasksByOrder.set(task.orderId, []);
        }
        tasksByOrder.get(task.orderId).push(task);
      });
      orders.forEach((order) => {
        order.stages = tasksByOrder.get(order.id) || [];
      });
      return orders;
    });
  }

  async function getOrder(orderId, options = {}) {
    return withClient(async (client) => {
      const row = await client.query('SELECT * FROM pc_orders WHERE id = $1', [orderId]);
      if (row.rows.length === 0) return null;
      const order = mapOrderRow(row.rows[0]);
      if (options.includeStages) {
        const taskRows = await client.query(
          'SELECT * FROM pc_order_tasks WHERE order_id = $1 ORDER BY stage_code, position ASC',
          [orderId]
        );
        order.stages = taskRows.rows.map(mapTaskRow);
      }
      return order;
    });
  }

  async function listStageTasks(stageCode, options = {}) {
    const code = normalizeStageCode(stageCode);
    if (!code) {
      return [];
    }
    return withClient(async (client) => {
      const taskRows = await client.query(
        'SELECT * FROM pc_order_tasks WHERE stage_code = $1 ORDER BY position ASC, updated_at DESC',
        [code]
      );
      const tasks = taskRows.rows.map(mapTaskRow);
      if (!options.includeOrders || tasks.length === 0) {
        return tasks;
      }
      const ids = Array.from(new Set(tasks.map((task) => task.orderId)));
      if (ids.length === 0) return tasks;
      const placeholders = ids.map((_, index) => `$${index + 1}`).join(',');
      const ordersRes = await client.query(
        `SELECT * FROM pc_orders WHERE id IN (${placeholders})`,
        ids
      );
      const orderMap = new Map(ordersRes.rows.map((row) => [row.id, mapOrderRow(row)]));
      tasks.forEach((task) => {
        task.order = orderMap.get(task.orderId) || null;
      });
      return tasks;
    });
  }

  async function createOrder(payload) {
    const orderId = payload.id || randomId('order');
    const board = asNullableText(payload.board) || 'crm';
    const lane = asNullableText(payload.lane);
    const params = [
      orderId,
      board,
      lane,
      Number.isFinite(payload.position) ? payload.position : 0,
      asNullableText(payload.number),
      asNullableText(payload.title) || 'Без названия',
      asNullableText(payload.customer),
      asNullableText(payload.priority),
      asNullableText(payload.status),
      asNullableText(payload.manager),
      asNullableNumber(payload.readyPercent),
      asNullableNumber(payload.expectedPercent),
      parseDate(payload.plannedStart),
      parseDate(payload.plannedFinish),
      parseDate(payload.actualStart),
      parseDate(payload.actualFinish),
      parseDate(payload.dueDate),
      asNullableText(payload.notes),
      JSON.stringify(payload.meta || {})
    ];

    await withClient(async (client) => {
      await client.query(
        `INSERT INTO pc_orders (
          id, board_code, lane_code, position, number, title, customer, priority, status, manager,
          ready_percent, expected_percent, planned_start, planned_finish, actual_start, actual_finish,
          due_date, notes, meta, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW()
        )`,
        params
      );

      if (Array.isArray(payload.stages) && payload.stages.length) {
        const stageInserts = payload.stages.map((stage, index) => {
          const code = normalizeStageCode(stage.stageCode || stage.code);
          const id = stage.id || randomId('task');
          return client.query(
            `INSERT INTO pc_order_tasks (
              id, order_id, stage_code, stage_name, position, status, executor,
              ready_percent, expected_percent, planned_start, planned_finish,
              actual_start, actual_finish, due_date, notes, meta, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW()
            )`,
            [
              id,
              orderId,
              code || 'laser',
              STAGE_NAME_BY_CODE.get(code || 'laser') || 'Этап',
              Number.isFinite(stage.position) ? stage.position : index,
              asNullableText(stage.status),
              asNullableText(stage.executor),
              asNullableNumber(stage.readyPercent),
              asNullableNumber(stage.expectedPercent),
              parseDate(stage.plannedStart),
              parseDate(stage.plannedFinish),
              parseDate(stage.actualStart),
              parseDate(stage.actualFinish),
              parseDate(stage.dueDate),
              asNullableText(stage.notes),
              JSON.stringify(stage.meta || {})
            ]
          );
        });
        await Promise.all(stageInserts);
      }
    });

    return getOrder(orderId, { includeStages: true });
  }

  async function updateOrder(orderId, payload) {
    const fields = pickDefined(payload, [
      'board', 'lane', 'position', 'number', 'title', 'customer', 'priority', 'status', 'manager',
      'readyPercent', 'expectedPercent', 'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish',
      'dueDate', 'notes', 'meta'
    ]);
    if (Object.keys(fields).length === 0) {
      return getOrder(orderId, { includeStages: true });
    }
    const sets = [];
    const values = [];
    let index = 1;

    if (fields.board !== undefined) {
      sets.push(`board_code = $${index++}`);
      values.push(asNullableText(fields.board) || 'crm');
    }
    if (fields.lane !== undefined) {
      sets.push(`lane_code = $${index++}`);
      values.push(asNullableText(fields.lane));
    }
    if (fields.position !== undefined) {
      sets.push(`position = $${index++}`);
      values.push(Number.isFinite(fields.position) ? fields.position : 0);
    }
    if (fields.number !== undefined) {
      sets.push(`number = $${index++}`);
      values.push(asNullableText(fields.number));
    }
    if (fields.title !== undefined) {
      sets.push(`title = $${index++}`);
      values.push(asNullableText(fields.title) || 'Без названия');
    }
    if (fields.customer !== undefined) {
      sets.push(`customer = $${index++}`);
      values.push(asNullableText(fields.customer));
    }
    if (fields.priority !== undefined) {
      sets.push(`priority = $${index++}`);
      values.push(asNullableText(fields.priority));
    }
    if (fields.status !== undefined) {
      sets.push(`status = $${index++}`);
      values.push(asNullableText(fields.status));
    }
    if (fields.manager !== undefined) {
      sets.push(`manager = $${index++}`);
      values.push(asNullableText(fields.manager));
    }
    if (fields.readyPercent !== undefined) {
      sets.push(`ready_percent = $${index++}`);
      values.push(asNullableNumber(fields.readyPercent));
    }
    if (fields.expectedPercent !== undefined) {
      sets.push(`expected_percent = $${index++}`);
      values.push(asNullableNumber(fields.expectedPercent));
    }
    if (fields.plannedStart !== undefined) {
      sets.push(`planned_start = $${index++}`);
      values.push(parseDate(fields.plannedStart));
    }
    if (fields.plannedFinish !== undefined) {
      sets.push(`planned_finish = $${index++}`);
      values.push(parseDate(fields.plannedFinish));
    }
    if (fields.actualStart !== undefined) {
      sets.push(`actual_start = $${index++}`);
      values.push(parseDate(fields.actualStart));
    }
    if (fields.actualFinish !== undefined) {
      sets.push(`actual_finish = $${index++}`);
      values.push(parseDate(fields.actualFinish));
    }
    if (fields.dueDate !== undefined) {
      sets.push(`due_date = $${index++}`);
      values.push(parseDate(fields.dueDate));
    }
    if (fields.notes !== undefined) {
      sets.push(`notes = $${index++}`);
      values.push(asNullableText(fields.notes));
    }
    if (fields.meta !== undefined) {
      sets.push(`meta = $${index++}`);
      values.push(JSON.stringify(fields.meta || {}));
    }

    values.push(orderId);

    return withClient(async (client) => {
      await client.query(
        `UPDATE pc_orders SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
        values
      );
      return getOrder(orderId, { includeStages: true });
    });
  }

  async function deleteOrder(orderId) {
    await withClient(async (client) => {
      await client.query('DELETE FROM pc_orders WHERE id = $1', [orderId]);
    });
  }

  async function createStageTask(orderId, payload) {
    const code = normalizeStageCode(payload.stageCode || payload.code) || 'laser';
    const stageId = payload.id || randomId('task');
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO pc_order_tasks (
          id, order_id, stage_code, stage_name, position, status, executor, ready_percent, expected_percent,
          planned_start, planned_finish, actual_start, actual_finish, due_date, notes, meta, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW()
        )`,
        [
          stageId,
          orderId,
          code,
          STAGE_NAME_BY_CODE.get(code) || 'Этап',
          Number.isFinite(payload.position) ? payload.position : 0,
          asNullableText(payload.status),
          asNullableText(payload.executor),
          asNullableNumber(payload.readyPercent),
          asNullableNumber(payload.expectedPercent),
          parseDate(payload.plannedStart),
          parseDate(payload.plannedFinish),
          parseDate(payload.actualStart),
          parseDate(payload.actualFinish),
          parseDate(payload.dueDate),
          asNullableText(payload.notes),
          JSON.stringify(payload.meta || {})
        ]
      );
    });
    return getTask(stageId, { includeOrder: true });
  }

  async function updateStageTask(stageId, payload) {
    const fields = pickDefined(payload, [
      'stageCode', 'stageName', 'position', 'status', 'executor', 'readyPercent', 'expectedPercent',
      'plannedStart', 'plannedFinish', 'actualStart', 'actualFinish', 'dueDate', 'notes', 'meta'
    ]);
    if (Object.keys(fields).length === 0) {
      return getTask(stageId, { includeOrder: true });
    }
    const sets = [];
    const values = [];
    let index = 1;

    if (fields.stageCode !== undefined) {
      const code = normalizeStageCode(fields.stageCode) || 'laser';
      sets.push(`stage_code = $${index++}`);
      values.push(code);
      sets.push(`stage_name = $${index++}`);
      values.push(STAGE_NAME_BY_CODE.get(code) || 'Этап');
    }
    if (fields.stageName !== undefined) {
      sets.push(`stage_name = $${index++}`);
      values.push(asNullableText(fields.stageName) || 'Этап');
    }
    if (fields.position !== undefined) {
      sets.push(`position = $${index++}`);
      values.push(Number.isFinite(fields.position) ? fields.position : 0);
    }
    if (fields.status !== undefined) {
      sets.push(`status = $${index++}`);
      values.push(asNullableText(fields.status));
    }
    if (fields.executor !== undefined) {
      sets.push(`executor = $${index++}`);
      values.push(asNullableText(fields.executor));
    }
    if (fields.readyPercent !== undefined) {
      sets.push(`ready_percent = $${index++}`);
      values.push(asNullableNumber(fields.readyPercent));
    }
    if (fields.expectedPercent !== undefined) {
      sets.push(`expected_percent = $${index++}`);
      values.push(asNullableNumber(fields.expectedPercent));
    }
    if (fields.plannedStart !== undefined) {
      sets.push(`planned_start = $${index++}`);
      values.push(parseDate(fields.plannedStart));
    }
    if (fields.plannedFinish !== undefined) {
      sets.push(`planned_finish = $${index++}`);
      values.push(parseDate(fields.plannedFinish));
    }
    if (fields.actualStart !== undefined) {
      sets.push(`actual_start = $${index++}`);
      values.push(parseDate(fields.actualStart));
    }
    if (fields.actualFinish !== undefined) {
      sets.push(`actual_finish = $${index++}`);
      values.push(parseDate(fields.actualFinish));
    }
    if (fields.dueDate !== undefined) {
      sets.push(`due_date = $${index++}`);
      values.push(parseDate(fields.dueDate));
    }
    if (fields.notes !== undefined) {
      sets.push(`notes = $${index++}`);
      values.push(asNullableText(fields.notes));
    }
    if (fields.meta !== undefined) {
      sets.push(`meta = $${index++}`);
      values.push(JSON.stringify(fields.meta || {}));
    }

    values.push(stageId);

    return withClient(async (client) => {
      await client.query(
        `UPDATE pc_order_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
        values
      );
      return getTask(stageId, { includeOrder: true });
    });
  }

  async function deleteStageTask(stageId) {
    await withClient(async (client) => {
      await client.query('DELETE FROM pc_order_tasks WHERE id = $1', [stageId]);
    });
  }

  async function getTask(stageId, options = {}) {
    return withClient(async (client) => {
      const row = await client.query('SELECT * FROM pc_order_tasks WHERE id = $1', [stageId]);
      if (row.rows.length === 0) return null;
      const task = mapTaskRow(row.rows[0]);
      if (options.includeOrder) {
        const orderRow = await client.query('SELECT * FROM pc_orders WHERE id = $1', [task.orderId]);
        if (orderRow.rows.length) {
          task.order = mapOrderRow(orderRow.rows[0]);
        }
      }
      return task;
    });
  }

  async function listSettings() {
    return withClient(async (client) => {
      const rows = await client.query('SELECT key, payload FROM pc_settings');
      const settings = {};
      rows.rows.forEach((row) => {
        settings[row.key] = row.payload;
      });
      return settings;
    });
  }

  async function updateSettings(pairs = {}) {
    const entries = Object.entries(pairs);
    if (!entries.length) return listSettings();
    await withClient(async (client) => {
      for (const [key, value] of entries) {
        await client.query(
          `INSERT INTO pc_settings (key, payload, updated_at)
           VALUES ($1,$2::jsonb,NOW())
           ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()` ,
          [key, JSON.stringify(value ?? null)]
        );
      }
    });
    return listSettings();
  }

  async function appendJournalEntry(kind, payload) {
    await withClient(async (client) => {
      await client.query(
        'INSERT INTO pc_journal (kind, payload, created_at) VALUES ($1,$2::jsonb,NOW())',
        [kind, JSON.stringify(payload || {})]
      );
    });
  }

  async function listJournal(limit = 50) {
    return withClient(async (client) => {
      const rows = await client.query(
        'SELECT id, kind, payload, created_at FROM pc_journal ORDER BY id DESC LIMIT $1',
        [limit]
      );
      return rows.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: row.payload || {},
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null
      }));
    });
  }

  return {
    ensureSchema,
    listOrders,
    getOrder,
    createOrder,
    updateOrder,
    deleteOrder,
    listStageTasks,
    createStageTask,
    updateStageTask,
    deleteStageTask,
    getTask,
    listSettings,
    updateSettings,
    appendJournalEntry,
    listJournal,
    STAGE_CATALOG
  };
}

module.exports = {
  createDataLayer,
  STAGE_CATALOG,
  normalizeStageCode
};
