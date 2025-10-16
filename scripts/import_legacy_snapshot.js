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

const TABLE_SNAPSHOTS = 'planner_state_snapshots';
const TABLE_SCALARS = 'planner_state_scalars';
const TABLE_CAPACITY = 'planner_state_capacity';
const TABLE_PARALLEL = 'planner_state_parallel';
const TABLE_ROUTE_OVERRIDES = 'planner_state_route_overrides';
const TABLE_IGNORED_STATES = 'planner_state_ignored_states';
const TABLE_LIST_ENTRIES = 'planner_state_list_entries';
const TABLE_LIST_ATTRIBUTES = 'planner_state_list_entry_attributes';
const TABLE_META_VALUES = 'planner_meta_values';
const TABLE_META_HISTORY = 'planner_meta_history_entries';
const TABLE_META_HISTORY_ATTRS = 'planner_meta_history_entry_attributes';
const TABLE_CRM_VALUES = 'planner_state_crm_values';
const TABLE_MODE_VALUES = 'planner_state_mode_scoped_values';
const GENERAL_SETTINGS_TABLE = 'planner_settings';
const GENERAL_PREFERENCES_TABLE = 'planner_preferences';
const GENERAL_PREFERENCE_KEYS = [
  'autosaveOn',
  'autoOptimizeOn',
  'cascadeReadyOn',
  'shiftOnProgress',
  'priorityChangeLoggingOn',
  'routeDateChangeLoggingOn',
  'notificationsMuted'
];
const STATE_LIST_KEYS = ['orders', 't', 'done', 'trash', 'exc', 'res', 'locked'];
const STATE_SCALAR_KEYS = [
  'process',
  'filter',
  'freshness',
  'freshnessCsv',
  'freshnessManual',
  'lastImportTime',
  'lastManualTime',
  'autosaveOn',
  'autoOptimizeOn',
  'cascadeReadyOn',
  'priorityChangeLoggingOn',
  'routeDateChangeLoggingOn',
  'notificationsMuted',
  'shiftOnProgress'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneDeepPlain(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeepPlain(item));
  }
  if (isPlainObject(value)) {
    const result = {};
    Object.entries(value).forEach(([key, child]) => {
      result[key] = cloneDeepPlain(child);
    });
    return result;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : new Date(time);
  }
  return value;
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizePreferenceValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const lowered = trimmed.toLowerCase();
    if (['true', 'yes', 'on', 'y'].includes(lowered)) {
      return true;
    }
    if (['false', 'no', 'off', 'n'].includes(lowered)) {
      return false;
    }
    if (lowered === '1') {
      return true;
    }
    if (lowered === '0') {
      return false;
    }
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return numeric !== 0;
    }
    return null;
  }
  if (typeof value === 'bigint') {
    return value !== 0n;
  }
  return Boolean(value);
}

