#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://planner:planner@localhost:5432/planner';
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined
});

const readMigrations = () => {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
  return files.map((filename) => ({
    filename,
    fullPath: path.join(MIGRATIONS_DIR, filename),
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
  }));
};

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function alreadyApplied(client, filename) {
  const { rows } = await client.query('SELECT 1 FROM planner_schema_migrations WHERE filename = $1', [filename]);
  return rows.length > 0;
}

async function applyMigration(client, migration) {
  const applied = await alreadyApplied(client, migration.filename);
  if (applied) {
    return false;
  }
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query('INSERT INTO planner_schema_migrations (filename) VALUES ($1)', [migration.filename]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = readMigrations();
    for (const migration of migrations) {
      const applied = await applyMigration(client, migration);
      if (applied) {
        console.log(`Applied migration ${migration.filename}`);
      } else {
        console.log(`Skipping already applied migration ${migration.filename}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error('Migration failed', err);
  process.exit(1);
});
