'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const DEFAULT_DATABASE_URL = 'postgresql://planner:planner@localhost:5432/planner';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const PGSSL = process.env.PGSSLMODE === 'require' || process.env.PGSSL === 'true';
const PGPOOL_MAX = Number.parseInt(process.env.PGPOOL_MAX || '10', 10);
const PGPOOL_IDLE = Number.parseInt(process.env.PGPOOL_IDLE || '30000', 10);

const STAGE_KEYS = ['draw', 'proc', 'shear', 'laser', 'bend', 'weld', 'mech', 'coop', 'pack', 'ship'];
const CRM_STAGE_IGNORE = '__ignore__';
const CRM_TASK_PREFIX = 'crm-task::';

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

const CRM_STAGE_KEYWORDS = new Map([
  ['draw', ['подготов', 'техпод', 'технол', 'чертеж', 'кд', 'пп', 'препроиз', 'конструкт']],
  ['proc', ['закуп', 'снабж', 'покуп', 'комплект', 'поставка', 'материал', 'logist', 'логист']],
  ['shear', ['резк', 'рубк', 'гильот', 'листорез', 'раскро', 'плазм']],
  ['laser', ['лазер', 'laser', 'лаз.']],
  ['bend', ['гибк', 'гибка', 'листогиб', 'пресс', 'press']],
  ['weld', ['свар', 'сб', 'спайк', 'аргон', 'weld']],
  ['mech', ['мех', 'фрез', 'токар', 'расточ', 'зенк', 'сверл', 'шлиф', 'резьб', 'пукл', 'обработ', 'слесар']],
  ['coop', ['кооп', 'покрас', 'цинк', 'анод', 'полимер', 'термо', 'гальв', 'outsourc', 'аутсор', 'окрас']],
  ['pack', ['упаков', 'комплектов', 'тара', 'упак']],
  ['ship', ['отгруз', 'отправ', 'достав', 'экспед', 'самовыв', 'shipment']]
]);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
  max: Number.isFinite(PGPOOL_MAX) && PGPOOL_MAX > 0 ? PGPOOL_MAX : 10,
  idleTimeoutMillis: Number.isFinite(PGPOOL_IDLE) && PGPOOL_IDLE >= 0 ? PGPOOL_IDLE : 30000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error', err);
});

const app = express();
app.use(compression());
app.use(express.json({ limit: '15mb', strict: false }));
app.use(express.text({ limit: '15mb', type: ['text/plain', 'application/json'] }));

const sseClients = new Set();
let cachedSnapshot = null;

function sanitizeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function normalizeStage(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

function isCrmTaskUid(uid) {
  return typeof uid === 'string' && uid.startsWith(CRM_TASK_PREFIX);
}

function collectOrderAliasesForLookup(payload, meta = {}, extras = {}, options = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const metaRecord = meta && typeof meta === 'object' ? meta : {};
  const extra = extras && typeof extras === 'object' ? extras : {};
  const config = options && typeof options === 'object' ? options : {};
  const includePayloadUid = config.includePayloadUid !== false;
  const aliasSet = new Set();

  const addAlias = (prefix, value) => {
    const normalized = sanitizeString(value);
    if (!normalized) {
      return;
    }
    aliasSet.add(`${prefix}:${normalized}`);
  };

  const identityCandidates = [
    source.orderIdentity,
    source.identity,
    source.orderId,
    source.id,
    metaRecord.crmOrderId,
    extra.identity,
    extra.orderId,
    extra.crmOrderId,
    extra.crmDealId,
    extra.crmLeadId,
    source?.crmMeta?.orderIdentity,
    source?.crmMeta?.orderId,
    source?.crmMeta?.crmOrderId,
    source?.crm?.orderId,
    source?.crm?.id,
    source?.crm?.dealId
  ];
  identityCandidates.forEach((value) => addAlias('identity', value));

  const crmCandidates = [
    metaRecord.crmOrderId,
    extra.crmOrderId,
    extra.crmDealId,
    extra.crmLeadId,
    source.crmOrderId,
    source.crm_id,
    source.crmId,
    source?.crm?.id,
    source?.crm?.dealId,
    source?.crmMeta?.crmOrderId,
    source?.crmMeta?.orderId
  ];
  crmCandidates.forEach((value) => addAlias('crm', value));

  const numberCandidates = [
    metaRecord.orderNumber,
    extra.orderNumber,
    extra.number,
    source.orderNumber,
    source.orderNo,
    source.number,
    source.code,
    source.order_code,
    source.documentNumber,
    source?.crmMeta?.orderNumber
  ];
  numberCandidates.forEach((value) => addAlias('number', value));

  const titleCandidates = [
    metaRecord.title,
    extra.title,
    source.orderTitle,
    source.title,
    source.name,
    source.subject,
    source?.crmMeta?.title
  ];
  const customerCandidates = [
    metaRecord.customer,
    extra.customer,
    source.orderCustomer,
    source.customer,
    source.client,
    source.company,
    source.organization,
    source?.crmMeta?.customer
  ];
  const titlePrimary = titleCandidates.find((value) => sanitizeString(value));
  const customerPrimary = customerCandidates.find((value) => sanitizeString(value));
  if (titlePrimary && customerPrimary) {
    addAlias('title', `${sanitizeString(titlePrimary)}::${sanitizeString(customerPrimary)}`);
  }
  titleCandidates.forEach((value) => addAlias('title', value));
  customerCandidates.forEach((value) => addAlias('customer', value));

  const uidCandidates = [extra.uid];
  if (includePayloadUid) {
    uidCandidates.push(source.uid, source.orderUid, source.id, source.orderId);
  }
  uidCandidates.forEach((value) => addAlias('uid', value));

  return Array.from(aliasSet);
}

function computeHash(input) {
  return crypto.createHash('sha1').update(input || '', 'utf8').digest('hex');
}

function computeEtag(hash) {
  if (!hash) return null;
  return `W/"${hash}"`;
}

function clonePlain(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    console.warn('Failed to clone plain value', err);
    return value;
  }
}

function safeJsonStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value ?? {});
  } catch (err) {
    console.warn('Failed to stringify JSON payload, using fallback', err);
    return fallback;
  }
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      return value;
    }
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const text = value.trim();
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function toNullableString(value) {
  const text = sanitizeString(value);
  return text ? text : null;
}

function normalizeNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed
      .replace(/%/g, '')
      .replace(/\s+/g, '')
      .replace(',', '.');
    const match = normalized.match(/[-+]?\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseFloat(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeIsoDate(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return trimmed;
    }
    return parsed.toISOString();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString();
}

function clampProgress(value) {
  const num = normalizeNumber(value);
  if (num === null) {
    return null;
  }
  if (Number.isNaN(num)) {
    return null;
  }
  const limited = Math.max(0, Math.min(100, Math.round(num)));
  return limited;
}

function mapCrmStageName(name, mapping = {}) {
  const label = sanitizeString(name);
  if (!label) {
    return null;
  }
  const normalized = label.toLowerCase();
  if (mapping && typeof mapping === 'object') {
    const customRaw = mapping[normalized];
    if (customRaw === CRM_STAGE_IGNORE) {
      return null;
    }
    if (typeof customRaw === 'string' && STAGE_KEYS.includes(customRaw)) {
      return customRaw;
    }
  }
  let fallback = CRM_STAGE_DEFAULT_MAP.get(normalized) || null;
  if (!fallback) {
    for (const [stage, keywords] of CRM_STAGE_KEYWORDS.entries()) {
      if (keywords.some((keyword) => normalized.includes(keyword))) {
        fallback = stage;
        break;
      }
    }
  }
  if (!fallback) {
    if (normalized.includes('кооп') || normalized.includes('кооперац') || normalized.includes('покрас')) {
      fallback = 'coop';
    } else if (
      normalized.includes('мехобр')
      || normalized.includes('зенк')
      || normalized.includes('сверл')
      || normalized.includes('резьб')
      || normalized.includes('пукл')
      || normalized.includes('заклеп')
    ) {
      fallback = 'mech';
    }
  }
  return fallback;
}

function ensureOrderIdentitySnapshot(order, fallbackIndex = 0) {
  if (!order || typeof order !== 'object') {
    return `order-${fallbackIndex || 1}`;
  }
  const candidates = [
    order.orderIdentity,
    order.identity,
    order.uid,
    order.id,
    order.crmOrderId,
    order.orderId,
    order.orderNumber,
    order.orderNo,
    order.title && order.customer ? `${order.title}::${order.customer}` : null,
    order.title
  ];
  for (const candidate of candidates) {
    const normalized = sanitizeString(candidate);
    if (normalized) {
      if (!order.orderIdentity) {
        order.orderIdentity = normalized;
      }
      return normalized;
    }
  }
  const generated = `order-${fallbackIndex || Math.floor(Math.random() * 100000)}`;
  order.orderIdentity = generated;
  return generated;
}

function buildCrmStageTasksFromSnapshot(snapshot) {
  const boards = snapshot?.crm?.boards;
  if (!Array.isArray(boards) || boards.length === 0) {
    return [];
  }
  const mapping = snapshot?.meta?.settings?.crmStageMapping || {};
  const stageTasks = [];

  boards.forEach((board) => {
    if (!board || typeof board !== 'object') {
      return;
    }
    const boardId = sanitizeString(board.id);
    const laneNames = Array.isArray(board.lanes) ? board.lanes : [];
    const primaryLane = laneNames.length ? sanitizeString(laneNames[0]) : '';
    const orders = Array.isArray(board.orders) ? board.orders : [];

    orders.forEach((order, orderIndex) => {
      if (!order || typeof order !== 'object') {
        return;
      }
      const orderCopy = { ...order };
      const orderIdentity = ensureOrderIdentitySnapshot(orderCopy, orderIndex + 1);
      const orderUid = sanitizeString(orderCopy.uid);
      const orderNumber = sanitizeString(orderCopy.orderNumber) || sanitizeString(orderCopy.orderNo);
      const orderCustomer = sanitizeString(orderCopy.orderCustomer) || sanitizeString(orderCopy.customer);
      let orderId = sanitizeString(orderCopy.orderId);
      if (!orderId) {
        const composed = [orderNumber ? (orderNumber.startsWith('№') ? orderNumber : `№${orderNumber}`) : '', orderCustomer]
          .map((value) => sanitizeString(value))
          .filter(Boolean)
          .join(' ');
        orderId = composed || orderIdentity;
      }
      const lane = sanitizeString(orderCopy.status) || sanitizeString(orderCopy.lane) || primaryLane;
      const parentId = sanitizeString(orderCopy.parentId);
      const crmOrderId = sanitizeString(orderCopy.crmOrderId)
        || sanitizeString(orderCopy.crm_id)
        || sanitizeString(orderCopy.crmId)
        || sanitizeString(orderCopy?.crm?.id);

      const stages = Array.isArray(orderCopy.stages) ? orderCopy.stages : [];
      stages.forEach((stage, stageIndex) => {
        if (!stage || typeof stage !== 'object') {
          return;
        }
        const stageKey = mapCrmStageName(stage.stageKey || stage.stage || stage.name, mapping);
        if (!stageKey) {
          return;
        }
        const hoursRaw = stage.hours !== undefined ? stage.hours : stage.value;
        const hours = normalizeNumber(hoursRaw) || 0;
        const progress = clampProgress(stage.progress);
        const done = stage.done === true || (progress !== null && progress >= 100);
        const startIso = normalizeIsoDate(stage.start);
        const endIso = normalizeIsoDate(stage.end);
        const origStartIso = normalizeIsoDate(stage.originalStart || stage.origStart);
        const origEndIso = normalizeIsoDate(stage.originalEnd || stage.origEnd);
        const doneAtIso = normalizeIsoDate(stage.doneAt);

        const uidSeed = sanitizeString(orderUid || orderIdentity || orderId || `${boardId || 'board'}-${orderIndex + 1}`)
          .replace(/\s+/g, '_');
        const uid = `${CRM_TASK_PREFIX}${uidSeed || `auto-${stageIndex + 1}`}::${stageKey}`;

        const routeSegment = {
          hours,
          start: startIso || null,
          end: endIso || null
        };
        if (origStartIso) {
          routeSegment.origStart = origStartIso;
        }
        if (origEndIso) {
          routeSegment.origEnd = origEndIso;
        }
        if (doneAtIso) {
          routeSegment.doneAt = doneAtIso;
        }
        if (progress !== null) {
          routeSegment.progress = progress;
        }

        const task = {
          uid,
          orderId,
          orderNumber: orderNumber || '',
          orderCustomer: orderCustomer || '',
          orderIdentity,
          stage: stageKey,
          childId: '',
          parentId: parentId || '',
          hours,
          extraHours: 0,
          startDate: startIso || '',
          endDate: endIso || '',
          startMissing: !startIso,
          endMissing: !endIso,
          state: lane || '',
          status: done ? 'Готово (CRM)' : 'CRM',
          useReserve: !!stage.useReserve,
          progress: done ? 100 : (progress ?? 0),
          origStartDate: origStartIso || '',
          origEndDate: origEndIso || '',
          route: { [stageKey]: routeSegment },
          locked: false,
          hiddenByState: false,
          crmMeta: {
            boardId: boardId || '',
            crmOrderId: crmOrderId || '',
            orderId,
            orderIdentity,
            stageKey,
            stageId: sanitizeString(stage.id || stage.stageId || stage.crmStageId) || '',
            stageName: sanitizeString(stage.name || stage.stageName || stage.stageKey) || stageKey,
            lane: lane || ''
          },
          crmOrigin: true
        };

        if (doneAtIso) {
          task.doneMeta = { when: doneAtIso, source: 'crm' };
        }

        stageTasks.push(task);
      });
    });
  });

  return stageTasks;
}

function normalizePercent(value) {
  const num = normalizeNumber(value);
  return num === null ? null : num;
}

function numbersEqual(a, b) {
  const left = normalizeNumber(a);
  const right = normalizeNumber(b);
  if (left === null && right === null) {
    return true;
  }
  if (left === null || right === null) {
    return false;
  }
  return Math.abs(left - right) < 0.0001;
}

function getDeep(record, path) {
  if (!record || typeof record !== 'object') {
    return undefined;
  }
  if (!path) {
    return undefined;
  }
  const parts = Array.isArray(path) ? path : String(path).split('.');
  let current = record;
  for (const rawPart of parts) {
    const part = rawPart && rawPart.toString ? rawPart.toString() : rawPart;
    if (!part) {
      return undefined;
    }
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function pickField(record, keys) {
  if (!Array.isArray(keys)) {
    return null;
  }
  for (const key of keys) {
    const value = getDeep(record, key);
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    return value;
  }
  return null;
}

function extractOrderMetadata(payload) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const meta = {};
  meta.crmOrderId = toNullableString(
    pickField(record, [
      'crmOrderId',
      'crm_id',
      'orderId',
      'order_id',
      'id',
      'uid',
      'identity',
      'orderIdentity',
      'crmMeta.orderId',
      'crmMeta.crmOrderId',
      'crm.orderId',
      'crm.id'
    ])
  );
  meta.orderNumber = toNullableString(
    pickField(record, [
      'orderNumber',
      'number',
      'orderNo',
      'docNumber',
      'documentNumber',
      'code',
      'order_code',
      'crmMeta.orderNumber',
      'crm.orderNumber'
    ])
  );
  meta.title = toNullableString(
    pickField(record, [
      'orderTitle',
      'title',
      'name',
      'subject',
      'orderName',
      'displayTitle',
      'crmMeta.title',
      'crm.title'
    ])
  );
  meta.customer = toNullableString(
    pickField(record, [
      'customer',
      'client',
      'company',
      'organization',
      'customerName',
      'clientName',
      'buyer',
      'companyName',
      'organisation',
      'crmMeta.customer',
      'crm.customer'
    ])
  );
  meta.status = toNullableString(
    pickField(record, [
      'status',
      'state',
      'orderStatus',
      'stage',
      'stageName',
      'stageTitle',
      'crmMeta.status',
      'crm.status'
    ])
  );
  meta.priority = toNullableString(
    pickField(record, ['priority', 'orderPriority', 'importance', 'crmMeta.priority', 'crm.priority'])
  );
  meta.dueDate = toNullableString(
    pickField(record, [
      'dueDate',
      'deadline',
      'finishPlan',
      'finishDatePlan',
      'endDatePlan',
      'expectedDate',
      'due',
      'deadlineDate',
      'crmMeta.dueDate',
      'crm.dueDate'
    ])
  );
  meta.plannedStart = toNullableString(
    pickField(record, [
      'plannedStart',
      'startPlan',
      'startDatePlan',
      'datePlanStart',
      'planStart',
      'plannedStartDate',
      'startPlanned',
      'crmMeta.plannedStart',
      'crm.startPlan'
    ])
  );
  meta.plannedFinish = toNullableString(
    pickField(record, [
      'plannedFinish',
      'finishPlan',
      'finishDatePlan',
      'datePlanFinish',
      'planFinish',
      'plannedFinishDate',
      'finishPlanned',
      'crmMeta.plannedFinish',
      'crm.finishPlan'
    ])
  );
  meta.readyPercent = normalizePercent(
    pickField(record, [
      'readyPercent',
      'progress',
      'ready',
      'completeness',
      'donePercent',
      'percentComplete',
      'completion',
      'crmMeta.progress',
      'crm.progress'
    ])
  );
  meta.manager = toNullableString(
    pickField(record, [
      'manager',
      'responsible',
      'owner',
      'assignee',
      'responsibleName',
      'crmMeta.manager',
      'crm.manager'
    ])
  );
  meta.updatedBy = toNullableString(
    pickField(record, ['updatedBy', 'lastEditor', 'modifiedBy', 'changedBy', 'crmMeta.updatedBy', 'crm.updatedBy'])
  );
  meta.updatedText = toNullableString(
    pickField(record, [
      'updatedAt',
      'modifiedAt',
      'updated',
      'lastUpdate',
      'timestamp',
      'crmMeta.updatedAt',
      'crm.updatedAt'
    ])
  );
  return meta;
}

function extractTaskMetadata(payload) {
  const record = payload && typeof payload === 'object' ? payload : {};
  const meta = {};
  meta.crmOrderId = toNullableString(
    pickField(record, [
      'crmOrderId',
      'orderId',
      'order_id',
      'orderIdentity',
      'identity',
      'id',
      'crmMeta.orderId',
      'crmMeta.crmOrderId',
      'crm.orderId',
      'crm.id',
      'crmStage.orderId'
    ])
  );
  meta.orderNumber = toNullableString(
    pickField(record, [
      'orderNumber',
      'number',
      'orderNo',
      'docNumber',
      'code',
      'order_code',
      'crmMeta.orderNumber',
      'crm.orderNumber'
    ])
  );
  meta.stageName = toNullableString(
    pickField(record, [
      'stageName',
      'stageTitle',
      'stage',
      'name',
      'displayStage',
      'operation',
      'crmMeta.stageName',
      'crmMeta.stageTitle',
      'crmStage.stageName',
      'crmStage.name',
      'crmStage.stageTitle',
      'crmStage.stage'
    ])
  );
  meta.status = toNullableString(
    pickField(record, ['status', 'state', 'taskStatus', 'stageStatus', 'crmMeta.status', 'crmStage.status'])
  );
  meta.priority = toNullableString(
    pickField(record, ['priority', 'taskPriority', 'importance', 'crmMeta.priority', 'crmStage.priority'])
  );
  meta.executor = toNullableString(
    pickField(record, [
      'executor',
      'performer',
      'assignee',
      'worker',
      'responsible',
      'operator',
      'crmMeta.executor',
      'crmStage.executor'
    ])
  );
  meta.plannedStart = toNullableString(
    pickField(record, [
      'planStart',
      'plannedStart',
      'startPlan',
      'startPlanDate',
      'plannedStartDate',
      'planStartDate',
      'startPlanned',
      'crmMeta.plannedStart',
      'crmStage.start',
      'crmStage.plannedStart'
    ])
  );
  meta.plannedFinish = toNullableString(
    pickField(record, [
      'planFinish',
      'plannedFinish',
      'finishPlan',
      'finishPlanDate',
      'plannedFinishDate',
      'planFinishDate',
      'finishPlanned',
      'crmMeta.plannedFinish',
      'crmStage.end',
      'crmStage.plannedFinish'
    ])
  );
  meta.actualStart = toNullableString(
    pickField(record, [
      'factStart',
      'actualStart',
      'startFact',
      'startActual',
      'startedAt',
      'crmMeta.actualStart',
      'crmStage.actualStart'
    ])
  );
  meta.actualFinish = toNullableString(
    pickField(record, [
      'factFinish',
      'actualFinish',
      'finishFact',
      'finishActual',
      'finishedAt',
      'crmMeta.actualFinish',
      'crmStage.actualFinish'
    ])
  );
  meta.dueDate = toNullableString(
    pickField(record, [
      'dueDate',
      'deadline',
      'finishDate',
      'expectedDate',
      'due',
      'deadlineDate',
      'crmMeta.dueDate',
      'crmStage.dueDate'
    ])
  );
  meta.expectedPercent = normalizePercent(
    pickField(record, [
      'expectedPercent',
      'planPercent',
      'targetPercent',
      'plannedPercent',
      'crmMeta.expectedPercent',
      'crmStage.expectedPercent'
    ])
  );
  meta.progressPercent = normalizePercent(
    pickField(record, [
      'progress',
      'readyPercent',
      'donePercent',
      'percentComplete',
      'completion',
      'factPercent',
      'crmMeta.progress',
      'crmStage.progress'
    ])
  );
  return meta;
}

function buildEmptySnapshot() {
  return {
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
        extraTime: { percent: 5, minimum: 0.25 },
        crmStageMapping: {},
        logLimit: 50,
        admin: { allowForceOverwrite: false, writeMode: 'both' },
        updatedAt: ''
      },
      ignoredStates: [],
      storage: { local: false, remote: true, remotePreferred: true, mode: 'remote' }
    },
    modeScoped: {}
  };
}