function extractGeneralSettingsForStorage(snapshot, meta = null) {
  if (!isPlainObject(snapshot)) {
    return { hasSettings: false, payload: null, meta: isPlainObject(meta) ? meta : null };
  }

  const workingMeta = isPlainObject(meta) ? cloneDeepPlain(meta) : null;
  let settings = null;

  if (Object.prototype.hasOwnProperty.call(snapshot, 'settings')) {
    const rootValue = snapshot.settings;
    delete snapshot.settings;
    if (isPlainObject(rootValue)) {
      settings = rootValue;
    } else if (rootValue === null || rootValue === undefined) {
      settings = null;
    }
  }

  if (isPlainObject(snapshot.meta) && Object.prototype.hasOwnProperty.call(snapshot.meta, 'settings')) {
    const metaValue = snapshot.meta.settings;
    delete snapshot.meta.settings;
    if (isPlainObject(metaValue)) {
      settings = metaValue;
    } else if (metaValue === null || metaValue === undefined) {
      settings = null;
    }
  }

  if (isPlainObject(workingMeta) && Object.prototype.hasOwnProperty.call(workingMeta, 'settings')) {
    const storedValue = workingMeta.settings;
    delete workingMeta.settings;
    if (isPlainObject(storedValue)) {
      settings = storedValue;
    } else if (storedValue === null || storedValue === undefined) {
      settings = null;
    }
  }

  const preferences = {};
  const preferenceSources = [
    snapshot,
    isPlainObject(snapshot.meta) ? snapshot.meta : null,
    workingMeta
  ];

  GENERAL_PREFERENCE_KEYS.forEach((key) => {
    let valueFound = null;
    preferenceSources.forEach((source) => {
      if (!isPlainObject(source) || !Object.prototype.hasOwnProperty.call(source, key)) {
        return;
      }
      const normalized = normalizePreferenceValue(source[key]);
      if (normalized !== null) {
        valueFound = normalized;
      }
      delete source[key];
    });
    if (valueFound !== null) {
      preferences[key] = valueFound;
    }
  });

  const payload = {};
  if (settings === null) {
    payload.settings = null;
  } else if (isPlainObject(settings)) {
    payload.settings = cloneDeepPlain(settings);
  }
  if (Object.keys(preferences).length) {
    payload.preferences = preferences;
  }

  const hasSettings = Boolean(
    (payload.settings && isPlainObject(payload.settings) && Object.keys(payload.settings).length)
    || payload.settings === null
    || Object.keys(preferences).length
  );

  return {
    hasSettings,
    payload: hasSettings ? payload : null,
    meta: workingMeta
  };
}

function sanitizeMetaForStorage(meta) {
  if (!isPlainObject(meta)) return null;
  const copy = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (value === null) {
      copy[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      copy[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      copy[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      try {
        copy[key] = JSON.parse(JSON.stringify(value));
      } catch (_err) {
        /* ignore */
      }
      continue;
    }
    if (isPlainObject(value)) {
      const nested = sanitizeMetaForStorage(value);
      if (nested !== null) {
        copy[key] = nested;
      }
    }
  }
  return Object.keys(copy).length ? copy : null;
}

function encodePathSegment(segment) {
  if (segment === null || segment === undefined) {
    return '';
  }
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function normalizePrimitiveForStorage(value) {
  if (value === null || value === undefined) {
    return { type: 'null', text: null, numeric: null, boolean: null };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', text: null, numeric: null, boolean: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { type: 'string', text: String(value), numeric: null, boolean: null };
    }
    return { type: 'number', text: null, numeric: value, boolean: null };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { type: 'string', text: '', numeric: null, boolean: null };
    }
    return { type: 'string', text: value.toISOString(), numeric: null, boolean: null };
  }
  if (typeof value === 'string') {
    return { type: 'string', text: value, numeric: null, boolean: null };
  }
  try {
    return { type: 'string', text: JSON.stringify(value), numeric: null, boolean: null };
  } catch (_err) {
    return { type: 'string', text: String(value), numeric: null, boolean: null };
  }
}

function flattenValueForStorage(value, pathSegments, rows, parentIsArray, ordinal) {
  const path = pathSegments.join('/');
  if (Array.isArray(value)) {
    rows.push({ path, type: 'array', ordinal: parentIsArray ? ordinal : 0, valueText: null, valueNumeric: null, valueBoolean: null });
    value.forEach((item, index) => {
      const next = pathSegments.slice();
      next.push(encodePathSegment(index));
      flattenValueForStorage(item, next, rows, true, index);
    });
    return;
  }
  if (isPlainObject(value)) {
    rows.push({ path, type: 'object', ordinal: parentIsArray ? ordinal : 0, valueText: null, valueNumeric: null, valueBoolean: null });
    Object.entries(value).forEach(([key, child]) => {
      const next = pathSegments.slice();
      next.push(encodePathSegment(key));
      flattenValueForStorage(child, next, rows, false, 0);
    });
    return;
  }
  const normalized = normalizePrimitiveForStorage(value);
  rows.push({
    path,
    type: normalized.type,
    ordinal: parentIsArray ? ordinal : 0,
    valueText: normalized.text,
    valueNumeric: normalized.numeric,
    valueBoolean: normalized.boolean
  });
}

function flattenObjectForStorage(source) {
  const rows = [];
  if (!isPlainObject(source)) {
    return rows;
  }
  Object.entries(source).forEach(([key, value]) => {
    flattenValueForStorage(value, [encodePathSegment(key)], rows, false, 0);
  });
  return rows;
}

function parseOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const normalized = String(value).trim();
    return normalized || null;
  }
  return null;
}

