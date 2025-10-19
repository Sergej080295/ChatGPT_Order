'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const Database = require('better-sqlite3');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_STATE_FILE = path.join(DATA_DIR, 'planner-state.json');
const SQLITE_FILE = path.join(DATA_DIR, 'planner.db');

let sqlite = null;

function getDatabase() {
  if (sqlite) {
    return sqlite;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqlite = new Database(SQLITE_FILE);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      rev INTEGER PRIMARY KEY,
      hash TEXT,
      state_json TEXT NOT NULL,
      meta_json TEXT,
      actor TEXT,
      source TEXT,
      note TEXT,
      channel TEXT,
      saved_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

const pool = {
  async connect() {
    return {
      async query(sql, params = []) {
        const db = getDatabase();
        const statement = db.prepare(sql);
        if (/^\s*select/i.test(sql)) {
          const rows = statement.all(params);
          return { rows };
        }
        const info = statement.run(params);
        return { rowCount: info.changes || 0 };
      },
      async release() {
        /* no-op for sqlite */
      }
    };
  },
  async query(sql, params = []) {
    const db = getDatabase();
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
      const rows = statement.all(params);
      return { rows };
    }
    const info = statement.run(params);
    return { rowCount: info.changes || 0 };
  },
  on() {
    // no-op
  }
};

const app = express();
app.use(compression());
app.use(express.json({ limit: '10mb', strict: false }));
app.use(express.text({ limit: '10mb', type: ['text/plain', 'application/octet-stream'] }));

const sseClients = new Set();
let cachedSnapshot = null;
let lastRevision = 0;
let revisionColumnInfo = null;
let ordersTableInfo = null;
let settingsSchemaEnsured = false;

async function ensureDataDir() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      throw err;
    }
  }
}

