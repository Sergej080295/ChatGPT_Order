'use strict';

const { newDb } = require('pg-mem');
const { createDataLayer } = require('../src/data-layer');

async function main() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  const layer = createDataLayer(pool);
  await layer.ensureSchema();

  const createdOrder = await layer.createOrder({
    title: 'Демонстрационный заказ',
    number: 'CRM-001',
    board: 'crm',
    customer: 'ООО «Тест»',
    readyPercent: 10
  });

  const stage = await layer.createStageTask(createdOrder.id, {
    stageCode: 'laser',
    readyPercent: 40,
    expectedPercent: 50,
    plannedFinish: new Date().toISOString()
  });

  await layer.updateStageTask(stage.id, { readyPercent: 60 });

  const orders = await layer.listOrders({ includeStages: true });
  const laserTasks = await layer.listStageTasks('laser', { includeOrders: true });

  console.log('Orders:', JSON.stringify(orders, null, 2));
  console.log('Laser stage tasks:', JSON.stringify(laserTasks, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