function normalizeSnapshotCollections(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return buildEmptySnapshot();
  }
  const base = buildEmptySnapshot();
  const output = { ...base, ...snapshot };

  const arrayKeys = ['t', 'done', 'trash', 'exc', 'res', 'orders', 'routeOverrides', 'locked', 'ignoredStates'];
  for (const key of arrayKeys) {
    if (!Array.isArray(output[key])) {
      output[key] = [];
    }
  }

  if (!output.crm || typeof output.crm !== 'object') {
    output.crm = { boards: [], currentBoardId: null };
  }
  if (!Array.isArray(output.crm.boards)) {
    output.crm.boards = [];
  }
  if (!output.meta || typeof output.meta !== 'object') {
    output.meta = buildEmptySnapshot().meta;
  } else if (!output.meta.settings || typeof output.meta.settings !== 'object') {
    output.meta.settings = buildEmptySnapshot().meta.settings;
  }

  return output;
}

function createEmptyModeScopedSnapshot() {
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

function ensureModeScopedConsistency(snapshot, tasks, stageSequences) {
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshot;
  }

  const modeScoped = snapshot.modeScoped && typeof snapshot.modeScoped === 'object'
    ? { ...snapshot.modeScoped }
    : {};
  const existingCrm = modeScoped.crm && typeof modeScoped.crm === 'object'
    ? { ...modeScoped.crm }
    : createEmptyModeScopedSnapshot();

  const normalizedStageSequences = Array.isArray(stageSequences) ? stageSequences : [];
  const stageIdsByStage = new Map();
  const stageOrderIndex = new Map();
  const encounteredStages = new Set();

  normalizedStageSequences.forEach(({ stage, ids }) => {
    const normalizedStage = normalizeStage(stage);
    if (!normalizedStage) {
      return;
    }
    const sanitizedIds = Array.isArray(ids)
      ? ids.map((id) => sanitizeString(id)).filter(Boolean)
      : [];
    stageIdsByStage.set(normalizedStage, sanitizedIds);
    const indexMap = new Map();
    sanitizedIds.forEach((uid, idx) => {
      indexMap.set(uid, idx);
    });
    stageOrderIndex.set(normalizedStage, indexMap);
    encounteredStages.add(normalizedStage);
  });

  const stageTaskMap = new Map();
  (Array.isArray(tasks) ? tasks : []).forEach((task) => {
    if (!task || (task.bucket !== 't' && task.bucket !== 'crm_stage')) {
      return;
    }
    const normalizedStage = normalizeStage(task.stage) || normalizeStage(task?.payload?.stage);
    if (!normalizedStage) {
      return;
    }
    const payload = clonePlain(task.payload) || {};
    const uid = sanitizeString(payload.uid || task.uid);
    if (!uid) {
      return;
    }
    payload.uid = uid;
    if (!payload.stage) {
      payload.stage = normalizedStage;
    }
    encounteredStages.add(normalizedStage);
    if (!stageTaskMap.has(normalizedStage)) {
      stageTaskMap.set(normalizedStage, []);
    }
    stageTaskMap.get(normalizedStage).push(payload);
  });

  if (stageTaskMap.size === 0) {
    const fallback = buildCrmStageTasksFromSnapshot(snapshot);
    if (fallback.length) {
      fallback.forEach((task) => {
        const normalizedStage = normalizeStage(task.stage);
        if (!normalizedStage) {
          return;
        }
        encounteredStages.add(normalizedStage);
        if (!stageTaskMap.has(normalizedStage)) {
          stageTaskMap.set(normalizedStage, []);
        }
        const list = stageTaskMap.get(normalizedStage);
        list.push({ ...task });
      });
    }
  }

  const orderedStages = [];
  STAGE_KEYS.forEach((stage) => {
    if (encounteredStages.has(stage) || stageTaskMap.has(stage)) {
      orderedStages.push(stage);
      encounteredStages.delete(stage);
    }
  });
  Array.from(encounteredStages).sort().forEach((stage) => {
    if (!orderedStages.includes(stage)) {
      orderedStages.push(stage);
    }
  });

  const stageEntries = orderedStages.map((stage) => {
    const tasksForStage = stageTaskMap.get(stage) || [];
    const indexMap = stageOrderIndex.get(stage);
    if (indexMap) {
      tasksForStage.sort((a, b) => {
        const left = indexMap.get(sanitizeString(a.uid)) ?? Number.MAX_SAFE_INTEGER;
        const right = indexMap.get(sanitizeString(b.uid)) ?? Number.MAX_SAFE_INTEGER;
        if (left === right) {
          return sanitizeString(a.uid).localeCompare(sanitizeString(b.uid));
        }
        return left - right;
      });
    } else {
      tasksForStage.sort((a, b) => sanitizeString(a.uid).localeCompare(sanitizeString(b.uid)));
    }
    return [stage, tasksForStage];
  });

  const ordersEntries = stageEntries.map(([stage, list]) => {
    const existingOrder = stageIdsByStage.get(stage);
    if (existingOrder && existingOrder.length) {
      return [stage, existingOrder];
    }
    const derivedOrder = list.map((item) => sanitizeString(item.uid)).filter(Boolean);
    return [stage, derivedOrder];
  });

  existingCrm.stageTasks = stageEntries;
  existingCrm.orders = ordersEntries;

  if (!Array.isArray(existingCrm.exceptions)) existingCrm.exceptions = [];
  if (!Array.isArray(existingCrm.reserves)) existingCrm.reserves = [];
  if (!Array.isArray(existingCrm.routeOverrides)) existingCrm.routeOverrides = [];
  if (!Array.isArray(existingCrm.locked)) {
    existingCrm.locked = Array.isArray(snapshot.locked) ? snapshot.locked.slice() : [];
  }
  if (!Array.isArray(existingCrm.ignored)) existingCrm.ignored = [];
  if (!existingCrm.stageFilters || typeof existingCrm.stageFilters !== 'object') {
    existingCrm.stageFilters = {};
  }
  existingCrm.done = clonePlain(Array.isArray(snapshot.done) ? snapshot.done : existingCrm.done);
  existingCrm.trash = clonePlain(Array.isArray(snapshot.trash) ? snapshot.trash : existingCrm.trash);

  modeScoped.crm = existingCrm;
  snapshot.modeScoped = modeScoped;
  return snapshot;
}

function sanitizeIncomingSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const settings = {};

  if (source.capacity && typeof source.capacity === 'object') {
    const capacity = {};
    Object.entries(source.capacity).forEach(([stage, value]) => {
      const normalizedStage = normalizeStage(stage);
      const num = Number(value);
      if (normalizedStage && Number.isFinite(num)) {
        capacity[normalizedStage] = num;
      }
    });
    if (Object.keys(capacity).length) {
      settings.capacity = capacity;
    }
  }

  if (source.parallel && typeof source.parallel === 'object') {
    const parallel = {};
    Object.entries(source.parallel).forEach(([stage, value]) => {
      const normalizedStage = normalizeStage(stage);
      const num = Number(value);
      if (normalizedStage && Number.isFinite(num) && num > 0) {
        parallel[normalizedStage] = num;
      }
    });
    if (Object.keys(parallel).length) {
      settings.parallel = parallel;
    }
  }

  if (source.tableColumns && typeof source.tableColumns === 'object') {
    const tableColumns = {};
    Object.entries(source.tableColumns).forEach(([key, value]) => {
      const column = sanitizeString(key);
      const num = Number(value);
      if (column && Number.isFinite(num) && num > 0) {
        tableColumns[column] = Math.round(num);
      }
    });
    if (Object.keys(tableColumns).length) {
      settings.tableColumns = tableColumns;
    }
  }

  if (source.extraTime && typeof source.extraTime === 'object') {
    const extra = {};
    const percent = Number(source.extraTime.percent);
    const minimum = Number(source.extraTime.minimum);
    if (Number.isFinite(percent) && percent >= 0) {
      extra.percent = percent;
    }
    if (Number.isFinite(minimum) && minimum >= 0) {
      extra.minimum = minimum;
    }
    if (Object.keys(extra).length) {
      settings.extraTime = extra;
    }
  }

  if (source.crmStageMapping && typeof source.crmStageMapping === 'object') {
    const mapping = {};
    Object.entries(source.crmStageMapping).forEach(([key, value]) => {
      const normalizedKey = sanitizeString(key).toLowerCase();
      if (!normalizedKey) {
        return;
      }
      if (value === CRM_STAGE_IGNORE) {
        mapping[normalizedKey] = CRM_STAGE_IGNORE;
        return;
      }
      const stage = normalizeStage(value);
      if (stage) {
        mapping[normalizedKey] = stage;
      }
    });
    if (Object.keys(mapping).length) {
      settings.crmStageMapping = mapping;
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'logLimit')) {
    if (source.logLimit === null || source.logLimit === undefined || source.logLimit === '') {
      settings.logLimit = null;
    } else {
      const num = Number(source.logLimit);
      if (Number.isFinite(num)) {
        settings.logLimit = num;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(source, 'notificationsMuted')) {
    settings.notificationsMuted = !!source.notificationsMuted;
  }

  if (source.plannerMode !== undefined) {
    const mode = sanitizeString(source.plannerMode);
    if (mode) {
      settings.plannerMode = mode.toLowerCase();
    }
  }

  if (source.admin && typeof source.admin === 'object') {
    const admin = {};
    if (source.admin.historyLimit !== undefined) {
      const limit = Number(source.admin.historyLimit);
      if (Number.isFinite(limit) && limit > 0) {
        admin.historyLimit = Math.round(limit);
      }
    }
    if (source.admin.historyDailyLimit !== undefined) {
      const daily = Number(source.admin.historyDailyLimit);
      if (Number.isFinite(daily) && daily > 0) {
        admin.historyDailyLimit = Math.round(daily);
      }
    }
    if (Object.prototype.hasOwnProperty.call(source.admin, 'allowForceOverwrite')) {
      admin.allowForceOverwrite = source.admin.allowForceOverwrite === true || source.admin.allowForceOverwrite === 'true';
    }
    if (source.admin.writeMode !== undefined) {
      const mode = sanitizeString(source.admin.writeMode).toLowerCase();
      if (['crm', 'planner', 'both'].includes(mode)) {
        admin.writeMode = mode;
      }
    }
    if (Object.keys(admin).length) {
      settings.admin = admin;
    }
  }

  return settings;
}

function applySettingsToSnapshot(snapshot, settings, options = {}) {
  const normalized = normalizeSnapshotCollections(snapshot);
  const metaSettings = normalized.meta && typeof normalized.meta === 'object' && normalized.meta.settings
    ? { ...normalized.meta.settings }
    : buildEmptySnapshot().meta.settings;

  if (settings.capacity) {
    normalized.capByProc = { ...(normalized.capByProc || {}), ...settings.capacity };
    metaSettings.capacity = { ...(metaSettings.capacity || {}), ...settings.capacity };
  }

  if (settings.parallel) {
    normalized.parallelByProc = { ...(normalized.parallelByProc || {}), ...settings.parallel };
    metaSettings.parallel = { ...(metaSettings.parallel || {}), ...settings.parallel };
  }

  if (settings.tableColumns) {
    metaSettings.tableColumns = { ...(metaSettings.tableColumns || {}), ...settings.tableColumns };
  }

  if (settings.extraTime) {
    const baseExtra = metaSettings.extraTime && typeof metaSettings.extraTime === 'object'
      ? { ...metaSettings.extraTime }
      : {};
    if (settings.extraTime.percent !== undefined) {
      baseExtra.percent = Number(settings.extraTime.percent);
    }
    if (settings.extraTime.minimum !== undefined) {
      baseExtra.minimum = Number(settings.extraTime.minimum);
    }
    metaSettings.extraTime = baseExtra;
  }

  if (settings.crmStageMapping) {
    const replaceMapping = options.replaceMapping === true;
    const baseMap = replaceMapping
      ? {}
      : (metaSettings.crmStageMapping && typeof metaSettings.crmStageMapping === 'object'
        ? { ...metaSettings.crmStageMapping }
        : {});
    Object.entries(settings.crmStageMapping).forEach(([key, value]) => {
      if (value === CRM_STAGE_IGNORE) {
        baseMap[key] = CRM_STAGE_IGNORE;
      } else {
        baseMap[key] = value;
      }
    });
    metaSettings.crmStageMapping = baseMap;
  }

  if (settings.logLimit !== undefined) {
    if (settings.logLimit === null) {
      metaSettings.logLimit = null;
    } else {
      metaSettings.logLimit = Number(settings.logLimit);
    }
  }

  if (settings.notificationsMuted !== undefined) {
    normalized.notificationsMuted = !!settings.notificationsMuted;
    metaSettings.notificationsMuted = normalized.notificationsMuted;
  }

  if (settings.plannerMode) {
    metaSettings.plannerMode = settings.plannerMode;
  }

  if (settings.admin) {
    const baseAdmin = metaSettings.admin && typeof metaSettings.admin === 'object'
      ? { ...metaSettings.admin }
      : {};
    if (settings.admin.historyLimit !== undefined) {
      const limit = Math.max(1, Math.round(Number(settings.admin.historyLimit)) || 1);
      baseAdmin.historyLimit = limit;
      if (baseAdmin.historyDailyLimit && baseAdmin.historyDailyLimit > limit) {
        baseAdmin.historyDailyLimit = limit;
      }
    }
    if (settings.admin.historyDailyLimit !== undefined) {
      const dailyRaw = Math.max(1, Math.round(Number(settings.admin.historyDailyLimit)) || 1);
      const limit = Math.max(1, Math.round(Number(baseAdmin.historyLimit || dailyRaw)) || 1);
      baseAdmin.historyLimit = limit;
      baseAdmin.historyDailyLimit = Math.min(limit, dailyRaw);
    }
    if (settings.admin.allowForceOverwrite !== undefined) {
      baseAdmin.allowForceOverwrite = !!settings.admin.allowForceOverwrite;
    }
    if (settings.admin.writeMode) {
      const mode = sanitizeString(settings.admin.writeMode).toLowerCase();
      if (['crm', 'planner', 'both'].includes(mode)) {
        baseAdmin.writeMode = mode;
      }
    }
    metaSettings.admin = baseAdmin;
  }

  if (settings.updatedAt) {
    metaSettings.updatedAt = settings.updatedAt;
  }

  normalized.meta.settings = metaSettings;
  return normalized;
}

function hasCrmStageTasks(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }
  const stageTasks = snapshot?.modeScoped?.crm?.stageTasks;
  if (!Array.isArray(stageTasks)) {
    return false;
  }
  return stageTasks.some((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return false;
    }
    const [, tasks] = entry;
    return Array.isArray(tasks) && tasks.length > 0;
  });
}

function readMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort();
  return files.map((filename) => ({
    filename,
    fullPath: path.join(MIGRATIONS_DIR, filename),
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
  }));
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

async function isMigrationApplied(client, filename) {
  const { rows } = await client.query(
    'SELECT 1 FROM planner_schema_migrations WHERE filename = $1',
    [filename]
  );
  return rows.length > 0;
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = readMigrations();
    for (const migration of migrations) {
      // eslint-disable-next-line no-await-in-loop
      const applied = await isMigrationApplied(client, migration.filename);
      if (applied) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO planner_schema_migrations (filename) VALUES ($1)',
          [migration.filename]
        );
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
}

async function ensureCoreSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_settings (
      key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_orders (
      uid TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      lane_id TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'board_code'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'board_id'
      ) THEN
        EXECUTE 'ALTER TABLE pc_orders RENAME COLUMN board_code TO board_id';
      END IF;
    END $$
  `);
  await client.query('ALTER TABLE pc_orders ADD COLUMN IF NOT EXISTS board_id TEXT');
  await client.query('ALTER TABLE pc_orders ALTER COLUMN board_id TYPE TEXT USING board_id::text');
  await client.query(`
    UPDATE pc_orders
       SET board_id = COALESCE(NULLIF(btrim(board_id), ''), 'legacy-board')
     WHERE board_id IS NULL OR btrim(board_id) = ''
  `);
  await client.query('ALTER TABLE pc_orders ALTER COLUMN board_id SET NOT NULL');
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'lane_code'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'lane_id'
      ) THEN
        EXECUTE 'ALTER TABLE pc_orders RENAME COLUMN lane_code TO lane_id';
      END IF;
    END $$
  `);
  await client.query('ALTER TABLE pc_orders ADD COLUMN IF NOT EXISTS lane_id TEXT');
  await client.query('ALTER TABLE pc_orders ALTER COLUMN lane_id TYPE TEXT USING lane_id::text');
  await client.query(`
    DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'lane_code'
      ) THEN
        EXECUTE $sql$
          UPDATE pc_orders
             SET lane_id = COALESCE(NULLIF(btrim(lane_id), ''), NULLIF(btrim(lane_code::text), ''))
           WHERE lane_id IS NULL OR btrim(lane_id) = '';
        $sql$;
      END IF;
    END
    $do$
  `);
  await client.query(`
    UPDATE pc_orders
       SET lane_id = NULL
     WHERE lane_id IS NOT NULL AND btrim(lane_id) = ''
  `);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'data'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'payload'
      ) THEN
        EXECUTE 'ALTER TABLE pc_orders RENAME COLUMN data TO payload';
      END IF;
    END $$
  `);
  await client.query('ALTER TABLE pc_orders ADD COLUMN IF NOT EXISTS payload JSONB');
  await client.query(`
    DO $$
    DECLARE
      col_type TEXT;
      rec RECORD;
      payload_text TEXT;
    BEGIN
      SELECT data_type INTO col_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pc_orders'
         AND column_name = 'payload';
      IF col_type IS NOT NULL AND col_type <> 'jsonb' THEN
        BEGIN
          EXECUTE 'ALTER TABLE pc_orders ALTER COLUMN payload TYPE JSONB USING payload::jsonb';
        EXCEPTION WHEN others THEN
          EXECUTE 'ALTER TABLE pc_orders ADD COLUMN payload_tmp JSONB';
          FOR rec IN EXECUTE 'SELECT uid, payload FROM pc_orders' LOOP
            BEGIN
              payload_text := rec.payload::text;
              EXECUTE 'UPDATE pc_orders SET payload_tmp = $1::jsonb WHERE uid = $2'
                USING payload_text, rec.uid;
            EXCEPTION WHEN others THEN
              EXECUTE 'UPDATE pc_orders SET payload_tmp = ''{}''::jsonb WHERE uid = $1'
                USING rec.uid;
            END;
          END LOOP;
          EXECUTE 'ALTER TABLE pc_orders DROP COLUMN payload';
          EXECUTE 'ALTER TABLE pc_orders RENAME COLUMN payload_tmp TO payload';
        END;
      END IF;
    END $$
  `);
  await client.query(`
    UPDATE pc_orders
       SET payload = '{}'::jsonb
     WHERE payload IS NULL
  `);
  await client.query(`
    ALTER TABLE pc_orders
      ALTER COLUMN payload SET DEFAULT '{}'::jsonb,
      ALTER COLUMN payload SET NOT NULL
  `);
  await client.query(`
    ALTER TABLE pc_orders
      ADD COLUMN IF NOT EXISTS crm_order_id TEXT,
      ADD COLUMN IF NOT EXISTS order_number TEXT,
      ADD COLUMN IF NOT EXISTS title TEXT,
      ADD COLUMN IF NOT EXISTS customer TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS priority TEXT,
      ADD COLUMN IF NOT EXISTS due_date TEXT,
      ADD COLUMN IF NOT EXISTS planned_start TEXT,
      ADD COLUMN IF NOT EXISTS planned_finish TEXT,
      ADD COLUMN IF NOT EXISTS ready_percent NUMERIC,
      ADD COLUMN IF NOT EXISTS manager TEXT,
      ADD COLUMN IF NOT EXISTS updated_by TEXT,
      ADD COLUMN IF NOT EXISTS updated_text TEXT
  `);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'uid'
      ) THEN
        EXECUTE 'ALTER TABLE pc_orders RENAME COLUMN id TO uid';
      END IF;
    END $$
  `);
  await client.query('ALTER TABLE pc_orders ADD COLUMN IF NOT EXISTS uid TEXT');
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND column_name = 'id'
      ) THEN
        EXECUTE 'UPDATE pc_orders SET uid = COALESCE(uid, id::text) WHERE uid IS NULL';
      END IF;
    END $$
  `);
  await client.query(`
    UPDATE pc_orders
       SET uid = 'order-' || md5(random()::text || clock_timestamp()::text)
     WHERE uid IS NULL OR btrim(uid) = ''
  `);
  await client.query('ALTER TABLE pc_orders ALTER COLUMN uid TYPE TEXT USING uid::text');
  await client.query('ALTER TABLE pc_orders ALTER COLUMN uid SET NOT NULL');
  await client.query(`
    DO $$
    DECLARE
      pk_name TEXT;
    BEGIN
      SELECT constraint_name
        INTO pk_name
        FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND table_name = 'pc_orders'
         AND constraint_type = 'PRIMARY KEY'
       LIMIT 1;
      IF pk_name IS NULL THEN
        EXECUTE 'ALTER TABLE pc_orders ADD CONSTRAINT pc_orders_pkey PRIMARY KEY (uid)';
      ELSIF NOT EXISTS (
        SELECT 1
          FROM information_schema.key_column_usage
         WHERE table_schema = 'public'
           AND table_name = 'pc_orders'
           AND constraint_name = pk_name
           AND column_name = 'uid'
      ) THEN
        EXECUTE format('ALTER TABLE pc_orders DROP CONSTRAINT %I', pk_name);
        EXECUTE 'ALTER TABLE pc_orders ADD CONSTRAINT pc_orders_pkey PRIMARY KEY (uid)';
      END IF;
    END $$
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_order_tasks (
      uid TEXT PRIMARY KEY,
      order_uid TEXT,
      stage_code TEXT,
      bucket TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE pc_order_tasks
      ADD COLUMN IF NOT EXISTS bucket TEXT
  `);
  await client.query(`
    UPDATE pc_order_tasks
       SET bucket = 't'
     WHERE bucket IS NULL
  `);
  await client.query(`
    ALTER TABLE pc_order_tasks
      ALTER COLUMN bucket SET DEFAULT 't'
  `);
  await client.query(`
    ALTER TABLE pc_order_tasks
      ALTER COLUMN bucket SET NOT NULL
  `);
  await client.query(`
    ALTER TABLE pc_order_tasks
      ADD COLUMN IF NOT EXISTS order_uid TEXT,
      ADD COLUMN IF NOT EXISTS crm_order_id TEXT,
      ADD COLUMN IF NOT EXISTS order_number TEXT,
      ADD COLUMN IF NOT EXISTS stage_name TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT,
      ADD COLUMN IF NOT EXISTS priority TEXT,
      ADD COLUMN IF NOT EXISTS executor TEXT,
      ADD COLUMN IF NOT EXISTS planned_start TEXT,
      ADD COLUMN IF NOT EXISTS planned_finish TEXT,
      ADD COLUMN IF NOT EXISTS actual_start TEXT,
      ADD COLUMN IF NOT EXISTS actual_finish TEXT,
      ADD COLUMN IF NOT EXISTS due_date TEXT,
      ADD COLUMN IF NOT EXISTS expected_percent NUMERIC,
      ADD COLUMN IF NOT EXISTS progress_percent NUMERIC
  `);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_order_tasks'
           AND column_name = 'data'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_order_tasks'
           AND column_name = 'payload'
      ) THEN
        EXECUTE 'ALTER TABLE pc_order_tasks RENAME COLUMN data TO payload';
      END IF;
    END $$
  `);
  await client.query('ALTER TABLE pc_order_tasks ADD COLUMN IF NOT EXISTS payload JSONB');
  await client.query(`
    DO $$
    DECLARE
      col_type TEXT;
      rec RECORD;
      payload_text TEXT;
    BEGIN
      SELECT data_type INTO col_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pc_order_tasks'
         AND column_name = 'payload';
      IF col_type IS NOT NULL AND col_type <> 'jsonb' THEN
        BEGIN
          EXECUTE 'ALTER TABLE pc_order_tasks ALTER COLUMN payload TYPE JSONB USING payload::jsonb';
        EXCEPTION WHEN others THEN
          EXECUTE 'ALTER TABLE pc_order_tasks ADD COLUMN payload_tmp JSONB';
          FOR rec IN EXECUTE 'SELECT uid, payload FROM pc_order_tasks' LOOP
            BEGIN
              payload_text := rec.payload::text;
              EXECUTE 'UPDATE pc_order_tasks SET payload_tmp = $1::jsonb WHERE uid = $2'
                USING payload_text, rec.uid;
            EXCEPTION WHEN others THEN
              EXECUTE 'UPDATE pc_order_tasks SET payload_tmp = ''{}''::jsonb WHERE uid = $1'
                USING rec.uid;
            END;
          END LOOP;
          EXECUTE 'ALTER TABLE pc_order_tasks DROP COLUMN payload';
          EXECUTE 'ALTER TABLE pc_order_tasks RENAME COLUMN payload_tmp TO payload';
        END;
      END IF;
    END $$
  `);
  await client.query(`
    UPDATE pc_order_tasks
       SET payload = '{}'::jsonb
     WHERE payload IS NULL
  `);
  await client.query(`
    ALTER TABLE pc_order_tasks
      ALTER COLUMN payload SET DEFAULT '{}'::jsonb,
      ALTER COLUMN payload SET NOT NULL
  `);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_order_tasks'
           AND column_name = 'id'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_order_tasks'
           AND column_name = 'uid'
      ) THEN
        EXECUTE 'ALTER TABLE pc_order_tasks RENAME COLUMN id TO uid';
      END IF;
    END $$
  `);
  await client.query('ALTER TABLE pc_order_tasks ADD COLUMN IF NOT EXISTS uid TEXT');
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'pc_order_tasks'
           AND column_name = 'id'
      ) THEN
        EXECUTE 'UPDATE pc_order_tasks SET uid = COALESCE(uid, id::text) WHERE uid IS NULL';
      END IF;
    END $$
  `);
  await client.query(`
    UPDATE pc_order_tasks
       SET uid = 'task-' || md5(random()::text || clock_timestamp()::text)
     WHERE uid IS NULL OR btrim(uid) = ''
  `);
  await client.query('ALTER TABLE pc_order_tasks ALTER COLUMN uid TYPE TEXT USING uid::text');
  await client.query('ALTER TABLE pc_order_tasks ALTER COLUMN uid SET NOT NULL');
  await client.query(`
    DO $$
    DECLARE
      pk_name TEXT;
    BEGIN
      SELECT constraint_name
        INTO pk_name
        FROM information_schema.table_constraints
       WHERE table_schema = 'public'
         AND table_name = 'pc_order_tasks'
         AND constraint_type = 'PRIMARY KEY'
       LIMIT 1;
      IF pk_name IS NULL THEN
        EXECUTE 'ALTER TABLE pc_order_tasks ADD CONSTRAINT pc_order_tasks_pkey PRIMARY KEY (uid)';
      ELSIF NOT EXISTS (
        SELECT 1
          FROM information_schema.key_column_usage
         WHERE table_schema = 'public'
           AND table_name = 'pc_order_tasks'
           AND constraint_name = pk_name
           AND column_name = 'uid'
      ) THEN
        EXECUTE format('ALTER TABLE pc_order_tasks DROP CONSTRAINT %I', pk_name);
        EXECUTE 'ALTER TABLE pc_order_tasks ADD CONSTRAINT pc_order_tasks_pkey PRIMARY KEY (uid)';
      END IF;
    END $$
  `);
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_bucket_idx ON pc_order_tasks(bucket)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_order_idx ON pc_order_tasks(order_uid)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_orders_crm_order_idx ON pc_orders(crm_order_id)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_orders_number_idx ON pc_orders(order_number)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_stage_idx ON pc_order_tasks(stage_code)');
  await client.query('CREATE INDEX IF NOT EXISTS pc_order_tasks_crm_idx ON pc_order_tasks(crm_order_id)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_stage_sequences (
      stage_code TEXT PRIMARY KEY,
      task_uids TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pc_revisions (
      rev BIGSERIAL PRIMARY KEY,
      hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function upsertSetting(client, key, value) {
  await client.query(
    `INSERT INTO pc_settings (key, payload, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE
       SET payload = EXCLUDED.payload,
           updated_at = NOW()` ,
    [key, JSON.stringify(value ?? null)]
  );
}

function resolveOrderUid(order, fallbackIndex) {
  if (!order || typeof order !== 'object') {
    return `order-${fallbackIndex}`;
  }
  const candidates = [
    order.uid,
    order.identity,
    order.orderIdentity,
    order.orderId,
    order.id,
    order.orderNumber,
    order.number,
    order.code
  ];
  for (const candidate of candidates) {
    const normalized = sanitizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return `order-${fallbackIndex}`;
}

function resolveTaskUid(task, fallbackIndex) {
  if (!task || typeof task !== 'object') {
    return `task-${fallbackIndex}`;
  }
  const candidates = [task.uid, task.id, task.identity];
  for (const candidate of candidates) {
    const normalized = sanitizeString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return `task-${fallbackIndex}`;
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

  return (record) => {
    if (!record || typeof record !== 'object') {
      return { key: null, merged: [] };
    }

    const metaRecord = record.meta && typeof record.meta === 'object' ? record.meta : {};
    const extras = {
      uid: record.uid,
      crmOrderId: record.crmOrderId || record.orderId,
      orderNumber: record.orderNumber || record.number,
      number: record.number,
      title: record.orderTitle || record.title || record.orderName,
      customer: record.orderCustomer || record.customer,
      identity: record.orderIdentity || record.identity
    };
    const includePayloadUid = record.includePayloadUid !== false;
    const aliases = collectOrderAliasesForLookup(record, metaRecord, extras, { includePayloadUid });

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

function extractStorageParts(snapshot) {
  const normalized = normalizeSnapshotCollections(snapshot);
  const boards = [];
  const orders = [];
  const orderKeyToUid = new Map();
  const resolveKey = createOrderKeyResolver();

  normalized.crm.boards.forEach((board, boardIndex) => {
    const boardId = sanitizeString(board?.id) || `crm-board-${boardIndex + 1}`;
    const boardCopy = { ...board, id: boardId };
    const laneOrders = Array.isArray(board?.orders) ? board.orders : [];
    boardCopy.orders = [];
    boards.push({
      id: boardCopy.id,
      name: sanitizeString(boardCopy.name) || 'Список заказов',
      lanes: Array.isArray(boardCopy.lanes) ? boardCopy.lanes : []
    });

    laneOrders.forEach((order, orderIndex) => {
      const uid = resolveOrderUid(order, orders.length + 1);
      const payload = order && typeof order === 'object' ? { ...order, uid } : { uid };
      const meta = extractOrderMetadata(payload);
      const keySource = {
        uid,
        orderId: payload.orderId || payload.crmOrderId || meta.crmOrderId,
        orderNumber: payload.orderNumber || payload.number || meta.orderNumber,
        orderTitle: payload.orderTitle || payload.title || meta.title,
        orderCustomer: payload.orderCustomer || payload.customer || meta.customer,
        orderIdentity: payload.orderIdentity || payload.identity || meta.crmOrderId,
        crmOrderId: payload.crmOrderId || payload.crm_id || meta.crmOrderId,
        number: payload.number || payload.orderNo || meta.orderNumber,
        crmMeta: payload.crmMeta || {},
        crm: payload.crm || {},
        meta
      };
      const resolution = resolveKey(keySource);
      if (resolution.key) {
        orderKeyToUid.set(resolution.key, uid);
        if (resolution.merged && resolution.merged.length) {
          resolution.merged.forEach((alias) => orderKeyToUid.set(alias, uid));
        }
      }
      orders.push({
        uid,
        boardId,
        laneId: sanitizeString(order?.laneId || order?.lane || null) || null,
        position: orderIndex,
        payload,
        meta
      });
    });
  });

  const buckets = [
    ['t', 'active'],
    ['done', 'done'],
    ['trash', 'trash'],
    ['exc', 'exception'],
    ['res', 'reserve']
  ];

  const tasks = [];
  const taskByUid = new Map();
  const registerTaskRecord = (record) => {
    if (!record || !record.uid) {
      return;
    }
    tasks.push(record);
    taskByUid.set(record.uid, record);
  };
  const flatStageCandidates = new Map();
  for (const [key] of buckets) {
    const list = Array.isArray(normalized[key]) ? normalized[key] : [];
    list.forEach((task, index) => {
      const uid = resolveTaskUid(task, tasks.length + 1);
      const payload = task && typeof task === 'object' ? { ...task, uid } : { uid };
      const keySource = {
        uid,
        orderId: payload.orderId || payload.crmOrderId,
        orderNumber: payload.orderNumber || payload.number,
        orderTitle: payload.orderTitle || payload.title,
        orderCustomer: payload.orderCustomer || payload.customer,
        orderIdentity: payload.orderIdentity || payload.identity,
        crmOrderId: payload.crmOrderId || payload.crm_id,
        number: payload.number || payload.orderNo,
        crmMeta: payload.crmMeta || {},
        crm: payload.crm || {},
        includePayloadUid: false
      };
      const resolution = resolveKey(keySource);
      const orderUid = resolution.key ? orderKeyToUid.get(resolution.key) || null : null;
      const meta = extractTaskMetadata(payload);
      const stage = normalizeStage(task?.stage) || normalizeStage(payload.stage);
      if (stage && !payload.stage) {
        payload.stage = stage;
      }
      const bucketName = isCrmTaskUid(uid) && stage ? 'crm_stage' : key;
      const record = {
        uid,
        orderUid,
        stage,
        bucket: bucketName,
        position: index,
        payload,
        meta
      };
      registerTaskRecord(record);
      if (stage) {
        if (!flatStageCandidates.has(stage)) {
          flatStageCandidates.set(stage, []);
        }
        flatStageCandidates.get(stage).push({ uid, position: index, bucket: bucketName });
      }
    });
  }

  let stageSequences = Array.isArray(normalized.orders)
    ? normalized.orders
        .map((entry) => {
          if (!Array.isArray(entry) || entry.length < 2) return null;
          const stage = normalizeStage(entry[0]);
          if (!stage) return null;
          const ids = Array.isArray(entry[1])
            ? entry[1].map((uid) => sanitizeString(uid)).filter(Boolean)
            : [];
          return { stage, ids };
        })
        .filter(Boolean)
    : [];

  const crmStageEntries = Array.isArray(normalized?.modeScoped?.crm?.stageTasks)
    ? normalized.modeScoped.crm.stageTasks
    : [];
  const derivedStageSequences = new Map();

  crmStageEntries.forEach((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return;
    }
    const stage = normalizeStage(entry[0]);
    if (!stage) {
      return;
    }
    const list = Array.isArray(entry[1]) ? entry[1] : [];
    const ids = [];
    list.forEach((task, index) => {
      const uid = resolveTaskUid(task, tasks.length + 1);
      const payload = task && typeof task === 'object' ? { ...task, uid } : { uid };
      if (!payload.stage) {
        payload.stage = stage;
      }
      const keySource = {
        uid,
        orderId: payload.orderId || payload.crmOrderId,
        orderNumber: payload.orderNumber || payload.number,
        orderTitle: payload.orderTitle || payload.title,
        orderCustomer: payload.orderCustomer || payload.customer,
        orderIdentity: payload.orderIdentity || payload.identity,
        crmOrderId: payload.crmOrderId || payload.crm_id,
        number: payload.number || payload.orderNo,
        crmMeta: payload.crmMeta || {},
        crm: payload.crm || {},
        includePayloadUid: false
      };
      const resolution = resolveKey(keySource);
      const orderUid = resolution.key ? orderKeyToUid.get(resolution.key) || null : null;
      const meta = extractTaskMetadata(payload);
      if (taskByUid.has(uid)) {
        const existing = taskByUid.get(uid);
        if (stage && !existing.stage) {
          existing.stage = stage;
        }
        if (existing.payload && !existing.payload.stage) {
          existing.payload.stage = stage;
        }
        if (!existing.orderUid && orderUid) {
          existing.orderUid = orderUid;
        }
        if ((!existing.meta || Object.keys(existing.meta || {}).length === 0) && meta) {
          existing.meta = meta;
        }
      } else {
        registerTaskRecord({
          uid,
          orderUid,
          stage,
          bucket: 'crm_stage',
          position: tasks.length,
          payload,
          meta
        });
      }
      if (!ids.includes(uid)) {
        ids.push(uid);
      }
      if (resolution.key && resolution.merged && resolution.merged.length) {
        resolution.merged.forEach((alias) => {
          if (!orderKeyToUid.has(alias) && orderUid) {
            orderKeyToUid.set(alias, orderUid);
          }
        });
      }
    });
    derivedStageSequences.set(stage, ids);
  });

  flatStageCandidates.forEach((entries, stage) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    const sorted = entries
      .slice()
      .sort((a, b) => {
        const left = Number.isFinite(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
        const right = Number.isFinite(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
        if (left === right) {
          return sanitizeString(a.uid).localeCompare(sanitizeString(b.uid));
        }
        return left - right;
      })
      .map((entry) => sanitizeString(entry.uid))
      .filter(Boolean);
    if (!sorted.length) {
      return;
    }
    if (derivedStageSequences.has(stage)) {
      const existing = derivedStageSequences.get(stage) || [];
      const seen = new Set(existing);
      sorted.forEach((uid) => {
        if (!seen.has(uid)) {
          existing.push(uid);
          seen.add(uid);
        }
      });
      derivedStageSequences.set(stage, existing);
    } else {
      derivedStageSequences.set(stage, sorted);
    }
  });

  if (derivedStageSequences.size > 0) {
    const stageSequenceMap = new Map();
    stageSequences.forEach((entry) => {
      stageSequenceMap.set(entry.stage, entry.ids);
    });
    derivedStageSequences.forEach((ids, stage) => {
      const existing = stageSequenceMap.get(stage);
      if (!existing || existing.length === 0) {
        stageSequenceMap.set(stage, ids);
      }
    });
    const orderedSequences = [];
    stageSequences.forEach((entry) => {
      orderedSequences.push({ stage: entry.stage, ids: stageSequenceMap.get(entry.stage) || [] });
      stageSequenceMap.delete(entry.stage);
    });
    STAGE_KEYS.forEach((stage) => {
      if (stageSequenceMap.has(stage)) {
        orderedSequences.push({ stage, ids: stageSequenceMap.get(stage) || [] });
        stageSequenceMap.delete(stage);
      }
    });
    stageSequenceMap.forEach((ids, stage) => {
      orderedSequences.push({ stage, ids });
    });
    stageSequences = orderedSequences;
  }

  const baseSnapshot = JSON.parse(JSON.stringify(normalized));
  baseSnapshot.crm = { ...baseSnapshot.crm, boards: [] };
  baseSnapshot.t = [];
  baseSnapshot.done = [];
  baseSnapshot.trash = [];
  baseSnapshot.exc = [];
  baseSnapshot.res = [];
  baseSnapshot.orders = [];

  return { baseSnapshot, boards, orders, tasks, stageSequences };
}

function assembleSnapshot(baseSnapshot, boards, orders, tasks, stageSequences) {
  const snapshot = normalizeSnapshotCollections(baseSnapshot);
  const boardMap = new Map();
  snapshot.crm.boards = boards.map((board) => {
    const entry = {
      id: board.id,
      name: board.name,
      lanes: Array.isArray(board.lanes) ? board.lanes : [],
      orders: []
    };
    boardMap.set(entry.id, entry);
    return entry;
  });

  orders.sort((a, b) => {
    if (a.boardId === b.boardId) {
      return a.position - b.position;
    }
    return a.boardId.localeCompare(b.boardId);
  });

  orders.forEach((order) => {
    const board = boardMap.get(order.boardId);
    if (!board) return;
    const payload = order.payload && typeof order.payload === 'object'
      ? { ...order.payload, uid: order.uid }
      : { uid: order.uid };
    payload.laneId = order.laneId;
    board.orders.push(payload);
  });

  const bucketMap = new Map([
    ['t', []],
    ['done', []],
    ['trash', []],
    ['exc', []],
    ['res', []]
  ]);

  tasks.sort((a, b) => {
    if (a.bucket === b.bucket) {
      return a.position - b.position;
    }
    return a.bucket.localeCompare(b.bucket);
  });

  tasks.forEach((task) => {
    const bucket = task.bucket === 'crm_stage' ? 't' : task.bucket;
    const list = bucketMap.get(bucket);
    if (!list) return;
    const payload = task.payload && typeof task.payload === 'object'
      ? { ...task.payload, uid: task.uid }
      : { uid: task.uid };
    if (task.bucket && typeof payload.bucket === 'undefined') {
      payload.bucket = task.bucket;
    }
    if (task.orderUid) {
      payload.orderIdentity = payload.orderIdentity || task.orderUid;
    }
    if (task.stage) {
      payload.stage = task.stage;
    }
    list.push(payload);
  });

  snapshot.t = bucketMap.get('t');
  snapshot.done = bucketMap.get('done');
  snapshot.trash = bucketMap.get('trash');
  snapshot.exc = bucketMap.get('exc');
  snapshot.res = bucketMap.get('res');

  snapshot.orders = stageSequences.map((entry) => [entry.stage, entry.ids]);

  ensureModeScopedConsistency(snapshot, tasks, stageSequences);

  return snapshot;
}

async function getLatestRevision(client) {
  const runner = client || pool;
  const { rows } = await runner.query('SELECT COALESCE(MAX(rev),0) AS rev FROM pc_revisions');
  return Number(rows[0]?.rev || 0);
}

async function loadSnapshotFromDatabase() {
  const client = await pool.connect();
  try {
    await ensureCoreSchema(client);

    const baseRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_base']);
    const boardsRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['crm_boards']);
    const hashRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_hash']);
    const fullRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_full']);

    let baseSnapshot = baseRow.rows.length
      ? safeJsonParse(baseRow.rows[0].payload, buildEmptySnapshot())
      : buildEmptySnapshot();
    const fullSnapshot = fullRow.rows.length
      ? safeJsonParse(fullRow.rows[0].payload, null)
      : null;

    if ((!baseRow.rows.length || !hasCrmStageTasks(baseSnapshot)) && fullSnapshot && typeof fullSnapshot === 'object') {
      if (!hasCrmStageTasks(baseSnapshot) && hasCrmStageTasks(fullSnapshot)) {
        baseSnapshot.modeScoped = clonePlain(fullSnapshot.modeScoped || {});
      }
      if ((!Array.isArray(baseSnapshot.done) || baseSnapshot.done.length === 0) && Array.isArray(fullSnapshot.done)) {
        baseSnapshot.done = clonePlain(fullSnapshot.done);
      }
      if ((!Array.isArray(baseSnapshot.trash) || baseSnapshot.trash.length === 0) && Array.isArray(fullSnapshot.trash)) {
        baseSnapshot.trash = clonePlain(fullSnapshot.trash);
      }
      if ((!Array.isArray(baseSnapshot.exc) || baseSnapshot.exc.length === 0) && Array.isArray(fullSnapshot.exc)) {
        baseSnapshot.exc = clonePlain(fullSnapshot.exc);
      }
      if ((!Array.isArray(baseSnapshot.res) || baseSnapshot.res.length === 0) && Array.isArray(fullSnapshot.res)) {
        baseSnapshot.res = clonePlain(fullSnapshot.res);
      }
      if ((!Array.isArray(baseSnapshot.locked) || baseSnapshot.locked.length === 0) && Array.isArray(fullSnapshot.locked)) {
        baseSnapshot.locked = clonePlain(fullSnapshot.locked);
      }
      if ((!Array.isArray(baseSnapshot.routeOverrides) || baseSnapshot.routeOverrides.length === 0)
        && Array.isArray(fullSnapshot.routeOverrides)) {
        baseSnapshot.routeOverrides = clonePlain(fullSnapshot.routeOverrides);
      }
      if ((!Array.isArray(baseSnapshot.orders) || baseSnapshot.orders.length === 0) && Array.isArray(fullSnapshot.orders)) {
        baseSnapshot.orders = clonePlain(fullSnapshot.orders);
      }
      if (!baseSnapshot.meta || typeof baseSnapshot.meta !== 'object') {
        baseSnapshot.meta = clonePlain(fullSnapshot.meta || {});
      } else if (fullSnapshot.meta && typeof fullSnapshot.meta === 'object') {
        baseSnapshot.meta = { ...fullSnapshot.meta, ...baseSnapshot.meta };
      }
    }
    const boards = boardsRow.rows.length
      ? safeJsonParse(boardsRow.rows[0].payload, [])
      : [];
    const stageMapping = baseSnapshot?.meta?.settings?.crmStageMapping || {};

    const ordersRes = await client.query(
      `SELECT uid, board_id, lane_id, position, payload,
              crm_order_id, order_number, title, customer, status, priority,
              due_date, planned_start, planned_finish, ready_percent,
              manager, updated_by, updated_text
         FROM pc_orders`
    );
    const orders = [];
    const orderUpdates = [];
    const orderAliasToUid = new Map();
    const orderByUid = new Map();
    for (const row of ordersRes.rows) {
      const payload = safeJsonParse(row.payload, {});
      const meta = extractOrderMetadata(payload);
      const storedCrmId = toNullableString(row.crm_order_id);
      const storedNumber = toNullableString(row.order_number);
      const storedTitle = toNullableString(row.title);
      const storedCustomer = toNullableString(row.customer);
      const storedStatus = toNullableString(row.status);
      const storedPriority = toNullableString(row.priority);
      const storedDue = toNullableString(row.due_date);
      const storedPlanStart = toNullableString(row.planned_start);
      const storedPlanFinish = toNullableString(row.planned_finish);
      const storedManager = toNullableString(row.manager);
      const storedUpdatedBy = toNullableString(row.updated_by);
      const storedUpdatedText = toNullableString(row.updated_text);
      const storedReady = row.ready_percent;
      const readyPercent = meta.readyPercent ?? null;
      const needsUpdate =
        storedCrmId !== (meta.crmOrderId || null) ||
        storedNumber !== (meta.orderNumber || null) ||
        storedTitle !== (meta.title || null) ||
        storedCustomer !== (meta.customer || null) ||
        storedStatus !== (meta.status || null) ||
        storedPriority !== (meta.priority || null) ||
        storedDue !== (meta.dueDate || null) ||
        storedPlanStart !== (meta.plannedStart || null) ||
        storedPlanFinish !== (meta.plannedFinish || null) ||
        !numbersEqual(storedReady, readyPercent) ||
        storedManager !== (meta.manager || null) ||
        storedUpdatedBy !== (meta.updatedBy || null) ||
        storedUpdatedText !== (meta.updatedText || null);
      if (needsUpdate) {
        orderUpdates.push([
          meta.crmOrderId || null,
          meta.orderNumber || null,
          meta.title || null,
          meta.customer || null,
          meta.status || null,
          meta.priority || null,
          meta.dueDate || null,
          meta.plannedStart || null,
          meta.plannedFinish || null,
          readyPercent,
          meta.manager || null,
          meta.updatedBy || null,
          meta.updatedText || null,
          sanitizeString(row.uid)
        ]);
      }
      orders.push({
        uid: sanitizeString(row.uid),
        boardId: sanitizeString(row.board_id),
        laneId: sanitizeString(row.lane_id || null) || null,
        position: Number(row.position) || 0,
        payload
      });
      const aliasExtras = {
        uid: sanitizeString(row.uid),
        crmOrderId: row.crm_order_id,
        orderNumber: row.order_number,
        number: row.order_number,
        title: row.title,
        customer: row.customer,
        identity: payload.orderIdentity || payload.identity || meta.crmOrderId
      };
      const orderAliases = collectOrderAliasesForLookup(payload, meta, aliasExtras, { includePayloadUid: true });
      orderAliases.forEach((alias) => {
        if (!orderAliasToUid.has(alias)) {
          orderAliasToUid.set(alias, sanitizeString(row.uid));
        }
      });
      orderByUid.set(sanitizeString(row.uid), { payload, meta });
    }

    for (const params of orderUpdates) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE pc_orders
            SET crm_order_id = $1,
                order_number = $2,
                title = $3,
                customer = $4,
                status = $5,
                priority = $6,
                due_date = $7,
                planned_start = $8,
                planned_finish = $9,
                ready_percent = $10,
                manager = $11,
                updated_by = $12,
                updated_text = $13,
                updated_at = NOW()
          WHERE uid = $14`,
        params
      );
    }

    const tasksRes = await client.query(
      `SELECT uid, order_uid, stage_code, bucket, position, payload,
              crm_order_id, order_number, stage_name, status, priority, executor,
              planned_start, planned_finish, actual_start, actual_finish,
              due_date, expected_percent, progress_percent
         FROM pc_order_tasks`
    );
    const tasks = [];
    const taskUpdates = [];
    const taskLinkUpdates = [];
    for (const row of tasksRes.rows) {
      const payload = safeJsonParse(row.payload, {});
      const meta = extractTaskMetadata(payload);
      const storedOrderUid = sanitizeString(row.order_uid) || null;
      const aliasExtras = {
        uid: storedOrderUid,
        crmOrderId: row.crm_order_id,
        orderNumber: row.order_number,
        number: row.order_number,
        identity: payload.orderIdentity || payload.identity || meta.crmOrderId || storedOrderUid
      };
      const aliasCandidates = collectOrderAliasesForLookup(payload, meta, aliasExtras, { includePayloadUid: false });
      let linkedOrderUid = storedOrderUid;
      if (!linkedOrderUid) {
        for (const alias of aliasCandidates) {
          const candidate = orderAliasToUid.get(alias);
          if (candidate) {
            linkedOrderUid = sanitizeString(candidate) || null;
            break;
          }
        }
      }
      if (!linkedOrderUid && meta.crmOrderId) {
        const directAlias = `crm:${sanitizeString(meta.crmOrderId)}`;
        const candidate = orderAliasToUid.get(directAlias);
        if (candidate) {
          linkedOrderUid = sanitizeString(candidate) || null;
        }
      }
      aliasCandidates.forEach((alias) => {
        if (!orderAliasToUid.has(alias) && linkedOrderUid) {
          orderAliasToUid.set(alias, linkedOrderUid);
        }
      });
      const linkedOrder = linkedOrderUid ? orderByUid.get(linkedOrderUid) : null;
      if (linkedOrder) {
        const orderPayload = linkedOrder.payload || {};
        const orderMeta = linkedOrder.meta || extractOrderMetadata(orderPayload);
        const linkedIdentity = sanitizeString(orderPayload.orderIdentity)
          || sanitizeString(orderPayload.identity)
          || orderMeta.crmOrderId
          || linkedOrderUid;
        if (!payload.orderIdentity && linkedIdentity) {
          payload.orderIdentity = linkedIdentity;
        }
        if (!payload.orderId && (orderMeta.crmOrderId || orderPayload.orderId)) {
          payload.orderId = payload.orderId || orderMeta.crmOrderId || orderPayload.orderId;
        }
        if (!payload.orderNumber && (orderMeta.orderNumber || orderPayload.orderNumber || orderPayload.number)) {
          payload.orderNumber = payload.orderNumber || orderMeta.orderNumber || orderPayload.orderNumber || orderPayload.number;
        }
        if (!payload.orderCustomer && (orderMeta.customer || orderPayload.orderCustomer || orderPayload.customer)) {
          payload.orderCustomer = payload.orderCustomer || orderMeta.customer || orderPayload.orderCustomer || orderPayload.customer;
        }
        if (!payload.title && (orderMeta.title || orderPayload.title || orderPayload.orderTitle)) {
          payload.title = payload.title || orderMeta.title || orderPayload.title || orderPayload.orderTitle;
        }
        if (!payload.customer && (orderMeta.customer || orderPayload.customer)) {
          payload.customer = payload.customer || orderMeta.customer || orderPayload.customer;
        }
        if (!payload.crmMeta || typeof payload.crmMeta !== 'object') {
          payload.crmMeta = payload.crmMeta && typeof payload.crmMeta === 'object' ? { ...payload.crmMeta } : {};
        }
        if (orderMeta.crmOrderId && !payload.crmMeta.orderId) {
          payload.crmMeta.orderId = payload.crmMeta.orderId || orderMeta.crmOrderId;
        }
        if (orderMeta.orderNumber && !payload.crmMeta.orderNumber) {
          payload.crmMeta.orderNumber = payload.crmMeta.orderNumber || orderMeta.orderNumber;
        }
        if (orderMeta.customer && !payload.crmMeta.customer) {
          payload.crmMeta.customer = payload.crmMeta.customer || orderMeta.customer;
        }
        if (!meta.crmOrderId && orderMeta.crmOrderId) {
          meta.crmOrderId = orderMeta.crmOrderId;
        }
        if (!meta.orderNumber && orderMeta.orderNumber) {
          meta.orderNumber = orderMeta.orderNumber;
        }
        if (!meta.customer && orderMeta.customer) {
          meta.customer = orderMeta.customer;
        }
      }
      const stageCandidates = [
        row.stage_code,
        payload.stage,
        payload.stageKey,
        payload.stage_code,
        payload?.crmMeta?.stageKey,
        payload?.crmMeta?.stage,
        payload?.crmMeta?.stageName,
        payload?.crmStage?.stageKey,
        payload?.crmStage?.stage,
        payload?.crmStage?.name,
        payload?.crmStage?.stageName,
        meta.stageName,
        row.stage_name
      ];
      let stage = null;
      for (const candidate of stageCandidates) {
        const normalized = normalizeStage(candidate);
        if (!normalized) {
          continue;
        }
        if (STAGE_KEYS.includes(normalized)) {
          stage = normalized;
          break;
        }
        const mapped = mapCrmStageName(candidate, stageMapping);
        if (mapped) {
          stage = mapped;
          break;
        }
        if (!stage) {
          stage = normalized;
        }
      }
      if (stage && !payload.stage) {
        payload.stage = stage;
      }
      if (stage && !meta.stageName) {
        meta.stageName = stage;
      }
      const storedCrmId = toNullableString(row.crm_order_id);
      const storedNumber = toNullableString(row.order_number);
      const storedStageName = toNullableString(row.stage_name);
      const storedStatus = toNullableString(row.status);
      const storedPriority = toNullableString(row.priority);
      const storedExecutor = toNullableString(row.executor);
      const storedPlanStart = toNullableString(row.planned_start);
      const storedPlanFinish = toNullableString(row.planned_finish);
      const storedActualStart = toNullableString(row.actual_start);
      const storedActualFinish = toNullableString(row.actual_finish);
      const storedDue = toNullableString(row.due_date);
      const storedExpected = row.expected_percent;
      const storedProgress = row.progress_percent;
      const expectedPercent = meta.expectedPercent ?? null;
      const progressPercent = meta.progressPercent ?? null;
      const needsUpdate =
        storedCrmId !== (meta.crmOrderId || null) ||
        storedNumber !== (meta.orderNumber || null) ||
        storedStageName !== (meta.stageName || null) ||
        storedStatus !== (meta.status || null) ||
        storedPriority !== (meta.priority || null) ||
        storedExecutor !== (meta.executor || null) ||
        storedPlanStart !== (meta.plannedStart || null) ||
        storedPlanFinish !== (meta.plannedFinish || null) ||
        storedActualStart !== (meta.actualStart || null) ||
        storedActualFinish !== (meta.actualFinish || null) ||
        storedDue !== (meta.dueDate || null) ||
        !numbersEqual(storedExpected, expectedPercent) ||
        !numbersEqual(storedProgress, progressPercent);
      if (needsUpdate) {
        taskUpdates.push([
          meta.crmOrderId || null,
          meta.orderNumber || null,
          meta.stageName || null,
          meta.status || null,
          meta.priority || null,
          meta.executor || null,
          meta.plannedStart || null,
          meta.plannedFinish || null,
          meta.actualStart || null,
          meta.actualFinish || null,
          meta.dueDate || null,
          expectedPercent,
          progressPercent,
          sanitizeString(row.uid)
        ]);
      }
      const sanitizedUid = sanitizeString(row.uid);
      const normalizedStage = stage || normalizeStage(row.stage_code);
      const resolvedOrderUid = linkedOrderUid || null;
      if ((resolvedOrderUid || storedOrderUid) || stage) {
        const storedStageCode = normalizeStage(row.stage_code);
        if (resolvedOrderUid !== storedOrderUid || (stage && stage !== storedStageCode)) {
          taskLinkUpdates.push([resolvedOrderUid, stage || storedStageCode || null, sanitizedUid]);
        }
      }
      tasks.push({
        uid: sanitizedUid,
        orderUid: resolvedOrderUid,
        stage: normalizedStage,
        bucket: sanitizeString(row.bucket) || 't',
        position: Number(row.position) || 0,
        payload
      });
    }

    for (const params of taskUpdates) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE pc_order_tasks
            SET crm_order_id = $1,
                order_number = $2,
                stage_name = $3,
                status = $4,
                priority = $5,
                executor = $6,
                planned_start = $7,
                planned_finish = $8,
                actual_start = $9,
                actual_finish = $10,
                due_date = $11,
                expected_percent = $12,
                progress_percent = $13,
                updated_at = NOW()
          WHERE uid = $14`,
        params
      );
    }

    for (const params of taskLinkUpdates) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `UPDATE pc_order_tasks
            SET order_uid = $1,
                stage_code = $2,
                updated_at = NOW()
          WHERE uid = $3`,
        params
      );
    }

    const stageRes = await client.query('SELECT stage_code, task_uids FROM pc_stage_sequences');
    const stageSequences = stageRes.rows.map((row) => ({
      stage: normalizeStage(row.stage_code),
      ids: Array.isArray(row.task_uids)
        ? row.task_uids.map((uid) => sanitizeString(uid)).filter(Boolean)
        : []
    })).filter((entry) => entry.stage);

    const snapshot = assembleSnapshot(baseSnapshot, boards, orders, tasks, stageSequences);
    const stateString = safeJsonStringify(snapshot, '{}');
    const storedHash = hashRow.rows.length
      ? sanitizeString(hashRow.rows[0].payload?.hash || hashRow.rows[0].payload?.HASH)
      : null;
    const hash = storedHash || computeHash(stateString);
    const rev = await getLatestRevision(client);

    return { snapshot, stateString, hash, rev };
  } finally {
    client.release();
  }
}

async function getCachedSnapshot() {
  if (cachedSnapshot) {
    return cachedSnapshot;
  }
  const loaded = await loadSnapshotFromDatabase();
  cachedSnapshot = loaded;
  return loaded;
}

async function persistSnapshotWithSql({ snapshot, stateString }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCoreSchema(client);

    const parsed = typeof snapshot === 'string' ? safeJsonParse(snapshot, {}) : snapshot;
    const storage = extractStorageParts(parsed);
    const normalizedState = assembleSnapshot(
      storage.baseSnapshot,
      storage.boards,
      storage.orders,
      storage.tasks,
      storage.stageSequences
    );
    const finalString = stateString || safeJsonStringify(normalizedState, '{}');
    const hash = computeHash(finalString);

    const currentRow = await client.query('SELECT payload FROM pc_settings WHERE key = $1', ['snapshot_hash']);
    const currentHash = currentRow.rows.length
      ? sanitizeString(currentRow.rows[0].payload?.hash || currentRow.rows[0].payload?.HASH)
      : null;

    if (currentHash && currentHash === hash) {
      await client.query('ROLLBACK');
      return { snapshot: normalizedState, stateString: finalString, hash, rev: await getLatestRevision(client) };
    }

    await client.query('DELETE FROM pc_order_tasks');
    await client.query('DELETE FROM pc_orders');
    await client.query('DELETE FROM pc_stage_sequences');

    for (const order of storage.orders) {
      const meta = order.meta || extractOrderMetadata(order.payload);
      await client.query(
        `INSERT INTO pc_orders (
           uid, board_id, lane_id, position, payload,
           crm_order_id, order_number, title, customer, status, priority,
           due_date, planned_start, planned_finish, ready_percent,
           manager, updated_by, updated_text,
           created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())`,
        [
          order.uid,
          order.boardId,
          order.laneId,
          order.position,
          JSON.stringify(order.payload ?? {}),
          meta?.crmOrderId || null,
          meta?.orderNumber || null,
          meta?.title || null,
          meta?.customer || null,
          meta?.status || null,
          meta?.priority || null,
          meta?.dueDate || null,
          meta?.plannedStart || null,
          meta?.plannedFinish || null,
          meta?.readyPercent ?? null,
          meta?.manager || null,
          meta?.updatedBy || null,
          meta?.updatedText || null
        ]
      );
    }

    for (const task of storage.tasks) {
      const meta = task.meta || extractTaskMetadata(task.payload);
      await client.query(
        `INSERT INTO pc_order_tasks (
           uid, order_uid, stage_code, bucket, position, payload,
           crm_order_id, order_number, stage_name, status, priority, executor,
           planned_start, planned_finish, actual_start, actual_finish,
           due_date, expected_percent, progress_percent,
           created_at, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())`,
        [
          task.uid,
          task.orderUid,
          task.stage,
          task.bucket,
          task.position,
          JSON.stringify(task.payload ?? {}),
          meta?.crmOrderId || null,
          meta?.orderNumber || null,
          meta?.stageName || null,
          meta?.status || null,
          meta?.priority || null,
          meta?.executor || null,
          meta?.plannedStart || null,
          meta?.plannedFinish || null,
          meta?.actualStart || null,
          meta?.actualFinish || null,
          meta?.dueDate || null,
          meta?.expectedPercent ?? null,
          meta?.progressPercent ?? null
        ]
      );
    }

    for (const entry of storage.stageSequences) {
      await client.query(
        `INSERT INTO pc_stage_sequences (stage_code, task_uids, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (stage_code) DO UPDATE
           SET task_uids = EXCLUDED.task_uids,
               updated_at = NOW()` ,
        [entry.stage, entry.ids]
      );
    }

    await upsertSetting(client, 'snapshot_base', storage.baseSnapshot);
    await upsertSetting(client, 'crm_boards', storage.boards);
    await upsertSetting(client, 'snapshot_full', normalizedState);
    await upsertSetting(client, 'snapshot_hash', { hash });

    const revResult = await client.query('INSERT INTO pc_revisions (hash) VALUES ($1) RETURNING rev', [hash]);
    const rev = Number(revResult.rows[0]?.rev || 0);

    await client.query('COMMIT');
    const assembled = { snapshot: normalizedState, stateString: finalString, hash, rev };
    cachedSnapshot = assembled;
    return assembled;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function broadcastRevision({ rev, hash }) {
  const payload = JSON.stringify({ type: 'revision', rev, hash, etag: computeEtag(hash) });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.warn('Failed to push SSE payload', err);
    }
  }
}

