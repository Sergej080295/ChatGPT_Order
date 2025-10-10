'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
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

const LEGACY_IMPORT_ENABLED = process.env.PLANNER_SKIP_LEGACY_IMPORT !== 'true';

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error', err);
});

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'text/*'] }));

const sseClients = new Set();

const simpleHash = (str) => {
  if (!str) return '';
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
};

const normalizeWeakEtag = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const withoutWeak = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
  const stripped = withoutWeak.replace(/^"|"$/g, '');
  return stripped || null;
};

const parseIfMatchHeader = (value) => {
  if (!value) {
    return { hash: null, any: false };
  }
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const tokens = raw.split(',').map((part) => part.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') {
      return { hash: null, any: true };
    }
    const normalized = normalizeWeakEtag(token);
    if (normalized && normalized !== '*') {
      return { hash: normalized, any: false };
    }
  }
  return { hash: null, any: false };
};

const sanitizeHashCandidate = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return sanitizeHashCandidate(String(value));
};

const DEFAULT_STATE = {
  routeOverrides: [],
  t: [],
  done: [],
  trash: [],
  exc: [],
  res: [],
  process: null,
  capByProc: {},
  parallelByProc: {},
  filter: 'all',
  locked: [],
  orders: [],
  freshness: null,
  freshnessCsv: null,
  freshnessManual: null,
  lastImportTime: null,
  lastManualTime: null,
  autosaveOn: true,
  autoOptimizeOn: false,
  shiftOnProgress: false,
  meta: {
    versions: {},
    history: [],
    lastAuthors: {},
    csvTimestamp: '',
    manualTimestamp: '',
    ignoredStates: [],
    storage: { local: true, remote: true, remotePreferred: true, mode: 'remote' },
    settings: {}
  }
};

const createInitialState = () => {
  const stateString = JSON.stringify(DEFAULT_STATE);
  return {
    state: stateString,
    meta: {
      stage: null,
      version: 0,
      user: 'system',
      session: null,
      diff: null
    },
    updatedAt: new Date().toISOString(),
    hash: simpleHash(stateString)
  };
};

const loadLegacyStateFromDisk = async () => {
  if (!LEGACY_IMPORT_ENABLED) {
    return null;
  }
  const legacyPath = path.join(__dirname, 'planner-state.json');
  try {
    const raw = await fsp.readFile(legacyPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.state === 'string') {
      return {
        state: parsed.state,
        meta: parsed.meta ?? null,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        hash: parsed.hash ?? simpleHash(parsed.state)
      };
    }
  } catch (err) {
    // ignore legacy import failure
  }
  return null;
};

