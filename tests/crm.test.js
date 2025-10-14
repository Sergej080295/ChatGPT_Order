const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const {
  normalizeCrmStateSnapshot,
  syncCrmTables,
  loadCrmState
} = require('../server');

const CRM_SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '017_crm_sql_integration.sql'),
  'utf8'
);

function createInMemoryPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const statements = CRM_SCHEMA_SQL
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !/^--/i.test(statement))
    .filter((statement) => !/^BEGIN$/i.test(statement))
    .filter((statement) => !/^COMMIT$/i.test(statement));

  statements.forEach((statement) => {
    db.public.none(`${statement};`);
  });

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return { pool };
}

test('syncCrmTables persists CRM snapshot and loadCrmState rebuilds it', async (t) => {
  const { pool } = createInMemoryPool();
  t.after(() => pool.end());

  const rawState = {
    boards: [
      {
        id: 'board-alpha',
        name: '  Alpha Board  ',
        lanes: ['New', 'In Progress', ''],
        theme: 'navy',
        orders: [
          {
            id: 'order-1',
            title: '  First Order  ',
            status: 'New',
            progress: 15.4,
            done: false,
            serviceTotal: '12 345,67',
            childIds: [' child-a ', '', null],
            parentId: ' parent-01 ',
            notes: '  note  ',
            orderNo: ' #123 ',
            customer: ' Customer A ',
            start: '2024-01-02',
            end: '2024-01-05'
          }
        ]
      }
    ],
    currentBoardId: 'board-alpha',
    updatedAt: '2024-01-01T10:00:00Z',
    mini_crm_theme: 'dark'
  };

  const { state, normalizedBoards, stateMeta } = normalizeCrmStateSnapshot(rawState);
  const client = await pool.connect();
  try {
    await syncCrmTables(client, normalizedBoards, state, stateMeta);
  } finally {
    client.release();
  }

  const boardResult = await pool.query(
    'SELECT id, name, lanes, position, payload FROM crm_boards ORDER BY position'
  );
  assert.equal(boardResult.rowCount, 1);
  const boardRow = boardResult.rows[0];
  assert.equal(boardRow.id, 'board-alpha');
  assert.equal(boardRow.name.trim(), 'Alpha Board');
  assert.deepEqual(boardRow.lanes, ['New', 'In Progress']);
  assert.equal(boardRow.payload.theme, 'navy');
  assert.equal(boardRow.payload.orders, undefined);

  const orderResult = await pool.query(
    'SELECT id, board_id, title, status, position, progress, service_total, child_ids, parent_id FROM crm_orders'
  );
  assert.equal(orderResult.rowCount, 1);
  const orderRow = orderResult.rows[0];
  assert.equal(orderRow.id, 'order-1');
  assert.equal(orderRow.board_id, 'board-alpha');
  assert.equal(orderRow.title.trim(), 'First Order');
  assert.equal(orderRow.status, 'New');
  assert.equal(orderRow.position, 0);
  assert.equal(orderRow.progress, 15);
  assert.deepEqual(orderRow.child_ids, ['child-a']);
  assert.equal(orderRow.parent_id, 'parent-01');
  assert.equal(Number(orderRow.service_total), 12345.67);

  const loaded = await loadCrmState(pool);
  assert.equal(loaded.hasData, true);
  assert.equal(loaded.state.currentBoardId, 'board-alpha');
  assert.equal(loaded.state.mini_crm_theme, 'dark');
  assert.equal(loaded.state.boards.length, 1);
  const loadedOrder = loaded.state.boards[0].orders[0];
  assert.equal(loadedOrder.id, 'order-1');
  assert.equal(loadedOrder.title, 'First Order');
  assert.equal(loadedOrder.childIds[0], 'child-a');
});

test('syncCrmTables replaces previous CRM data snapshot', async (t) => {
  const { pool } = createInMemoryPool();
  t.after(() => pool.end());

  const firstState = {
    boards: [
      {
        id: 'board-alpha',
        name: 'Alpha',
        lanes: ['New'],
        orders: [
          { id: 'order-a', title: 'First', status: 'New', progress: 5 }
        ]
      }
    ],
    currentBoardId: 'board-alpha',
    updatedAt: '2024-02-01T00:00:00Z'
  };

  const { state: firstNormalized, normalizedBoards: firstBoards, stateMeta: firstMeta } =
    normalizeCrmStateSnapshot(firstState);
  const client = await pool.connect();
  try {
    await syncCrmTables(client, firstBoards, firstNormalized, firstMeta);
  } finally {
    client.release();
  }

  const secondState = {
    boards: [
      {
        id: 'board-beta',
        name: 'Beta',
        lanes: ['Queue'],
        orders: [
          { id: 'order-b', title: 'Second', status: 'Queue', progress: 65 }
        ]
      }
    ],
    currentBoardId: 'board-beta',
    updatedAt: '2024-03-01T00:00:00Z'
  };

  const { state: secondNormalized, normalizedBoards: secondBoards, stateMeta: secondMeta } =
    normalizeCrmStateSnapshot(secondState);
  const client2 = await pool.connect();
  try {
    await syncCrmTables(client2, secondBoards, secondNormalized, secondMeta);
  } finally {
    client2.release();
  }

  const boardIds = await pool.query('SELECT id FROM crm_boards ORDER BY id');
  assert.deepEqual(boardIds.rows.map((row) => row.id), ['board-beta']);

  const { state: reloaded } = await loadCrmState(pool);
  assert.equal(reloaded.boards.length, 1);
  assert.equal(reloaded.boards[0].id, 'board-beta');
  assert.equal(reloaded.boards[0].orders.length, 1);
  assert.equal(reloaded.boards[0].orders[0].title, 'Second');
});

test('loadCrmState returns empty payload when tables are empty', async (t) => {
  const { pool } = createInMemoryPool();
  t.after(() => pool.end());

  const loaded = await loadCrmState(pool);
  assert.equal(loaded.hasData, false);
  assert.deepEqual(loaded.state.boards, []);
  assert.equal(loaded.state.currentBoardId, null);
  assert.equal(loaded.state.updatedAt, '');
});