async function readLocalStateFile() {
  try {
    const raw = await fsp.readFile(LOCAL_STATE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

async function writeLocalStateFile(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Local state payload must be an object');
  }
  await ensureDataDir();
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const tmpPath = `${LOCAL_STATE_FILE}.tmp`;
  await fsp.writeFile(tmpPath, serialized, 'utf8');
  await fsp.rename(tmpPath, LOCAL_STATE_FILE);
}

function safeParseJson(text, fallback = null) {
  if (typeof text !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function readSnapshotFromSql() {
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        'SELECT rev, hash, state_json, meta_json, actor, source, note, channel, saved_at FROM snapshots ORDER BY rev DESC LIMIT 1'
      )
      .get();
    if (!row) {
      return null;
    }
    const parsed = safeParseJson(row.state_json, null);
    if (!isPlainObject(parsed)) {
      return null;
    }
    normalizeExtraTimeSettings(parsed);
    normalizeSnapshotCollections(parsed);
    ensureModeScopedState(parsed);
    ensureLocalStorageMetadata(parsed);
    mergeCrmTasksIntoSnapshot(parsed);
    const stateString = safeSerializeSnapshot(parsed);
    const hash = row.hash || computeSnapshotHash(stateString);
    const meta = safeParseJson(row.meta_json, null);
    return {
      rev: Number(row.rev) || 0,
      snapshot: parsed,
      stateString,
      hash,
      meta: isPlainObject(meta) ? meta : null,
      savedAt: row.saved_at || null,
      savedBy: {
        actor: row.actor || null,
        source: row.source || null,
        note: row.note || null,
        channel: row.channel || null
      }
    };
  } catch (err) {
    console.warn('Failed to read snapshot from sqlite storage', err);
    return null;
  }
}

function writeSnapshotToSql(record) {
  try {
    const db = getDatabase();
    const metaJson = record.meta ? JSON.stringify(record.meta) : null;
    const savedAt = record.savedAt || new Date().toISOString();
    db.prepare(
      `INSERT INTO snapshots (rev, hash, state_json, meta_json, actor, source, note, channel, saved_at)
       VALUES (@rev,@hash,@state_json,@meta_json,@actor,@source,@note,@channel,@saved_at)
       ON CONFLICT(rev) DO UPDATE SET
         hash = excluded.hash,
         state_json = excluded.state_json,
         meta_json = excluded.meta_json,
         actor = excluded.actor,
         source = excluded.source,
         note = excluded.note,
         channel = excluded.channel,
         saved_at = excluded.saved_at`
    ).run({
      rev: record.rev,
      hash: record.hash || null,
      state_json: record.stateString || JSON.stringify(record.snapshot || {}),
      meta_json: metaJson,
      actor: record.savedBy?.actor || null,
      source: record.savedBy?.source || null,
      note: record.savedBy?.note || null,
      channel: record.savedBy?.channel || null,
      saved_at: savedAt
    });

    db.prepare(
      `INSERT INTO kv_store (key, value_json, updated_at)
       VALUES (@key,@value_json,@updated_at)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run({
      key: 'latest_snapshot',
      value_json: JSON.stringify({
        rev: record.rev,
        hash: record.hash || null,
        meta: record.meta || null,
        savedAt,
        savedBy: record.savedBy || null
      }),
      updated_at: savedAt
    });
  } catch (err) {
    console.error('Failed to write snapshot to sqlite storage', err);
    throw err;
  }
}

function readLatestSnapshotMetadata() {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT value_json FROM kv_store WHERE key = ?').get('latest_snapshot');
    if (!row) {
      return null;
    }
    const parsed = safeParseJson(row.value_json, null);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('Failed to read snapshot metadata from sqlite storage', err);
    return null;
  }
}

const PG_UNDEFINED_TABLE = '42P01';
const PG_UNDEFINED_COLUMN = '42703';
const DEFAULT_EXTRA_PERCENT = 5;
const DEFAULT_EXTRA_MINIMUM = 0.25;

const CRM_STAGE_IGNORE = '__ignore__';
const CRM_STAGE_DEFAULT_MAP = new Map([
  ['подготовка в работу', 'draw'],
  ['технологи: подготовка в работу', 'draw'],
  ['техподготовка', 'draw'],
  ['закупка', 'proc'],
  ['покупка', 'proc'],
  ['снабжение', 'proc'],
  ['рубка', 'shear'],
  ['резка', 'shear'],
  ['лазер', 'laser'],
  ['гибка', 'bend'],
  ['сварка', 'weld'],
  ['зенковка', 'mech'],
  ['зенкование', 'mech'],
  ['мехобработка', 'mech'],
  ['мех.обработка', 'mech'],
  ['мех. обработка', 'mech'],
  ['мех-обработка', 'mech'],
  ['мехобр', 'mech'],
  ['мехобр.', 'mech'],
  ['сверловка', 'mech'],
  ['сверление', 'mech'],
  ['сверл', 'mech'],
  ['резьбонарезка', 'mech'],
  ['резьба', 'mech'],
  ['резьб', 'mech'],
  ['пуклевка', 'mech'],
  ['пукл', 'mech'],
  ['заклепка', 'mech'],
  ['заклеп', 'mech'],
  ['кооперация', 'coop'],
  ['кооп', 'coop'],
  ['покраска', 'coop'],
  ['цинкование (кооперация)', 'coop'],
  ['цинкование', 'coop'],
  ['упаковка', 'pack'],
  ['отгрузка', 'ship']
]);
const CRM_PARALLEL_STAGES = new Set(['proc', 'shear', 'coop', 'pack', 'ship']);
const CRM_TASK_PREFIX = 'crm-task::';
const PLANNER_STAGE_CODES = ['draw', 'proc', 'shear', 'laser', 'bend', 'weld', 'mech', 'coop', 'pack', 'ship'];
const MODE_SCOPED_KEYS = Object.freeze(['csv', 'crm']);
const DEFAULT_CRM_LANES = Object.freeze([
  'Не запланированное',
  'Клиент',
  'Отдел продаж',
  'Технологи',
  'Производство',
  'Закупка',
  'Упаковка',
  'Готово (Ож. отгрузки)',
  'Отгружено'
]);

const WRITE_CHANNELS = Object.freeze({
  CRM: 'crm',
  PLANNER: 'planner',
  ADMIN: 'admin',
  SYSTEM: 'system'
});

const WRITE_MODES = Object.freeze({
  CRM: 'crm',
  PLANNER: 'planner',
  BOTH: 'both'
});

const DEFAULT_WRITE_MODE = WRITE_MODES.BOTH;

const SHARED_BOOLEAN_PREF_KEYS = [
  'autosaveOn',
  'shiftOnProgress',
  'autoOptimizeOn',
  'cascadeReadyOn'
];

function normalizeWeakEtag(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  const hasWeak = trimmed.length >= 2 && (trimmed[0] === 'W' || trimmed[0] === 'w') && trimmed[1] === '/';
  const withoutWeak = hasWeak ? trimmed.slice(2) : trimmed;
  const stripped = withoutWeak.replace(/^"|"$/g, '');
  return stripped || null;
}

function extractHashFromHeader(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(',')
    .map((token) => normalizeWeakEtag(token))
    .find((token) => token && token !== '*')
    || null;
}

function parseIfMatchHeader(value) {
  if (!value) {
    return { any: false, hash: null };
  }
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token === '*') {
      return { any: true, hash: null };
    }
    const normalized = normalizeWeakEtag(token);
    if (normalized && normalized !== '*') {
      return { any: false, hash: normalized };
    }
  }
  return { any: false, hash: null };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function computeSnapshotHash(stateString) {
  return crypto.createHash('sha1').update(stateString, 'utf8').digest('hex');
}

function normalizeStage(code) {
  if (!code) return null;
  return String(code).trim().toLowerCase();
}

function titleFromCode(code) {
  if (!code) return '';
  return code.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeWriteMode(value) {
  if (value === null || value === undefined) {
    return DEFAULT_WRITE_MODE;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_WRITE_MODE;
  }
  if (normalized === WRITE_MODES.CRM) {
    return WRITE_MODES.CRM;
  }
  if (normalized === WRITE_MODES.PLANNER) {
    return WRITE_MODES.PLANNER;
  }
  return WRITE_MODES.BOTH;
}

function normalizeChannelValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === WRITE_CHANNELS.CRM || normalized.startsWith('crm')) {
    return WRITE_CHANNELS.CRM;
  }
  if (normalized === WRITE_CHANNELS.PLANNER || normalized.startsWith('planner')) {
    return WRITE_CHANNELS.PLANNER;
  }
  if (normalized === WRITE_CHANNELS.ADMIN || normalized.includes('admin')) {
    return WRITE_CHANNELS.ADMIN;
  }
  if (normalized === WRITE_CHANNELS.SYSTEM
      || normalized.includes('system')
      || normalized.includes('startup')
      || normalized.includes('rollback')) {
    return WRITE_CHANNELS.SYSTEM;
  }
  return WRITE_CHANNELS.PLANNER;
}

function normalizeCrmStageLabel(value) {
  return sanitizeString(value);
}

function normalizeCrmStageKey(value) {
  const label = normalizeCrmStageLabel(value);
  return label ? label.toLowerCase() : '';
}

function sanitizeCrmStageMapping(mapping) {
  if (!isPlainObject(mapping)) {
    return {};
  }
  const result = {};
  Object.entries(mapping).forEach(([key, value]) => {
    const normalizedKey = normalizeCrmStageKey(key);
    if (!normalizedKey) return;
    if (value === CRM_STAGE_IGNORE) {
      result[normalizedKey] = CRM_STAGE_IGNORE;
      return;
    }
    const stage = normalizeStage(value);
    if (stage) {
      result[normalizedKey] = stage;
    }
  });
  return result;
}

function clampProgressValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
}

function mapCrmStageName(label, customMap) {
  const normalizedKey = normalizeCrmStageKey(label);
  if (!normalizedKey) {
    return null;
  }
  if (customMap && Object.prototype.hasOwnProperty.call(customMap, normalizedKey)) {
    const mapped = customMap[normalizedKey];
    if (mapped === CRM_STAGE_IGNORE) {
      return null;
    }
    if (mapped) {
      return normalizeStage(mapped);
    }
  }
  const fallback = CRM_STAGE_DEFAULT_MAP.get(normalizedKey);
  if (fallback) {
    return fallback;
  }

  const includesAny = (...parts) => parts.some((part) => normalizedKey.includes(part));

  if (includesAny('кооп', 'кооперац', 'покрас', 'цинк', 'анод', 'галван')) {
    return 'coop';
  }
  if (
    includesAny('мехобр', 'зенк', 'сверл', 'резьб', 'пукл', 'заклеп', 'механо', 'фрез', 'токар')
  ) {
    return 'mech';
  }
  if (includesAny('гиб', 'bend', 'изгиб')) {
    return 'bend';
  }
  if (includesAny('лазер', 'laser')) {
    return 'laser';
  }
  if (includesAny('свар', 'weld')) {
    return 'weld';
  }
  if (includesAny('подгот', 'техпод', 'технолог', 'планир')) {
    return 'draw';
  }
  if (includesAny('закуп', 'покуп', 'снабж', 'постав', 'proc')) {
    return 'proc';
  }
  if (includesAny('рубк', 'резк', 'гильот', 'штамп', 'отрез', 'раскро')) {
    return 'shear';
  }
  if (includesAny('упаков', 'упак', 'комплект', 'тара', 'pack')) {
    return 'pack';
  }
  if (includesAny('отгруз', 'отправ', 'достав', 'ship', 'shipment', 'экспед')) {
    return 'ship';
  }
  return null;
}

function resolveCrmStageKey(entry, customMap) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const directCandidates = [
    entry.stageKey,
    entry.crmStageKey,
    entry.stage_code,
    entry.stageCode,
    entry.stage,
    entry.code,
    entry.key
  ];
  for (const candidate of directCandidates) {
    const normalized = normalizeStage(candidate);
    if (normalized && PLANNER_STAGE_CODES.includes(normalized)) {
      return normalized;
    }
  }

  const nameCandidates = [
    entry.name,
    entry.stageName,
    entry.title,
    entry.label,
    entry.displayName
  ];
  for (const candidate of nameCandidates) {
    const resolved = mapCrmStageName(candidate, customMap);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function buildCrmTaskUid(orderInfo, stageInfo, stageKey) {
  const parts = [
    orderInfo.identity,
    orderInfo.crmOrderId,
    orderInfo.orderId,
    orderInfo.orderNumber,
    orderInfo.title,
    stageInfo?.id,
    stageInfo?.crmStageId,
    stageInfo?.name,
    stageKey
  ].map((part) => sanitizeString(part)).filter(Boolean);
  const base = parts.length ? parts.join('|') : `${stageKey}::${Math.random().toString(16).slice(2, 10)}`;
  const hash = crypto.createHash('sha1').update(base, 'utf8').digest('hex').slice(0, 12);
  return `${CRM_TASK_PREFIX}${hash}::${stageKey}`;
}

function deriveCrmTasksFromSnapshot(snapshot, { existingTasks = [] } = {}) {
  if (!isPlainObject(snapshot?.crm) || !Array.isArray(snapshot.crm.boards)) {
    return [];
  }

  const customMapping = sanitizeCrmStageMapping(snapshot?.meta?.settings?.crmStageMapping);
  const existingKeys = new Set();
  existingTasks.forEach((task) => {
    const key = buildCrmTaskIdentityKey(task);
    if (key) {
      existingKeys.add(key);
    }
  });

  const tasks = [];

  const scoped = snapshot?.modeScoped?.crm;
  if (isPlainObject(scoped) && Array.isArray(scoped.stageTasks)) {
    scoped.stageTasks.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return;
      }
      const stageKey = normalizeStage(entry[0]);
      if (!stageKey) {
        return;
      }
      const list = Array.isArray(entry[1]) ? entry[1] : [];
      list.forEach((rawTask) => {
        const task = buildTaskFromModeScopedEntry(rawTask, stageKey);
        if (!task) {
          return;
        }
        const key = buildCrmTaskIdentityKey(task);
        if (key && existingKeys.has(key)) {
          return;
        }
        tasks.push(task);
        if (key) {
          existingKeys.add(key);
        }
      });
    });
  }

  snapshot.crm.boards.forEach((board) => {
    if (!board || !Array.isArray(board.orders)) return;
    const boardId = sanitizeString(board.id);
    const laneFallback = Array.isArray(board.lanes) && board.lanes.length
      ? sanitizeString(board.lanes[0])
      : '';
    board.orders.forEach((order) => {
      if (!order) return;
      const identity = sanitizeString(order.orderIdentity)
        || sanitizeString(order.id)
        || sanitizeString(order.orderId)
        || sanitizeString(order.orderNo)
        || sanitizeString(order.title);
      const orderNumber = sanitizeString(order.orderNumber)
        || sanitizeString(order.orderNo)
        || sanitizeString(order.orderId);
      const orderCustomer = sanitizeString(order.orderCustomer)
        || sanitizeString(order.customer);
      const title = sanitizeString(order.title);
      const parentId = sanitizeString(order.parentId);
      const lane = sanitizeString(order.status) || sanitizeString(order.lane) || laneFallback;
      const crmOrderId = sanitizeString(order.id) || sanitizeString(order.orderId);
      const stageList = Array.isArray(order.stages) ? order.stages : [];

      stageList.forEach((stageEntry) => {
        if (!stageEntry) return;
        const stageKey = resolveCrmStageKey(stageEntry, customMapping);
        if (!stageKey) return;
        const dedupeKey = identity ? `${identity}::${stageKey}` : null;
        if (dedupeKey && existingKeys.has(dedupeKey)) {
          return;
        }

        const start = parseDate(stageEntry.start || stageEntry.startDate);
        const end = parseDate(stageEntry.end || stageEntry.endDate);
        const origStart = parseDate(stageEntry.originalStart || stageEntry.origStart);
        const origEnd = parseDate(stageEntry.originalEnd || stageEntry.origEnd);
        const doneAt = parseDate(stageEntry.doneAt);
        const hoursRaw = Number(stageEntry.hours ?? stageEntry.value ?? 0);
        const hours = CRM_PARALLEL_STAGES.has(stageKey)
          ? 0
          : (Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 0);
        const progress = clampProgressValue(
          stageEntry.progress != null ? stageEntry.progress : (stageEntry.done ? 100 : 0)
        );
        const isDone = Boolean(stageEntry.done || stageEntry.isReady || progress >= 100);

        const orderInfo = {
          identity,
          crmOrderId,
          orderId: sanitizeString(order.orderId) || orderNumber || crmOrderId || identity || '',
          orderNumber: orderNumber || '',
          orderCustomer: orderCustomer || '',
          title: title || '',
          parentId: parentId || '',
          boardId: boardId || '',
          lane: lane || ''
        };

        const uid = buildCrmTaskUid(orderInfo, stageEntry, stageKey);
        const task = {
          uid,
          orderId: orderInfo.orderId,
          orderNumber: orderInfo.orderNumber,
          orderCustomer: orderInfo.orderCustomer,
          orderIdentity: orderInfo.identity || '',
          orderTitle: orderInfo.title,
          stage: stageKey,
          parentId: orderInfo.parentId,
          childId: '',
          hours,
          extraHours: 0,
          startDate: start,
          endDate: end,
          startMissing: !start,
          endMissing: !end,
          state: orderInfo.lane,
          status: isDone ? 'Готово (CRM)' : 'CRM',
          useReserve: Boolean(stageEntry.useReserve),
          progress,
          origStartDate: origStart,
          origEndDate: origEnd,
          route: {
            [stageKey]: {
              hours,
              start,
              end,
              ...(origStart ? { origStart } : {}),
              ...(origEnd ? { origEnd } : {}),
              ...(doneAt ? { doneAt } : {}),
              ...(isDone ? { done: true } : {})
            }
          },
          crmMeta: {
            boardId: orderInfo.boardId,
            crmOrderId,
            orderId: orderInfo.orderId,
            orderIdentity: orderInfo.identity || '',
            stageKey,
            stageId: stageEntry.id || stageEntry.crmStageId || '',
            stageName: sanitizeString(stageEntry.name) || stageKey,
            lane: orderInfo.lane
          },
          crmOrigin: true
        };

        if (isDone) {
          const doneMoment = doneAt || end || start;
          if (doneMoment) {
            const doneDate = parseDate(doneMoment) || null;
            if (doneDate) {
              task.doneMeta = { when: doneDate, source: 'crm' };
            }
          }
        }

        if (dedupeKey) {
          existingKeys.add(dedupeKey);
        }
        tasks.push(task);
      });
    });
  });

  return tasks;
}

function mergeCrmTasksIntoSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    return { tasks: Array.isArray(snapshot?.t) ? snapshot.t : [], crmTasks: [] };
  }

  const baseTasks = Array.isArray(snapshot.t) ? snapshot.t : [];
  const derivedCrmTasks = deriveCrmTasksFromSnapshot(snapshot, { existingTasks: baseTasks });
  const tasks = derivedCrmTasks.length ? baseTasks.concat(derivedCrmTasks) : baseTasks.slice();

  if (Array.isArray(snapshot.t)) {
    snapshot.t = tasks;
  } else {
    snapshot.t = tasks.slice();
  }

  const baseOrderMap = new Map();
  if (Array.isArray(snapshot.orders)) {
    snapshot.orders.forEach((entry) => {
      if (!entry || !Array.isArray(entry)) return;
      const [stage, list] = entry;
      const stageKey = normalizeStage(stage);
      if (!stageKey) return;
      const filtered = Array.isArray(list)
        ? list
            .map((value) => (value == null ? '' : String(value)))
            .filter((uid) => uid && !uid.startsWith(CRM_TASK_PREFIX))
        : [];
      baseOrderMap.set(stageKey, filtered);
    });
  }

  const mergedOrderMap = new Map(baseOrderMap);
  tasks.forEach((task) => {
    if (!task || !task.uid) return;
    const stageKey = normalizeStage(task.stage);
    if (!stageKey) return;
    const uid = String(task.uid);
    const current = mergedOrderMap.get(stageKey) || [];
    if (!current.includes(uid)) {
      current.push(uid);
    }
    mergedOrderMap.set(stageKey, current);
  });

  snapshot.orders = Array.from(mergedOrderMap.entries());

  ensureCrmModeScoped(snapshot, tasks);

  const crmTasks = tasks.filter((task) => isCrmTaskRecord(task));

  return { tasks, crmTasks };
}

function toIsoString(value) {
  const date = parseDate(value);
  if (!date) return '';
  return date.toISOString();
}

function serializeRouteSegmentForMode(seg) {
  if (!seg || typeof seg !== 'object') {
    return null;
  }
  return {
    hours: Number(seg.hours) || 0,
    start: toIsoString(seg.start || null),
    end: toIsoString(seg.end || null),
    origStart: toIsoString(seg.origStart || seg.originalStart || null),
    origEnd: toIsoString(seg.origEnd || seg.originalEnd || null),
    doneAt: toIsoString(seg.doneAt || null)
  };
}

function serializeTaskForModeState(task) {
  if (!task || typeof task !== 'object') {
    return null;
  }
  const route = isPlainObject(task.route) ? task.route : {};
  const stageKey = normalizeStage(task.stage || task.crmMeta?.stageKey || task.crmMeta?.stage || task.crmMeta?.stageName) || '';
  const doneMeta = task.doneMeta && task.doneMeta.when
    ? { when: toIsoString(task.doneMeta.when), source: sanitizeString(task.doneMeta.source) || '' }
    : null;
  return {
    uid: task.uid == null ? '' : String(task.uid),
    orderId: sanitizeString(task.orderId) || '',
    orderNumber: sanitizeString(task.orderNumber) || '',
    orderCustomer: sanitizeString(task.orderCustomer) || '',
    orderIdentity: sanitizeString(task.orderIdentity) || '',
    stage: stageKey,
    childId: sanitizeString(task.childId) || '',
    parentId: sanitizeString(task.parentId) || '',
    hours: Number(task.hours) || 0,
    extraHours: Number(task.extraHours) || 0,
    startDate: toIsoString(task.startDate || null),
    endDate: toIsoString(task.endDate || null),
    startMissing: Boolean(task.startMissing),
    endMissing: Boolean(task.endMissing),
    state: sanitizeString(task.state) || '',
    status: sanitizeString(task.status) || '',
    useReserve: Boolean(task.useReserve),
    progress: clampProgressValue(task.progress),
    origStartDate: toIsoString(task.origStartDate || null),
    origEndDate: toIsoString(task.origEndDate || null),
    route: {
      laser: serializeRouteSegmentForMode(route.laser),
      bend: serializeRouteSegmentForMode(route.bend),
      draw: serializeRouteSegmentForMode(route.draw),
      weld: serializeRouteSegmentForMode(route.weld),
      mech: serializeRouteSegmentForMode(route.mech),
      proc: serializeRouteSegmentForMode(route.proc),
      shear: serializeRouteSegmentForMode(route.shear),
      pack: serializeRouteSegmentForMode(route.pack),
      ship: serializeRouteSegmentForMode(route.ship)
    },
    locked: Boolean(task.locked),
    hiddenByState: Boolean(task.hiddenByState),
    doneMeta,
    crmMeta: isPlainObject(task.crmMeta) ? cloneJson(task.crmMeta) : null,
    crmOrigin: Boolean(task.crmOrigin)
  };
}

function isCrmTaskRecord(task) {
  if (!task) {
    return false;
  }
  if (task.crmOrigin) {
    return true;
  }
  if (isPlainObject(task.crmMeta)) {
    return Boolean(
      task.crmMeta.stageKey
      || task.crmMeta.stage
      || task.crmMeta.stageName
      || task.crmMeta.crmOrderId
    );
  }
  return false;
}

function buildCrmTaskIdentityKey(task) {
  if (!task) {
    return null;
  }
  const stageKey = normalizeStage(task.stage || task.crmMeta?.stageKey || task.crmMeta?.stage || task.crmMeta?.stageName);
  if (!stageKey) {
    return null;
  }
  const identity = sanitizeString(task.orderIdentity)
    || sanitizeString(task.crmMeta?.orderIdentity)
    || sanitizeString(task.orderId)
    || sanitizeString(task.orderNumber)
    || sanitizeString(task.uid);
  if (!identity) {
    return null;
  }
  return `${identity}::${stageKey}`;
}

function buildTaskFromModeScopedEntry(raw, stageKeyHint = null) {
  if (!isPlainObject(raw)) {
    return null;
  }

  const normalizedStage = normalizeStage(stageKeyHint || raw.stage || raw.crmMeta?.stageKey || raw.crmMeta?.stage);
  if (!normalizedStage) {
    return null;
  }

  const parseMaybeDate = (value) => parseDate(value) || null;
  const routeRaw = isPlainObject(raw.route) ? raw.route : {};
  const stageRouteRaw = isPlainObject(routeRaw[normalizedStage]) ? routeRaw[normalizedStage] : {};

  const identity = sanitizeString(raw.orderIdentity)
    || sanitizeString(raw.crmMeta?.orderIdentity)
    || sanitizeString(raw.orderId)
    || sanitizeString(raw.orderNumber)
    || sanitizeString(raw.uid);
  const orderId = sanitizeString(raw.orderId)
    || sanitizeString(raw.crmMeta?.orderId)
    || identity
    || '';
  const orderNumber = sanitizeString(raw.orderNumber) || '';
  const orderCustomer = sanitizeString(raw.orderCustomer) || '';

  if (!identity && !orderId && !orderNumber) {
    return null;
  }

  const hoursCandidate = Number(raw.hours);
  const routeHours = Number(stageRouteRaw.hours);
  const hours = Number.isFinite(hoursCandidate)
    ? hoursCandidate
    : (Number.isFinite(routeHours) ? routeHours : 0);

  const startDate = parseMaybeDate(raw.startDate) || parseMaybeDate(stageRouteRaw.start);
  const endDate = parseMaybeDate(raw.endDate) || parseMaybeDate(stageRouteRaw.end);
  const origStartDate = parseMaybeDate(raw.origStartDate)
    || parseMaybeDate(stageRouteRaw.origStart)
    || parseMaybeDate(stageRouteRaw.originalStart);
  const origEndDate = parseMaybeDate(raw.origEndDate)
    || parseMaybeDate(stageRouteRaw.origEnd)
    || parseMaybeDate(stageRouteRaw.originalEnd);
  const doneAt = parseMaybeDate(raw.doneMeta?.when) || parseMaybeDate(stageRouteRaw.doneAt);

  const progress = clampProgressValue(raw.progress);
  const useReserve = raw.useReserve !== undefined
    ? Boolean(raw.useReserve)
    : Boolean(stageRouteRaw.useReserve);
  const state = sanitizeString(raw.state) || sanitizeString(raw.crmMeta?.lane) || '';
  const status = sanitizeString(raw.status) || (progress >= 100 ? 'Готово (CRM)' : 'CRM');

  const crmMeta = isPlainObject(raw.crmMeta) ? cloneJson(raw.crmMeta) : {};
  if (!crmMeta.stageKey) {
    crmMeta.stageKey = normalizedStage;
  }
  if (!crmMeta.stageName && status) {
    crmMeta.stageName = status;
  }
  if (!crmMeta.orderId && orderId) {
    crmMeta.orderId = orderId;
  }
  if (!crmMeta.orderIdentity && identity) {
    crmMeta.orderIdentity = identity;
  }

  const task = {
    uid: sanitizeString(raw.uid) || `${CRM_TASK_PREFIX}${identity || orderId || Math.random().toString(16).slice(2, 10)}::${normalizedStage}`,
    orderId: orderId || '',
    orderNumber,
    orderCustomer,
    orderIdentity: identity || '',
    stage: normalizedStage,
    childId: sanitizeString(raw.childId) || '',
    parentId: sanitizeString(raw.parentId) || '',
    hours,
    extraHours: Number(raw.extraHours) || 0,
    startDate,
    endDate,
    startMissing: startDate ? Boolean(raw.startMissing) : true,
    endMissing: endDate ? Boolean(raw.endMissing) : true,
    state,
    status,
    useReserve,
    progress,
    origStartDate,
    origEndDate,
    route: {},
    crmMeta,
    crmOrigin: true
  };

  if (doneAt) {
    task.doneMeta = {
      when: doneAt,
      source: sanitizeString(raw.doneMeta?.source) || 'crm'
    };
  }

  const primarySeg = {
    hours,
    start: startDate,
    end: endDate
  };
  if (origStartDate) primarySeg.origStart = origStartDate;
  if (origEndDate) primarySeg.origEnd = origEndDate;
  if (doneAt) primarySeg.doneAt = doneAt;
  if (useReserve) primarySeg.useReserve = true;
  if (progress >= 100) primarySeg.done = true;
  task.route[normalizedStage] = primarySeg;

  PLANNER_STAGE_CODES.forEach((code) => {
    if (code === normalizedStage) {
      return;
    }
    const segRaw = routeRaw[code];
    if (!isPlainObject(segRaw)) {
      return;
    }
    const segHours = Number(segRaw.hours);
    const segStart = parseMaybeDate(segRaw.start);
    const segEnd = parseMaybeDate(segRaw.end);
    const segOrigStart = parseMaybeDate(segRaw.origStart || segRaw.originalStart);
    const segOrigEnd = parseMaybeDate(segRaw.origEnd || segRaw.originalEnd);
    const segDoneAt = parseMaybeDate(segRaw.doneAt);
    const segment = {
      hours: Number.isFinite(segHours) ? segHours : 0,
      start: segStart,
      end: segEnd
    };
    if (segOrigStart) segment.origStart = segOrigStart;
    if (segOrigEnd) segment.origEnd = segOrigEnd;
    if (segDoneAt) segment.doneAt = segDoneAt;
    if (segRaw.useReserve) segment.useReserve = true;
    if (segRaw.done || segRaw.isDone) segment.done = true;
    task.route[code] = segment;
  });

  return task;
}

function ensureCrmModeScoped(snapshot, tasksInput = []) {
  if (!isPlainObject(snapshot)) {
    return;
  }

  const tasks = Array.isArray(tasksInput) ? tasksInput : [];
  if (!tasks.length && !isPlainObject(snapshot.modeScoped?.crm)) {
    return;
  }

  if (!isPlainObject(snapshot.modeScoped)) {
    snapshot.modeScoped = {};
  }

  const scoped = isPlainObject(snapshot.modeScoped.crm) ? { ...snapshot.modeScoped.crm } : {};
  const crmTasks = tasks.filter((task) => task && (task.crmOrigin || isPlainObject(task.crmMeta)));

  if (crmTasks.length) {
    const stageMap = new Map();
    crmTasks.forEach((task) => {
      const stageKey = normalizeStage(task.stage || task.crmMeta?.stageKey || task.crmMeta?.stage || task.crmMeta?.stageName);
      if (!stageKey) return;
      const serialized = serializeTaskForModeState(task);
      if (!serialized) return;
      if (!stageMap.has(stageKey)) stageMap.set(stageKey, []);
      stageMap.get(stageKey).push(serialized);
    });

    const stageTasks = [];
    PLANNER_STAGE_CODES.forEach((stage) => {
      if (stageMap.has(stage)) {
        stageTasks.push([stage, stageMap.get(stage)]);
        stageMap.delete(stage);
      }
    });
    stageMap.forEach((list, stage) => {
      stageTasks.push([stage, list]);
    });
    scoped.stageTasks = stageTasks;
  } else if (!Array.isArray(scoped.stageTasks)) {
    scoped.stageTasks = [];
  }

  if (Array.isArray(snapshot.orders) && snapshot.orders.length) {
    scoped.orders = snapshot.orders.map((entry) => {
      const stage = normalizeStage(entry && entry[0]);
      const list = Array.isArray(entry && entry[1])
        ? entry[1].map((uid) => (uid == null ? '' : String(uid)))
        : [];
      return [stage || (entry && entry[0]) || '', list];
    });
  } else if (!Array.isArray(scoped.orders)) {
    scoped.orders = PLANNER_STAGE_CODES.map((stage) => [stage, []]);
  }

  if (!Array.isArray(scoped.exceptions)) {
    scoped.exceptions = Array.isArray(snapshot.exc) ? cloneJson(snapshot.exc) : [];
  }
  if (!Array.isArray(scoped.reserves)) {
    scoped.reserves = Array.isArray(snapshot.res) ? cloneJson(snapshot.res) : [];
  }
  if (!Array.isArray(scoped.locked)) {
    scoped.locked = Array.isArray(snapshot.locked) ? snapshot.locked.slice() : [];
  }
  if (!Array.isArray(scoped.ignored)) {
    scoped.ignored = Array.isArray(snapshot.ignoredStates) ? snapshot.ignoredStates.slice() : [];
  }
  if (!scoped.csvFreshness && snapshot.freshnessCsv) {
    scoped.csvFreshness = snapshot.freshnessCsv;
  }
  if (!scoped.manualFreshness && snapshot.freshnessManual) {
    scoped.manualFreshness = snapshot.freshnessManual;
  }
  if (!scoped.lastImportTime && snapshot.lastImportTime) {
    scoped.lastImportTime = snapshot.lastImportTime;
  }
  if (!scoped.lastManualTime && snapshot.lastManualTime) {
    scoped.lastManualTime = snapshot.lastManualTime;
  }

  snapshot.modeScoped.crm = scoped;
}

function cloneJson(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    if (Array.isArray(value)) {
      return value.slice();
    }
    if (isPlainObject(value)) {
      return { ...value };
    }
    return value;
  }
}

function ensureCrmBoardsStructure(crm, fallbackCrm = null) {
  const target = isPlainObject(crm) ? crm : { boards: [], currentBoardId: null };
  if (!Array.isArray(target.boards)) {
    target.boards = [];
  }

  const seenIds = new Set();
  let sequence = 0;
  const allocateId = (rawId) => {
    const normalized = sanitizeString(rawId);
    if (normalized && !seenIds.has(normalized)) {
      seenIds.add(normalized);
      return normalized;
    }
    do {
      sequence += 1;
    } while (seenIds.has(`crm-board-${sequence}`));
    const candidate = `crm-board-${sequence}`;
    seenIds.add(candidate);
    return candidate;
  };

  const normalizeBoard = (rawBoard) => {
    if (!isPlainObject(rawBoard)) {
      return null;
    }
    const board = { ...rawBoard };
    board.id = allocateId(board.id);
    board.name = sanitizeString(board.name) || 'Список заказов';
    const lanes = Array.isArray(board.lanes)
      ? board.lanes.map((lane) => sanitizeString(lane)).filter(Boolean)
      : [];
    board.lanes = lanes.length ? lanes : [...DEFAULT_CRM_LANES];
    board.orders = Array.isArray(board.orders)
      ? board.orders.filter((order) => isPlainObject(order)).map((order) => cloneJson(order))
      : [];
    return board;
  };

  const normalizedBoards = [];
  target.boards.forEach((rawBoard) => {
    const normalized = normalizeBoard(rawBoard);
    if (normalized) {
      normalizedBoards.push(normalized);
    }
  });

  if (!normalizedBoards.length && isPlainObject(fallbackCrm) && Array.isArray(fallbackCrm.boards)) {
    fallbackCrm.boards.forEach((rawBoard) => {
      const normalized = normalizeBoard(rawBoard);
      if (normalized) {
        normalizedBoards.push(normalized);
      }
    });
  }

  if (!normalizedBoards.length) {
    const baseBoard = normalizeBoard({
      id: 'crm-board-1',
      name: 'Список заказов',
      lanes: [...DEFAULT_CRM_LANES],
      orders: []
    });
    if (baseBoard) {
      normalizedBoards.push(baseBoard);
    }
  }

  target.boards = normalizedBoards;
  if (!sanitizeString(target.currentBoardId)
      || !normalizedBoards.some((board) => board.id === target.currentBoardId)) {
    target.currentBoardId = normalizedBoards[0]?.id || null;
  }

  return target;
}

function isEmptyArray(value) {
  return !Array.isArray(value) || value.length === 0;
}

function isEmptyObject(value) {
  if (!isPlainObject(value)) {
    return true;
  }
  return Object.keys(value).length === 0;
}

function mergeDeepMissing(target, source) {
  if (!isPlainObject(source)) {
    return isPlainObject(target) ? target : {};
  }
  const result = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (result[key] === undefined || result[key] === null) {
      result[key] = cloneJson(value);
      continue;
    }
    if (Array.isArray(value)) {
      if (isEmptyArray(result[key]) && !isEmptyArray(value)) {
        result[key] = cloneJson(value);
      }
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = mergeDeepMissing(result[key], value);
    }
  }
  return result;
}

function applyFallbackSnapshot(target, fallback) {
  if (!isPlainObject(target) || !isPlainObject(fallback)) {
    return;
  }

  if (isEmptyArray(target.t) && Array.isArray(fallback.t) && !isEmptyArray(fallback.t)) {
    target.t = cloneJson(fallback.t);
  }
  if (isEmptyArray(target.done) && Array.isArray(fallback.done) && !isEmptyArray(fallback.done)) {
    target.done = cloneJson(fallback.done);
  }
  if (isEmptyArray(target.trash) && Array.isArray(fallback.trash) && !isEmptyArray(fallback.trash)) {
    target.trash = cloneJson(fallback.trash);
  }
  if (isEmptyArray(target.exc) && Array.isArray(fallback.exc) && !isEmptyArray(fallback.exc)) {
    target.exc = cloneJson(fallback.exc);
  }
  if (isEmptyArray(target.res) && Array.isArray(fallback.res) && !isEmptyArray(fallback.res)) {
    target.res = cloneJson(fallback.res);
  }
  if (isEmptyArray(target.routeOverrides)
      && Array.isArray(fallback.routeOverrides)
      && !isEmptyArray(fallback.routeOverrides)) {
    target.routeOverrides = cloneJson(fallback.routeOverrides);
  }
  if (isEmptyArray(target.orders) && Array.isArray(fallback.orders) && !isEmptyArray(fallback.orders)) {
    target.orders = cloneJson(fallback.orders);
  }
  if (isEmptyArray(target.locked) && Array.isArray(fallback.locked) && !isEmptyArray(fallback.locked)) {
    target.locked = cloneJson(fallback.locked);
  }
  if (isEmptyArray(target.ignoredStates)
      && Array.isArray(fallback.ignoredStates)
      && !isEmptyArray(fallback.ignoredStates)) {
    target.ignoredStates = cloneJson(fallback.ignoredStates);
  }

  if (!target.process && fallback.process) {
    target.process = fallback.process;
  }
  if (!target.filter && fallback.filter) {
    target.filter = fallback.filter;
  }
  if (!target.freshness && fallback.freshness) {
    target.freshness = fallback.freshness;
  }
  if (!target.freshnessCsv && fallback.freshnessCsv) {
    target.freshnessCsv = fallback.freshnessCsv;
  }
  if (!target.freshnessManual && fallback.freshnessManual) {
    target.freshnessManual = fallback.freshnessManual;
  }
  if (!target.lastImportTime && fallback.lastImportTime) {
    target.lastImportTime = fallback.lastImportTime;
  }
  if (!target.lastManualTime && fallback.lastManualTime) {
    target.lastManualTime = fallback.lastManualTime;
  }

  if (!isPlainObject(target.meta) || isEmptyObject(target.meta)) {
    target.meta = {};
  }
  if (isPlainObject(fallback.meta)) {
    target.meta = mergeDeepMissing(target.meta, fallback.meta);
  }

  if (!isPlainObject(target.modeScoped) && isPlainObject(fallback.modeScoped)) {
    target.modeScoped = cloneJson(fallback.modeScoped);
  }

  if (!isPlainObject(target.crm)) {
    target.crm = { boards: [], currentBoardId: null };
  }
  ensureCrmBoardsStructure(target.crm, fallback?.crm);
}

function extractBaseState(snapshot) {
  if (!isPlainObject(snapshot)) {
    return {};
  }
  const base = {};
  const copy = (key, fallback) => {
    if (snapshot[key] === undefined) {
      if (fallback !== undefined) {
        base[key] = fallback;
      }
      return;
    }
    base[key] = cloneJson(snapshot[key]);
  };

  copy('routeOverrides', []);
  copy('trash', []);
  copy('exc', []);
  copy('res', []);
  copy('process', 'bend');
  copy('capByProc', {});
  copy('parallelByProc', {});
  copy('filter', '');
  copy('locked', []);
  copy('freshness', '');
  copy('freshnessCsv', '');
  copy('freshnessManual', '');
  copy('lastImportTime', '');
  copy('lastManualTime', '');
  copy('autosaveOn', true);
  copy('autoOptimizeOn', true);
  copy('cascadeReadyOn', true);
  copy('priorityChangeLoggingOn', false);
  copy('routeDateChangeLoggingOn', false);
  copy('notificationsMuted', false);
  copy('shiftOnProgress', true);
  copy('ignoredStates', []);
  copy('meta', {});
  copy('modeScoped', {});

  const crm = snapshot.crm && typeof snapshot.crm === 'object' ? snapshot.crm : {};
  base.crm = {
    currentBoardId: crm.currentBoardId || null
  };

  return base;
}

function applyBaseSnapshot(target, base) {
  if (!isPlainObject(base) || !isPlainObject(target)) {
    return;
  }

  const assignArray = (key) => {
    if (Array.isArray(base[key])) {
      target[key] = base[key].map((item) => cloneJson(item));
    }
  };

  const assignObject = (key) => {
    if (isPlainObject(base[key])) {
      target[key] = cloneJson(base[key]);
    }
  };

  const assignValue = (key) => {
    if (base[key] !== undefined) {
      target[key] = cloneJson(base[key]);
    }
  };

  assignArray('routeOverrides');
  assignArray('trash');
  assignArray('exc');
  assignArray('res');
  assignArray('locked');
  assignArray('ignoredStates');

  assignObject('capByProc');
  assignObject('parallelByProc');
  assignObject('meta');
  assignObject('modeScoped');

  assignValue('process');
  assignValue('filter');
  assignValue('freshness');
  assignValue('freshnessCsv');
  assignValue('freshnessManual');
  assignValue('lastImportTime');
  assignValue('lastManualTime');
  assignValue('autosaveOn');
  assignValue('autoOptimizeOn');
  assignValue('cascadeReadyOn');
  assignValue('priorityChangeLoggingOn');
  assignValue('routeDateChangeLoggingOn');
  assignValue('notificationsMuted');
  assignValue('shiftOnProgress');

  if (!isPlainObject(target.crm)) {
    target.crm = { boards: [], currentBoardId: null };
  }
  ensureCrmBoardsStructure(target.crm);
  if (isPlainObject(base.crm) && base.crm.currentBoardId) {
    const normalizedId = sanitizeString(base.crm.currentBoardId);
    if (normalizedId && target.crm.boards.some((board) => board.id === normalizedId)) {
      target.crm.currentBoardId = normalizedId;
    }
  }
}

function ensureCrmOrderStagesArray(order) {
  if (!isPlainObject(order)) {
    return [];
  }
  if (Array.isArray(order.stages)) {
    return order.stages;
  }
  if (order.stages && typeof order.stages === 'object') {
    const values = Object.values(order.stages).filter(Boolean).map((value) => (
      isPlainObject(value) ? value : { value }
    ));
    order.stages = values;
    return order.stages;
  }
  order.stages = [];
  return order.stages;
}

function assignIfChanged(target, key, value) {
  if (!target) {
    return false;
  }
  const prev = target[key];
  if (prev === value) {
    return false;
  }
  if (prev == null && value === undefined) {
    return false;
  }
  target[key] = value;
  return true;
}

function recomputeCrmOrderAggregates(order) {
  if (!isPlainObject(order)) {
    return;
  }
  const stages = ensureCrmOrderStagesArray(order);
  const starts = [];
  const ends = [];
  let progressSum = 0;
  let progressCount = 0;
  let allDone = stages.length > 0;

  stages.forEach((stage) => {
    if (!stage || typeof stage !== 'object') {
      allDone = false;
      return;
    }
    const start = parseDate(stage.start || stage.startDate);
    if (start) {
      starts.push(start);
    }
    const end = parseDate(stage.end || stage.endDate);
    if (end) {
      ends.push(end);
    }
    const progress = clampProgressValue(stage.progress);
    if (Number.isFinite(progress)) {
      progressSum += progress;
      progressCount += 1;
    }
    const stageDone = stage.done || progress >= 100;
    if (!stageDone) {
      allDone = false;
    }
  });

  if (starts.length) {
    starts.sort((a, b) => a - b);
    assignIfChanged(order, 'start', starts[0].toISOString());
  }
  if (ends.length) {
    ends.sort((a, b) => a - b);
    assignIfChanged(order, 'end', ends[ends.length - 1].toISOString());
  }

  if (progressCount > 0) {
    const avg = Math.round(progressSum / progressCount);
    assignIfChanged(order, 'progress', avg);
  }

  if (allDone) {
    assignIfChanged(order, 'done', true);
  } else if (order.done) {
    assignIfChanged(order, 'done', false);
  }

  assignIfChanged(order, 'progressManual', true);
  assignIfChanged(order, 'updatedAt', new Date().toISOString());
}

function updateCrmOrderFromTask(order, task) {
  if (!isPlainObject(order) || !task) {
    return false;
  }
  const stageKey = normalizeStage(task.stage || task.crmMeta?.stageKey || task.crmMeta?.stage || task.crmMeta?.stageName);
  if (!stageKey) {
    return false;
  }

  const stages = ensureCrmOrderStagesArray(order);
  let stageEntry = null;
  for (const entry of stages) {
    const entryKey = normalizeStage(entry?.stageKey || entry?.crmStageKey || entry?.name);
    if (entryKey && entryKey === stageKey) {
      stageEntry = entry;
      break;
    }
  }

  if (!stageEntry) {
    stageEntry = {
      stageKey,
      crmStageKey: stageKey,
      name: task.crmMeta?.stageName || titleFromCode(stageKey),
      id: task.crmMeta?.stageId || null,
      crmStageId: task.crmMeta?.stageId || null,
      done: false,
      progress: 0
    };
    stages.push(stageEntry);
  }

  let changed = false;
  const routeSeg = task.stage ? (isPlainObject(task.route) ? task.route[stageKey] : null) : null;
  const startCandidate = routeSeg?.start || task.startDate;
  const endCandidate = routeSeg?.end || task.endDate;
  const origStartCandidate = routeSeg?.origStart || routeSeg?.originalStart || task.origStartDate;
  const origEndCandidate = routeSeg?.origEnd || routeSeg?.originalEnd || task.origEndDate;
  const doneAtCandidate = routeSeg?.doneAt || task.doneMeta?.when;

  if (assignIfChanged(stageEntry, 'start', startCandidate ? toIsoString(startCandidate) : '')) changed = true;
  if (assignIfChanged(stageEntry, 'end', endCandidate ? toIsoString(endCandidate) : '')) changed = true;
  if (assignIfChanged(stageEntry, 'originalStart', origStartCandidate ? toIsoString(origStartCandidate) : '')) changed = true;
  if (assignIfChanged(stageEntry, 'originalEnd', origEndCandidate ? toIsoString(origEndCandidate) : '')) changed = true;
  if (assignIfChanged(stageEntry, 'doneAt', doneAtCandidate ? toIsoString(doneAtCandidate) : '')) changed = true;

  const hours = Number.isFinite(Number(task.hours)) ? Number(task.hours) : Number(routeSeg?.hours);
  if (Number.isFinite(hours)) {
    if (assignIfChanged(stageEntry, 'hours', hours)) changed = true;
    if (assignIfChanged(stageEntry, 'value', hours)) changed = true;
  }

  if (assignIfChanged(stageEntry, 'useReserve', Boolean(task.useReserve || routeSeg?.useReserve))) changed = true;

  const progress = clampProgressValue(task.progress != null ? task.progress : stageEntry.progress);
  if (assignIfChanged(stageEntry, 'progress', progress)) changed = true;

  const isDone = progress >= 100 || Boolean(task.doneMeta?.when) || Boolean(task.done) || Boolean(routeSeg?.done);
  if (assignIfChanged(stageEntry, 'done', isDone)) changed = true;

  if (task.crmMeta && task.crmMeta.stageId && assignIfChanged(stageEntry, 'crmStageId', task.crmMeta.stageId)) changed = true;
  if (task.crmMeta && task.crmMeta.stageName && assignIfChanged(stageEntry, 'name', task.crmMeta.stageName)) changed = true;

  return changed;
}

function syncCrmOrderReference(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return;
  }
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    target[key] = Array.isArray(value) || isPlainObject(value) ? cloneJson(value) : value;
  }
}

async function savePlannerDerivedState(client, snapshot, {
  tasks = [],
  done = [],
  resolveOrderKey = null,
  orderIdMap = null
} = {}) {
  const runner = client || pool;
  const resolver = typeof resolveOrderKey === 'function' ? resolveOrderKey : createOrderKeyResolver();
  const orderMap = orderIdMap instanceof Map ? orderIdMap : new Map();

  await runner.query('DELETE FROM crm_boards');
  await runner.query('DELETE FROM crm_orders_meta');
  await runner.query('DELETE FROM planner_tasks_payload');
  await runner.query('DELETE FROM planner_stage_orders');
  await runner.query('DELETE FROM planner_misc_state WHERE key = $1', ['base']);

  const boards = Array.isArray(snapshot?.crm?.boards) ? snapshot.crm.boards : [];
  const boardInsertSql = `
    INSERT INTO crm_boards (id, name, lanes, position, payload, updated_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
  `;
  const boardMap = new Map();

  for (let index = 0; index < boards.length; index += 1) {
    const boardRaw = boards[index];
    if (!isPlainObject(boardRaw)) continue;
    const boardId = sanitizeString(boardRaw.id) || `crm-board-${index + 1}`;
    const boardName = sanitizeString(boardRaw.name) || `Доска ${index + 1}`;
    const lanes = Array.isArray(boardRaw.lanes)
      ? boardRaw.lanes.map((lane) => sanitizeString(lane) || '').filter(Boolean)
      : [];
    const payload = cloneJson(boardRaw) || {};
    payload.id = boardId;
    payload.name = boardName;
    payload.lanes = lanes.slice();
    payload.orders = [];

    // eslint-disable-next-line no-await-in-loop
    await runner.query(boardInsertSql, [boardId, boardName, lanes, index, JSON.stringify(payload)]);
    boardMap.set(boardId, { id: boardId, index });
  }

  const ordersByKey = new Map();
  for (const board of boards) {
    if (!isPlainObject(board)) continue;
    const boardId = sanitizeString(board.id) || Array.from(boardMap.keys())[0] || 'crm-board-1';
    const orderList = Array.isArray(board.orders) ? board.orders : [];
    for (let position = 0; position < orderList.length; position += 1) {
      const order = orderList[position];
      if (!isPlainObject(order)) continue;
      const resolution = resolver(order) || {};
      const canonicalKey = resolution.key
        || sanitizeString(order.orderIdentity)
        || sanitizeString(order.id)
        || sanitizeString(order.orderId)
        || sanitizeString(order.orderNo)
        || `${boardId}:${position + 1}`;
      if (!canonicalKey) continue;
      const entry = {
        key: canonicalKey,
        boardId,
        crmOrderId: sanitizeString(order.id)
          || sanitizeString(order.crmOrderId)
          || sanitizeString(order.orderId)
          || null,
        position,
        payload: cloneJson(order),
        sourceRef: order
      };
      if (ordersByKey.has(canonicalKey)) {
        ordersByKey.delete(canonicalKey);
      }
      ordersByKey.set(canonicalKey, entry);
    }
  }

  const orderEntryByKey = new Map();
  for (const entry of ordersByKey.values()) {
    orderEntryByKey.set(entry.key, entry);
  }

  const crmRelevantTasks = [];
  if (Array.isArray(tasks) && tasks.length) {
    crmRelevantTasks.push(...tasks);
  }
  if (Array.isArray(done) && done.length) {
    crmRelevantTasks.push(...done);
  }

  const dirtyOrderKeys = new Set();
  for (const task of crmRelevantTasks) {
    if (!task) continue;
    const resolution = resolver(task) || {};
    const key = resolution.key;
    if (!key) continue;
    const entry = orderEntryByKey.get(key);
    if (!entry || !isPlainObject(entry.payload)) continue;
    if (!updateCrmOrderFromTask(entry.payload, task)) continue;
    dirtyOrderKeys.add(key);
  }

  if (dirtyOrderKeys.size) {
    dirtyOrderKeys.forEach((key) => {
      const entry = orderEntryByKey.get(key);
      if (!entry || !isPlainObject(entry.payload)) return;
      recomputeCrmOrderAggregates(entry.payload);
      if (isPlainObject(entry.sourceRef)) {
        syncCrmOrderReference(entry.sourceRef, entry.payload);
      }
    });
    if (isPlainObject(snapshot.crm)) {
      assignIfChanged(snapshot.crm, 'updatedAt', new Date().toISOString());
    }
  }

  const orderInsertSql = `
    INSERT INTO crm_orders_meta (order_key, order_id, board_id, crm_order_id, position, payload, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
    ON CONFLICT (order_key) DO UPDATE SET
      order_id = EXCLUDED.order_id,
      board_id = EXCLUDED.board_id,
      crm_order_id = EXCLUDED.crm_order_id,
      position = EXCLUDED.position,
      payload = EXCLUDED.payload,
      updated_at = NOW()
  `;
  for (const entry of ordersByKey.values()) {
    const dbOrderId = orderMap.get(entry.key) || null;
    // eslint-disable-next-line no-await-in-loop
    await runner.query(orderInsertSql, [
      entry.key,
      dbOrderId,
      entry.boardId,
      entry.crmOrderId,
      entry.position,
      JSON.stringify(entry.payload)
    ]);
  }

  const taskInsertSql = `
    INSERT INTO planner_tasks_payload (uid, order_key, stage_code, is_done, sort_index, payload, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
  `;
  let sortIndex = 0;
  const seenTaskUids = new Set();
  const storeTask = async (task, isDone) => {
    if (!isPlainObject(task)) return;
    const rawUid = sanitizeString(task.uid);
    const uid = rawUid || `task-${sortIndex + 1}`;
    if (seenTaskUids.has(uid)) {
      return;
    }
    seenTaskUids.add(uid);
    const stageCode = normalizeStage(task.stage);
    const resolution = resolver(task) || {};
    const payload = cloneJson(task);
    // eslint-disable-next-line no-await-in-loop
    await runner.query(taskInsertSql, [
      uid,
      resolution.key || null,
      stageCode,
      Boolean(isDone),
      sortIndex,
      JSON.stringify(payload)
    ]);
    sortIndex += 1;
  };

  for (const task of tasks) {
    // eslint-disable-next-line no-await-in-loop
    await storeTask(task, false);
  }
  for (const task of done) {
    // eslint-disable-next-line no-await-in-loop
    await storeTask(task, true);
  }

  const stageEntries = Array.isArray(snapshot?.orders) ? snapshot.orders : [];
  const stageInsertSql = `
    INSERT INTO planner_stage_orders (stage_code, order_uids, updated_at)
    VALUES ($1,$2,NOW())
  `;
  for (const entry of stageEntries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const stageCode = normalizeStage(entry[0]);
    if (!stageCode) continue;
    const uidList = Array.isArray(entry[1])
      ? entry[1].map((uid) => (uid == null ? null : String(uid))).filter(Boolean)
      : [];
    // eslint-disable-next-line no-await-in-loop
    await runner.query(stageInsertSql, [stageCode, uidList]);
  }

  ensureCrmModeScoped(snapshot, Array.isArray(snapshot.t) ? snapshot.t : tasks);

  const baseState = extractBaseState(snapshot);
  await runner.query(
    `INSERT INTO planner_misc_state (key, payload, updated_at)
      VALUES ('base', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = NOW()` ,
    [JSON.stringify(baseState)]
  );

  const fallbackSnapshot = cloneJson(snapshot) || {};
  await runner.query(
    `INSERT INTO planner_misc_state (key, payload, updated_at)
      VALUES ('full', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = NOW()` ,
    [JSON.stringify(fallbackSnapshot)]
  );
}

async function getLatestRevision() {
  if (cachedSnapshot) {
    const revValue = Number(cachedSnapshot.rev || 0);
    if (Number.isFinite(revValue)) {
      lastRevision = Math.max(lastRevision, revValue);
    }
    return lastRevision;
  }
  const meta = readLatestSnapshotMetadata();
  const metaRev = meta && Number.isFinite(Number(meta.rev)) ? Number(meta.rev) : 0;
  if (Number.isFinite(metaRev) && metaRev > 0) {
    lastRevision = Math.max(lastRevision, metaRev);
    return lastRevision;
  }
  const sqlRecord = readSnapshotFromSql();
  if (sqlRecord && Number.isFinite(Number(sqlRecord.rev))) {
    lastRevision = Math.max(lastRevision, Number(sqlRecord.rev));
    return lastRevision;
  }
  const stored = await readLocalStateFile();
  const revValue = stored && Number.isFinite(Number(stored.rev)) ? Number(stored.rev) : 0;
  if (Number.isFinite(revValue)) {
    lastRevision = Math.max(lastRevision, revValue);
  }
  return lastRevision;
}

async function buildSnapshotFromDatabase(client) {
  const runner = client || pool;
  await ensurePlannerSettingsSchema(runner);

  const baseRow = await queryRowsSafe(runner, 'SELECT payload FROM planner_misc_state WHERE key = $1', ['base']);
  const basePayload = baseRow.rows.length ? parseJsonColumn(baseRow.rows[0].payload, {}) : {};
  const fullRow = await queryRowsSafe(runner, 'SELECT payload FROM planner_misc_state WHERE key = $1', ['full']);
  const fallbackPayload = fullRow.rows.length ? parseJsonColumn(fullRow.rows[0].payload, null) : null;

  const snapshot = buildEmptySnapshot();
  applyBaseSnapshot(snapshot, basePayload);
  if (fallbackPayload) {
    applyFallbackSnapshot(snapshot, fallbackPayload);
  }

  const boardRows = await queryRowsSafe(
    runner,
    'SELECT id, name, lanes, position, payload FROM crm_boards ORDER BY position ASC, id ASC'
  );
  const boards = [];
  const boardMap = new Map();

  for (const row of boardRows.rows) {
    const payload = parseJsonColumn(row.payload, {});
    const board = cloneJson(payload) || {};
    board.id = sanitizeString(row.id) || board.id || `crm-board-${boards.length + 1}`;
    board.name = sanitizeString(row.name) || board.name || 'Список заказов';
    board.lanes = Array.isArray(row.lanes)
      ? row.lanes.map((lane) => (lane == null ? '' : String(lane)))
      : Array.isArray(board.lanes) ? board.lanes : [];
    board.orders = [];
    boards.push(board);
    boardMap.set(board.id, board);
  }

  const orderRows = await queryRowsSafe(
    runner,
    'SELECT order_key, board_id, payload, position FROM crm_orders_meta ORDER BY board_id ASC, position ASC, order_key ASC'
  );
  if (!boards.length && orderRows.rows.length) {
    const fallback = {
      id: 'crm-board-1',
      name: 'Список заказов',
      lanes: [],
      orders: []
    };
    boards.push(fallback);
    boardMap.set(fallback.id, fallback);
    if (!snapshot.crm.currentBoardId) {
      snapshot.crm.currentBoardId = fallback.id;
    }
  }

  for (const row of orderRows.rows) {
    const payload = parseJsonColumn(row.payload, null);
    if (!payload) continue;
    const boardId = sanitizeString(row.board_id)
      || payload.boardId
      || snapshot.crm.currentBoardId
      || (boards[0]?.id ?? null);
    const board = boardMap.get(boardId);
    if (!board) {
      continue;
    }
    board.orders.push(cloneJson(payload));
  }

  if (boards.length) {
    snapshot.crm.boards = boards;
  } else if (!Array.isArray(snapshot.crm?.boards)) {
    snapshot.crm.boards = [];
  }
  if (!snapshot.crm.currentBoardId && snapshot.crm.boards.length) {
    snapshot.crm.currentBoardId = snapshot.crm.boards[0].id;
  }

  const taskRows = await queryRowsSafe(
    runner,
    'SELECT uid, is_done, payload FROM planner_tasks_payload ORDER BY is_done ASC, sort_index ASC, uid ASC'
  );
  const activeTasks = [];
  const doneTasks = [];
  for (const row of taskRows.rows) {
    const payload = parseJsonColumn(row.payload, null);
    if (!payload) continue;
    if (row.is_done) {
      doneTasks.push(payload);
    } else {
      activeTasks.push(payload);
    }
  }

  snapshot.t = activeTasks;
  snapshot.done = doneTasks;

  const stageRows = await queryRowsSafe(
    runner,
    'SELECT stage_code, order_uids FROM planner_stage_orders ORDER BY stage_code ASC'
  );
  if (stageRows.rows.length) {
    snapshot.orders = stageRows.rows.map((row) => [row.stage_code, Array.isArray(row.order_uids) ? row.order_uids : []]);
  } else if (!Array.isArray(snapshot.orders)) {
    snapshot.orders = [];
  }

  mergeCrmTasksIntoSnapshot(snapshot);

  return snapshot;
}

async function queryRowsSafe(runner, sql, params = []) {
  const executor = runner && typeof runner.query === 'function' ? runner : pool;
  try {
    return await executor.query(sql, params);
  } catch (err) {
    if (err && (err.code === PG_UNDEFINED_TABLE || err.code === PG_UNDEFINED_COLUMN)) {
      return { rows: [] };
    }
    throw err;
  }
}

function classifyWriteChannel({ channel = null, source = null } = {}) {
  const explicit = normalizeChannelValue(channel);
  if (explicit) {
    return explicit;
  }
  const derived = normalizeChannelValue(source);
  if (derived) {
    return derived;
  }
  return WRITE_CHANNELS.PLANNER;
}

function isWriteChannelAllowed(writeMode, channel) {
  const normalizedMode = normalizeWriteMode(writeMode);
  const normalizedChannel = channel ? channel : WRITE_CHANNELS.PLANNER;
  if (normalizedChannel === WRITE_CHANNELS.SYSTEM || normalizedChannel === WRITE_CHANNELS.ADMIN) {
    return true;
  }
  if (normalizedMode === WRITE_MODES.BOTH) {
    return true;
  }
  if (normalizedMode === WRITE_MODES.CRM) {
    return normalizedChannel === WRITE_CHANNELS.CRM;
  }
  if (normalizedMode === WRITE_MODES.PLANNER) {
    return normalizedChannel === WRITE_CHANNELS.PLANNER;
  }
  return true;
}

function buildEmptyModeScopedSnapshot() {
  return {
    exceptions: [],
    reserves: [],
    routeOverrides: [],
    orders: [],
    locked: [],
    ignored: [],
    stageFilters: {},
    stageTasks: [],
    done: [],
    trash: [],
    lastRows: null,
    csvFreshness: '',
    manualFreshness: '',
    lastImportTime: '',
    lastManualTime: ''
  };
}

function cloneModeScopedArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const cloned = cloneJson(value);
  return Array.isArray(cloned) ? cloned : [];
}

function sanitizeModeStageFilters(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const normalized = {};
  for (const [stage, filter] of Object.entries(value)) {
    const stageKey = sanitizeString(stage);
    if (!stageKey) continue;
    if (filter === null || filter === undefined) {
      normalized[stageKey] = '';
      continue;
    }
    normalized[stageKey] = typeof filter === 'string' ? filter : String(filter);
  }
  return normalized;
}

function ensureModeScopedState(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }
  if (!isPlainObject(snapshot.modeScoped)) {
    snapshot.modeScoped = {};
  }
  const sourceMap = snapshot.modeScoped;
  const normalized = {};
  for (const key of MODE_SCOPED_KEYS) {
    const source = sourceMap[key];
    const target = buildEmptyModeScopedSnapshot();
    if (source && typeof source === 'object') {
      target.exceptions = cloneModeScopedArray(source.exceptions);
      target.reserves = cloneModeScopedArray(source.reserves);
      target.routeOverrides = cloneModeScopedArray(source.routeOverrides);
      target.orders = cloneModeScopedArray(source.orders);
      target.locked = cloneModeScopedArray(source.locked);
      target.ignored = cloneModeScopedArray(source.ignored);
      target.stageFilters = sanitizeModeStageFilters(source.stageFilters);
      target.stageTasks = cloneModeScopedArray(source.stageTasks);
      target.done = cloneModeScopedArray(source.done);
      target.trash = cloneModeScopedArray(source.trash);
      if (Array.isArray(source.lastRows) || isPlainObject(source.lastRows)) {
        const cloned = cloneJson(source.lastRows);
        if (Array.isArray(cloned) || isPlainObject(cloned)) {
          target.lastRows = cloned;
        }
      }
      if (typeof source.csvFreshness === 'string') {
        target.csvFreshness = source.csvFreshness;
      }
      if (typeof source.manualFreshness === 'string') {
        target.manualFreshness = source.manualFreshness;
      }
      if (typeof source.lastImportTime === 'string') {
        target.lastImportTime = source.lastImportTime;
      }
      if (typeof source.lastManualTime === 'string') {
        target.lastManualTime = source.lastManualTime;
      }
    }
    normalized[key] = target;
  }
  for (const [extraKey, value] of Object.entries(sourceMap)) {
    if (!MODE_SCOPED_KEYS.includes(extraKey)) {
      normalized[extraKey] = cloneJson(value);
    }
  }
  snapshot.modeScoped = normalized;
}

function ensureLocalStorageMetadata(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }
  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }
  if (!isPlainObject(snapshot.meta.storage)) {
    snapshot.meta.storage = {};
  }
  snapshot.meta.storage.local = true;
  snapshot.meta.storage.remote = true;
  snapshot.meta.storage.remotePreferred = true;
  snapshot.meta.storage.mode = 'hybrid';
}

function buildEmptySnapshot() {
  const snapshot = {
    routeOverrides: [],
    t: [],
    done: [],
    trash: [],
    exc: [],
    res: [],
    process: 'bend',
    capByProc: {},
    parallelByProc: {},
    filter: '',
    locked: [],
    orders: [],
    freshness: '',
    freshnessCsv: '',
    freshnessManual: '',
    lastImportTime: '',
    lastManualTime: '',
    autosaveOn: true,
    autoOptimizeOn: true,
    cascadeReadyOn: true,
    priorityChangeLoggingOn: false,
    routeDateChangeLoggingOn: false,
    notificationsMuted: false,
    crm: { boards: [], currentBoardId: null },
    shiftOnProgress: true,
    ignoredStates: [],
    meta: {
      versions: {},
      lastAuthors: {},
      csvTimestamp: '',
      manualTimestamp: '',
      history: [],
      settings: {
        capacity: {},
        parallel: {},
        tableColumns: {},
        extraTime: { percent: DEFAULT_EXTRA_PERCENT, minimum: DEFAULT_EXTRA_MINIMUM },
        crmStageMapping: {},
        logLimit: 50,
        admin: { allowForceOverwrite: false, writeMode: DEFAULT_WRITE_MODE },
        updatedAt: ''
      },
      ignoredStates: [],
      storage: { local: true, remote: false, remotePreferred: false, mode: 'local' }
    },
    modeScoped: {}
  };
  ensureModeScopedState(snapshot);
  ensureLocalStorageMetadata(snapshot);
  return snapshot;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS planner_schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureHistoryTrigger(client, tableName) {
  const triggerName = `${tableName}_history_trg`;
  const tableReg = `public.${tableName}`;
  try {
    const { rows } = await client.query(
      'SELECT 1 FROM pg_trigger WHERE tgname = $1 AND tgrelid = to_regclass($2)',
      [triggerName, tableReg]
    );
    if (rows.length) {
      return;
    }
    const { rows: fnRows } = await client.query(
      "SELECT to_regprocedure('generic_history_trigger()') AS proc"
    );
    if (!fnRows.length || !fnRows[0].proc) {
      return;
    }
    await client.query(`
      CREATE TRIGGER ${triggerName}
        AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION generic_history_trigger()
    `);
  } catch (err) {
    console.warn(`Failed to ensure history trigger for ${tableName}`, err);
  }
}

async function ensurePlannerSettingsSchema() {
  if (settingsSchemaEnsured) {
    return;
  }
  settingsSchemaEnsured = true;
}


function readMigrations() {
  return [];
}

async function runMigrations() {
  try {
    getDatabase();
    console.log(`SQLite storage ready at ${SQLITE_FILE}`);
  } catch (err) {
    console.error('Failed to initialize sqlite storage', err);
    throw err;
  }
}

async function loadRevisionColumnInfo(runner) {
  if (revisionColumnInfo) {
    return revisionColumnInfo;
  }
  const client = runner || pool;
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

async function ensureMigrationRevision(client) {
  const { rows: regRows } = await client.query("SELECT to_regclass('public.revisions') AS oid");
  if (!regRows.length || regRows[0].oid === null) {
    return;
  }

  await loadRevisionColumnInfo(client);

  let rev = null;
  const { rows: maxRows } = await client.query('SELECT MAX(rev) AS rev FROM revisions');
  if (maxRows.length && maxRows[0].rev !== null) {
    const candidate = Number(maxRows[0].rev);
    if (Number.isFinite(candidate) && candidate > 0) {
      rev = candidate;
    }
  }

  if (rev === null) {
    let nextRev = null;
    const { rows: seqRows } = await client.query("SELECT to_regclass('public.revisions_rev_seq') AS oid");
    if (seqRows.length && seqRows[0].oid !== null) {
      const { rows: nextRows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
      if (nextRows.length && nextRows[0].rev !== null) {
        nextRev = Number(nextRows[0].rev);
      }
    }
    if (!Number.isFinite(nextRev) || nextRev <= 0) {
      nextRev = 1;
    }
    rev = nextRev;
    await insertRevisionRow(
      client,
      rev,
      'system',
      'migration-bootstrap',
      'auto-generated revision for pending migrations'
    );
  }

  lastRevision = Math.max(lastRevision, rev);
  await client.query('SELECT set_config($1, $2, true)', ['app.rev', String(rev)]);
}

async function loadLatestSnapshot() {
  const fromSql = readSnapshotFromSql();
  if (fromSql) {
    try {
      const currentFile = await readLocalStateFile();
      const fileRev = Number.isFinite(Number(currentFile?.rev)) ? Number(currentFile.rev) : 0;
      const fileHash = currentFile?.hash || null;
      if (fileRev !== fromSql.rev || fileHash !== fromSql.hash) {
        await writeLocalStateFile({
          rev: fromSql.rev,
          snapshot: fromSql.snapshot,
          stateString: fromSql.stateString,
          hash: fromSql.hash,
          meta: fromSql.meta,
          savedAt: fromSql.savedAt || new Date().toISOString(),
          savedBy: fromSql.savedBy || null
        });
      }
    } catch (err) {
      console.warn('Failed to synchronize local snapshot file from sqlite', err);
    }
    return fromSql;
  }

  const stored = await readLocalStateFile();
  if (stored && typeof stored === 'object') {
    let snapshotObj = stored.snapshot;
    if (!isPlainObject(snapshotObj)) {
      snapshotObj = buildEmptySnapshot();
    }
    normalizeExtraTimeSettings(snapshotObj);
    normalizeSnapshotCollections(snapshotObj);
    ensureModeScopedState(snapshotObj);
    ensureLocalStorageMetadata(snapshotObj);
    const stateString = safeSerializeSnapshot(snapshotObj);
    const hash = computeSnapshotHash(stateString);
    const rev = Number.isFinite(Number(stored.rev)) ? Number(stored.rev) : 0;
    const record = {
      rev,
      snapshot: snapshotObj,
      stateString,
      hash,
      meta: stored.meta && typeof stored.meta === 'object' ? stored.meta : null,
      savedAt: stored.savedAt || new Date().toISOString(),
      savedBy: isPlainObject(stored.savedBy) ? stored.savedBy : null
    };
    try {
      writeSnapshotToSql(record);
    } catch (err) {
      console.warn('Failed to hydrate sqlite from existing local snapshot file', err);
    }
    return record;
  }
  const empty = buildEmptySnapshot();
  const stateString = JSON.stringify(empty);
  const hash = computeSnapshotHash(stateString);
  return { rev: 0, snapshot: empty, stateString, hash, meta: null };
}

async function getCachedSnapshot() {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const latest = await loadLatestSnapshot();
  if (latest) {
    lastRevision = Math.max(lastRevision, latest.rev);
    cachedSnapshot = latest;
    return cachedSnapshot;
  }
  const empty = buildEmptySnapshot();
  const stateString = JSON.stringify(empty);
  const hash = computeSnapshotHash(stateString);
  cachedSnapshot = { rev: 0, snapshot: empty, stateString, hash, meta: null };
  return cachedSnapshot;
}

function invalidateCache() {
  cachedSnapshot = null;
}

function broadcastRevision(event) {
  const payload = JSON.stringify({ type: 'revision', ...event });
  sseClients.forEach((client) => {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.warn('Failed to push SSE event', err);
    }
  });
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
      const trimmed = value.trim();
      copy[key] = trimmed;
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
        /* ignore unserializable values */
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

function computeEtag(hash) {
  const normalized = hash ? String(hash).trim() : '';
  if (!normalized) return null;
  return normalized.startsWith('W/') ? normalized : `W/"${normalized}"`;
}

function normalizeRequestMeta(rawMeta) {
  const response = {
    actor: null,
    source: null,
    note: null,
    summary: null,
    channel: null,
    meta: null,
    concurrency: {
      baseHash: null,
      baseEtag: null,
      forceOverwrite: false
    }
  };
  if (!isPlainObject(rawMeta)) {
    return response;
  }

  const working = { ...rawMeta };

  if (working.forceOverwrite === true || working.force === true) {
    response.concurrency.forceOverwrite = true;
  }

  if (typeof working.baseHash === 'string') {
    const trimmed = working.baseHash.trim();
    if (trimmed) {
      response.concurrency.baseHash = trimmed;
    }
  }
  if (typeof working.baseEtag === 'string') {
    const trimmed = working.baseEtag.trim();
    if (trimmed) {
      response.concurrency.baseEtag = trimmed;
    }
  }

  delete working.baseHash;
  delete working.baseEtag;
  delete working.forceOverwrite;
  delete working.force;
  delete working.ifMatch;
  const channel = sanitizeString(working.channel);
  delete working.channel;

  const actor = sanitizeString(working.actor || working.user || working.username || working.owner);
  const source = sanitizeString(working.source || working.changeType || working.stage || working.reason);
  const note = sanitizeString(working.note || working.comment);
  const summary = sanitizeString(working.summary || working.description || working.message);

  if (actor) {
    response.actor = actor;
    working.actor = actor;
  }
  if (source) {
    response.source = source;
    working.source = source;
  }
  if (note) {
    response.note = note;
    working.note = note;
  } else {
    delete working.note;
  }
  if (summary) {
    response.summary = summary;
    working.summary = summary;
  } else {
    delete working.summary;
  }

  if (channel) {
    response.channel = channel;
    working.channel = channel;
  }

  response.meta = sanitizeMetaForStorage(working);
  return response;
}

function extractSnapshotPayload(body) {
  if (body === null || body === undefined) {
    throw new Error('Empty payload');
  }

  let stateSource = body;
  let meta = null;

  if (Buffer.isBuffer(body)) {
    stateSource = body.toString('utf8');
  }

  if (typeof stateSource === 'string') {
    const trimmed = stateSource.trim();
    if (!trimmed) {
      throw new Error('Snapshot payload is empty');
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        snapshot: parsed,
        stateString: JSON.stringify(parsed),
        requestMeta: null
      };
    } catch (err) {
      throw new Error('Snapshot payload must be valid JSON');
    }
  }

  if (isPlainObject(stateSource) && Object.prototype.hasOwnProperty.call(stateSource, 'state')) {
    stateSource = stateSource.state;
  }

  if (isPlainObject(body) && body.meta !== undefined) {
    meta = body.meta;
  }

  if (typeof stateSource === 'string') {
    const trimmed = stateSource.trim();
    if (!trimmed) {
      throw new Error('Snapshot payload is empty');
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        snapshot: parsed,
        stateString: JSON.stringify(parsed),
        requestMeta: meta
      };
    } catch (err) {
      throw new Error('Snapshot payload must be valid JSON');
    }
  }

  if (isPlainObject(stateSource)) {
    return {
      snapshot: stateSource,
      stateString: JSON.stringify(stateSource),
      requestMeta: meta
    };
  }

  throw new Error('Unsupported snapshot payload');
}

function safeSerializeSnapshot(snapshot, stateString = null) {
  if (typeof stateString === 'string') {
    const trimmed = stateString.trim();
    if (trimmed) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch (err) {
        console.warn('Failed to validate provided snapshot string, will re-stringify object', err);
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
      console.warn('Snapshot string payload is invalid JSON, returning empty snapshot', err);
      return '{}';
    }
  }

  try {
    return JSON.stringify(snapshot ?? {});
  } catch (err) {
    console.error('Failed to serialize snapshot payload, falling back to empty object', err);
    return '{}';
  }
}

function normalizeExtraTimeSettings(snapshot, override = null) {
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
  const overridePercent = override && Number.isFinite(override.percent)
    ? override.percent
    : null;
  const overrideMinimum = override && Number.isFinite(override.minimum)
    ? override.minimum
    : null;

  const percentSource = overridePercent !== null
    ? overridePercent
    : Number(extra.percent);
  const minimumSource = overrideMinimum !== null
    ? overrideMinimum
    : Number(extra.minimum);

  const normalizedPercent = Number.isFinite(percentSource)
    ? Math.max(0, Math.round(percentSource * 100) / 100)
    : DEFAULT_EXTRA_PERCENT;
  const normalizedMinimum = Number.isFinite(minimumSource)
    ? Math.max(0, Math.round(minimumSource * 100) / 100)
    : DEFAULT_EXTRA_MINIMUM;

  extra.percent = normalizedPercent;
  extra.minimum = normalizedMinimum;
  if (override && override.enabled !== null) {
    extra.enabled = Boolean(override.enabled);
  } else if (typeof extra.enabled !== 'boolean') {
    extra.enabled = normalizedPercent > 0 || normalizedMinimum > 0;
  }
}

function validateSnapshotStructure(snapshot) {
  const missing = [];
  if (!Array.isArray(snapshot?.t)) missing.push('tasks');
  if (!Array.isArray(snapshot?.done)) missing.push('done');
  if (!Array.isArray(snapshot?.trash)) missing.push('trash');
  if (!Array.isArray(snapshot?.orders)) missing.push('orders');
  return { ok: missing.length === 0, missing };
}

function normalizeSnapshotCollections(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }

  const ensureArray = (key) => {
    if (!Array.isArray(snapshot[key])) {
      snapshot[key] = [];
    }
  };

  ensureArray('t');
  ensureArray('done');
  ensureArray('trash');
  ensureArray('exc');
  ensureArray('res');
  ensureArray('routeOverrides');
  ensureArray('orders');
  ensureArray('locked');
  ensureArray('ignoredStates');

  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }
  if (!Array.isArray(snapshot.meta.history)) {
    snapshot.meta.history = [];
  }
  if (!isPlainObject(snapshot.meta.versions)) {
    snapshot.meta.versions = {};
  }
  if (!isPlainObject(snapshot.meta.settings)) {
    snapshot.meta.settings = {};
  }

  if (!isPlainObject(snapshot.crm)) {
    snapshot.crm = { boards: [], currentBoardId: null };
  }
  ensureCrmBoardsStructure(snapshot.crm);
}

async function runWithRevision(actor, source, note, handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query("SELECT nextval('revisions_rev_seq') AS rev");
    const rev = Number(rows[0]?.rev || 0);
    if (!Number.isFinite(rev) || rev <= 0) {
      throw new Error('Failed to allocate revision number');
    }
    await insertRevisionRow(client, rev, actor || null, source || null, note || null);
    await client.query('SELECT set_config($1,$2,false)', ['app.rev', String(rev)]);
    const result = await handler(client, rev);
    await client.query('COMMIT');
    lastRevision = Math.max(lastRevision, rev);
    return { rev, result };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SAVE_LOG_PREFIX = '[SaveService]';

function logSaveEvent(level, message, context = {}) {
  if (level !== 'warn' && level !== 'error') {
    return;
  }
  const payload = { ...context };
  const log = level === 'error' ? console.error : console.warn;
  log(`${SAVE_LOG_PREFIX} ${message}`, payload);
}

async function persistSnapshotWithSql(options) {
  const {
    actor,
    source,
    note,
    snapshot,
    stateString = null,
    hash = null,
    meta = null,
    channel = null
  } = options || {};

  let parsedSnapshot = null;
  if (isPlainObject(snapshot)) {
    try {
      parsedSnapshot = JSON.parse(JSON.stringify(snapshot));
    } catch (_err) {
      parsedSnapshot = { ...snapshot };
    }
  } else if (typeof stateString === 'string') {
    const trimmed = stateString.trim();
    if (trimmed) {
      try {
        parsedSnapshot = JSON.parse(trimmed);
      } catch (_err) {
        parsedSnapshot = {};
      }
    } else {
      parsedSnapshot = {};
    }
  } else if (typeof snapshot === 'string') {
    const trimmed = snapshot.trim();
    if (trimmed) {
      try {
        parsedSnapshot = JSON.parse(trimmed);
      } catch (_err) {
        parsedSnapshot = {};
      }
    } else {
      parsedSnapshot = {};
    }
  }

  if (!isPlainObject(parsedSnapshot)) {
    parsedSnapshot = {};
  }

  normalizeExtraTimeSettings(parsedSnapshot);
  normalizeSnapshotCollections(parsedSnapshot);
  ensureModeScopedState(parsedSnapshot);
  ensureLocalStorageMetadata(parsedSnapshot);

  mergeCrmTasksIntoSnapshot(parsedSnapshot);

  const storedMeta = sanitizeMetaForStorage(meta);

  const serialized = safeSerializeSnapshot(parsedSnapshot);
  const hashBefore = computeSnapshotHash(serialized);
  if (hash && hash !== hashBefore) {
    logSaveEvent('warn', 'provided hash does not match normalized snapshot', { expected: hashBefore, provided: hash });
  }

  await getLatestRevision();
  const nextRev = lastRevision + 1;
  const effectiveHash = hashBefore;

  const record = {
    rev: nextRev,
    snapshot: parsedSnapshot,
    stateString: serialized,
    hash: effectiveHash,
    meta: storedMeta,
    savedAt: new Date().toISOString(),
    savedBy: {
      actor: actor || null,
      source: source || null,
      note: note || null,
      channel: channel || null
    }
  };

  writeSnapshotToSql(record);
  await writeLocalStateFile(record);

  cachedSnapshot = {
    rev: nextRev,
    snapshot: parsedSnapshot,
    stateString: serialized,
    hash: effectiveHash,
    meta: storedMeta,
    savedAt: record.savedAt,
    savedBy: record.savedBy
  };
  lastRevision = nextRev;

  return cachedSnapshot;
}

function parseInteger(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function resetOrdersTableInfo() {
  ordersTableInfo = null;
}

async function getOrdersTableInfo(client, { forceReload = false } = {}) {
  if (!forceReload && ordersTableInfo) {
    return ordersTableInfo;
  }

  const { rows } = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
  `);

  const columnSet = new Set(rows.map((row) => row.column_name));
  ordersTableInfo = {
    columns: columnSet,
    has(column) {
      return columnSet.has(column);
    }
  };

  return ordersTableInfo;
}

function parseBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (Buffer.isBuffer(value) || value instanceof Buffer) {
    if (!value.length) return fallback;
    try {
      return JSON.parse(value.toString('utf8'));
    } catch (_err) {
      return fallback;
    }
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return fallback;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      return fallback;
    }
  }
  const text = String(value).trim();
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
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

async function syncSharedPreferences() {
  // no-op: shared preferences stored within snapshot
}

async function loadSharedPreferences(runner) {
  return null;
}

async function getCurrentWriteMode(runner) {
  return DEFAULT_WRITE_MODE;
}

function applySharedPreferencesToSnapshot(snapshot, prefMap) {
  if (!isPlainObject(snapshot) || !(prefMap instanceof Map) || prefMap.size === 0) {
    return;
  }
  for (const key of SHARED_BOOLEAN_PREF_KEYS) {
    if (prefMap.has(key)) {
      snapshot[key] = Boolean(prefMap.get(key));
    }
  }
}

async function loadAutoweightSettings() {
  return null;
}

function valuesEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!valuesEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!valuesEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function diffSnapshotValue(current, next) {
  if (valuesEqual(current, next)) {
    return undefined;
  }
  if (Array.isArray(current) && Array.isArray(next)) {
    return next;
  }
  if (isPlainObject(current) && isPlainObject(next)) {
    const diff = {};
    const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
    for (const key of keys) {
      const delta = diffSnapshotValue(
        current ? current[key] : undefined,
        next ? next[key] : undefined
      );
      if (delta !== undefined) {
        diff[key] = delta;
      }
    }
    return Object.keys(diff).length ? diff : undefined;
  }
  if (next === undefined) {
    return null;
  }
  return next;
}

function buildSnapshotDiff(current, next) {
  const delta = diffSnapshotValue(current || {}, next || {});
  if (delta === undefined || delta === null) {
    return null;
  }
  if (isPlainObject(delta) && !Object.keys(delta).length) {
    return null;
  }
  return delta;
}

async function ensureSqlHydrated() {
  const snapshot = await getCachedSnapshot();
  if (!snapshot || !isPlainObject(snapshot.snapshot)) {
    return;
  }
  try {
    writeSnapshotToSql({
      rev: Number(snapshot.rev) || lastRevision || 0,
      snapshot: snapshot.snapshot,
      stateString: snapshot.stateString,
      hash: snapshot.hash,
      meta: snapshot.meta || null,
      savedAt: snapshot.savedAt || new Date().toISOString(),
      savedBy: snapshot.savedBy || null
    });
  } catch (err) {
    console.warn('Failed to ensure sqlite hydration from cached snapshot', err);
  }
}

function createOrderKeyResolver() {
  const aliasToCanonical = new Map();
  const canonicalToAliases = new Map();
  let fallbackCounter = 0;

  const registerAlias = (alias, canonical) => {
    if (!alias) return;
    aliasToCanonical.set(alias, canonical);
    if (!canonicalToAliases.has(canonical)) {
      canonicalToAliases.set(canonical, new Set());
    }
    canonicalToAliases.get(canonical).add(alias);
  };

  const mergeCanonicals = (source, target) => {
    if (!source || !target || source === target) return;
    const aliases = canonicalToAliases.get(source);
    if (aliases) {
      aliases.forEach((alias) => {
        aliasToCanonical.set(alias, target);
        if (!canonicalToAliases.has(target)) {
          canonicalToAliases.set(target, new Set());
        }
        canonicalToAliases.get(target).add(alias);
      });
      canonicalToAliases.delete(source);
    }
    registerAlias(source, target);
  };

  return (task) => {
    if (!task || typeof task !== 'object') {
      return { key: null, merged: [] };
    }

    const identity = sanitizeString(task.orderIdentity);
    const crmOrderId = sanitizeString(task.orderId || task.crmOrderId);
    const numberPrimary = sanitizeString(task.orderNumber || task.number || task.orderNo);
    const numberAlt = sanitizeString(task.orderIdNumber || task.orderRef);
    const title = sanitizeString(task.orderTitle || task.title || task.orderName);
    const customer = sanitizeString(task.orderCustomer);
    const uid = sanitizeString(task.uid);

    const aliases = [];
    if (identity) aliases.push(`identity:${identity}`);
    if (crmOrderId) aliases.push(`crm:${crmOrderId}`);
    if (numberPrimary) aliases.push(`number:${numberPrimary}`);
    if (numberAlt && numberAlt !== numberPrimary) aliases.push(`number:${numberAlt}`);
    if (title && customer) aliases.push(`title:${title}::${customer}`);
    if (title) aliases.push(`title:${title}`);
    if (customer) aliases.push(`customer:${customer}`);
    if (uid) aliases.push(`uid:${uid}`);

    let canonical = null;
    const seenCanonicals = new Set();
    for (const alias of aliases) {
      const existing = aliasToCanonical.get(alias);
      if (existing) {
        if (!canonical) {
          canonical = existing;
        }
        seenCanonicals.add(existing);
      }
    }

    if (!canonical) {
      canonical = aliases.find((alias) => !alias.startsWith('uid:')) || aliases[0] || null;
    }

    if (!canonical) {
      fallbackCounter += 1;
      canonical = `generated:${fallbackCounter}`;
    }

    const merged = [];
    seenCanonicals.forEach((seen) => {
      if (seen !== canonical) {
        merged.push(seen);
        mergeCanonicals(seen, canonical);
      }
    });

    aliases.forEach((alias) => registerAlias(alias, canonical));
    registerAlias(canonical, canonical);

    return { key: canonical, merged };
  };
}

function mergeOrderRecords(target, source) {
  if (!target) return source;
  if (!source) return target;

  const toDate = (value) => {
    if (!value) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  if (!target.crmOrderId && source.crmOrderId) target.crmOrderId = source.crmOrderId;
  if (!target.number && source.number) target.number = source.number;
  if (!target.customerName && source.customerName) target.customerName = source.customerName;
  if (!target.status && source.status) target.status = source.status;
  if (!target.title && source.title) target.title = source.title;
  if (target.priority === null || target.priority === undefined) target.priority = source.priority ?? target.priority;
  else if ((source.priority ?? null) !== null && (target.priority ?? null) === null) target.priority = source.priority;

  if (!target.dueDate && source.dueDate) target.dueDate = source.dueDate;

  const createdTarget = toDate(target.createdAt);
  const createdSource = toDate(source.createdAt);
  if (createdTarget && createdSource) {
    target.createdAt = createdTarget < createdSource ? createdTarget : createdSource;
  } else if (!createdTarget && createdSource) {
    target.createdAt = createdSource;
  }

  const updatedTarget = toDate(target.updatedAt);
  const updatedSource = toDate(source.updatedAt);
  if (updatedTarget && updatedSource) {
    target.updatedAt = updatedTarget > updatedSource ? updatedTarget : updatedSource;
  } else if (!updatedTarget && updatedSource) {
    target.updatedAt = updatedSource;
  }

  if (source.deleted) target.deleted = true;
  const deletedSource = toDate(source.deletedAt);
  const deletedTarget = toDate(target.deletedAt);
  if (deletedSource && (!deletedTarget || deletedSource > deletedTarget)) {
    target.deletedAt = deletedSource;
  }

  return target;
}

async function applySnapshotToSql(client, snapshot) {
  await ensurePlannerSettingsSchema(client);
  const previousWriteMode = await getCurrentWriteMode(client);
  const { tasks } = mergeCrmTasksIntoSnapshot(snapshot);
  ensureCrmModeScoped(snapshot, tasks);

  const done = Array.isArray(snapshot.done) ? snapshot.done : [];
  const trash = Array.isArray(snapshot.trash) ? snapshot.trash : [];

  const resolveOrderKey = createOrderKeyResolver();

  const parallelSet = new Set();
  if (isPlainObject(snapshot.parallelByProc)) {
    Object.keys(snapshot.parallelByProc).forEach((key) => {
      const normalized = normalizeStage(key);
      if (normalized) parallelSet.add(normalized);
    });
  }

  await syncSharedPreferences(client, snapshot);

  const processMap = new Map();
  const ensureProcess = (code) => {
    const normalized = normalizeStage(code);
    if (!normalized) return null;
    if (!processMap.has(normalized)) {
      processMap.set(normalized, {
        code: normalized,
        name: titleFromCode(normalized),
        isParallel: parallelSet.has(normalized),
        id: null
      });
    }
    return processMap.get(normalized);
  };

  tasks.forEach((task) => ensureProcess(task?.stage));
  done.forEach((task) => ensureProcess(task?.stage));
  if (isPlainObject(snapshot.capByProc)) {
    Object.keys(snapshot.capByProc).forEach((code) => ensureProcess(code));
  }
  if (isPlainObject(snapshot.meta?.settings?.capacity)) {
    Object.keys(snapshot.meta.settings.capacity).forEach((code) => ensureProcess(code));
  }
  if (isPlainObject(snapshot.meta?.settings?.crmStageMapping)) {
    Object.values(snapshot.meta.settings.crmStageMapping).forEach((code) => ensureProcess(code));
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

  const processes = Array.from(processMap.values());
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

  const customerMap = new Map();
  const sortedCustomers = Array.from(customerNames.values()).sort();
  for (const name of sortedCustomers) {
    const { rows } = await client.query(
      'INSERT INTO customers (name) VALUES ($1) RETURNING id',
      [name]
    );
    customerMap.set(name, rows[0].id);
  }

  const ordersInfo = await getOrdersTableInfo(client);

  const orderData = new Map();
  const ensureRecord = (key) => {
    if (!key) return null;
    if (orderData.has(key)) {
      return orderData.get(key);
    }
    const record = {
      key,
      crmOrderId: null,
      number: null,
      customerName: null,
      status: null,
      deleted: false,
      deletedAt: null,
      createdAt: null,
      updatedAt: null,
      title: null,
      priority: null,
      dueDate: null
    };
    orderData.set(key, record);
    return record;
  };

  const collectOrderData = (task, options = {}) => {
    if (!task || typeof task !== 'object') return;
    const resolution = resolveOrderKey(task);
    const key = resolution.key;
    if (!key) return;

    if (Array.isArray(resolution.merged) && resolution.merged.length) {
      for (const aliasKey of resolution.merged) {
        if (!aliasKey || aliasKey === key) continue;
        if (!orderData.has(aliasKey)) continue;
        const aliasRecord = orderData.get(aliasKey);
        orderData.delete(aliasKey);
        const target = ensureRecord(key);
        mergeOrderRecords(target, aliasRecord);
      }
    }

    const existing = ensureRecord(key);
    const crmOrderId = sanitizeString(task.orderId);
    if (crmOrderId) existing.crmOrderId = existing.crmOrderId || crmOrderId;
    const number = sanitizeString(task.orderNumber);
    if (number) existing.number = existing.number || number;
    const customerName = sanitizeString(task.orderCustomer);
    if (customerName) existing.customerName = existing.customerName || customerName;
    const title = sanitizeString(
      task.orderTitle
        || task.title
        || task.orderName
        || task.name
        || task.project
    );
    if (title) {
      existing.title = existing.title || title;
    }
    const status = sanitizeString(task.status) || sanitizeString(task.state);
    if (status) existing.status = status;
    const start = parseDate(task.startDate || task.start);
    if (start && !existing.createdAt) existing.createdAt = start;
    const end = parseDate(task.endDate || task.end);
    if (end) existing.updatedAt = end;
    const due = parseDate(task.orderDueDate || task.dueDate || task.deadline);
    if (due && !existing.dueDate) {
      existing.dueDate = due;
    }
    const priority = parseInteger(task.orderPriority ?? task.priority, null);
    if (priority !== null && !Number.isNaN(priority)) {
      existing.priority = existing.priority ?? priority;
    }
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
  let fallbackOrderCounter = 0;
  for (const data of orderData.values()) {
    const customerId = data.customerName ? customerMap.get(data.customerName) || null : null;
    const createdAt = data.createdAt || new Date();
    const updatedAt = data.updatedAt || createdAt;
    let number = data.number || data.crmOrderId || data.title || null;
    if (!number || (typeof number === 'string' && !number.trim())) {
      number = data.key;
    }
    if (!number || (typeof number === 'string' && !number.trim())) {
      fallbackOrderCounter += 1;
      number = `order-${fallbackOrderCounter}`;
    }
    if (typeof number === 'string') {
      const trimmed = number.trim();
      number = trimmed || `order-${fallbackOrderCounter || 1}`;
    }
    const deletedAt = data.deleted ? (data.deletedAt || updatedAt) : null;
    const title = data.title || number;
    const priority = Number.isFinite(data.priority) ? data.priority : null;
    const dueDate = data.dueDate || null;

    const columns = [];
    const values = [];
    const placeholders = [];
    let paramIndex = 1;
    const addColumn = (column, value) => {
      if (!ordersInfo.has(column)) return;
      columns.push(column);
      placeholders.push(`$${paramIndex}`);
      values.push(value === undefined ? null : value);
      paramIndex += 1;
    };

    addColumn('crm_order_id', data.crmOrderId || null);
    addColumn('number', number);
    addColumn('order_no', number);
    addColumn('customer_id', customerId);
    addColumn('status', data.status || null);
    addColumn('title', title || null);
    addColumn('client', data.customerName || null);
    addColumn('priority', priority);
    addColumn('due_date', dueDate);
    addColumn('created_at', createdAt);
    addColumn('updated_at', updatedAt);
    addColumn('deleted_at', deletedAt);
    addColumn('is_deleted', Boolean(data.deleted));

    if (!columns.length) {
      throw new Error('orders table has no known columns for insertion');
    }

    const sql = `INSERT INTO orders (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`;
    const { rows } = await client.query(sql, values);
    orderIdMap.set(data.key, rows[0].id);
  }

  const seqByOrder = new Map();
  const positionByProcess = new Map();
  const insertTask = async (task, options = {}) => {
    if (!task) return;
    const resolution = resolveOrderKey(task);
    const key = resolution.key;
    if (!key) return;
    const orderId = orderIdMap.get(key);
    if (!orderId) return;
    const process = ensureProcess(task.stage);
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
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
    const process = ensureProcess(code);
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
  const percentRaw = Number(extra.percent);
  const minimumRaw = Number(extra.minimum);
  const percentValue = Number.isFinite(percentRaw)
    ? Math.max(0, Math.round(percentRaw * 100) / 100)
    : DEFAULT_EXTRA_PERCENT;
  const minimumValue = Number.isFinite(minimumRaw)
    ? Math.max(0, Math.round(minimumRaw * 100) / 100)
    : DEFAULT_EXTRA_MINIMUM;
  const extraEnabled = typeof extra.enabled === 'boolean'
    ? extra.enabled
    : (percentValue > 0 || minimumValue > 0);
  if (!isPlainObject(settings.extraTime)) {
    settings.extraTime = {};
  }
  settings.extraTime.percent = percentValue;
  settings.extraTime.minimum = minimumValue;
  await client.query(
    `INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
     VALUES (1,$1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           percent = EXCLUDED.percent,
           minimum_hours = EXCLUDED.minimum_hours,
           updated_at = NOW()` ,
    [extraEnabled, percentValue, minimumValue]
  );

  const logLimit = Number(settings.logLimit);
  if (Number.isFinite(logLimit) && logLimit > 0) {
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at)
       VALUES (1,$1,NOW())
       ON CONFLICT (id) DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()` ,
      [Math.round(logLimit)]
    );
  } else {
    await client.query(
      `INSERT INTO settings_journal (id, max_rows, updated_at)
       VALUES (1,$1,NOW())
       ON CONFLICT (id) DO UPDATE SET max_rows = EXCLUDED.max_rows, updated_at = NOW()` ,
      [50]
    );
  }

  if (isPlainObject(settings.tableColumns)) {
    for (const [key, width] of Object.entries(settings.tableColumns)) {
      const columnKey = sanitizeString(key);
      if (!columnKey) continue;
      const widthValue = parseInteger(width, null);
      if (widthValue === null) continue;
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO settings_column_widths (column_key, width_px, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (column_key) DO UPDATE SET width_px = EXCLUDED.width_px, updated_at = NOW()` ,
        [columnKey, widthValue]
      );
    }
  }

  if (isPlainObject(settings.crmStageMapping)) {
    for (const [crmStage, mappedProcess] of Object.entries(settings.crmStageMapping)) {
      const stageKey = sanitizeString(crmStage);
      if (!stageKey) continue;
      const process = ensureProcess(mappedProcess);
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

  const adminSettings = settings.admin || {};
  const allowForce = parseBoolean(adminSettings.allowForceOverwrite, false);
  const writeMode = normalizeWriteMode(adminSettings.writeMode || previousWriteMode);
  await client.query(
    `INSERT INTO settings_admin (id, allow_force_overwrite, write_mode, updated_at)
     VALUES (1,$1,$2,NOW())
     ON CONFLICT (id) DO UPDATE
       SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
           write_mode = EXCLUDED.write_mode,
           updated_at = NOW()` ,
    [
      allowForce,
      writeMode
    ]
  );


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

  return { tasks, done, trash, resolveOrderKey, orderIdMap };
}

app.get('/api/state', async (req, res) => {
  try {
    const snapshot = await getCachedSnapshot();
    const etag = computeEtag(snapshot.hash);
    if (etag) {
      const headerHash = extractHashFromHeader(req.headers['if-none-match']);
      if (headerHash && snapshot.hash && headerHash === snapshot.hash) {
        res.status(304).end();
        return;
      }
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(snapshot.stateString);
  } catch (err) {
    console.error('GET /api/state failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.put('/api/state', async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    const { snapshot, stateString, requestMeta } = extractSnapshotPayload(req.body);
    if (!isPlainObject(snapshot)) {
      res.status(400).json({ error: 'Snapshot must be an object' });
      return;
    }

    const structure = validateSnapshotStructure(snapshot);
    if (!structure.ok) {
      logSaveEvent('warn', 'snapshot missing required sections', { requestId, missing: structure.missing });
      res.status(422).json({ error: 'Unprocessable snapshot', missing: structure.missing });
      return;
    }

    const normalizedMeta = normalizeRequestMeta(requestMeta);
    const hash = computeSnapshotHash(stateString);
    const current = await getCachedSnapshot();
    const currentHash = current?.hash || null;
    const ifMatch = parseIfMatchHeader(req.headers['if-match']);
    const baseHashFromMeta = normalizedMeta.concurrency.baseHash
      || normalizeWeakEtag(normalizedMeta.concurrency.baseEtag || null);
    const expectedHash = normalizedMeta.concurrency.forceOverwrite
      ? null
      : (baseHashFromMeta || (ifMatch.any ? null : ifMatch.hash));

    await ensurePlannerSettingsSchema();
    const channel = classifyWriteChannel({
      channel: normalizedMeta.channel
        || sanitizeString(requestMeta?.channel)
        || sanitizeString(requestMeta?.meta?.channel),
      source: normalizedMeta.source
        || sanitizeString(requestMeta?.source)
        || sanitizeString(requestMeta?.meta?.source)
    });
    const writeMode = await getCurrentWriteMode();
    if (!isWriteChannelAllowed(writeMode, channel)) {
      logSaveEvent('warn', 'write rejected due to mode', { requestId, channel, writeMode });
      res.status(403).json({ error: 'Write mode restriction', channel, writeMode });
      return;
    }

    if (!normalizedMeta.concurrency.forceOverwrite
        && expectedHash
        && currentHash
        && expectedHash !== currentHash) {
      const latestEtag = computeEtag(currentHash);
      logSaveEvent('warn', 'save rejected due to hash mismatch', {
        requestId,
        expectedHash,
        currentHash,
        rev: current?.rev || 0
      });
      if (latestEtag) {
        res.set('ETag', latestEtag);
      }
      res.set('Cache-Control', 'no-store');
      res.status(412).json({
        error: 'Conflict',
        message: 'Snapshot hash mismatch',
        expectedHash: currentHash,
        providedHash: expectedHash,
        currentHash,
        rev: current?.rev || 0,
        etag: latestEtag || null
      });
      return;
    }

    const actor = normalizedMeta.actor || requestMeta?.actor || requestMeta?.user || 'planner-ui';
    const source = normalizedMeta.source || 'planner-ui';
    const note = normalizedMeta.note || null;
    const summary = normalizedMeta.summary || null;
    const storedMeta = sanitizeMetaForStorage({
      ...normalizedMeta.meta,
      actor: actor || undefined,
      source: source || undefined,
      note: note || undefined,
      summary: summary || undefined,
      channel
    });

    logSaveEvent('info', 'save request received', {
      requestId,
      actor,
      source,
      channel,
      expectedHash: expectedHash || null,
      currentHash,
      forceOverwrite: normalizedMeta.concurrency.forceOverwrite
    });

    const latest = await persistSnapshotWithSql({
      actor,
      source,
      note: note || summary,
      snapshot,
      stateString,
      hash,
      meta: storedMeta,
      channel
    });

    const etag = computeEtag(latest.hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');

    cachedSnapshot = latest;

    broadcastRevision({ rev: latest.rev, hash: latest.hash, etag });
    const duration = Date.now() - startedAt;
    logSaveEvent('info', 'save completed', {
      requestId,
      rev: latest.rev,
      hash: latest.hash || null,
      duration
    });
    res.status(200).json({ ok: true, rev: latest.rev, hash: latest.hash, etag, conflict: false });
  } catch (err) {
    if (err && err.message && err.message.includes('Snapshot payload')) {
      res.status(400).json({ error: err.message });
      return;
    }
    logSaveEvent('error', 'save failed', { requestId, error: err?.message || String(err) });
    console.error('PUT /api/state failed error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write('retry: 3000\n\n');

  sseClients.add(res);

  const sendInitial = async () => {
    try {
      const snapshot = await getCachedSnapshot();
      if (snapshot && snapshot.hash) {
        const etag = computeEtag(snapshot.hash);
        const payload = JSON.stringify({ type: 'revision', rev: snapshot.rev, hash: snapshot.hash, etag });
        res.write(`data: ${payload}\n\n`);
      }
    } catch (err) {
      console.warn('Failed to send initial SSE payload', err);
    }
  };

  sendInitial();

  req.on('close', () => {
    sseClients.delete(res);
    try {
      res.end();
    } catch (_err) {
      /* ignore */
    }
  });
});

app.get('/api/admin/history', (req, res) => {
  res.json({ items: [] });
});

app.get('/api/admin/history/:hash', (req, res) => {
  res.status(404).json({ error: 'History disabled' });
});

app.delete('/api/admin/history', (_req, res) => {
  res.status(410).json({ error: 'History storage disabled' });
});

app.post('/api/admin/snapshot', (_req, res) => {
  res.status(410).json({ error: 'Snapshot storage disabled' });
});

app.post('/api/admin/rollback', (_req, res) => {
  res.status(410).json({ error: 'Rollback disabled' });
});


app.use(express.static(PUBLIC_DIR, { index: 'Planner_Codex_v3.html' }));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(PUBLIC_DIR, 'Planner_Codex_v3.html'));
    return;
  }
  next();
});

async function bootstrap() {
  await runMigrations();
  await getLatestRevision();
  await getCachedSnapshot();
  await ensureSqlHydrated();
  app.listen(PORT, () => {
    console.log(`Planner hybrid storage server listening on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