async function clearStateForRevision(client, rev) {
  await client.query(`DELETE FROM ${TABLE_SCALARS} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_CAPACITY} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_PARALLEL} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_ROUTE_OVERRIDES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_IGNORED_STATES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_LIST_ENTRIES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_META_VALUES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_META_HISTORY} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_CRM_VALUES} WHERE rev = $1`, [rev]);
  await client.query(`DELETE FROM ${TABLE_MODE_VALUES} WHERE rev = $1`, [rev]);
}

async function persistScalarValues(client, rev, snapshot) {
  await client.query(`DELETE FROM ${TABLE_SCALARS} WHERE rev = $1`, [rev]);
  for (const key of STATE_SCALAR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
      continue;
    }
    const normalized = normalizePrimitiveForStorage(snapshot[key]);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_SCALARS} (rev, key, value_type, value_text, value_numeric, value_boolean, value_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)` ,
      [rev, key, normalized.type, normalized.text, normalized.numeric, normalized.boolean, null]
    );
  }
}

async function persistCapacity(client, rev, capacity) {
  await client.query(`DELETE FROM ${TABLE_CAPACITY} WHERE rev = $1`, [rev]);
  if (!isPlainObject(capacity)) {
    return;
  }
  for (const [code, value] of Object.entries(capacity)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_CAPACITY} (rev, process_code, minutes) VALUES ($1,$2,$3)` ,
      [rev, String(code), numeric]
    );
  }
}

async function persistParallel(client, rev, parallel) {
  await client.query(`DELETE FROM ${TABLE_PARALLEL} WHERE rev = $1`, [rev]);
  if (!isPlainObject(parallel)) {
    return;
  }
  for (const [code, value] of Object.entries(parallel)) {
    const flag = normalizePreferenceValue(value);
    if (flag === null) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_PARALLEL} (rev, process_code, is_parallel) VALUES ($1,$2,$3)` ,
      [rev, String(code), flag]
    );
  }
}

async function persistRouteOverrides(client, rev, overrides) {
  await client.query(`DELETE FROM ${TABLE_ROUTE_OVERRIDES} WHERE rev = $1`, [rev]);
  if (!Array.isArray(overrides)) {
    return;
  }
  for (const entry of overrides) {
    if (!Array.isArray(entry) || entry.length < 2) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const key = parseOptionalString(entry[0]) || '';
    const payload = isPlainObject(entry[1]) ? entry[1] : {};
    const [parentRaw, stageRaw] = key.split('::');
    const parentOrderId = parseOptionalString(parentRaw) || '';
    const stage = parseOptionalString(stageRaw) || '';
    const startAt = parseDate(payload.start || payload.startAt || payload.start_date);
    const endAt = parseDate(payload.end || payload.endAt || payload.end_date);
    const source = parseOptionalString(payload.source || payload.reason || payload.note);
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_ROUTE_OVERRIDES} (rev, parent_order_id, stage, start_at, end_at, source)
       VALUES ($1,$2,$3,$4,$5,$6)` ,
      [
        rev,
        parentOrderId,
        stage,
        startAt ? startAt.toISOString() : null,
        endAt ? endAt.toISOString() : null,
        source
      ]
    );
  }
}