const readPlannerStateRow = async (client, options = {}) => {
  const runner = client || pool;
  const { forUpdate = false } = options;
  const suffix = forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await runner.query(
    `SELECT id, state, meta, hash, updated_at FROM planner_state ORDER BY id LIMIT 1${suffix}`
  );
  if (rows.length > 0) {
    const row = rows[0];
    return {
      id: row.id,
      state: row.state,
      meta: row.meta ?? null,
      hash: row.hash,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }
  return null;
};

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
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const clonePlainObject = (value) => {
  if (!isPlainObject(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
};

const normaliseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const mergeSettingsSnapshot = (currentStateObj, nextStateObj, meta) => {
  if (!isPlainObject(nextStateObj)) {
    return { stateObj: nextStateObj, touched: false };
  }

  const metaSettings = meta?.settings;
  if (!metaSettings || (!Array.isArray(metaSettings.entries) && metaSettings.replace !== true)) {
    return { stateObj: nextStateObj, touched: false };
  }

  const currentSettings = clonePlainObject(currentStateObj?.meta?.settings);
  const incomingSettings = clonePlainObject(nextStateObj?.meta?.settings);
  if (!Object.keys(incomingSettings).length && !Object.keys(currentSettings).length) {
    return { stateObj: nextStateObj, touched: false };
  }

  const plan = new Map();
  const ensurePlan = (key, defaults = {}) => {
    if (!plan.has(key)) {
      plan.set(key, { type: 'value', values: new Map(), whole: undefined, allowReplace: false, ...defaults });
    }
    return plan.get(key);
  };

  const readIncoming = (rootKey, fallback) => {
    const value = incomingSettings[rootKey];
    if (value === undefined) {
      return fallback;
    }
    return isPlainObject(value) ? clonePlainObject(value) : value;
  };

  const entries = Array.isArray(metaSettings.entries) ? metaSettings.entries : [];
  entries.forEach((entry) => {
    if (!entry) return;
    const entryKind = entry.kind;
    if ((entryKind === 'capacity' || entryKind === 'parallel') && entry.stage) {
      const rootKey = entry.kind === 'parallel' ? 'parallel' : 'capacity';
      const stageKey = String(entry.stage || '').trim();
      if (!stageKey) return;
      const targetPlan = ensurePlan(rootKey, { type: 'object' });
      const nextValue = entry.to ?? readIncoming(rootKey, {})?.[stageKey];
      if (nextValue === undefined) return;
      targetPlan.values.set(stageKey, Number.isFinite(nextValue) ? nextValue : nextValue);
      return;
    }
    if (typeof entry.key !== 'string') {
      return;
    }
    const keyPath = entry.key.split('.');
    const rootKey = keyPath.shift();
    if (!rootKey) {
      return;
    }
    if (rootKey === 'tableColumn') {
      const columnKey = keyPath[0];
      if (!columnKey) return;
      const targetPlan = ensurePlan('tableColumns', { type: 'object' });
      const tableColumnsIncoming = readIncoming('tableColumns', {});
      const value = entry.value ?? tableColumnsIncoming?.[columnKey];
      if (value === undefined) return;
      targetPlan.values.set(columnKey, value);
      return;
    }
    if (rootKey === 'extraTime') {
      const extraKey = keyPath[0];
      if (!extraKey) return;
      const targetPlan = ensurePlan('extraTime', { type: 'object' });
      const extraIncoming = readIncoming('extraTime', {});
      const value = entry.value ?? extraIncoming?.[extraKey];
      if (value === undefined) return;
      targetPlan.values.set(extraKey, value);
      return;
    }
    if (rootKey === 'crmStageMapping') {
      const targetPlan = ensurePlan('crmStageMapping', { type: 'object', allowReplace: true });
      const mappingValue = entry.value ?? readIncoming('crmStageMapping', {});
      if (isPlainObject(mappingValue)) {
        targetPlan.whole = clonePlainObject(mappingValue);
      }
      return;
    }
    const targetPlan = ensurePlan(rootKey, { type: 'value' });
    const value = entry.value ?? readIncoming(rootKey, undefined);
    if (value !== undefined) {
      targetPlan.value = value;
    }
  });

  if (plan.size === 0) {
    return { stateObj: nextStateObj, touched: false };
  }

  const mergedSettings = clonePlainObject(currentSettings);
  const allowGlobalReplace = metaSettings.replace === true;

  plan.forEach((targetPlan, key) => {
    if (targetPlan.type === 'object') {
      const replaceMode = allowGlobalReplace && (targetPlan.allowReplace || targetPlan.whole);
      const base = replaceMode ? {} : clonePlainObject(mergedSettings[key]);
      const nextObject = { ...base };
      if (isPlainObject(targetPlan.whole)) {
        Object.entries(targetPlan.whole).forEach(([childKey, childValue]) => {
          nextObject[childKey] = childValue;
        });
      }
      targetPlan.values.forEach((value, childKey) => {
        if (value === undefined && replaceMode) {
          delete nextObject[childKey];
        } else if (value !== undefined) {
          nextObject[childKey] = value;
        }
      });
      mergedSettings[key] = nextObject;
    } else if (Object.prototype.hasOwnProperty.call(targetPlan, 'value')) {
      const value = targetPlan.value;
      mergedSettings[key] = isPlainObject(value) ? clonePlainObject(value) : value;
    }
  });

  if (incomingSettings.updatedAt) {
    mergedSettings.updatedAt = incomingSettings.updatedAt;
  }

  if (!isPlainObject(nextStateObj.meta)) {
    nextStateObj.meta = {};
  }
  nextStateObj.meta.settings = mergedSettings;

  if (isPlainObject(mergedSettings.capacity)) {
    nextStateObj.capByProc = { ...mergedSettings.capacity };
  }

  if (isPlainObject(mergedSettings.parallel)) {
    nextStateObj.parallelByProc = { ...mergedSettings.parallel };
  }

  if (Object.prototype.hasOwnProperty.call(mergedSettings, 'autosave')) {
    nextStateObj.autosaveOn = mergedSettings.autosave;
  }

  if (Object.prototype.hasOwnProperty.call(mergedSettings, 'autoOptimize')) {
    nextStateObj.autoOptimizeOn = mergedSettings.autoOptimize;
  }

  if (Object.prototype.hasOwnProperty.call(mergedSettings, 'shiftOnProgress')) {
    nextStateObj.shiftOnProgress = mergedSettings.shiftOnProgress;
  }

  return { stateObj: nextStateObj, touched: true };
};

const upsertPlannerStateRow = async (client, stateString, meta, hash, updatedAt, options = {}) => {
  const { expectedHash = null, existing = null } = options;
  const existingRow = existing || await readPlannerStateRow(client);
  if (existingRow) {
    const params = [stateString, meta, hash, updatedAt, existingRow.id];
    let sql = 'UPDATE planner_state SET state = $1, meta = $2, hash = $3, updated_at = $4 WHERE id = $5';
    if (expectedHash && existingRow.hash) {
      params.push(expectedHash);
      sql += ' AND hash = $6';
    }
    const result = await client.query(sql, params);
    if (expectedHash && result.rowCount === 0) {
      return { conflict: true, id: existingRow.id };
    }
    return { conflict: false, id: existingRow.id };
  }
  const { rows } = await client.query(
    'INSERT INTO planner_state (state, meta, hash, updated_at) VALUES ($1,$2,$3,$4) RETURNING id',
    [stateString, meta, hash, updatedAt]
  );
  return { conflict: false, id: rows[0].id };
};

const persistSnapshotToSql = async (client, stateObj) => {
  const stageEntries = Array.isArray(stateObj?.t) ? stateObj.t : [];
  const doneEntries = Array.isArray(stateObj?.done) ? stateObj.done : [];
  const excEntries = Array.isArray(stateObj?.exc) ? stateObj.exc : [];
  const settings = isPlainObject(stateObj?.meta?.settings) ? stateObj.meta.settings : {};
  const capacityEntries = isPlainObject(settings.capacity)
    ? settings.capacity
    : (isPlainObject(stateObj?.capByProc) ? stateObj.capByProc : {});
  const parallelEntries = isPlainObject(settings.parallel)
    ? settings.parallel
    : (isPlainObject(stateObj?.parallelByProc) ? stateObj.parallelByProc : {});

  const stageCodeSet = new Set();
  stageEntries.forEach((entry) => {
    if (!entry?.stage) return;
    const code = String(entry.stage).trim();
    if (code) stageCodeSet.add(code);
  });
  doneEntries.forEach((entry) => {
    if (!entry?.stage) return;
    const code = String(entry.stage).trim();
    if (code) stageCodeSet.add(code);
  });
  Object.keys(capacityEntries).forEach((code) => {
    const normalized = String(code || '').trim();
    if (normalized) stageCodeSet.add(normalized);
  });

  const stageTypeMap = new Map();
  let sort = 0;
  for (const code of Array.from(stageCodeSet)) {
    const { rows } = await client.query(
      `INSERT INTO stage_type (code, name, sort_order, is_active)
       VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, is_active = TRUE, updated_at = NOW()
       RETURNING id`,
      [code, code, sort]
    );
    stageTypeMap.set(code, rows[0].id);
    sort += 1;
  }

  if (stageCodeSet.size > 0) {
    await client.query(
      `UPDATE stage_type SET is_active = FALSE, updated_at = NOW()
       WHERE NOT (code = ANY($1::text[]))`,
      [Array.from(stageCodeSet)]
    );
  } else {
    await client.query('UPDATE stage_type SET is_active = FALSE, updated_at = NOW()');
  }

  const orderNumbers = new Set();
  stageEntries.forEach((entry) => {
    if (!entry?.orderId) return;
    const orderNo = String(entry.orderId).trim();
    if (orderNo) orderNumbers.add(orderNo);
  });

  const orderIdMap = new Map();
  for (const orderNo of Array.from(orderNumbers)) {
    const { rows } = await client.query(
      `INSERT INTO customer_order (order_no, title, is_deleted)
       VALUES ($1,$2,FALSE)
       ON CONFLICT (order_no, is_deleted) DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
       RETURNING id`,
      [orderNo, orderNo]
    );
    orderIdMap.set(orderNo, rows[0].id);
  }

  if (orderNumbers.size > 0) {
    await client.query(
      `UPDATE customer_order SET is_deleted = TRUE, updated_at = NOW()
       WHERE is_deleted = FALSE AND NOT (order_no = ANY($1::text[]))`,
      [Array.from(orderNumbers)]
    );
  } else {
    await client.query('UPDATE customer_order SET is_deleted = TRUE, updated_at = NOW() WHERE is_deleted = FALSE');
  }

  const stageUidSet = new Set();
  const stageUidToId = new Map();

  for (const stage of stageEntries) {
    if (!stage || !stage.orderId || !stage.stage) continue;
    const orderKey = String(stage.orderId).trim();
    const stageCode = String(stage.stage).trim();
    if (!orderKey || !stageCode) continue;
    const orderId = orderIdMap.get(orderKey);
    const stageTypeId = stageTypeMap.get(stageCode);
    if (!orderId || !stageTypeId) continue;
    const uid = stage.uid || `${orderKey}::${stageCode}`;
    const stageVersionRaw = stateObj?.meta?.versions && stateObj.meta.versions[stageCode];
    const stageVersion = Number.isFinite(Number(stageVersionRaw)) ? Number(stageVersionRaw) : 1;
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
        uid,
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
        stageVersion,
        stage ?? null
      ]
    );
    stageUidSet.add(uid);
    stageUidToId.set(uid, rows[0].id);
  }

  if (stageUidSet.size > 0) {
    await client.query(
      `UPDATE order_stage SET is_deleted = TRUE, updated_at = NOW()
       WHERE is_deleted = FALSE AND external_uid IS NOT NULL AND NOT (external_uid = ANY($1::text[]))`,
      [Array.from(stageUidSet)]
    );
  } else {
    await client.query('UPDATE order_stage SET is_deleted = TRUE, updated_at = NOW() WHERE is_deleted = FALSE');
  }

  await client.query('DELETE FROM stage_completion');
  for (const done of doneEntries) {
    const orderKey = done?.orderId ? String(done.orderId).trim() : '';
    const stageCode = done?.stage ? String(done.stage).trim() : '';
    const uid = done?.uid || (orderKey && stageCode ? `${orderKey}::${stageCode}` : null);
    const stageId = uid ? stageUidToId.get(uid) ?? null : null;
    await client.query(
      `INSERT INTO stage_completion (order_stage_id, completed_at, source, note)
       VALUES ($1,$2,$3,$4)`,
      [stageId, normaliseDate(done?.when) || normaliseDate(done?.end), done?.source ?? null, done?.note ?? null]
    );
  }

  await client.query('DELETE FROM stage_exception');
  for (const exc of excEntries) {
    const orderKey = exc?.orderId ? String(exc.orderId).trim() : '';
    const stageCode = exc?.stage ? String(exc.stage).trim() : '';
    const uid = exc?.uid || (orderKey && stageCode ? `${orderKey}::${stageCode}` : null);
    const stageId = uid ? stageUidToId.get(uid) ?? null : null;
    await client.query(
      `INSERT INTO stage_exception (order_stage_id, kind, details, created_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [stageId, exc?.kind || exc?.type || 'unknown', exc?.details ?? null, normaliseDate(exc?.createdAt) || normaliseDate(exc?.start), normaliseDate(exc?.resolvedAt) || normaliseDate(exc?.end)]
    );
  }

  await client.query('DELETE FROM capacity_by_stage');
  for (const [code, value] of Object.entries(capacityEntries)) {
    const stageTypeId = stageTypeMap.get(code);
    if (!stageTypeId) continue;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) continue;
    await client.query(
      `INSERT INTO capacity_by_stage (stage_type_id, capacity_per_day, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (stage_type_id) DO UPDATE SET capacity_per_day = EXCLUDED.capacity_per_day, updated_at = NOW()`,
      [stageTypeId, numericValue]
    );
  }

  await client.query('DELETE FROM parallel_limits');
  for (const [code, value] of Object.entries(parallelEntries)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) continue;
    await client.query(
      `INSERT INTO parallel_limits (code, max_parallel, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (code) DO UPDATE SET max_parallel = EXCLUDED.max_parallel, updated_at = NOW()`,
      [code, numericValue]
    );
  }

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
      settings.autosave ?? stateObj?.autosaveOn ?? null,
      settings.autoOptimize ?? stateObj?.autoOptimizeOn ?? null,
      settings.shiftOnProgress ?? stateObj?.shiftOnProgress ?? null,
      stateObj?.meta?.storage?.mode ?? null,
      settings
    ]
  );
};

const buildStateFromSql = async () => {
  const client = await pool.connect();
  try {
    const plannerRow = await readPlannerStateRow(client);
    let baseObj;
    try {
      baseObj = plannerRow?.state ? JSON.parse(plannerRow.state) : JSON.parse(JSON.stringify(DEFAULT_STATE));
    } catch (err) {
      baseObj = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }

    const { rows: stageRows } = await client.query(
      `SELECT os.external_uid, os.payload, os.state, os.status, os.hours, os.extra_hours, os.start_at, os.end_at,
              os.start_missing, os.end_missing, os.progress, os.use_reserve, os.orig_start_at,
              os.version, co.order_no, st.code AS stage_code
         FROM order_stage os
         JOIN customer_order co ON co.id = os.order_id
         JOIN stage_type st ON st.id = os.stage_type_id
        WHERE os.is_deleted = FALSE AND co.is_deleted = FALSE
        ORDER BY st.sort_order, os.start_at NULLS LAST, os.id`
    );

    const { rows: doneRows } = await client.query(
      `SELECT sc.order_stage_id, sc.completed_at, sc.source, sc.note, os.external_uid, co.order_no, st.code AS stage_code
         FROM stage_completion sc
         LEFT JOIN order_stage os ON os.id = sc.order_stage_id
         LEFT JOIN customer_order co ON co.id = os.order_id
         LEFT JOIN stage_type st ON st.id = os.stage_type_id
        ORDER BY sc.completed_at DESC`
    );

    const { rows: excRows } = await client.query(
      `SELECT se.order_stage_id, se.kind, se.details, se.created_at, se.resolved_at, os.external_uid, co.order_no, st.code AS stage_code
         FROM stage_exception se
         LEFT JOIN order_stage os ON os.id = se.order_stage_id
         LEFT JOIN customer_order co ON co.id = os.order_id
         LEFT JOIN stage_type st ON st.id = os.stage_type_id
        ORDER BY se.created_at DESC`
    );

    const { rows: capacityRows } = await client.query(
      `SELECT st.code, cb.capacity_per_day
         FROM capacity_by_stage cb
         JOIN stage_type st ON st.id = cb.stage_type_id`
    );

    const { rows: parallelRows } = await client.query('SELECT code, max_parallel FROM parallel_limits');

    const { rows: settingsRows } = await client.query('SELECT autosave_on, auto_optimize_on, shift_on_progress, storage_mode, extra FROM planner_settings WHERE id = 1');

    const stateObj = baseObj && typeof baseObj === 'object' ? baseObj : JSON.parse(JSON.stringify(DEFAULT_STATE));

    stateObj.t = stageRows.map((row) => {
      if (isPlainObject(row.payload)) {
        return row.payload;
      }
      const uid = row.external_uid || `${row.order_no}::${row.stage_code}`;
      return {
        uid,
        orderId: row.order_no,
        stage: row.stage_code,
        parentId: row.order_no,
        childId: uid,
        hours: row.hours ?? 0,
        extraHours: row.extra_hours ?? 0,
        startDate: row.start_at,
        endDate: row.end_at,
        startMissing: !!row.start_missing,
        endMissing: !!row.end_missing,
        state: row.state,
        status: row.status,
        useReserve: !!row.use_reserve,
        progress: row.progress ?? 0,
        origStartDate: row.orig_start_at
      };
    });

    stateObj.done = doneRows.map((row) => ({
      uid: row.external_uid || (row.order_no && row.stage_code ? `${row.order_no}::${row.stage_code}` : null),
      orderId: row.order_no,
      stage: row.stage_code,
      when: row.completed_at,
      source: row.source,
      note: row.note
    })).filter((item) => item.uid);

    stateObj.exc = excRows.map((row) => ({
      uid: row.external_uid || (row.order_no && row.stage_code ? `${row.order_no}::${row.stage_code}` : null),
      orderId: row.order_no,
      stage: row.stage_code,
      kind: row.kind,
      details: row.details ?? null,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at
    })).filter((item) => item.uid);

    stateObj.capByProc = capacityRows.reduce((acc, row) => {
      if (row.code) {
        acc[row.code] = Number(row.capacity_per_day);
      }
      return acc;
    }, {});

    stateObj.parallelByProc = parallelRows.reduce((acc, row) => {
      if (row.code) {
        acc[row.code] = Number(row.max_parallel);
      }
      return acc;
    }, {});

    if (!isPlainObject(stateObj.meta)) {
      stateObj.meta = clonePlainObject(DEFAULT_STATE.meta);
    }

    if (settingsRows.length > 0) {
      const dbSettings = settingsRows[0];
      const extraSettings = isPlainObject(dbSettings.extra) ? dbSettings.extra : {};
      stateObj.meta.settings = { ...extraSettings };
      if (dbSettings.autosave_on !== null) {
        stateObj.meta.settings.autosave = dbSettings.autosave_on;
        stateObj.autosaveOn = dbSettings.autosave_on;
      }
      if (dbSettings.auto_optimize_on !== null) {
        stateObj.meta.settings.autoOptimize = dbSettings.auto_optimize_on;
        stateObj.autoOptimizeOn = dbSettings.auto_optimize_on;
      }
      if (dbSettings.shift_on_progress !== null) {
        stateObj.meta.settings.shiftOnProgress = dbSettings.shift_on_progress;
        stateObj.shiftOnProgress = dbSettings.shift_on_progress;
      }
      if (!isPlainObject(stateObj.meta.storage)) {
        stateObj.meta.storage = { local: true, remote: true, remotePreferred: true, mode: 'remote' };
      }
      if (dbSettings.storage_mode) {
        stateObj.meta.storage.mode = dbSettings.storage_mode;
      }
    }

    if (!isPlainObject(stateObj.meta.settings)) {
      stateObj.meta.settings = {};
    }
    stateObj.meta.settings.capacity = { ...stateObj.capByProc };
    stateObj.meta.settings.parallel = { ...stateObj.parallelByProc };

    const versions = {};
    stageRows.forEach((row) => {
      if (!row.stage_code) return;
      const current = versions[row.stage_code] ?? 0;
      versions[row.stage_code] = Math.max(current, row.version ?? 0);
    });
    stateObj.meta.versions = versions;

    const ordersMap = new Map();
    stageRows.forEach((row) => {
      const code = row.stage_code;
      if (!code) return;
      if (!ordersMap.has(code)) {
        ordersMap.set(code, []);
      }
      const uid = row.external_uid || `${row.order_no}::${row.stage_code}`;
      ordersMap.get(code).push(uid);
    });
    stateObj.orders = Array.from(ordersMap.entries());

    const stateString = JSON.stringify(stateObj);
    const hash = simpleHash(stateString);
    const updatedAt = plannerRow?.updatedAt ?? new Date().toISOString();
    const meta = plannerRow?.meta ?? null;

    return {
      state: stateString,
      meta,
      updatedAt,
      hash,
      etag: `W/"${hash}"`,
      parsed: stateObj
    };
  } finally {
    client.release();
  }
};

const refreshCachedState = async () => {
  cachedState = await buildStateFromSql();
  return cachedState;
};

const computeDelta = (prevState, nextState) => {
  const prevStages = new Map();
  const nextStages = new Map();

  if (Array.isArray(prevState?.t)) {
    prevState.t.forEach((stage) => {
      if (stage && stage.uid) {
        prevStages.set(stage.uid, JSON.stringify(stage));
      }
    });
  }

  if (Array.isArray(nextState?.t)) {
    nextState.t.forEach((stage) => {
      if (stage && stage.uid) {
        nextStages.set(stage.uid, JSON.stringify(stage));
      }
    });
  }

  const added = [];
  const updated = [];
  const removed = [];

  nextStages.forEach((value, uid) => {
    if (!prevStages.has(uid)) {
      added.push(uid);
    } else if (prevStages.get(uid) !== value) {
      updated.push(uid);
    }
  });

  prevStages.forEach((_value, uid) => {
    if (!nextStages.has(uid)) {
      removed.push(uid);
    }
  });

  const settingsChanged = JSON.stringify(prevState?.meta?.settings ?? null) !== JSON.stringify(nextState?.meta?.settings ?? null);

  return {
    stages: { added, updated, removed },
    settingsChanged
  };
};

let cachedState = null;

const bootstrapState = async () => {
  await runMigrations();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let existing = await readPlannerStateRow(client);
    if (!existing) {
      const legacy = await loadLegacyStateFromDisk();
      const payload = legacy || createInitialState();
      let stateObj;
      try {
        stateObj = payload.state ? JSON.parse(payload.state) : JSON.parse(JSON.stringify(DEFAULT_STATE));
      } catch (err) {
        stateObj = JSON.parse(JSON.stringify(DEFAULT_STATE));
      }
      await persistSnapshotToSql(client, stateObj);
      await upsertPlannerStateRow(client, JSON.stringify(stateObj), payload.meta ?? null, payload.hash ?? simpleHash(JSON.stringify(stateObj)), payload.updatedAt ?? new Date().toISOString());
      await client.query('COMMIT');
    } else {
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await refreshCachedState();
};

const appendLog = async (entry) => {
  await pool.query(
    `INSERT INTO planner_activity_log (timestamp, stage, version, user_name, session, source, summary, diff, orders_summary, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.timestamp,
      entry.stage,
      entry.version,
      entry.user,
      entry.session,
      entry.source,
      entry.summary,
      entry.diff ?? null,
      entry.ordersSummary ?? null,
      entry.ip
    ]
  );
};

const broadcast = (payload) => {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => {
    res.write(data);
  });
};

app.get('/api/events', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });

  const current = cachedState || await refreshCachedState();
  res.write(`data: ${JSON.stringify({ type: 'state', state: current.state, meta: current.meta, updatedAt: current.updatedAt, hash: current.hash, etag: current.etag })}\n\n`);
});