function extractHashFromHeader(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const tokens = raw.split(',').map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (!token) continue;
    const normalized = token.startsWith('W/') ? token.slice(2) : token;
    const stripped = normalized.replace(/^"|"$/g, '');
    if (stripped) {
      return stripped;
    }
  }
  return null;
}

function extractSnapshotPayload(body) {
  if (body == null) {
    return { snapshot: buildEmptySnapshot(), stateString: JSON.stringify(buildEmptySnapshot()), meta: {} };
  }

  if (typeof body === 'string') {
    const parsed = safeJsonParse(body, {});
    return extractSnapshotPayload(parsed);
  }

  if (Buffer.isBuffer(body)) {
    return extractSnapshotPayload(body.toString('utf8'));
  }

  if (typeof body === 'object') {
    const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
    if (typeof body.state === 'string') {
      const snapshot = safeJsonParse(body.state, {});
      return { snapshot, stateString: body.state, meta };
    }
    if (body.state && typeof body.state === 'object') {
      const stateString = safeJsonStringify(body.state, '{}');
      return { snapshot: body.state, stateString, meta };
    }
    if (body.snapshot && typeof body.snapshot === 'object') {
      const stateString = safeJsonStringify(body.snapshot, '{}');
      return { snapshot: body.snapshot, stateString, meta };
    }
    const stateString = safeJsonStringify(body, '{}');
    const snapshot = safeJsonParse(stateString, {});
    return { snapshot, stateString, meta };
  }

  return { snapshot: buildEmptySnapshot(), stateString: JSON.stringify(buildEmptySnapshot()), meta: {} };
}