async function persistIgnoredStates(client, rev, ignored) {
  await client.query(`DELETE FROM ${TABLE_IGNORED_STATES} WHERE rev = $1`, [rev]);
  if (!Array.isArray(ignored)) {
    return;
  }
  for (let index = 0; index < ignored.length; index += 1) {
    const key = parseOptionalString(ignored[index]);
    if (!key) {
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${TABLE_IGNORED_STATES} (rev, state_key, ordinal) VALUES ($1,$2,$3)` ,
      [rev, key, index]
    );
  }
}

function sanitizeStageOrdersEntry(entry) {
  if (!Array.isArray(entry) || entry.length < 1) {
    return null;
  }
  const stage = parseOptionalString(entry[0]);
  if (!stage) {
    return null;
  }
  const rawList = entry.length > 1 ? entry[1] : [];
  const uids = Array.isArray(rawList)
    ? rawList.map((value) => parseOptionalString(value)).filter((value) => value !== null)
    : [];
  return { stage, uids };
}

function sanitizeLockedEntry(entry) {
  const value = parseOptionalString(entry);
  return value || null;
}

async function persistListEntries(client, rev, listKey, entries) {
  await client.query(`DELETE FROM ${TABLE_LIST_ENTRIES} WHERE rev = $1 AND list_key = $2`, [rev, listKey]);
  if (!Array.isArray(entries) || !entries.length) {
    return;
  }

  if (listKey === 'locked') {
    for (let index = 0; index < entries.length; index += 1) {
      const uid = sanitizeLockedEntry(entries[index]);
      if (!uid) {
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)`
         VALUES ($1,$2,$3,$4,$5,$6)` ,
        [rev, listKey, null, null, uid, index]
      );
    }
    return;
  }

  if (listKey === 'orders') {
    for (let index = 0; index < entries.length; index += 1) {
      const sanitized = sanitizeStageOrdersEntry(entries[index]);
      if (!sanitized) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const orderIdentity = sanitized.stage;
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await client.query(
        `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)`
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id` ,
        [rev, listKey, sanitized.stage, null, orderIdentity, index]
      );
      const entryId = rows[0]?.id;
      if (!entryId) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const attributeRows = flattenObjectForStorage({ stage: sanitized.stage, uids: sanitized.uids });
      for (const row of attributeRows) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO ${TABLE_LIST_ATTRIBUTES} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)`
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)` ,
          [
            entryId,
            row.path,
            row.ordinal || 0,
            row.type,
            row.valueText,
            row.valueNumeric,
            row.valueBoolean,
            null
          ]
        );
      }
    }
    return;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isPlainObject(entry)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const parentOrderId = parseOptionalString(entry.parentId);
    const childOrderId = parseOptionalString(entry.childId);
    const orderIdentity = parseOptionalString(entry.orderId || entry.orderNumber || entry.orderIdentity);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(
      `INSERT INTO ${TABLE_LIST_ENTRIES} (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)`
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id` ,
      [rev, listKey, parentOrderId, childOrderId, orderIdentity, index]
    );
    const entryId = rows[0]?.id;
    if (!entryId) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const attributeRows = flattenObjectForStorage(entry);
    for (const row of attributeRows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_LIST_ATTRIBUTES} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)`
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)` ,
        [
          entryId,
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null
        ]
      );
    }
  }
}

async function persistStructuredValues(client, table, rev, data) {
  await client.query(`DELETE FROM ${table} WHERE rev = $1`, [rev]);
  if (!isPlainObject(data) || !Object.keys(data).length) {
    return;
  }
  const rows = flattenObjectForStorage(data);
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO ${table} (rev, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)` ,
      [
        rev,
        row.path,
        row.ordinal || 0,
        row.type,
        row.valueText,
        row.valueNumeric,
        row.valueBoolean,
        null
      ]
    );
  }
}