app.get('/api/state', async (req, res) => {
  const current = cachedState || await refreshCachedState();
  if (req.headers['if-none-match'] && req.headers['if-none-match'] === current.etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('ETag', current.etag);
  res.type('application/json').send(current.state);
});

const extractStateFromBody = (body) => {
  if (!body) return { state: null, meta: null };
  if (typeof body === 'string') {
    return { state: body, meta: null };
  }
  if (typeof body === 'object') {
    if (typeof body.state === 'string') {
      return { state: body.state, meta: body.meta ?? null };
    }
    if (body.state && typeof body.state === 'object') {
      try {
        return { state: JSON.stringify(body.state), meta: body.meta ?? null };
      } catch (err) {
        console.error('state stringify failed', err);
        return { state: null, meta: null };
      }
    }
    try {
      return { state: JSON.stringify(body), meta: null };
    } catch (err) {
      return { state: null, meta: null };
    }
  }
  return { state: null, meta: null };
};

app.put('/api/state', async (req, res) => {
  const { state, meta } = extractStateFromBody(req.body);
  if (!state) {
    res.status(400).send('Invalid state payload');
    return;
  }

  const current = cachedState || await refreshCachedState();
  const currentHash = sanitizeHashCandidate(current?.hash);
  let currentStateObj = {};
  try {
    currentStateObj = JSON.parse(current.state || '{}');
  } catch (err) {
    currentStateObj = {};
  }

  let nextStateObj = {};
  try {
    nextStateObj = JSON.parse(state);
  } catch (err) {
    res.status(400).send('State must be valid JSON');
    return;
  }

  const stage = meta?.stage ?? null;
  const incomingVersion = meta?.version ?? (nextStateObj?.meta?.versions?.[stage] ?? null);
  const currentVersion = stage != null ? currentStateObj?.meta?.versions?.[stage] ?? null : null;

  if (incomingVersion != null && currentVersion != null && incomingVersion <= currentVersion) {
    const lastAuthor = currentStateObj?.meta?.lastAuthors?.[stage] ?? null;
    res.status(409).json({
      error: 'Conflict',
      stage,
      currentVersion,
      incomingVersion,
      lastAuthor,
      updatedAt: current.updatedAt
    });
    return;
  }

  const ifMatchHeader = parseIfMatchHeader(req.headers['if-match']);
  let expectedHash = ifMatchHeader.hash ? sanitizeHashCandidate(ifMatchHeader.hash) : null;
  if (!expectedHash && meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const metaExpected = sanitizeHashCandidate(meta.expectedHash) || sanitizeHashCandidate(meta.baseHash);
    if (metaExpected) {
      expectedHash = metaExpected;
    } else if (meta.baseEtag) {
      const parsed = normalizeWeakEtag(meta.baseEtag);
      if (parsed && parsed !== '*') {
        expectedHash = sanitizeHashCandidate(parsed);
      }
    }
  }
  const ifMatchAllowsAny = ifMatchHeader.any;

  if (currentHash) {
    if (ifMatchAllowsAny && !expectedHash) {
      res.status(428).json({
        error: 'Precondition Required',
        message: 'Wildcard If-Match is not allowed once planner state exists',
        stage,
        updatedAt: current.updatedAt,
        currentHash
      });
      return;
    }
    if (expectedHash && expectedHash !== currentHash) {
      const lastAuthor = stage ? currentStateObj?.meta?.lastAuthors?.[stage] ?? null : null;
      res.status(409).json({
        error: 'Conflict',
        stage,
        reason: 'hash_mismatch',
        expectedHash,
        currentHash,
        lastAuthor,
        updatedAt: current.updatedAt
      });
      return;
    }
  }

  const updatedAt = new Date().toISOString();
  let nextStateString = state;
  if (meta?.stage === 'settings') {
    try {
      const { stateObj, touched } = mergeSettingsSnapshot(currentStateObj, nextStateObj, meta);
      if (touched) {
        nextStateObj = stateObj;
        nextStateString = JSON.stringify(stateObj);
      }
    } catch (err) {
      console.error('Failed to merge settings snapshot, falling back to incoming state', err);
    }
  }

  const hash = simpleHash(nextStateString);
  let nextMeta = meta || null;
  if (nextMeta && typeof nextMeta === 'object' && !Array.isArray(nextMeta)) {
    const cleaned = { ...nextMeta };
    delete cleaned.baseHash;
    delete cleaned.baseEtag;
    delete cleaned.expectedHash;
    delete cleaned.ifMatch;
    if (Object.keys(cleaned).length > 0) {
      nextMeta = cleaned;
    } else {
      nextMeta = null;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRow = await readPlannerStateRow(client, { forUpdate: true });
    const dbHash = sanitizeHashCandidate(existingRow?.hash);
    if (dbHash) {
      if (!expectedHash) {
        await client.query('ROLLBACK');
        res.status(428).json({
          error: 'Precondition Required',
          message: ifMatchAllowsAny
            ? 'Wildcard If-Match is not allowed once planner state exists'
            : 'Planner state update requires an If-Match header or base hash',
          stage,
          updatedAt: existingRow.updatedAt,
          currentHash: dbHash
        });
        return;
      }
      if (expectedHash !== dbHash) {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: 'Conflict',
          stage,
          reason: 'hash_mismatch',
          expectedHash,
          currentHash: dbHash,
          updatedAt: existingRow.updatedAt
        });
        return;
      }
    } else if (!dbHash && ifMatchAllowsAny) {
      expectedHash = null;
    }

    await persistSnapshotToSql(client, nextStateObj);
    const upsertResult = await upsertPlannerStateRow(client, nextStateString, nextMeta, hash, updatedAt, {
      expectedHash,
      existing: existingRow
    });
    if (upsertResult?.conflict) {
      await client.query('ROLLBACK');
      res.status(409).json({
        error: 'Conflict',
        stage,
        reason: 'hash_mismatch',
        expectedHash,
        updatedAt: existingRow?.updatedAt ?? current.updatedAt
      });
      return;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to persist snapshot', err);
    res.status(500).send('Failed to persist snapshot');
    return;
  } finally {
    client.release();
  }

  const previousState = cachedState ? cachedState.parsed : null;
  const refreshed = await refreshCachedState();
  const delta = computeDelta(previousState, refreshed.parsed);

  const logEntry = {
    timestamp: updatedAt,
    stage,
    version: incomingVersion ?? null,
    user: meta?.user ?? null,
    session: meta?.session ?? null,
    source: meta?.source ?? null,
    summary: meta?.summary ?? null,
    ip: req.ip
  };
  if (meta?.diff) {
    logEntry.diff = meta.diff;
  }
  if (meta?.ordersSummary) {
    logEntry.ordersSummary = meta.ordersSummary;
  }
  await appendLog(logEntry);

  broadcast({ type: 'delta', hash: refreshed.hash, updatedAt: refreshed.updatedAt, etag: refreshed.etag, delta });
  res.setHeader('ETag', refreshed.etag);
  res.json({ ok: true, hash: refreshed.hash, updatedAt: refreshed.updatedAt, etag: refreshed.etag });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Internal Server Error');
});

let serverInstance = null;
let shuttingDown = false;

const shutdown = async (signal = 'SIGTERM') => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  if (serverInstance) {
    serverInstance.close();
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('Error while closing PostgreSQL pool', err);
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

bootstrapState().then(() => {
  serverInstance = app.listen(PORT, () => {
    console.log(`Planner server running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to bootstrap state', err);
  process.exit(1);
});