app.get('/api/state', async (req, res) => {
  try {
    const snapshot = await getCachedSnapshot();
    const etag = computeEtag(snapshot.hash);
    if (etag) {
      const headerHash = extractHashFromHeader(req.headers['if-none-match']);
      if (headerHash && headerHash === snapshot.hash) {
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
  try {
    const { snapshot, stateString } = extractSnapshotPayload(req.body);
    const current = await getCachedSnapshot();
    const ifMatch = extractHashFromHeader(req.headers['if-match']);
    if (ifMatch && current.hash && ifMatch !== current.hash && ifMatch !== '*') {
      res.status(412).json({ error: 'Precondition Failed', expected: current.hash });
      return;
    }

    const latest = await persistSnapshotWithSql({ snapshot, stateString });
    const etag = computeEtag(latest.hash);
    if (etag) {
      res.set('ETag', etag);
    }
    res.set('Cache-Control', 'no-store');
    broadcastRevision({ rev: latest.rev, hash: latest.hash });
    res.status(200).json({ ok: true, rev: latest.rev, hash: latest.hash, etag });
  } catch (err) {
    console.error('PUT /api/state failed', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
    const incomingSettings = sanitizeIncomingSettings(rawBody.settings || {});
    const timestamp = sanitizeString(rawBody.timestamp) || new Date().toISOString();
    incomingSettings.updatedAt = timestamp;
    const replaceMapping = !!(rawBody.meta && typeof rawBody.meta === 'object' && rawBody.meta.replace);

    const current = await getCachedSnapshot();
    const previousHash = current?.hash || null;
    const baselineSnapshot = current?.snapshot ? clonePlain(current.snapshot) : buildEmptySnapshot();
    const updatedSnapshot = applySettingsToSnapshot(baselineSnapshot, incomingSettings, { replaceMapping });
    const stateString = safeJsonStringify(updatedSnapshot, '{}');
    const latest = await persistSnapshotWithSql({ snapshot: updatedSnapshot, stateString });

    if (latest.hash !== previousHash) {
      broadcastRevision({ rev: latest.rev, hash: latest.hash });
    }

    res.status(200).json({
      ok: true,
      hash: latest.hash,
      rev: latest.rev,
      updatedAt: incomingSettings.updatedAt,
      settings: latest.snapshot?.meta?.settings || null
    });
  } catch (err) {
    console.error('POST /api/settings failed', err);
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

  try {
    const snapshot = await getCachedSnapshot();
    if (snapshot && snapshot.hash) {
      const payload = JSON.stringify({
        type: 'revision',
        rev: snapshot.rev,
        hash: snapshot.hash,
        etag: computeEtag(snapshot.hash)
      });
      res.write(`data: ${payload}\n\n`);
    }
  } catch (err) {
    console.warn('Failed to send initial SSE payload', err);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html', 'htm'] }));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  const indexPath = path.join(PUBLIC_DIR, 'CRM.html');
  fs.createReadStream(indexPath)
    .on('error', () => next())
    .pipe(res);
});

(async () => {
  try {
    await runMigrations();
    await getCachedSnapshot();
    app.listen(PORT, () => {
      console.log(`Planner SQL bridge listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to bootstrap application', err);
    process.exit(1);
  }
})();