async function persistMetaHistory(client, rev, history) {
  await client.query(`DELETE FROM ${TABLE_META_HISTORY} WHERE rev = $1`, [rev]);
  if (!Array.isArray(history) || !history.length) {
    return;
  }
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (!isPlainObject(entry)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const actor = parseOptionalString(entry.actor);
    const source = parseOptionalString(entry.source);
    const note = parseOptionalString(entry.note);
    const summary = parseOptionalString(entry.summary);
    const when = parseDate(entry.when || entry.timestamp || entry.createdAt);
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(
      `INSERT INTO ${TABLE_META_HISTORY} (rev, ordinal, actor, source, note, summary, event_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id` ,
      [rev, index, actor, source, note, summary, when ? when.toISOString() : null]
    );
    const entryId = rows[0]?.id;
    if (!entryId) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const attributeRows = flattenObjectForStorage(entry);
    for (const row of attributeRows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${TABLE_META_HISTORY_ATTRS} (entry_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)` ,
        [
          entryId,
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null
        ]
      );
    }
  }
}

function sanitizeGeneralPreferences(preferences) {
  if (!isPlainObject(preferences)) {
    return null;
  }
  const sanitized = {};
  GENERAL_PREFERENCE_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(preferences, key)) {
      return;
    }
    const normalized = normalizePreferenceValue(preferences[key]);
    if (normalized !== null) {
      sanitized[key] = normalized;
    }
  });
  return Object.keys(sanitized).length ? sanitized : null;
}

function sanitizeGeneralSettingsPayload(payload) {
  if (!isPlainObject(payload)) {
    return null;
  }

  let sanitizedSettings = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'settings')) {
    if (payload.settings === null) {
      sanitizedSettings = null;
    } else {
      const candidate = sanitizeMetaForStorage(payload.settings);
      if (isPlainObject(candidate) && Object.keys(candidate).length) {
        sanitizedSettings = candidate;
      }
    }
  } else {
    const candidate = sanitizeMetaForStorage(payload);
    if (isPlainObject(candidate) && Object.keys(candidate).length) {
      sanitizedSettings = candidate;
    }
  }

  const sanitizedPreferences = sanitizeGeneralPreferences(payload.preferences);

  if (sanitizedSettings === null && !sanitizedPreferences) {
    return null;
  }

  return {
    settings: sanitizedSettings,
    preferences: sanitizedPreferences
  };
}

async function persistGeneralSettings(client, payload, options = {}) {
  await client.query(`DELETE FROM ${GENERAL_SETTINGS_TABLE}`);
  await client.query(`DELETE FROM ${GENERAL_PREFERENCES_TABLE}`);

  const hasSettings = Boolean(options?.hasSettings);
  if (!hasSettings) {
    return;
  }

  const actor = options?.actor ? String(options.actor).trim() || null : null;
  const sanitized = sanitizeGeneralSettingsPayload(payload || {});
  if (!sanitized) {
    return;
  }

  if (sanitized.settings === null) {
    await client.query(
      `INSERT INTO ${GENERAL_SETTINGS_TABLE} (path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)` ,
      ['', 0, 'null', null, null, null, null, actor]
    );
  } else if (isPlainObject(sanitized.settings)) {
    const rows = flattenObjectForStorage(sanitized.settings);
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${GENERAL_SETTINGS_TABLE} (path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)` ,
        [
          row.path,
          row.ordinal || 0,
          row.type,
          row.valueText,
          row.valueNumeric,
          row.valueBoolean,
          null,
          actor
        ]
      );
    }
  }

  if (isPlainObject(sanitized.preferences)) {
    for (const [key, value] of Object.entries(sanitized.preferences)) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO ${GENERAL_PREFERENCES_TABLE} (key, value, updated_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by` ,
        [key, Boolean(value), actor]
      );
    }
  }
}

async function persistSnapshotData(client, rev, snapshot, hash, meta, options = {}) {
  const snapshotSource = isPlainObject(snapshot) ? snapshot : {};
  const workingSnapshot = cloneDeepPlain(snapshotSource);
  const extraction = extractGeneralSettingsForStorage(workingSnapshot, meta);
  const { hasSettings, payload, meta: cleanedMeta } = extraction;

  await client.query(
    `INSERT INTO ${TABLE_SNAPSHOTS} (rev, hash)
     VALUES ($1,$2)
     ON CONFLICT (rev) DO UPDATE
       SET hash = EXCLUDED.hash,
           created_at = NOW()` ,
    [rev, hash]
  );

  await clearStateForRevision(client, rev);

  await persistScalarValues(client, rev, workingSnapshot);
  await persistCapacity(client, rev, workingSnapshot.capByProc);
  await persistParallel(client, rev, workingSnapshot.parallelByProc);
  await persistRouteOverrides(client, rev, workingSnapshot.routeOverrides);
  await persistIgnoredStates(client, rev, workingSnapshot.ignoredStates);

  for (const listKey of STATE_LIST_KEYS) {
    const items = Array.isArray(workingSnapshot[listKey]) ? workingSnapshot[listKey] : [];
    // eslint-disable-next-line no-await-in-loop
    await persistListEntries(client, rev, listKey, items);
    delete workingSnapshot[listKey];
  }

  const crmData = isPlainObject(workingSnapshot.crm) ? workingSnapshot.crm : null;
  await persistStructuredValues(client, TABLE_CRM_VALUES, rev, crmData);
  delete workingSnapshot.crm;

  const modeScopedData = isPlainObject(workingSnapshot.modeScoped) ? workingSnapshot.modeScoped : null;
  await persistStructuredValues(client, TABLE_MODE_VALUES, rev, modeScopedData);
  delete workingSnapshot.modeScoped;

  STATE_SCALAR_KEYS.forEach((key) => {
    delete workingSnapshot[key];
  });
  delete workingSnapshot.capByProc;
  delete workingSnapshot.parallelByProc;
  delete workingSnapshot.routeOverrides;
  delete workingSnapshot.ignoredStates;

  const sanitizedMeta = sanitizeMetaForStorage(cleanedMeta);
  let historyPayload = [];
  if (isPlainObject(sanitizedMeta) && Array.isArray(sanitizedMeta.history)) {
    historyPayload = sanitizedMeta.history.slice();
    delete sanitizedMeta.history;
  }

  await persistStructuredValues(client, TABLE_META_VALUES, rev, sanitizedMeta);
  await persistMetaHistory(client, rev, historyPayload);

  await persistGeneralSettings(client, payload, { hasSettings, actor: options?.actor || null });
}

function computeSnapshotHash(stateString) {
  return crypto.createHash('sha1').update(stateString, 'utf8').digest('hex');
}

function normalizeExtraTimeSettings(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }
  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }
  if (!isPlainObject(snapshot.meta.settings)) {
    snapshot.meta.settings = {};
  }
  if (!isPlainObject(snapshot.meta.settings.extraTime)) {
    snapshot.meta.settings.extraTime = {};
  }
  const extra = snapshot.meta.settings.extraTime;
  const percent = Number.isFinite(extra.percent) ? extra.percent : 5;
  const minimum = Number.isFinite(extra.minimum) ? extra.minimum : 0.25;
  extra.percent = Math.max(0, Math.round(percent * 100) / 100);
  extra.minimum = Math.max(0, Math.round(minimum * 100) / 100);
  if (typeof extra.enabled !== 'boolean') {
    extra.enabled = extra.percent > 0 || extra.minimum > 0;
  }
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: import_legacy_snapshot.js <snapshot.json>');
    process.exit(1);
    return;
  }
  const filePath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let snapshot = {};
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse snapshot JSON', err);
    process.exit(1);
    return;
  }
  if (!isPlainObject(snapshot)) {
    console.error('Snapshot must be a JSON object');
    process.exit(1);
    return;
  }

  normalizeExtraTimeSettings(snapshot);
  const stateString = JSON.stringify(snapshot);
  const hash = computeSnapshotHash(stateString);
  const meta = sanitizeMetaForStorage({
    actor: 'import-script',
    source: 'legacy-import',
    note: 'Initial import'
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
    const rev = Number(rows[0]?.rev || 0);
    if (!Number.isFinite(rev) || rev <= 0) {
      throw new Error('Failed to allocate revision number');
    }
    await client.query(
      'INSERT INTO revisions (rev, actor, source, note) VALUES ($1,$2,$3,$4)',
      [rev, 'import-script', 'legacy-import', 'Initial import']
    );
    await client.query('SELECT set_config($1,$2,false)', ['app.rev', String(rev)]);
    await persistSnapshotData(client, rev, snapshot, hash, meta, { actor: 'import-script' });
    await client.query('COMMIT');
    console.log(`Snapshot imported as revision ${rev}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
