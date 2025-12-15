'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
function requireWithAutoInstall(moduleName) {
  try {
    return require(moduleName);
  } catch (err) {
    if (!isMissingDependencyError(err, moduleName)) {
      throw err;
    }
    try {
      attemptAutoInstall();
    } catch (installErr) {
      const message = `[CRM] Не удалось автоматически установить зависимости (${installErr?.message || installErr}).`;
      console.error(message);
      throw err;
    }
    return require(moduleName);
  }
}

function attemptAutoInstall() {
  if (autoInstallAttempted) {
    throw new Error('повторная установка зависимостей не выполнялась');
  }
  autoInstallAttempted = true;

  const spawnSync = require('child_process').spawnSync;
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.warn('[CRM] Не найдены обязательные зависимости. Выполняется "npm install --production"...');
  const result = spawnSync(
    npmCommand,
    ['install', '--production', '--no-audit', '--no-fund'],
    {
      cwd: __dirname,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm завершился с кодом ${result.status}`);
  }
  console.info('[CRM] Автоматическая установка зависимостей завершена успешно.');
}

function isMissingDependencyError(err, moduleName) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') {
    return false;
  }
  if (typeof err.message !== 'string') {
    return false;
  }
  return err.message.includes(`'${moduleName}'`);
}

function sanitizeCookieName(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.replace(/[^0-9A-Za-z_-]+/g, '');
  if (!cleaned) {
    return null;
  }
  const normalized = cleaned.replace(/^[-_]+/, '');
  return normalized || null;
}

function resolveSessionCookieName(port) {
  const fromEnv = sanitizeCookieName(process.env.SESSION_COOKIE_NAME);
  if (fromEnv) {
    return {
      name: fromEnv,
      source: 'env',
      notice: `[CRM] Имя cookie сессии установлено из SESSION_COOKIE_NAME: ${fromEnv}.`
    };
  }

  const suffix = sanitizeCookieName(process.env.SESSION_COOKIE_SUFFIX);
  if (suffix) {
    const name = `${DEFAULT_SESSION_COOKIE_NAME}_${suffix}`;
    return {
      name,
      source: 'suffix',
      notice: `[CRM] Имя cookie сессии дополнено суффиксом SESSION_COOKIE_SUFFIX: ${name}.`
    };
  }

  const instance = sanitizeCookieName(process.env.INSTANCE_ID || process.env.PLANNER_INSTANCE || process.env.APP_INSTANCE);
  if (instance) {
    const name = `${DEFAULT_SESSION_COOKIE_NAME}_${instance}`;
    return {
      name,
      source: 'instance',
      notice: `[CRM] Имя cookie сессии дополнено идентификатором экземпляра: ${name}.`
    };
  }

  const numericPort = Number.isFinite(port) ? port : Number.parseInt(port, 10);
  if (Number.isFinite(numericPort) && numericPort > 0 && numericPort !== 3000) {
    const name = `${DEFAULT_SESSION_COOKIE_NAME}_${numericPort}`;
    return {
      name,
      source: 'port',
      notice: `[CRM] Имя cookie сессии скорректировано по порту ${numericPort}: ${name}.`
    };
  }

  return {
    name: DEFAULT_SESSION_COOKIE_NAME,
    source: 'default',
    notice: `[CRM] Используется базовое имя cookie сессии: ${DEFAULT_SESSION_COOKIE_NAME}.`
  };
}

function resolveCookieSecureConfiguration() {
  const explicit = process.env.COOKIE_SECURE;
  if (explicit !== undefined) {
    const secure = parseBoolean(explicit, true);
    return {
      enforced: secure,
      preferSecure: secure,
      notice: `[CRM] Флаг Secure для cookie задан через COOKIE_SECURE=${secure ? 'true' : 'false'}.`
    };
  }

  const urlSources = [
    ['PUBLIC_URL', process.env.PUBLIC_URL],
    ['APP_URL', process.env.APP_URL],
    ['APP_ORIGIN', process.env.APP_ORIGIN],
    ['BASE_URL', process.env.BASE_URL]
  ];

  for (const [label, value] of urlSources) {
    const protocol = detectUrlProtocol(value);
    if (protocol === 'https:') {
      return {
        enforced: null,
        preferSecure: true,
        notice: `[CRM] Флаг Secure для cookie определяется автоматически (https) на основе ${label}.`
      };
    }
    if (protocol === 'http:') {
      return {
        enforced: null,
        preferSecure: false,
        notice: `[CRM] Флаг Secure для cookie отключён для HTTP (источник ${label}).`
      };
    }
  }

  const defaultSecure = parseBoolean(process.env.COOKIE_SECURE_DEFAULT, false);
  if (defaultSecure) {
    return {
      enforced: true,
      preferSecure: true,
      notice: '[CRM] Флаг Secure для cookie принудительно включён через COOKIE_SECURE_DEFAULT=true.'
    };
  }

  return {
    enforced: null,
    preferSecure: false,
    notice: '[CRM] Флаг Secure для cookie выбирается автоматически по протоколу запроса.'
  };
}

function detectUrlProtocol(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.protocol;
    }
  } catch (_err) {
    /* ignore */
  }
  return null;
}

function resolveRequestBodyLimit(defaultBytes, maxBytes) {
  const fallback = Number.isFinite(defaultBytes) && defaultBytes > 0 ? Math.floor(defaultBytes) : 10 * 1024 * 1024;
  const ceiling = Number.isFinite(maxBytes) && maxBytes > fallback ? Math.floor(maxBytes) : 512 * 1024 * 1024;
  const sources = [
    ['REQUEST_BODY_LIMIT', process.env.REQUEST_BODY_LIMIT],
    ['BODY_SIZE_LIMIT', process.env.BODY_SIZE_LIMIT],
    ['MAX_BODY_SIZE', process.env.MAX_BODY_SIZE]
  ];

  let warning = null;
  for (const [label, rawValue] of sources) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = String(rawValue).trim();
    if (!value) {
      continue;
    }
    const parsed = parseDataSize(value, null);
    if (parsed === null) {
      warning = `[CRM] Значение ${label}=${value} не распознано. Используется лимит по умолчанию.`;
      continue;
    }
    const normalized = Math.max(1, Math.floor(parsed));
    const bytes = Math.min(normalized, ceiling);
    const limitLabel = formatByteSize(bytes) || `${bytes} байт`;
    const info = {
      bytes,
      source: label,
      label: limitLabel,
      notice: `[CRM] Лимит тела запросов установлен через ${label}: ${limitLabel}.`
    };
    if (bytes !== normalized) {
      info.warning = `[CRM] Значение ${label} ограничено максимумом ${formatByteSize(ceiling) || `${ceiling} байт`}.`;
    } else if (warning) {
      info.warning = warning;
    }
    return info;
  }

  const limitLabel = formatByteSize(fallback) || `${fallback} байт`;
  return {
    bytes: fallback,
    source: 'default',
    label: limitLabel,
    notice: `[CRM] Лимит тела запросов установлен по умолчанию: ${limitLabel}.`,
    warning
  };
}

function isForwardedSecure(req) {
  if (!req || !req.headers) {
    return false;
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
    const primary = forwardedProto.split(',')[0].trim().toLowerCase();
    if (primary === 'https') {
      return true;
    }
  }
  const forwarded = req.headers.forwarded;
  if (typeof forwarded === 'string' && forwarded.includes('proto=')) {
    const segments = forwarded.split(';');
    for (const segment of segments) {
      const [key, rawValue] = segment.split('=');
      if (typeof key === 'string' && key.trim().toLowerCase() === 'proto') {
        if (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === 'https') {
          return true;
        }
      }
    }
  }
  return false;
}

function isRequestSecure(req) {
  if (!req) {
    return false;
  }
  if (req.secure === true) {
    return true;
  }
  if (req.protocol === 'https') {
    return true;
  }
  if (req.connection?.encrypted) {
    return true;
  }
  return isForwardedSecure(req);
}

function shouldUseSecureCookies(req) {
  if (COOKIE_SECURE_ENFORCED === true) {
    return true;
  }
  if (COOKIE_SECURE_ENFORCED === false) {
    return false;
  }
  if (isRequestSecure(req)) {
    return true;
  }
  if (COOKIE_SECURE_PREFERRED) {
    return true;
  }
  return false;
}

let autoInstallAttempted = false;

const express = requireWithAutoInstall('express');
const compression = requireWithAutoInstall('compression');
const Database = requireWithAutoInstall('better-sqlite3');

let bcrypt;
try {
  bcrypt = requireWithAutoInstall('bcryptjs');
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    console.warn('[CRM] Модуль "bcryptjs" не установлен, используется резервная сборка из lib/bcryptjs.js.');
    bcrypt = require('./lib/bcryptjs');
  } else {
    throw err;
  }
}

const DEFAULT_SESSION_COOKIE_NAME = 'pc_session';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SESSION_COOKIE_INFO = resolveSessionCookieName(PORT);
const SESSION_COOKIE_NAME = SESSION_COOKIE_INFO.name;
const COOKIE_SECURE_CONFIG = resolveCookieSecureConfiguration();
const COOKIE_SECURE_ENFORCED = COOKIE_SECURE_CONFIG.enforced;
const COOKIE_SECURE_PREFERRED = COOKIE_SECURE_CONFIG.preferSecure;
const DEFAULT_BODY_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const REQUEST_BODY_LIMIT_INFO = resolveRequestBodyLimit(DEFAULT_BODY_SIZE_LIMIT_BYTES, 512 * 1024 * 1024);
const REQUEST_BODY_LIMIT_BYTES = REQUEST_BODY_LIMIT_INFO.bytes;

if (SESSION_COOKIE_INFO.notice) {
  console.info(SESSION_COOKIE_INFO.notice);
}
if (COOKIE_SECURE_CONFIG.notice) {
  console.info(COOKIE_SECURE_CONFIG.notice);
}
if (REQUEST_BODY_LIMIT_INFO.notice) {
  console.info(REQUEST_BODY_LIMIT_INFO.notice);
}
if (REQUEST_BODY_LIMIT_INFO.warning) {
  console.warn(REQUEST_BODY_LIMIT_INFO.warning);
}

const DEFAULT_DATA_DIR = path.join(__dirname, 'data');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR_INFO = resolveDataDirectory();
const DATA_DIR = DATA_DIR_INFO.path;
const LOCAL_STATE_FILE = path.join(DATA_DIR, 'planner-state.json');
const SQLITE_FILE = path.join(DATA_DIR, 'planner.db');
const USERS_EXPORT_FILE = path.join(DATA_DIR, 'users.json');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');

if (Array.isArray(DATA_DIR_INFO.previousErrors) && DATA_DIR_INFO.previousErrors.length) {
  const failedDefault = DATA_DIR_INFO.previousErrors.find((entry) => entry && entry.path === DEFAULT_DATA_DIR);
  if (failedDefault) {
    const reason = failedDefault.error?.message || failedDefault.reason || 'неизвестная ошибка';
    console.warn(`[CRM] Каталог данных по умолчанию ${DEFAULT_DATA_DIR} недоступен (${reason}). Используется ${DATA_DIR}.`);
  }
}
if (DATA_DIR_INFO.source === 'env') {
  console.info(`[CRM] Используется каталог данных ${DATA_DIR} из переменной окружения.`);
} else if (DATA_DIR_INFO.source === 'fallback' && !DATA_DIR_INFO.silent) {
  console.info(`[CRM] Используется резервный каталог данных ${DATA_DIR}.`);
}

const SESSION_TTL_MS = Math.max(1, Number.parseInt(process.env.SESSION_TTL_HOURS || '12', 10)) * 3600 * 1000;
const SESSION_RENEW_THRESHOLD_MS = SESSION_TTL_MS / 3;
const AUTH_MODE = (process.env.AUTH_MODE || 'local').trim().toLowerCase();
const ALLOW_GUEST_LOGIN = parseBoolean(process.env.ALLOW_GUEST ?? 'true', true);
const MAX_FAILED_ATTEMPTS = Math.max(1, Number.parseInt(process.env.AUTH_MAX_FAILED_ATTEMPTS || '5', 10));
const LOCKOUT_MINUTES = Math.max(1, Number.parseInt(process.env.AUTH_LOCKOUT_MINUTES || '15', 10));
const SESSION_IDLE_TIMEOUT_MS = Math.max(SESSION_TTL_MS, 60 * 60 * 1000);
const DEFAULT_ADMIN_LOGIN = (process.env.DEFAULT_ADMIN_LOGIN || 'admin').trim() || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
const DEFAULT_CREDENTIALS_TEMPLATE = {
  users: [
    {
      login: DEFAULT_ADMIN_LOGIN,
      password: DEFAULT_ADMIN_PASSWORD,
      displayName: 'Системный администратор',
      roles: ['superadmin']
    }
  ]
};
const DUMMY_BCRYPT_HASH = '$2b$10$Bk.MJErekvE/IjbhVyN0heNG48DL7Msis1TcSggoldLlYzUkyJDD2';

class StorageWriteError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageWriteError';
    this.code = 'STORAGE_PERMISSION';
    if (options && typeof options === 'object') {
      if (options.path) {
        this.path = options.path;
      }
      if (options.cause) {
        this.cause = options.cause;
      }
    }
  }
}

function isStoragePermissionError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = typeof err.code === 'string' ? err.code : null;
  const errno = typeof err.errno === 'number' ? err.errno : null;
  const name = typeof err.name === 'string' ? err.name : null;
  const normalizedCode = code ? code.toUpperCase() : '';
  const normalizedName = name ? name.toUpperCase() : '';
  if (['EACCES', 'EPERM', 'EROFS', 'SQLITE_READONLY', 'SQLITE_CANTOPEN', 'SQLITE_PERM'].includes(normalizedCode)) {
    return true;
  }
  if (['SQLITE_READONLY', 'SQLITE_IOERR'].includes(normalizedName)) {
    return true;
  }
  if (errno === -13) { // POSIX EACCES
    return true;
  }
  const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  if (message.includes('read-only') || message.includes('permission denied')) {
    return true;
  }
  return false;
}

function ensureWritableDirectory(targetPath) {
  if (!targetPath) {
    throw new Error('Каталог данных не задан');
  }
  fs.mkdirSync(targetPath, { recursive: true });
  const probePath = path.join(targetPath, `.permcheck-${process.pid}-${Date.now()}`);
  let created = false;
  try {
    fs.writeFileSync(probePath, 'ok', { mode: 0o600 });
    created = true;
  } finally {
    if (created) {
      try {
        fs.unlinkSync(probePath);
      } catch (_err) {
        /* ignore */
      }
    }
  }
  fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK);
}

function normalizeDataDirCandidate(dir) {
  if (dir === null || dir === undefined) {
    return null;
  }
  const trimmed = String(dir).trim();
  if (!trimmed) {
    return null;
  }
  try {
    return path.resolve(trimmed);
  } catch (_err) {
    return trimmed;
  }
}

function resolveDataDirectory() {
  const envDirRaw = process.env.DATA_DIR || process.env.PLANNER_DATA_DIR;
  const envDir = normalizeDataDirCandidate(envDirRaw);
  const homeDir = typeof os.homedir === 'function' ? os.homedir() : null;
  const seen = new Set();
  const candidates = [];

  const pushCandidate = (entry) => {
    if (!entry || !entry.path) {
      return;
    }
    if (seen.has(entry.path)) {
      return;
    }
    seen.add(entry.path);
    candidates.push(entry);
  };

  if (envDir) {
    pushCandidate({ path: envDir, source: 'env', mandatory: true, label: 'DATA_DIR' });
  }

  pushCandidate({ path: DEFAULT_DATA_DIR, source: 'default', mandatory: false, label: 'project data/' });

  if (homeDir) {
    pushCandidate({
      path: path.join(homeDir, '.local', 'share', 'planner-crm'),
      source: 'fallback',
      mandatory: false,
      label: 'home data dir'
    });
    pushCandidate({
      path: path.join(homeDir, '.planner-crm'),
      source: 'fallback',
      mandatory: false,
      label: 'legacy home data dir'
    });
  }

  const errors = [];

  for (const candidate of candidates) {
    try {
      ensureWritableDirectory(candidate.path);
      return {
        ...candidate,
        previousErrors: errors.slice(),
        silent: candidate.source !== 'env' && errors.length === 0
      };
    } catch (err) {
      const record = {
        ...candidate,
        error: err,
        reason: isStoragePermissionError(err) ? 'permission' : err?.code || err?.message || 'error'
      };
      errors.push(record);
      if (candidate.mandatory) {
        const message = `Каталог данных ${candidate.path} недоступен: ${err?.message || err}`;
        const failure = new Error(message);
        failure.cause = err;
        failure.previousErrors = errors.slice();
        throw failure;
      }
    }
  }

  const summary = errors.length
    ? errors.map((entry) => `${entry.path} (${entry.reason || entry.label || 'ошибка'})`).join('; ')
    : 'нет доступных путей';
  const fallbackError = new Error(`Не удалось подобрать каталог данных. Проверенные пути: ${summary}`);
  fallbackError.previousErrors = errors;
  throw fallbackError;
}

let sqlite = null;
let lastSessionCleanup = 0;

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

    CREATE TABLE IF NOT EXISTS planner_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      settings_hash TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stage_allocations (
      stage TEXT PRIMARY KEY,
      tasks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      description TEXT,
      permissions_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      display_name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      password_updated_at TEXT,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      is_guest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      roles TEXT,
      action TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS report_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_public INTEGER NOT NULL DEFAULT 1,
      allowed_roles TEXT,
      layout_json TEXT,
      widgets_json TEXT NOT NULL,
      filters_json TEXT,
      meta_json TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS report_preset_visibility (
      user_id INTEGER NOT NULL,
      preset_id INTEGER NOT NULL,
      is_visible INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, preset_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (preset_id) REFERENCES report_presets(id) ON DELETE CASCADE
    );
  `);
  ensureAuthBootstrap();
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

const STAGE_SLUGS = Object.freeze([
  'draw',
  'proc',
  'shear',
  'laser',
  'bend',
  'weld',
  'mech',
  'coop',
  'pack',
  'ship'
]);

const ROLE_PERMISSION_KEYS = Object.freeze([
  'view',
  'write',
  'viewOrderDetails',
  'manageUsers',
  'manageSettings',
  'manageStages',
  'manageOrders',
  'completeOrders',
  'viewAudit',
  'useJournal',
  'editComments',
  'deleteComments',
  'addStages',
  'viewReports',
  'useReportPresets',
  'editReportPresets',
  'deleteReportPresets',
  'accessReportBuilder'
]);

function createStageAccessDefaults(enabled) {
  return STAGE_SLUGS.reduce((acc, slug) => {
    acc[slug] = !!enabled;
    return acc;
  }, {});
}

const DEFAULT_ROLE_PERMISSIONS = {
  superadmin: {
    view: true,
    write: true,
    viewOrderDetails: true,
    manageUsers: true,
    manageSettings: true,
    manageStages: true,
    manageOrders: true,
    completeOrders: true,
    viewAudit: true,
    useJournal: true,
    editComments: true,
    deleteComments: true,
    addStages: true,
    viewReports: true,
    useReportPresets: true,
    editReportPresets: true,
    deleteReportPresets: true,
    accessReportBuilder: true,
    stageAccess: createStageAccessDefaults(true)
  },
  admin: {
    view: true,
    write: true,
    viewOrderDetails: true,
    manageUsers: false,
    manageSettings: true,
    manageStages: true,
    manageOrders: true,
    completeOrders: true,
    viewAudit: true,
    useJournal: true,
    editComments: true,
    deleteComments: true,
    addStages: true,
    viewReports: true,
    useReportPresets: true,
    editReportPresets: true,
    deleteReportPresets: true,
    accessReportBuilder: true,
    stageAccess: createStageAccessDefaults(true)
  },
  master: {
    view: true,
    write: true,
    viewOrderDetails: true,
    manageUsers: false,
    manageSettings: false,
    manageStages: true,
    manageOrders: false,
    completeOrders: false,
    viewAudit: false,
    useJournal: true,
    editComments: false,
    deleteComments: false,
    addStages: true,
    viewReports: true,
    useReportPresets: true,
    editReportPresets: false,
    deleteReportPresets: false,
    accessReportBuilder: false,
    stageAccess: createStageAccessDefaults(true)
  },
  guest: {
    view: true,
    write: false,
    viewOrderDetails: true,
    manageUsers: false,
    manageSettings: false,
    manageStages: false,
    manageOrders: false,
    completeOrders: false,
    viewAudit: false,
    useJournal: false,
    editComments: false,
    deleteComments: false,
    addStages: false,
    viewReports: false,
    useReportPresets: false,
    editReportPresets: false,
    deleteReportPresets: false,
    accessReportBuilder: false,
    stageAccess: createStageAccessDefaults(false)
  }
};
DEFAULT_ROLE_PERMISSIONS.administrator = DEFAULT_ROLE_PERMISSIONS.admin;
const ROLE_SEEDS = [
  {
    slug: 'superadmin',
    displayName: 'Super Админ',
    description: 'Полный доступ к системе, управление пользователями, ролями, настройками и журналами.',
    permissions: DEFAULT_ROLE_PERMISSIONS.superadmin
  },
  {
    slug: 'admin',
    displayName: 'Admin',
    description: 'Управление заказами, маршрутами и настройками производства. Доступны все операции мастера участка.',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin
  },
  {
    slug: 'master',
    displayName: 'Мастер участка',
    description: 'Отмечает готовность переделов, управляет бронью и исключениями, оставляет комментарии.',
    permissions: DEFAULT_ROLE_PERMISSIONS.master
  },
  {
    slug: 'guest',
    displayName: 'Гость',
    description: 'Только просмотр текущего состояния без возможности внесения изменений.',
    permissions: DEFAULT_ROLE_PERMISSIONS.guest
  }
];
const ROLE_SLUG_ALIASES = new Map([
  ['administrator', 'admin']
]);
const ROLE_LOOKUP = new Map();
ROLE_SEEDS.forEach((role) => {
  ROLE_LOOKUP.set(role.slug, { displayName: role.displayName, description: role.description });
});

function updateRoleLookup(slug, meta = {}) {
  if (!slug) return;
  const displayName = typeof meta.displayName === 'string' && meta.displayName.trim() ? meta.displayName.trim() : slug;
  const description = typeof meta.description === 'string' ? meta.description : '';
  ROLE_LOOKUP.set(slug, { displayName, description });
}

let rolePermissionCache = new Map();


const app = express();
app.use(compression());
app.use(express.json({ limit: REQUEST_BODY_LIMIT_BYTES, strict: false }));
app.use(express.text({ limit: REQUEST_BODY_LIMIT_BYTES, type: ['text/plain', 'application/octet-stream'] }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT_BYTES }));
app.use((err, req, res, next) => {
  if (!err) {
    next();
    return;
  }
  if (err.type === 'entity.too.large' || err.status === 413) {
    const limitLabel = REQUEST_BODY_LIMIT_INFO.label;
    const payload = {
      error: 'Payload Too Large',
      limit: REQUEST_BODY_LIMIT_BYTES,
      limitHuman: limitLabel
    };
    if (req.accepts('json')) {
      res.status(413).json(payload);
    } else {
      res.status(413).type('text/plain').send(`Payload Too Large. Максимальный размер: ${limitLabel}.`);
    }
    return;
  }
  next(err);
});

function sessionMiddleware(req, res, next) {
  try {
    req.authMode = AUTH_MODE;
    req.allowGuest = ALLOW_GUEST_LOGIN;
    const token = getSessionToken(req);
    if (!token) {
      req.session = null;
      req.user = null;
      return next();
    }
    const session = resolveSession(token);
    if (!session) {
      clearSessionCookie(req, res);
      req.session = null;
      req.user = null;
      return next();
    }
    req.session = session;
    req.user = session.user;
    res.locals.currentUser = session.user;
    const renewal = touchSession(session.id, session.lastSeenAt);
    if (renewal) {
      session.lastSeenAt = renewal.lastSeenAt;
      session.expiresAt = renewal.expiresAt;
      setSessionCookie(req, res, session.id);
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

app.use(sessionMiddleware);

function requireAuth(permission = null) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (permission) {
      const allowed = req.user?.permissions?.[permission];
      if (!allowed) {
        res.status(403).json({ error: 'Forbidden', permission });
        return;
      }
    }
    next();
  };
}

function ensureGuestAllowed(req, res, next) {
  if (!ALLOW_GUEST_LOGIN) {
    res.status(403).json({ error: 'Guest access disabled' });
    return;
  }
  next();
}

function ensureAuthBootstrap() {
  if (!sqlite) {
    return;
  }
  const db = sqlite;
  const now = new Date().toISOString();
  ensureRolePermissionColumn(db);
  const insertRole = db.prepare(`
    INSERT OR IGNORE INTO roles (slug, display_name, description, permissions_json, created_at, updated_at)
    VALUES (@slug, @display_name, @description, @permissions_json, @created_at, @updated_at)
  `);
  const selectRoleBySlug = db.prepare('SELECT id FROM roles WHERE slug = ?');
  const selectUserIdsByRole = db.prepare('SELECT user_id FROM user_roles WHERE role_id = ?');
  const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
  const deleteUserRoleByRole = db.prepare('DELETE FROM user_roles WHERE role_id = ?');
  const deleteRoleById = db.prepare('DELETE FROM roles WHERE id = ?');
  const updateRoleIdentity = db.prepare('UPDATE roles SET slug = ?, display_name = ?, updated_at = ? WHERE id = ?');
  const updateRoleDisplay = db.prepare('UPDATE roles SET display_name = ?, updated_at = ? WHERE id = ?');

  const mergeRole = (fromSlug, toSlug, toDisplayName) => {
    const fromRole = selectRoleBySlug.get(fromSlug);
    if (!fromRole?.id) {
      return;
    }
    const toRole = selectRoleBySlug.get(toSlug);
    if (toRole?.id) {
      const userRows = selectUserIdsByRole.all(fromRole.id);
      userRows.forEach((row) => {
        if (row?.user_id) {
          insertUserRole.run(row.user_id, toRole.id);
        }
      });
      deleteUserRoleByRole.run(fromRole.id);
      deleteRoleById.run(fromRole.id);
      updateRoleDisplay.run(toDisplayName, now, toRole.id);
      return;
    }
    updateRoleIdentity.run(toSlug, toDisplayName, now, fromRole.id);
  };

  mergeRole('admin', 'superadmin', 'Super Админ');
  mergeRole('administrator', 'admin', 'Admin');

  for (const role of ROLE_SEEDS) {
    insertRole.run({
      slug: role.slug,
      display_name: role.displayName,
      description: role.description,
      permissions_json: JSON.stringify(role.permissions || DEFAULT_ROLE_PERMISSIONS[role.slug] || {}),
      created_at: now,
      updated_at: now
    });
  }

  const selectRoles = db.prepare('SELECT slug, permissions_json FROM roles');
  const updateRoleSlug = db.prepare('UPDATE roles SET slug = ?, updated_at = ? WHERE slug = ?');
  const updateRolePermissions = db.prepare('UPDATE roles SET permissions_json = ?, updated_at = ? WHERE slug = ?');
  selectRoles.all().forEach((row) => {
    const rawSlug = typeof row.slug === 'string' ? row.slug.trim().toLowerCase() : '';
    const alias = ROLE_SLUG_ALIASES.get(rawSlug);
    if (alias && alias !== rawSlug) {
      updateRoleSlug.run(alias, now, rawSlug);
      row.slug = alias;
    }
    const slug = normalizeRoleSlug(row.slug);
    if (!slug) return;
    const normalizedPermissions = parseRolePermissions(row.permissions_json, slug);
    const serialized = JSON.stringify(normalizedPermissions);
    if (serialized !== row.permissions_json) {
      updateRolePermissions.run(serialized, now, slug);
    }
  });

  ensureCredentialTemplateFile();
  const manualEntries = readManualCredentialEntries();
  applyManualCredentialEntries(db, manualEntries, now);

  const totalUsersRow = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  const userCount = Number(totalUsersRow?.count || 0);
  if (userCount > 0) {
    refreshRolePermissionCache();
    ensureUsersExportSnapshot();
    return;
  }

  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
  const insertUser = db.prepare(`
    INSERT INTO users (login, password_hash, display_name, is_active, created_at, updated_at, last_login_at, password_updated_at)
    VALUES (@login, @password_hash, @display_name, 1, @created_at, @updated_at, NULL, @password_updated_at)
  `);
  const userResult = insertUser.run({
    login: DEFAULT_ADMIN_LOGIN,
    password_hash: passwordHash,
    display_name: 'Системный администратор',
    created_at: now,
    updated_at: now,
    password_updated_at: now
  });
  const userId = Number(userResult.lastInsertRowid);
  if (Number.isFinite(userId)) {
    let roleRow = db.prepare('SELECT id FROM roles WHERE slug = ?').get('superadmin');
    if (!roleRow?.id) {
      roleRow = db.prepare('SELECT id FROM roles WHERE slug = ?').get('admin');
    }
    if (roleRow?.id) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleRow.id);
    }
    console.warn(`Создан пользователь по умолчанию ${DEFAULT_ADMIN_LOGIN}. Пароль необходимо сменить после первого входа.`);
  }
  refreshRolePermissionCache();
  ensureUsersExportSnapshot();
}

function normalizeRoleSlug(input) {
  if (!input && input !== 0) return null;
  const normalized = String(input).trim().toLowerCase();
  if (!normalized) return null;
  const candidate = ROLE_SLUG_ALIASES.get(normalized) || normalized;
  if (ROLE_LOOKUP.has(candidate) || rolePermissionCache.has(candidate)) {
    return candidate;
  }
  return null;
}

function normalizeRolePermissions(payload, slug) {
  const result = {};
  const defaults = (slug && DEFAULT_ROLE_PERMISSIONS[slug]) || {};
  for (const key of ROLE_PERMISSION_KEYS) {
    const rawValue = payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : undefined;
    if (typeof rawValue === 'boolean') {
      result[key] = rawValue;
    } else {
      result[key] = !!defaults[key];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(payload || {}, 'addStages') && defaults.addStages === undefined) {
    result.addStages = !!result.manageStages;
  }
  const stageDefaults = defaults.stageAccess && typeof defaults.stageAccess === 'object' ? defaults.stageAccess : {};
  const sourceStages = payload && typeof payload.stageAccess === 'object' ? payload.stageAccess : {};
  const stageAccess = {};
  for (const stage of STAGE_SLUGS) {
    if (typeof sourceStages[stage] === 'boolean') {
      stageAccess[stage] = sourceStages[stage];
    } else if (typeof stageDefaults[stage] === 'boolean') {
      stageAccess[stage] = stageDefaults[stage];
    } else {
      stageAccess[stage] = !!result.manageStages;
    }
  }
  result.stageAccess = stageAccess;
  return result;
}

function parseRolePermissions(raw, slug) {
  if (!raw && raw !== 0) {
    return normalizeRolePermissions({}, slug);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return normalizeRolePermissions(parsed, slug);
      }
    } catch (_err) {
      return normalizeRolePermissions({}, slug);
    }
  }
  if (typeof raw === 'object' && raw !== null) {
    return normalizeRolePermissions(raw, slug);
  }
  return normalizeRolePermissions({}, slug);
}

function refreshRolePermissionCache() {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT slug, display_name, description, permissions_json FROM roles').all();
    const map = new Map();
    rows.forEach((row) => {
      const slug = normalizeRoleSlug(row.slug);
      if (!slug) return;
      const parsed = parseRolePermissions(row.permissions_json, slug);
      map.set(slug, parsed);
      updateRoleLookup(slug, { displayName: row.display_name, description: row.description });
    });
    rolePermissionCache = map;
  } catch (err) {
    console.warn('Failed to refresh role permission cache', err);
  }
}

function getRolePermissions(slug) {
  const normalized = normalizeRoleSlug(slug);
  if (!normalized) {
    return normalizeRolePermissions({}, slug);
  }
  const cached = rolePermissionCache.get(normalized);
  if (cached) {
    return cached;
  }
  const fallback = normalizeRolePermissions({}, normalized);
  rolePermissionCache.set(normalized, fallback);
  return fallback;
}

function ensureRolePermissionColumn(db) {
  try {
    const columns = db.prepare('PRAGMA table_info(roles)').all();
    const hasColumn = columns.some((col) => col?.name === 'permissions_json');
    if (!hasColumn) {
      db.exec('ALTER TABLE roles ADD COLUMN permissions_json TEXT');
    }
  } catch (err) {
    console.error('Failed to ensure permissions column on roles table', err);
  }
}

function exportUsersToFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const db = getDatabase();
    const users = db
      .prepare(
        `SELECT id, login, display_name, is_active, password_hash, created_at, updated_at, last_login_at, password_updated_at
           FROM users
          ORDER BY id ASC`
      )
      .all();
    const rolePairs = db
      .prepare(
        `SELECT ur.user_id AS userId, r.slug AS roleSlug
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id`
      )
      .all();
    const roleMap = new Map();
    rolePairs.forEach((pair) => {
      if (!pair) return;
      const list = roleMap.get(pair.userId) || [];
      list.push(pair.roleSlug);
      roleMap.set(pair.userId, list);
    });
    const snapshot = {
      exportedAt: new Date().toISOString(),
      authMode: AUTH_MODE,
      users: users.map((row) => {
        const assigned = roleMap.get(row.id) || [];
        const roles = assigned
          .map((slug) => {
            const normalized = normalizeRoleSlug(slug);
            if (normalized) return normalized;
            if (!slug && slug !== 0) return null;
            return String(slug).trim() || null;
          })
          .filter(Boolean);
        return {
          login: row.login,
          displayName: row.display_name,
          isActive: Number(row.is_active) !== 0,
          passwordHash: row.password_hash,
          roles,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastLoginAt: row.last_login_at || null,
          passwordUpdatedAt: row.password_updated_at || null
        };
      })
    };
    fs.writeFileSync(USERS_EXPORT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    console.error('Не удалось сохранить экспорт пользователей', err);
  }
}

function ensureUsersExportSnapshot() {
  try {
    exportUsersToFile();
  } catch (err) {
    console.warn('Failed to write users snapshot', err);
  }
}

function ensureCredentialTemplateFile() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(DEFAULT_CREDENTIALS_TEMPLATE, null, 2), 'utf8');
      console.info(`[CRM] Создан файл учётных записей ${CREDENTIALS_FILE}.`);
    }
  } catch (err) {
    console.warn(`[CRM] Не удалось подготовить файл учётных записей ${CREDENTIALS_FILE}:`, err);
  }
}

function looksLikeBcryptHash(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value.trim());
}

function normalizeCredentialEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const login = sanitizeLogin(raw.login || raw.username || raw.user);
  if (!login) {
    return null;
  }
  const displayNameRaw = typeof raw.displayName === 'string' ? raw.displayName : raw.name;
  const displayName = displayNameRaw && displayNameRaw.trim() ? displayNameRaw.trim() : login;
  let password = '';
  if (typeof raw.password === 'string') {
    password = raw.password.trim();
  } else if (typeof raw.pass === 'string') {
    password = raw.pass.trim();
  }
  if (!password && typeof raw.passwordHash === 'string') {
    password = raw.passwordHash.trim();
  }
  const isActive = raw.isActive !== undefined ? !!parseBoolean(raw.isActive, true) : true;
  const roleCandidates = [];
  if (Array.isArray(raw.roles)) {
    roleCandidates.push(...raw.roles);
  }
  if (typeof raw.role === 'string') {
    roleCandidates.push(raw.role);
  }
  const normalizedRoles = Array.from(
    new Set(
      roleCandidates
        .map((value) => normalizeRoleSlug(value))
        .filter(Boolean)
    )
  );
  return {
    login,
    displayName,
    password,
    passwordIsHash: looksLikeBcryptHash(password),
    isActive,
    roles: normalizedRoles
  };
}

function readManualCredentialEntries() {
  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.users) ? parsed.users : [];
    const result = [];
    for (const entry of list) {
      const normalized = normalizeCredentialEntry(entry);
      if (normalized) {
        result.push(normalized);
      }
    }
    return result;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [];
    }
    console.warn(`[CRM] Не удалось прочитать учётные записи из ${CREDENTIALS_FILE}:`, err);
    return [];
  }
}

function applyManualCredentialEntries(db, entries, nowIso) {
  if (!Array.isArray(entries) || !entries.length) {
    return false;
  }
  const selectUser = db.prepare('SELECT id, password_hash, display_name FROM users WHERE login = ?');
  const insertUser = db.prepare(
    `INSERT INTO users (login, password_hash, display_name, is_active, created_at, updated_at, last_login_at, password_updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
  );
  const updateUser = db.prepare(
    `UPDATE users
        SET display_name = ?, is_active = ?, updated_at = ?, password_hash = ?, password_updated_at = ?
      WHERE id = ?`
  );
  const updateUserNoPassword = db.prepare(
    `UPDATE users
        SET display_name = ?, is_active = ?, updated_at = ?
      WHERE id = ?`
  );
  const selectUserRoles = db.prepare(
    `SELECT r.id, r.slug
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?`
  );
  const deleteUserRole = db.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?');
  const insertUserRole = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)');
  const selectRoleId = db.prepare('SELECT id FROM roles WHERE slug = ?');
  const roleIdCache = new Map();
  const getRoleId = (slug) => {
    if (roleIdCache.has(slug)) {
      return roleIdCache.get(slug);
    }
    const row = selectRoleId.get(slug);
    const id = row?.id ? Number(row.id) : null;
    if (id) {
      roleIdCache.set(slug, id);
    }
    return id;
  };

  let changeCount = 0;
  for (const entry of entries) {
    const userRow = selectUser.get(entry.login);
    let passwordHash = null;
    let shouldUpdatePassword = false;
    if (entry.passwordIsHash && entry.password) {
      passwordHash = entry.password;
      shouldUpdatePassword = !userRow || userRow.password_hash !== passwordHash;
    } else if (entry.password && bcrypt) {
      if (userRow && userRow.password_hash) {
        try {
          if (bcrypt.compareSync(entry.password, userRow.password_hash)) {
            passwordHash = userRow.password_hash;
            shouldUpdatePassword = false;
          } else {
            passwordHash = bcrypt.hashSync(entry.password, 10);
            shouldUpdatePassword = true;
          }
        } catch (err) {
          console.warn(`[CRM] Не удалось сравнить пароль для ${entry.login}:`, err);
          passwordHash = bcrypt.hashSync(entry.password, 10);
          shouldUpdatePassword = true;
        }
      } else {
        passwordHash = bcrypt.hashSync(entry.password, 10);
        shouldUpdatePassword = true;
      }
    }

    if (!userRow && !passwordHash) {
      console.warn(`[CRM] Учётная запись ${entry.login} пропущена: требуется пароль или passwordHash.`);
      continue;
    }

    if (userRow) {
      if (shouldUpdatePassword && passwordHash) {
        const info = updateUser.run(entry.displayName, entry.isActive ? 1 : 0, nowIso, passwordHash, nowIso, userRow.id);
        changeCount += info?.changes || 0;
      } else {
        const info = updateUserNoPassword.run(entry.displayName, entry.isActive ? 1 : 0, nowIso, userRow.id);
        changeCount += info?.changes || 0;
      }
      if (entry.roles && entry.roles.length) {
        const desired = new Set(entry.roles);
        const currentRows = selectUserRoles.all(userRow.id) || [];
        const current = new Map();
        currentRows.forEach((row) => {
          const slug = normalizeRoleSlug(row.slug);
          if (slug && row.id) {
            current.set(slug, Number(row.id));
          }
        });
        for (const slug of desired) {
          const roleId = getRoleId(slug);
          if (!roleId) {
            console.warn(`[CRM] Роль ${slug} для пользователя ${entry.login} не найдена.`);
            continue;
          }
          if (!current.has(slug)) {
            const info = insertUserRole.run(userRow.id, roleId);
            changeCount += info?.changes || 0;
          }
        }
        for (const [slug, roleId] of current.entries()) {
          if (!desired.has(slug)) {
            const info = deleteUserRole.run(userRow.id, roleId);
            changeCount += info?.changes || 0;
          }
        }
      }
      continue;
    }

    if (!entry.roles || !entry.roles.length) {
      console.warn(`[CRM] Учётная запись ${entry.login} пропущена: требуется хотя бы одна роль.`);
      continue;
    }

    const info = insertUser.run(
      entry.login,
      passwordHash,
      entry.displayName,
      entry.isActive ? 1 : 0,
      nowIso,
      nowIso,
      nowIso
    );
    const userId = Number(info?.lastInsertRowid);
    if (!Number.isFinite(userId)) {
      console.warn(`[CRM] Не удалось создать пользователя ${entry.login}.`);
      continue;
    }
    changeCount += info?.changes || 0;
    for (const slug of entry.roles) {
      const roleId = getRoleId(slug);
      if (!roleId) {
        console.warn(`[CRM] Роль ${slug} для пользователя ${entry.login} не найдена.`);
        continue;
      }
      const roleInfo = insertUserRole.run(userId, roleId);
      changeCount += roleInfo?.changes || 0;
    }
  }

  if (changeCount > 0) {
    console.info(`[CRM] Синхронизировано учётных записей из credentials.json: ${changeCount}.`);
    return true;
  }
  return false;
}

function computePermissions(roleSlugs) {
  const permissions = normalizeRolePermissions({}, null);
  if (!Array.isArray(roleSlugs)) {
    return permissions;
  }
  for (const slugRaw of roleSlugs) {
    const slug = normalizeRoleSlug(slugRaw);
    if (!slug) continue;
    const rolePerms = getRolePermissions(slug);
    for (const key of ROLE_PERMISSION_KEYS) {
      if (rolePerms[key]) {
        permissions[key] = true;
      }
    }
    if (rolePerms.stageAccess && typeof rolePerms.stageAccess === 'object') {
      for (const stage of STAGE_SLUGS) {
        if (rolePerms.stageAccess[stage]) {
          permissions.stageAccess[stage] = true;
        }
      }
    }
  }
  return permissions;
}

function buildRoleDetails(roleSlugs) {
  if (!Array.isArray(roleSlugs)) {
    return [];
  }
  return roleSlugs
    .map((slug) => {
      const normalized = normalizeRoleSlug(slug);
      if (!normalized) return null;
      const meta = ROLE_LOOKUP.get(normalized);
      return {
        slug: normalized,
        displayName: meta?.displayName || normalized
      };
    })
    .filter(Boolean);
}

function buildUserPayload(userRow, roleRows) {
  if (!userRow) {
    return null;
  }
  const roles = Array.isArray(roleRows)
    ? roleRows.map((role) => normalizeRoleSlug(role.slug || role.role_slug || role))
    : [];
  const uniqueRoles = Array.from(new Set(roles.filter(Boolean)));
  const permissions = computePermissions(uniqueRoles);
  return {
    id: Number(userRow.id),
    login: userRow.login,
    displayName: userRow.display_name,
    isActive: Number(userRow.is_active) !== 0,
    lastLoginAt: userRow.last_login_at || null,
    lockedUntil: userRow.locked_until || null,
    roles: uniqueRoles,
    roleDetails: buildRoleDetails(uniqueRoles),
    permissions
  };
}

function readUserWithRolesByLogin(login) {
  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!user) {
    return null;
  }
  const roles = db
    .prepare(
      `SELECT r.slug
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?`
    )
    .all(user.id);
  return { user, roles };
}

function readUserWithRolesById(userId) {
  const db = getDatabase();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return null;
  }
  const roles = db
    .prepare(
      `SELECT r.slug
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?`
    )
    .all(user.id);
  return { user, roles };
}

function listAllRoles() {
  const db = getDatabase();
  return db
    .prepare('SELECT id, slug, display_name, description, permissions_json FROM roles ORDER BY id ASC')
    .all()
    .map((row) => {
      const entry = {
        id: Number(row.id),
        slug: row.slug,
        displayName: row.display_name,
        description: row.description || '',
        permissions: parseRolePermissions(row.permissions_json, row.slug)
      };
      updateRoleLookup(row.slug, { displayName: row.display_name, description: row.description });
      return entry;
    });
}

function sanitizeLogin(login) {
  if (typeof login !== 'string') {
    return null;
  }
  const trimmed = login.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

function normalizeRoleSlugForCreate(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!/^[a-z0-9_-]{3,32}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function sanitizeRoleDisplayName(input) {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  return trimmed || null;
}

function parseCookies(header) {
  if (!header || typeof header !== 'string') {
    return {};
  }
  return header.split(';').reduce((acc, part) => {
    const segment = part.trim();
    if (!segment) return acc;
    const eqIndex = segment.indexOf('=');
    if (eqIndex === -1) {
      acc[segment] = '';
      return acc;
    }
    const key = segment.slice(0, eqIndex).trim();
    const value = segment.slice(eqIndex + 1);
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch (_err) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers?.cookie || '');
  const token = cookies[SESSION_COOKIE_NAME];
  if (typeof token !== 'string') {
    return null;
  }
  const trimmed = token.trim();
  return trimmed ? trimmed : null;
}

function purgeExpiredSessions() {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
}

function loadSessionRecord(sessionId) {
  if (!sessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT s.id, s.user_id, s.is_guest, s.created_at, s.last_seen_at, s.expires_at,
              u.login, u.display_name, u.is_active, u.locked_until
         FROM sessions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(sessionId);
  if (!row) {
    return null;
  }
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : null;
  const now = Date.now();
  if (expiresAt && expiresAt <= now) {
    try {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    } catch (_err) {
      /* ignore */
    }
    return null;
  }
  return row;
}

function touchSession(sessionId, previousLastSeenIso) {
  if (!sessionId) return null;
  const db = getDatabase();
  const now = Date.now();
  const lastSeen = previousLastSeenIso ? Date.parse(previousLastSeenIso) : 0;
  if (Number.isFinite(lastSeen) && now - lastSeen < SESSION_RENEW_THRESHOLD_MS) {
    return null;
  }
  const nowIso = new Date(now).toISOString();
  const expiresIso = new Date(now + SESSION_IDLE_TIMEOUT_MS).toISOString();
  db
    .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
    .run(nowIso, expiresIso, sessionId);
  return { lastSeenAt: nowIso, expiresAt: expiresIso };
}

function destroySession(sessionId) {
  if (!sessionId) return;
  const db = getDatabase();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function createSessionRecord({ userId = null, isGuest = false }) {
  const db = getDatabase();
  const sessionId = generateSessionId();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresIso = new Date(now + SESSION_IDLE_TIMEOUT_MS).toISOString();
  db
    .prepare('INSERT INTO sessions (id, user_id, is_guest, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, userId, isGuest ? 1 : 0, nowIso, nowIso, expiresIso);
  return { id: sessionId, createdAt: nowIso, expiresAt: expiresIso };
}

function setSessionCookie(req, res, sessionId) {
  const secure = shouldUseSecureCookies(req);
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_IDLE_TIMEOUT_MS
  });
}

function clearSessionCookie(req, res) {
  const secure = shouldUseSecureCookies(req);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/'
  });
}

function recordAuditEvent({ user = null, action, details = null }) {
  if (!action) return;
  try {
    const db = getDatabase();
    const nowIso = new Date().toISOString();
    const payload = {
      user_id: user?.id ?? null,
      username: user?.login || user?.username || null,
      roles: user?.roles ? JSON.stringify(user.roles) : null,
      action,
      details_json: details ? JSON.stringify(details) : null,
      created_at: nowIso
    };
    db
      .prepare(
        'INSERT INTO audit_log (user_id, username, roles, action, details_json, created_at) VALUES (@user_id,@username,@roles,@action,@details_json,@created_at)'
      )
      .run(payload);
  } catch (err) {
    console.warn('Failed to write audit log', err);
  }
}

function buildGuestUserPayload() {
  const roles = ['guest'];
  return {
    id: null,
    login: 'guest',
    displayName: 'Гость',
    isActive: true,
    lastLoginAt: null,
    lockedUntil: null,
    roles,
    roleDetails: buildRoleDetails(roles),
    permissions: computePermissions(roles),
    isGuest: true
  };
}

function resolveSession(sessionId) {
  if (!sessionId) return null;
  const nowTs = Date.now();
  if (nowTs - lastSessionCleanup > SESSION_TTL_MS) {
    try {
      purgeExpiredSessions();
    } catch (_err) {
      /* ignore */
    }
    lastSessionCleanup = nowTs;
  }
  const record = loadSessionRecord(sessionId);
  if (!record) {
    return null;
  }
  if (Number(record.is_guest) === 1) {
    return {
      id: record.id,
      isGuest: true,
      createdAt: record.created_at,
      lastSeenAt: record.last_seen_at,
      expiresAt: record.expires_at,
      user: buildGuestUserPayload()
    };
  }
  if (!record.user_id) {
    destroySession(record.id);
    return null;
  }
  if (Number(record.is_active) === 0) {
    destroySession(record.id);
    return null;
  }
  if (record.locked_until) {
    const lockedUntil = Date.parse(record.locked_until);
    if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
      destroySession(record.id);
      return null;
    }
  }
  const fetched = readUserWithRolesById(record.user_id);
  if (!fetched) {
    destroySession(record.id);
    return null;
  }
  const userPayload = buildUserPayload(fetched.user, fetched.roles);
  if (!userPayload) {
    destroySession(record.id);
    return null;
  }
  userPayload.isGuest = false;
  return {
    id: record.id,
    isGuest: false,
    createdAt: record.created_at,
    lastSeenAt: record.last_seen_at,
    expiresAt: record.expires_at,
    user: userPayload
  };
}

function registerFailedLogin(userId) {
  if (!userId) return;
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const row = db.prepare('SELECT failed_attempts FROM users WHERE id = ?').get(userId);
  const attempts = Number(row?.failed_attempts || 0) + 1;
  let lockedUntil = null;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    const lockUntilDate = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    lockedUntil = lockUntilDate.toISOString();
  }
  db
    .prepare('UPDATE users SET failed_attempts = ?, locked_until = COALESCE(?, locked_until), updated_at = ? WHERE id = ?')
    .run(attempts, lockedUntil, nowIso, userId);
  return { attempts, lockedUntil };
}

function resetFailedLogin(userId) {
  if (!userId) return;
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  db
    .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .run(nowIso, userId);
}

function markSuccessfulLogin(userId) {
  if (!userId) return;
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  db
    .prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso, nowIso, userId);
}

function saveUserRoles(userId, roleSlugs) {
  const db = getDatabase();
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  if (!Array.isArray(roleSlugs) || !roleSlugs.length) {
    return [];
  }
  const insert = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
  const rolesTable = listAllRoles();
  const lookup = new Map(rolesTable.map((role) => [role.slug, role.id]));
  const applied = [];
  for (const slugRaw of roleSlugs) {
    const slug = normalizeRoleSlug(slugRaw);
    if (!slug) continue;
    const roleId = lookup.get(slug);
    if (!roleId) continue;
    insert.run(userId, roleId);
    applied.push(slug);
  }
  return applied;
}

function ensureAdminPreserved(userId, nextRoleSlugs) {
  const normalized = Array.isArray(nextRoleSlugs)
    ? nextRoleSlugs.map(normalizeRoleSlug).filter(Boolean)
    : [];
  if (normalized.includes('admin')) {
    return true;
  }
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
        WHERE r.slug = 'admin' AND ur.user_id != ?`
    )
    .get(userId);
  const count = Number(row?.count || 0);
  return count > 0;
}

function ensureCriticalRolesRetained(userId, removedRoleSlugs) {
  const normalized = Array.isArray(removedRoleSlugs)
    ? removedRoleSlugs.map(normalizeRoleSlug).filter(Boolean)
    : [];
  if (!normalized.length) {
    return { ok: true, slug: null };
  }
  const db = getDatabase();
  const critical = ['superadmin', 'admin'];
  for (const slug of critical) {
    if (!normalized.includes(slug)) continue;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE r.slug = ? AND ur.user_id != ?`
      )
      .get(slug, userId);
    const count = Number(row?.count || 0);
    if (count === 0) {
      return { ok: false, slug };
    }
  }
  return { ok: true, slug: null };
}

function validatePassword(password) {
  if (typeof password !== 'string') return false;
  const trimmed = password.trim();
  if (trimmed.length < 8) return false;
  return true;
}


const sseClients = new Set();
let cachedSnapshot = null;
let lastRevision = 0;
let revisionColumnInfo = null;
let ordersTableInfo = null;
let settingsSchemaEnsured = false;

const SETTINGS_ROW_ID = 1;

app.post('/auth/login', async (req, res) => {
  if (AUTH_MODE !== 'local') {
    res.status(501).json({ error: 'Auth mode not supported' });
    return;
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const login = sanitizeLogin(body.login);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!login || password.length < 1) {
    res.status(400).json({ error: 'Введите логин и пароль' });
    return;
  }
  const fetched = readUserWithRolesByLogin(login);
  if (!fetched || !fetched.user) {
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }
  const { user, roles } = fetched;
  if (Number(user.is_active) === 0) {
    res.status(403).json({ error: 'Учетная запись заблокирована' });
    return;
  }
  if (!user.password_hash) {
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }
  if (user.locked_until) {
    const lockedUntil = Date.parse(user.locked_until);
    if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
      res.status(423).json({ error: 'Учетная запись временно заблокирована', lockedUntil: user.locked_until });
      return;
    }
  }
  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    const state = registerFailedLogin(user.id);
    const roleSlugs = Array.isArray(roles) ? roles.map((entry) => entry.slug) : [];
    recordAuditEvent({ user: { id: user.id, login: user.login, roles: roleSlugs }, action: 'auth.failed', details: { attempts: state?.attempts || 0 } });
    if (state?.lockedUntil) {
      res.status(423).json({ error: 'Учетная запись временно заблокирована', lockedUntil: state.lockedUntil });
      return;
    }
    res.status(401).json({ error: 'Неверный логин или пароль' });
    return;
  }

  resetFailedLogin(user.id);
  markSuccessfulLogin(user.id);
  const payload = buildUserPayload(user, roles);
  if (payload) {
    payload.lastLoginAt = new Date().toISOString();
    payload.isGuest = false;
  }
  const session = createSessionRecord({ userId: user.id, isGuest: false });
  setSessionCookie(req, res, session.id);
  recordAuditEvent({ user: { id: user.id, login: user.login, roles: payload?.roles || [] }, action: 'auth.login' });
  res.json({
    user: payload,
    authMode: AUTH_MODE,
    allowGuest: ALLOW_GUEST_LOGIN,
    expiresAt: session.expiresAt
  });
});

app.post('/auth/guest', ensureGuestAllowed, (req, res) => {
  const session = createSessionRecord({ userId: null, isGuest: true });
  setSessionCookie(req, res, session.id);
  const guest = buildGuestUserPayload();
  recordAuditEvent({ user: { id: null, login: 'guest', roles: guest.roles }, action: 'auth.guest' });
  res.json({ user: guest, authMode: AUTH_MODE, allowGuest: ALLOW_GUEST_LOGIN, expiresAt: session.expiresAt });
});

app.post('/auth/logout', (req, res) => {
  if (req.session?.id) {
    destroySession(req.session.id);
  }
  clearSessionCookie(req, res);
  if (req.user) {
    recordAuditEvent({ user: { id: req.user.id, login: req.user.login, roles: req.user.roles }, action: 'auth.logout' });
  }
  res.status(204).end();
});

app.get('/me', (req, res) => {
  if (!req.user) {
    res.json({ user: null, authMode: AUTH_MODE, allowGuest: ALLOW_GUEST_LOGIN });
    return;
  }
  res.json({ user: req.user, authMode: AUTH_MODE, allowGuest: ALLOW_GUEST_LOGIN });
});

app.get('/admin/users', requireAuth('manageUsers'), (req, res) => {
  const db = getDatabase();
  const users = db
    .prepare(
      `SELECT id, login, display_name, is_active, last_login_at, locked_until, failed_attempts
         FROM users
        ORDER BY login ASC`
    )
    .all();
  const roleRows = db
    .prepare(
      `SELECT ur.user_id, r.slug
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id`
    )
    .all();
  const roleMap = new Map();
  for (const row of roleRows) {
    const list = roleMap.get(row.user_id) || [];
    list.push(row.slug);
    roleMap.set(row.user_id, list);
  }
  const payload = users.map((row) => {
    const roles = roleMap.get(row.id) || [];
    const meta = buildUserPayload(row, roles.map((slug) => ({ slug })));
    if (meta) {
      meta.failedAttempts = Number(row.failed_attempts || 0);
    }
    return meta;
  });
  res.json({ users: payload, roles: listAllRoles() });
});

app.post('/admin/users', requireAuth('manageUsers'), async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }
  const login = sanitizeLogin(req.body.login);
  const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const requestedRoles = Array.isArray(req.body.roles) ? req.body.roles : [];
  const isActive = parseBoolean(req.body.isActive, true);
  if (!login || !displayName) {
    res.status(400).json({ error: 'Логин и имя обязательны' });
    return;
  }
  if (!validatePassword(password)) {
    res.status(400).json({ error: 'Пароль должен содержать не менее 8 символов' });
    return;
  }
  if (!requestedRoles.length) {
    res.status(400).json({ error: 'Назначьте хотя бы одну роль' });
    return;
  }
  const existing = readUserWithRolesByLogin(login);
  if (existing) {
    res.status(409).json({ error: 'Пользователь с таким логином уже существует' });
    return;
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO users (login, password_hash, display_name, is_active, created_at, updated_at, password_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(login, passwordHash, displayName, isActive ? 1 : 0, nowIso, nowIso, nowIso);
  const userId = Number(result.lastInsertRowid);
  const appliedRoles = saveUserRoles(userId, requestedRoles);
  const payload = readUserWithRolesById(userId);
  const response = buildUserPayload(payload.user, payload.roles);
  recordAuditEvent({ user: req.user, action: 'admin.user.create', details: { userId, login, roles: appliedRoles } });
  ensureUsersExportSnapshot();
  res.status(201).json({ user: response });
});

app.patch('/admin/users/:id', requireAuth('manageUsers'), async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(400).json({ error: 'Некорректный идентификатор' });
    return;
  }
  const current = readUserWithRolesById(userId);
  if (!current) {
    res.status(404).json({ error: 'Пользователь не найден' });
    return;
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const updates = [];
  const db = getDatabase();
  const nowIso = new Date().toISOString();

  if (body.displayName !== undefined) {
    const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Имя не может быть пустым' });
      return;
    }
    updates.push({ column: 'display_name', value: name });
  }

  if (body.isActive !== undefined) {
    const active = parseBoolean(body.isActive, true);
    if (!active && !ensureAdminPreserved(userId, body.roles ?? current.roles?.map((r) => r.slug))) {
      res.status(400).json({ error: 'Нельзя отключить последнего администратора' });
      return;
    }
    updates.push({ column: 'is_active', value: active ? 1 : 0 });
  }

  let appliedRoles = current.roles?.map((r) => r.slug) || [];
  if (body.roles !== undefined) {
    const nextRoles = Array.isArray(body.roles) ? body.roles : [];
    if (!nextRoles.length) {
      res.status(400).json({ error: 'Назначьте хотя бы одну роль' });
      return;
    }
    if (!ensureAdminPreserved(userId, nextRoles)) {
      res.status(400).json({ error: 'В системе должен оставаться хотя бы один админ' });
      return;
    }
    appliedRoles = saveUserRoles(userId, nextRoles);
  }

  if (body.unlock === true) {
    updates.push({ column: 'failed_attempts', value: 0 });
    updates.push({ column: 'locked_until', value: null });
  }

  if (body.password) {
    if (!validatePassword(body.password)) {
      res.status(400).json({ error: 'Пароль должен содержать не менее 8 символов' });
      return;
    }
    const hash = await bcrypt.hash(body.password, 10);
    updates.push({ column: 'password_hash', value: hash });
    updates.push({ column: 'password_updated_at', value: nowIso });
  }

  if (updates.length) {
    const sets = updates.map((entry) => `${entry.column} = ?`).join(', ');
    const values = updates.map((entry) => entry.value);
    values.push(nowIso, userId);
    db.prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
  } else if (body.roles !== undefined || body.unlock === true) {
    db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(nowIso, userId);
  }

  const fresh = readUserWithRolesById(userId);
  const response = buildUserPayload(fresh.user, fresh.roles);
  recordAuditEvent({ user: req.user, action: 'admin.user.update', details: { userId, roles: appliedRoles } });
  ensureUsersExportSnapshot();
  res.json({ user: response });
});

app.delete('/admin/users/:id', requireAuth('manageUsers'), (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(400).json({ error: 'Некорректный идентификатор' });
    return;
  }
  const current = readUserWithRolesById(userId);
  if (!current) {
    res.status(404).json({ error: 'Пользователь не найден' });
    return;
  }
  const roleSlugs = Array.isArray(current.roles) ? current.roles.map((role) => role.slug).filter(Boolean) : [];
  const guard = ensureCriticalRolesRetained(userId, roleSlugs);
  if (!guard.ok) {
    const roleLabel = guard.slug === 'superadmin' ? 'Super Админ' : 'Admin';
    res.status(400).json({ error: `Нельзя удалить последнего пользователя с ролью «${roleLabel}»` });
    return;
  }
  const db = getDatabase();
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  ensureUsersExportSnapshot();
  recordAuditEvent({ user: req.user, action: 'admin.user.delete', details: { userId, login: current.user?.login || null } });
  res.status(204).send();
});

app.get('/admin/roles/description', requireAuth('manageUsers'), (req, res) => {
  res.json({ roles: listAllRoles() });
});

app.post('/admin/roles', requireAuth('manageUsers'), (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const slug = normalizeRoleSlugForCreate(req.body.slug);
  if (!slug) {
    res.status(400).json({ error: 'Укажите идентификатор роли (3-32 символа: латиница, цифры, "-" или "_")' });
    return;
  }
  if (ROLE_LOOKUP.has(slug) || rolePermissionCache.has(slug)) {
    res.status(409).json({ error: 'Роль с таким идентификатором уже существует' });
    return;
  }

  const displayName = sanitizeRoleDisplayName(req.body.displayName) || slug;
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  const permissions = normalizeRolePermissions(req.body.permissions, slug);

  const db = getDatabase();
  const nowIso = new Date().toISOString();
  try {
    db
      .prepare(
        'INSERT INTO roles (slug, display_name, description, permissions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)' 
      )
      .run(slug, displayName, description, JSON.stringify(permissions), nowIso, nowIso);
  } catch (err) {
    console.error('Не удалось создать роль', err);
    res.status(500).json({ error: 'Не удалось создать роль' });
    return;
  }

  updateRoleLookup(slug, { displayName, description });
  refreshRolePermissionCache();
  ensureUsersExportSnapshot();
  recordAuditEvent({ user: req.user, action: 'admin.roles.create', details: { slug } });
  res.status(201).json({ role: { slug, displayName, description, permissions } });
});

app.put('/admin/roles/description', requireAuth('manageUsers'), (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const updates = new Map();
  if (req.body.roles && typeof req.body.roles === 'object') {
    for (const [slugRaw, entry] of Object.entries(req.body.roles)) {
      const slug = normalizeRoleSlug(slugRaw);
      if (!slug) continue;
      const current = updates.get(slug) || {};
      if (entry && typeof entry === 'object') {
        if (Object.prototype.hasOwnProperty.call(entry, 'description')) {
          current.description = typeof entry.description === 'string' ? entry.description : '';
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'permissions')) {
          current.permissions = entry.permissions;
        }
      }
      updates.set(slug, current);
    }
  } else {
    if (req.body.descriptions && typeof req.body.descriptions === 'object') {
      for (const [slugRaw, text] of Object.entries(req.body.descriptions)) {
        const slug = normalizeRoleSlug(slugRaw);
        if (!slug) continue;
        const current = updates.get(slug) || {};
        current.description = typeof text === 'string' ? text : '';
        updates.set(slug, current);
      }
    } else {
      for (const [slugRaw, value] of Object.entries(req.body)) {
        const slug = normalizeRoleSlug(slugRaw);
        if (!slug) continue;
        const current = updates.get(slug) || {};
        current.description = typeof value === 'string' ? value : '';
        updates.set(slug, current);
      }
    }
    if (req.body.permissions && typeof req.body.permissions === 'object') {
      for (const [slugRaw, perms] of Object.entries(req.body.permissions)) {
        const slug = normalizeRoleSlug(slugRaw);
        if (!slug) continue;
        const current = updates.get(slug) || {};
        current.permissions = perms;
        updates.set(slug, current);
      }
    }
  }

  if (!updates.size) {
    res.json({ roles: listAllRoles() });
    return;
  }

  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const updateDescription = db.prepare('UPDATE roles SET description = ?, updated_at = ? WHERE slug = ?');
  const updatePermissions = db.prepare('UPDATE roles SET permissions_json = ?, updated_at = ? WHERE slug = ?');
  for (const [slug, entry] of updates.entries()) {
    if (Object.prototype.hasOwnProperty.call(entry, 'description')) {
      const description = typeof entry.description === 'string' ? entry.description.trim() : '';
      updateDescription.run(description, nowIso, slug);
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'permissions')) {
      const normalized = normalizeRolePermissions(entry.permissions, slug);
      updatePermissions.run(JSON.stringify(normalized), nowIso, slug);
    }
  }

  refreshRolePermissionCache();
  recordAuditEvent({ user: req.user, action: 'admin.roles.update' });
  res.json({ roles: listAllRoles() });
});

app.get('/admin/audit', requireAuth('viewAudit'), (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 100;
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, user_id, username, roles, action, details_json, created_at
         FROM audit_log
        ORDER BY id DESC
        LIMIT ?`
    )
    .all(limit);
  const entries = rows.map((row) => ({
    id: Number(row.id),
    userId: row.user_id === null ? null : Number(row.user_id),
    username: row.username || null,
    roles: row.roles ? safeParseJson(row.roles, []) : [],
    action: row.action,
    details: safeParseJson(row.details_json, null),
    createdAt: row.created_at
  }));
  res.json({ entries });
});



async function ensureDataDir() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      throw err;
    }
  }
}

async function runPersistenceHealthcheck() {
  const errors = [];
  try {
    await ensureDataDir();
    const probePath = path.join(DATA_DIR, `.healthcheck-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probePath, 'ok', { mode: 0o600 });
    await fsp.unlink(probePath).catch(() => {});
  } catch (err) {
    errors.push(`Каталог данных: ${err?.message || err}`);
  }

  try {
    const db = getDatabase();
    const nowIso = new Date().toISOString();
    const payload = { ok: true, ts: nowIso };
    db.prepare(
      `INSERT OR REPLACE INTO kv_store (key, value_json, updated_at)
       VALUES (@key, @value, @updatedAt)`
    ).run({
      key: '__healthcheck__',
      value: JSON.stringify(payload),
      updatedAt: nowIso
    });
  } catch (err) {
    errors.push(`SQLite: ${err?.message || err}`);
  }

  if (errors.length) {
    const message = `Проверка сохранности данных не пройдена: ${errors.join('; ')}`;
    console.error(`[CRM] ${message}`);
    const failure = new Error(message);
    failure.code = 'PERSISTENCE_HEALTHCHECK_FAILED';
    throw failure;
  }

  console.info('[CRM] Проверка сохранности данных пройдена успешно.');
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
  try {
    await ensureDataDir();
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const tmpPath = `${LOCAL_STATE_FILE}.tmp`;
    await fsp.writeFile(tmpPath, serialized, 'utf8');
    await fsp.rename(tmpPath, LOCAL_STATE_FILE);
  } catch (err) {
    if (isStoragePermissionError(err)) {
      throw new StorageWriteError('Недостаточно прав для записи локального снапшота', {
        cause: err,
        path: LOCAL_STATE_FILE
      });
    }
    throw err;
  }
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
    applyStoredSettingsToSnapshot(parsed);
    const storedStageAllocations = readStageAllocationsFromSql();
    if (storedStageAllocations.length) {
      applyStageAllocationsToSnapshot(parsed, storedStageAllocations);
    }
    const mergeResult = mergeCrmTasksIntoSnapshot(parsed);
    if (!storedStageAllocations.length && mergeResult.stageAllocations.length) {
      writeStageAllocationsToSql(mergeResult.stageAllocations);
    }
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
    if (isStoragePermissionError(err)) {
      throw new StorageWriteError('Недостаточно прав для записи снапшота планировщика', {
        cause: err,
        path: SQLITE_FILE
      });
    }
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

const KNOWN_SHARED_SETTINGS_KEYS = new Set([
  'capacity',
  'parallel',
  'plannerMode',
  'notificationsMuted',
  'tableColumns',
  'extraTime',
  'crmStageMapping',
  'logLimit',
  'admin',
  'updatedAt'
]);

function normalizePlannerMode(_value) {
  return 'crm';
}

function sanitizeSharedSettingsForStorage(source) {
  const base = sanitizeMetaForStorage(isPlainObject(source) ? source : {}) || {};
  const sanitized = {};

  const capacityRaw = isPlainObject(base.capacity) ? base.capacity : {};
  const capacity = {};
  for (const code of PLANNER_STAGE_CODES) {
    const num = Number(capacityRaw[code]);
    if (Number.isFinite(num) && num >= 0) {
      capacity[code] = Math.round(num * 100) / 100;
    }
  }
  sanitized.capacity = capacity;

  const parallelRaw = isPlainObject(base.parallel) ? base.parallel : {};
  const parallel = {};
  for (const code of PLANNER_STAGE_CODES) {
    const num = Number(parallelRaw[code]);
    if (!Number.isFinite(num) || num <= 0) {
      continue;
    }
    parallel[code] = Math.max(1, Math.round(num));
  }
  sanitized.parallel = parallel;

  sanitized.plannerMode = normalizePlannerMode(base.plannerMode);
  sanitized.notificationsMuted = Boolean(base.notificationsMuted);

  const columnsRaw = isPlainObject(base.tableColumns) ? base.tableColumns : {};
  const tableColumns = {};
  for (const [key, value] of Object.entries(columnsRaw)) {
    const columnKey = sanitizeString(key);
    if (!columnKey) continue;
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) continue;
    tableColumns[columnKey] = Math.round(width);
  }
  sanitized.tableColumns = tableColumns;

  const extraRaw = isPlainObject(base.extraTime) ? base.extraTime : {};
  const percent = Number(extraRaw.percent);
  const minimum = Number(extraRaw.minimum);
  const extra = {
    percent: Number.isFinite(percent) && percent >= 0 ? Math.round(percent * 100) / 100 : DEFAULT_EXTRA_PERCENT,
    minimum: Number.isFinite(minimum) && minimum >= 0 ? Math.round(minimum * 100) / 100 : DEFAULT_EXTRA_MINIMUM
  };
  if (typeof extraRaw.enabled === 'boolean') {
    extra.enabled = extraRaw.enabled;
  }
  sanitized.extraTime = extra;

  const logLimitNum = Number(base.logLimit);
  sanitized.logLimit = Number.isFinite(logLimitNum) && logLimitNum >= 0 ? Math.round(logLimitNum) : null;

  const mappingRaw = isPlainObject(base.crmStageMapping) ? base.crmStageMapping : {};
  const mapping = {};
  for (const [key, value] of Object.entries(mappingRaw)) {
    const normalizedKey = sanitizeString(key).toLowerCase();
    if (!normalizedKey) continue;
    const stageValue = sanitizeString(value).toLowerCase();
    if (stageValue === CRM_STAGE_IGNORE) {
      mapping[normalizedKey] = CRM_STAGE_IGNORE;
      continue;
    }
    if (PLANNER_STAGE_CODES.includes(stageValue)) {
      mapping[normalizedKey] = stageValue;
    }
  }
  sanitized.crmStageMapping = mapping;

  const adminRaw = isPlainObject(base.admin) ? base.admin : {};
  const historyLimit = Number(adminRaw.historyLimit);
  const historyDailyLimit = Number(adminRaw.historyDailyLimit);
  sanitized.admin = {
    historyLimit: Number.isFinite(historyLimit) && historyLimit >= 0 ? Math.round(historyLimit) : null,
    historyDailyLimit: Number.isFinite(historyDailyLimit) && historyDailyLimit >= 0
      ? Math.round(historyDailyLimit)
      : null,
    allowForceOverwrite: Boolean(adminRaw.allowForceOverwrite),
    writeMode: normalizeWriteMode(adminRaw.writeMode)
  };

  const updatedAtRaw = typeof base.updatedAt === 'string' ? base.updatedAt.trim() : '';
  if (updatedAtRaw) {
    sanitized.updatedAt = updatedAtRaw;
  }

  for (const [key, value] of Object.entries(base)) {
    if (KNOWN_SHARED_SETTINGS_KEYS.has(key)) {
      continue;
    }
    sanitized[key] = value;
  }

  return sanitized;
}

function readPlannerSettingsFromSql() {
  try {
    const db = getDatabase();
    const row = db
      .prepare('SELECT settings_json, settings_hash, updated_at FROM planner_settings WHERE id = ?')
      .get(SETTINGS_ROW_ID);
    if (!row) {
      return null;
    }
    const parsed = safeParseJson(row.settings_json, null);
    if (!isPlainObject(parsed)) {
      return null;
    }
    const sanitized = sanitizeSharedSettingsForStorage(parsed);
    const updatedAt = typeof row.updated_at === 'string' && row.updated_at.trim()
      ? row.updated_at.trim()
      : sanitized.updatedAt;
    if (updatedAt) {
      sanitized.updatedAt = updatedAt;
    }
    return { settings: sanitized, hash: row.settings_hash || null, updatedAt: sanitized.updatedAt || null };
  } catch (err) {
    console.warn('Failed to read planner settings from sqlite storage', err);
    return null;
  }
}

function mergeSharedSettings(existingSettings, incomingRaw) {
  const existing = sanitizeSharedSettingsForStorage(existingSettings);
  const incoming = sanitizeSharedSettingsForStorage(incomingRaw);
  const has = (key) => Object.prototype.hasOwnProperty.call(incomingRaw || {}, key);

  const merged = { ...existing };

  if (has('capacity')) merged.capacity = incoming.capacity;
  if (has('parallel')) merged.parallel = incoming.parallel;
  if (has('plannerMode')) merged.plannerMode = incoming.plannerMode;
  if (has('notificationsMuted')) merged.notificationsMuted = incoming.notificationsMuted;
  if (has('tableColumns')) merged.tableColumns = incoming.tableColumns;
  if (has('extraTime')) merged.extraTime = incoming.extraTime;
  if (has('crmStageMapping')) merged.crmStageMapping = incoming.crmStageMapping;
  if (has('logLimit')) merged.logLimit = incoming.logLimit;
  if (has('admin')) merged.admin = incoming.admin;

  for (const [key, value] of Object.entries(incoming)) {
    if (KNOWN_SHARED_SETTINGS_KEYS.has(key)) continue;
    if (has(key)) merged[key] = value;
  }

  return merged;
}

function writePlannerSettingsToSql(settings) {
  const incomingRaw = isPlainObject(settings) ? settings : {};
  const existing = readPlannerSettingsFromSql();
  const merged = mergeSharedSettings(existing?.settings || {}, incomingRaw);
  const sanitized = sanitizeSharedSettingsForStorage(merged);

  const updatedAt = typeof incomingRaw.updatedAt === 'string' && incomingRaw.updatedAt.trim()
    ? incomingRaw.updatedAt.trim()
    : (existing?.updatedAt || new Date().toISOString());
  sanitized.updatedAt = updatedAt;

  const payload = JSON.stringify(sanitized);
  const hash = computeSnapshotHash(payload);
  try {
    const db = getDatabase();
    const prev = db
      .prepare('SELECT settings_hash FROM planner_settings WHERE id = ?')
      .get(SETTINGS_ROW_ID);
    if (prev && prev.settings_hash === hash) {
      return sanitized;
    }
    db.prepare(
      `INSERT INTO planner_settings (id, settings_json, settings_hash, updated_at)
       VALUES (@id,@json,@hash,@updated_at)
       ON CONFLICT(id) DO UPDATE SET
         settings_json = excluded.settings_json,
         settings_hash = excluded.settings_hash,
         updated_at = excluded.updated_at`
    ).run({
      id: SETTINGS_ROW_ID,
      json: payload,
      hash,
      updated_at: updatedAt
    });
    return sanitized;
  } catch (err) {
    if (isStoragePermissionError(err)) {
      throw new StorageWriteError('Недостаточно прав для записи настроек планировщика', {
        cause: err,
        path: SQLITE_FILE
      });
    }
    console.error('Failed to write planner settings to sqlite storage', err);
    throw err;
  }
}

function applyStoredSettingsToSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    return;
  }
  if (!isPlainObject(snapshot.meta)) {
    snapshot.meta = {};
  }
  const stored = readPlannerSettingsFromSql();
  if (stored && isPlainObject(stored.settings)) {
    snapshot.meta.settings = stored.settings;
  } else if (isPlainObject(snapshot.meta.settings)) {
    snapshot.meta.settings = sanitizeSharedSettingsForStorage(snapshot.meta.settings);
  } else {
    snapshot.meta.settings = {};
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
const MODE_SCOPED_KEYS = Object.freeze(['crm']);
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

const REPORT_WIDGET_TYPES = new Set(['table', 'gantt', 'chart', 'route', 'kpi', 'dashboard']);
const DEFAULT_REPORT_SETTINGS = { enabled: false };
const REPORT_PREVIEW_COLUMNS = {
  orders: ['number', 'status', 'customer', 'total', 'ready', 'overdue'],
  stages: ['stage', 'workcenter', 'start', 'finish', 'duration', 'overdue'],
  route: ['step', 'status', 'responsible', 'deadline']
};
const REPORT_PREVIEW_FALLBACKS = {
  stages: [
    { stage: 'draw', workcenter: 'Подготовка', start: '2024-05-10 08:30', finish: '2024-05-10 10:00', duration: '1.5 ч', overdue: false },
    { stage: 'proc', workcenter: 'Закупка', start: '2024-05-10 10:30', finish: '2024-05-11 16:00', duration: '1 д 3.5 ч', overdue: false },
    { stage: 'shear', workcenter: 'Рубка', start: '2024-05-11 09:00', finish: '2024-05-11 12:00', duration: '3 ч', overdue: false },
    { stage: 'laser', workcenter: 'Лазерный станок', start: '2024-05-12 09:00', finish: '2024-05-12 14:30', duration: '5.5 ч', overdue: false },
    { stage: 'bend', workcenter: 'Гибка', start: '2024-05-13 10:00', finish: '2024-05-13 16:00', duration: '6 ч', overdue: true },
    { stage: 'weld', workcenter: 'Сварка', start: '2024-05-14 09:30', finish: '2024-05-14 18:00', duration: '7.5 ч', overdue: false },
    { stage: 'mech', workcenter: 'Мехобработка', start: '2024-05-15 08:00', finish: '2024-05-15 12:00', duration: '4 ч', overdue: false },
    { stage: 'coop', workcenter: 'Кооперация', start: '2024-05-15 13:00', finish: '2024-05-16 12:00', duration: '23 ч', overdue: false },
    { stage: 'pack', workcenter: 'Упаковка', start: '2024-05-16 13:00', finish: '2024-05-16 15:00', duration: '2 ч', overdue: false },
    { stage: 'ship', workcenter: 'Отгрузка', start: '2024-05-17 10:00', finish: '2024-05-17 11:00', duration: '1 ч', overdue: false }
  ],
  orders: [
    { number: 'A-1023', status: 'in_progress', customer: 'ООО «Север»', total: 185000, ready: false, overdue: false },
    { number: 'A-1019', status: 'overdue', customer: 'Завод Партнёр', total: 92000, ready: false, overdue: true }
  ],
  route: [
    { step: 'Подготовка', status: 'done', responsible: 'Анна', deadline: '2024-05-10' },
    { step: 'Лазер', status: 'in_progress', responsible: 'Иван', deadline: '2024-05-12' }
  ]
};

function readReportSettings() {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT value_json FROM kv_store WHERE key = ?').get('reports_settings');
    const parsed = safeParseJson(row?.value_json, null) || {};
    const enabled = parseBoolean(parsed.enabled, DEFAULT_REPORT_SETTINGS.enabled);
    const updatedAt = parsed.updatedAt || null;
    const updatedBy = parsed.updatedBy || null;
    return { enabled, updatedAt, updatedBy };
  } catch (err) {
    console.warn('[Reports] Failed to read settings', err);
    return { ...DEFAULT_REPORT_SETTINGS, updatedAt: null, updatedBy: null };
  }
}

function writeReportSettings(patch, actor = null) {
  const current = readReportSettings();
  const enabled = parseBoolean(patch?.enabled, current.enabled);
  const nowIso = new Date().toISOString();
  const payload = {
    enabled,
    updatedAt: nowIso,
    updatedBy: actor ? { id: actor.id, login: actor.login } : null
  };
  try {
    const db = getDatabase();
    db.prepare(
      `INSERT OR REPLACE INTO kv_store (key, value_json, updated_at)
       VALUES (@key, @value_json, @updated_at)`
    ).run({ key: 'reports_settings', value_json: JSON.stringify(payload), updated_at: nowIso });
    recordAuditEvent({ user: actor, action: 'reports.settings.update', details: { enabled } });
  } catch (err) {
    console.error('[Reports] Failed to write settings', err);
    throw err;
  }
  return payload;
}

function normalizeRoleList(rawRoles) {
  if (!Array.isArray(rawRoles)) {
    return [];
  }
  const normalized = rawRoles
    .map((role) => normalizeRoleSlug(role))
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
  return normalized;
}

function sanitizeLayoutConfig(raw) {
  if (!isPlainObject(raw)) {
    return {};
  }
  const layout = { ...raw };
  if (Array.isArray(raw.grid)) {
    layout.grid = raw.grid
      .map((cell) => {
        if (!isPlainObject(cell)) return null;
        const x = Number.isFinite(cell.x) ? cell.x : 0;
        const y = Number.isFinite(cell.y) ? cell.y : 0;
        const w = Number.isFinite(cell.w) && cell.w > 0 ? cell.w : 1;
        const h = Number.isFinite(cell.h) && cell.h > 0 ? cell.h : 1;
        const widgetId = typeof cell.widgetId === 'string' && cell.widgetId.trim() ? cell.widgetId.trim() : null;
        if (!widgetId) return null;
        return { widgetId, x, y, w, h };
      })
      .filter(Boolean);
  }
  return layout;
}

function sanitizeWidget(raw, index = 0) {
  const safeId = (raw && typeof raw.id === 'string' && raw.id.trim()) ||
    (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));
  const typeRaw = typeof raw?.type === 'string' ? raw.type.trim().toLowerCase() : 'table';
  const type = REPORT_WIDGET_TYPES.has(typeRaw) ? typeRaw : 'table';
  const title = sanitizeString(raw?.title || raw?.name || `Виджет ${index + 1}`);
  const dataSource = sanitizeString(raw?.dataSource || raw?.source || 'orders');
  let filters = {};
  if (Array.isArray(raw?.filters)) {
    filters = raw.filters
      .map((entry) => {
        if (!isPlainObject(entry)) return null;
        const field = sanitizeString(entry.field);
        const operator = sanitizeString(entry.operator || '=');
        const value = sanitizeString(entry.value || '');
        if (!field || !value) return null;
        return { field, operator, value };
      })
      .filter(Boolean);
  } else if (isPlainObject(raw?.filters)) {
    filters = raw.filters;
  }
  const options = isPlainObject(raw?.options) ? raw.options : {};
  const detail = sanitizeString(raw?.detail || '');
  const fields = Array.isArray(raw?.fields)
    ? raw.fields
        .map((value) => sanitizeString(value))
        .filter(Boolean)
        .filter((value, idx, arr) => arr.indexOf(value) === idx)
    : [];
  const size = isPlainObject(raw?.size)
    ? {
        w: Number.isFinite(raw.size.w) && raw.size.w > 0 ? raw.size.w : 1,
        h: Number.isFinite(raw.size.h) && raw.size.h > 0 ? raw.size.h : 1
      }
    : { w: 1, h: 1 };
  const position = isPlainObject(raw?.position)
    ? {
        x: Number.isFinite(raw.position.x) ? raw.position.x : 0,
        y: Number.isFinite(raw.position.y) ? raw.position.y : 0
      }
    : { x: 0, y: 0 };
  return { id: safeId, type, title, dataSource, detail, fields, filters, options, size, position };
}

function sanitizeWidgetList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, idx) => sanitizeWidget(entry, idx));
}

function buildReportPreview(snapshot, widget) {
  const source = widget?.dataSource || 'orders';
  const columns = Array.isArray(widget?.fields) && widget.fields.length
    ? widget.fields.map((field) => sanitizeString(field))
    : REPORT_PREVIEW_COLUMNS[source] || REPORT_PREVIEW_COLUMNS.orders;
  let rows = [];
  if (source === 'stages') {
    rows = extractStageRows(snapshot, widget?.detail);
  } else if (source === 'route') {
    rows = extractRouteRows(snapshot);
  } else {
    rows = extractOrderRows(snapshot);
  }
  rows = applyReportFilters(rows, widget?.filters || []);
  const normalized = rows.map((row) => {
    const entry = {};
    columns.forEach((col) => {
      entry[col] = row?.[col];
    });
    return entry;
  });
  return { columns, rows: normalized, total: normalized.length };
}

function applyReportFilters(rows, filters) {
  if (!Array.isArray(filters) || !filters.length) return rows;
  return rows.filter((row) => {
    return filters.every((filter) => {
      const field = sanitizeString(filter.field);
      const operator = sanitizeString(filter.operator || '=');
      const expected = filter.value;
      const actual = row?.[field];
      if (expected == null || expected === '') return true;
      if (operator === '!=') return actual != null && String(actual) !== String(expected);
      if (operator === 'contains') return String(actual || '').toLowerCase().includes(String(expected).toLowerCase());
      if (operator === '>') return Number(actual) > Number(expected);
      if (operator === '<') return Number(actual) < Number(expected);
      return String(actual) === String(expected);
    });
  });
}

function extractStageRows(snapshot, detail) {
  const tasks = Array.isArray(snapshot?.t) ? snapshot.t : [];
  const targetStage = normalizeStage(detail);
  const rows = tasks
    .map((task) => {
      if (!task) return null;
      const stage = normalizeStage(task.stage || task.process || detail || 'stage');
      if (targetStage && stage !== targetStage) return null;
      const start = task.start || task.startDate || task.dateStart || task.plannedStart || null;
      const finish = task.finish || task.end || task.finishDate || task.plannedFinish || null;
      const duration = computeDurationLabel(start, finish, task.duration);
      return {
        stage,
        workcenter: task.workcenter || task.area || task.machine || task.resource || '',
        start,
        finish,
        duration,
        overdue: Boolean(task.overdue || task.late || task.isOverdue)
      };
    })
    .filter(Boolean);
  if (rows.length) {
    return rows;
  }
  if (targetStage) {
    const fallbackByStage = REPORT_PREVIEW_FALLBACKS.stages.filter((entry) => normalizeStage(entry.stage) === targetStage);
    if (fallbackByStage.length) {
      return fallbackByStage;
    }
  }
  return REPORT_PREVIEW_FALLBACKS.stages;
}

function extractOrderRows(snapshot) {
  const boards = Array.isArray(snapshot?.crm?.boards) ? snapshot.crm.boards : [];
  const rows = [];
  boards.forEach((board) => {
    const orders = Array.isArray(board?.orders) ? board.orders : [];
    orders.forEach((order) => {
      rows.push({
        number: order?.number || order?.name || order?.title || order?.uid || '',
        status: order?.status || order?.state || order?.stage || '',
        customer: order?.customer || order?.client || order?.buyer || '',
        total: order?.total || order?.amount || order?.sum || order?.price || 0,
        ready: Boolean(order?.ready || order?.isReady || order?.done),
        overdue: Boolean(order?.overdue || order?.isOverdue || order?.late)
      });
    });
  });
  return rows.length ? rows : REPORT_PREVIEW_FALLBACKS.orders;
}

function extractRouteRows(snapshot) {
  const routes = Array.isArray(snapshot?.routeOverrides) ? snapshot.routeOverrides : [];
  const rows = routes
    .map((route) => ({
      step: route?.name || route?.step || '',
      status: route?.status || route?.state || '',
      responsible: route?.owner || route?.responsible || '',
      deadline: route?.deadline || route?.due || ''
    }))
    .filter((row) => row.step || row.status || row.deadline);
  return rows.length ? rows : REPORT_PREVIEW_FALLBACKS.route;
}

function computeDurationLabel(start, finish, fallback) {
  const startDate = parseDate(start);
  const endDate = parseDate(finish);
  if (startDate && endDate) {
    const diffHours = Math.max(0, (endDate - startDate) / (1000 * 60 * 60));
    return `${diffHours.toFixed(1)} ч`;
  }
  return fallback || '';
}

function sanitizeReportPresetPayload(payload, existing = {}) {
  const name = sanitizeString(payload?.name || existing.name);
  if (!name) {
    throw new Error('Название пресета обязательно');
  }
  const description = sanitizeString(payload?.description || existing.description || '');
  const isActive = parseBoolean(payload?.isActive ?? payload?.is_active, existing.isActive ?? true);
  const isPublic = parseBoolean(payload?.isPublic ?? payload?.is_public, existing.isPublic ?? true);
  const allowedRoles = normalizeRoleList(payload?.allowedRoles || payload?.allowed_roles || existing.allowedRoles || []);
  const filters = isPlainObject(payload?.filters)
    ? payload.filters
    : isPlainObject(existing.filters)
    ? existing.filters
    : {};
  const layout = sanitizeLayoutConfig(payload?.layout || payload?.layoutConfig || existing.layout || {});
  const widgets = sanitizeWidgetList(payload?.widgets || existing.widgets || []);
  const meta = isPlainObject(payload?.meta) ? payload.meta : isPlainObject(existing.meta) ? existing.meta : null;
  return { name, description, isActive, isPublic, allowedRoles, filters, layout, widgets, meta };
}

function mapReportPresetRow(row) {
  if (!row) return null;
  const allowedRoles = normalizeRoleList(safeParseJson(row.allowed_roles, []));
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || '',
    isActive: Number(row.is_active) !== 0,
    isPublic: Number(row.is_public) !== 0,
    allowedRoles,
    layout: safeParseJson(row.layout_json, {}) || {},
    widgets: safeParseJson(row.widgets_json, []) || [],
    filters: safeParseJson(row.filters_json, {}) || {},
    meta: safeParseJson(row.meta_json, null),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    createdBy: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : Number(row.updated_by)
  };
}

function readReportPresetById(presetId) {
  if (!Number.isFinite(presetId)) {
    return null;
  }
  try {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT id, name, description, is_active, is_public, allowed_roles, layout_json, widgets_json, filters_json, meta_json,
                created_by, updated_by, created_at, updated_at
           FROM report_presets
          WHERE id = ?`
      )
      .get(presetId);
    return mapReportPresetRow(row);
  } catch (err) {
    console.warn('[Reports] Failed to read preset', err);
    return null;
  }
}

function readReportVisibilityMap(userId) {
  if (!Number.isFinite(userId)) {
    return new Map();
  }
  try {
    const db = getDatabase();
    const rows = db
      .prepare('SELECT preset_id, is_visible FROM report_preset_visibility WHERE user_id = ?')
      .all(userId);
    const map = new Map();
    rows.forEach((row) => {
      map.set(Number(row.preset_id), Number(row.is_visible) !== 0);
    });
    return map;
  } catch (err) {
    console.warn('[Reports] Failed to read visibility map', err);
    return new Map();
  }
}

function presetAccessibleForUser(preset, user, { allowManage = false, includeInactive = false } = {}) {
  if (!preset || !user) return false;
  if (!preset.isActive && !includeInactive) {
    return false;
  }
  if (allowManage) {
    return true;
  }
  if (preset.isPublic) {
    return true;
  }
  if (!preset.allowedRoles.length) {
    return true;
  }
  const userRoles = Array.isArray(user.roles) ? user.roles.map((role) => normalizeRoleSlug(role)).filter(Boolean) : [];
  return userRoles.some((role) => preset.allowedRoles.includes(role));
}

function listReportPresetsForUser(user, { includeInactive = false, includeAll = false } = {}) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, name, description, is_active, is_public, allowed_roles, layout_json, widgets_json, filters_json, meta_json,
              created_by, updated_by, created_at, updated_at
         FROM report_presets
        ORDER BY updated_at DESC`
    )
    .all();
  const visibility = user?.id ? readReportVisibilityMap(user.id) : new Map();
  const allowManage = includeAll || !!user?.permissions?.editReportPresets || !!user?.permissions?.accessReportBuilder;
  const presets = [];
  for (const row of rows) {
    const preset = mapReportPresetRow(row);
    if (!preset) continue;
    const visible = visibility.has(preset.id) ? visibility.get(preset.id) : true;
    if (!presetAccessibleForUser(preset, user, { allowManage, includeInactive })) {
      continue;
    }
    presets.push({ ...preset, isVisible: !!visible });
  }
  return presets;
}

function saveReportPreset(presetInput, actor = null, presetId = null) {
  const existing = presetId ? readReportPresetById(presetId) : null;
  const sanitized = sanitizeReportPresetPayload(presetInput, existing || {});
  const nowIso = new Date().toISOString();
  const db = getDatabase();
  const allowedRolesJson = sanitized.allowedRoles.length ? JSON.stringify(sanitized.allowedRoles) : null;
  const layoutJson = sanitized.layout ? JSON.stringify(sanitized.layout) : null;
  const widgetsJson = JSON.stringify(sanitized.widgets || []);
  const filtersJson = sanitized.filters ? JSON.stringify(sanitized.filters) : null;
  const metaJson = sanitized.meta ? JSON.stringify(sanitized.meta) : null;

  if (presetId) {
    if (!existing) {
      return null;
    }
    db.prepare(
      `UPDATE report_presets
          SET name = @name,
              description = @description,
              is_active = @is_active,
              is_public = @is_public,
              allowed_roles = @allowed_roles,
              layout_json = @layout_json,
              widgets_json = @widgets_json,
              filters_json = @filters_json,
              meta_json = @meta_json,
              updated_by = @updated_by,
              updated_at = @updated_at
        WHERE id = @id`
    ).run({
      id: presetId,
      name: sanitized.name,
      description: sanitized.description,
      is_active: sanitized.isActive ? 1 : 0,
      is_public: sanitized.isPublic ? 1 : 0,
      allowed_roles: allowedRolesJson,
      layout_json: layoutJson,
      widgets_json: widgetsJson,
      filters_json: filtersJson,
      meta_json: metaJson,
      updated_by: actor?.id ?? null,
      updated_at: nowIso
    });
    recordAuditEvent({ user: actor, action: 'reports.presets.update', details: { presetId, name: sanitized.name } });
    return readReportPresetById(presetId);
  }

  const result = db
    .prepare(
      `INSERT INTO report_presets
         (name, description, is_active, is_public, allowed_roles, layout_json, widgets_json, filters_json, meta_json, created_by, updated_by, created_at, updated_at)
       VALUES
         (@name, @description, @is_active, @is_public, @allowed_roles, @layout_json, @widgets_json, @filters_json, @meta_json, @created_by, @updated_by, @created_at, @updated_at)`
    )
    .run({
      name: sanitized.name,
      description: sanitized.description,
      is_active: sanitized.isActive ? 1 : 0,
      is_public: sanitized.isPublic ? 1 : 0,
      allowed_roles: allowedRolesJson,
      layout_json: layoutJson,
      widgets_json: widgetsJson,
      filters_json: filtersJson,
      meta_json: metaJson,
      created_by: actor?.id ?? null,
      updated_by: actor?.id ?? null,
      created_at: nowIso,
      updated_at: nowIso
    });
  const createdId = Number(result.lastInsertRowid);
  recordAuditEvent({ user: actor, action: 'reports.presets.create', details: { presetId: createdId, name: sanitized.name } });
  return readReportPresetById(createdId);
}

function setReportPresetVisibility(userId, presetId, isVisible) {
  if (!Number.isFinite(userId) || !Number.isFinite(presetId)) {
    throw new Error('Некорректные параметры видимости пресета');
  }
  const db = getDatabase();
  db.prepare(
    `INSERT INTO report_preset_visibility (user_id, preset_id, is_visible)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, preset_id) DO UPDATE SET is_visible = excluded.is_visible`
  ).run(userId, presetId, isVisible ? 1 : 0);
  return true;
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

function collectStageAllocationsFromSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    return [];
  }

  const stageMap = new Map();

  const ensureBucket = (stage) => {
    const normalizedStage = normalizeStage(stage) || sanitizeString(stage);
    if (!normalizedStage) {
      return null;
    }
    if (!stageMap.has(normalizedStage)) {
      stageMap.set(normalizedStage, { tasks: [], seen: new Set() });
    }
    return stageMap.get(normalizedStage);
  };

  const registerTask = (stageKey, task) => {
    const bucket = ensureBucket(stageKey);
    if (!bucket) {
      return;
    }
    if (!task || typeof task !== 'object') {
      return;
    }
    const cloned = cloneJson(task);
    if (!isPlainObject(cloned)) {
      return;
    }
    const normalizedStage = normalizeStage(cloned.stage) || normalizeStage(stageKey) || sanitizeString(stageKey);
    if (!normalizedStage) {
      return;
    }
    cloned.stage = normalizedStage;
    const uid = cloned.uid == null ? '' : String(cloned.uid);
    if (uid) {
      if (bucket.seen.has(uid)) {
        return;
      }
      bucket.seen.add(uid);
      cloned.uid = uid;
    }
    bucket.tasks.push(cloned);
  };

  const scoped = snapshot?.modeScoped?.crm;
  if (isPlainObject(scoped) && Array.isArray(scoped.stageTasks)) {
    scoped.stageTasks.forEach((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return;
      }
      const [stageKey, list] = entry;
      const tasks = Array.isArray(list) ? list : [];
      tasks.forEach((task) => registerTask(stageKey, task));
    });
  }

  const tasks = Array.isArray(snapshot.t) ? snapshot.t : [];
  tasks.forEach((task) => {
    if (!task) {
      return;
    }
    const serialized = serializeTaskForModeState(task);
    if (!serialized) {
      return;
    }
    registerTask(serialized.stage || task.stage, serialized);
  });

  const normalizedEntries = [];
  const seenStages = new Set();

  PLANNER_STAGE_CODES.forEach((stage) => {
    const bucket = stageMap.get(stage);
    if (bucket) {
      normalizedEntries.push([stage, bucket.tasks]);
      seenStages.add(stage);
    } else {
      normalizedEntries.push([stage, []]);
    }
  });

  stageMap.forEach((bucket, stage) => {
    if (seenStages.has(stage)) {
      return;
    }
    normalizedEntries.push([stage, bucket.tasks]);
  });

  return normalizedEntries;
}

function applyStageAllocationsToSnapshot(snapshot, stageEntries) {
  if (!isPlainObject(snapshot)) {
    return { entries: [], orders: [] };
  }

  const stageMap = new Map();
  const entries = Array.isArray(stageEntries) ? stageEntries : [];

  entries.forEach((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return;
    }
    const [stageKey, list] = entry;
    const normalizedStage = normalizeStage(stageKey) || sanitizeString(stageKey);
    if (!normalizedStage) {
      return;
    }
    const tasks = Array.isArray(list) ? list : [];
    const seen = new Set();
    const normalizedTasks = [];
    tasks.forEach((task) => {
      if (!task || typeof task !== 'object') {
        return;
      }
      const cloned = cloneJson(task);
      if (!isPlainObject(cloned)) {
        return;
      }
      const stageCandidate = normalizeStage(cloned.stage) || normalizedStage;
      if (!stageCandidate) {
        return;
      }
      cloned.stage = stageCandidate;
      const uid = cloned.uid == null ? '' : String(cloned.uid);
      if (uid) {
        if (seen.has(uid)) {
          return;
        }
        cloned.uid = uid;
        seen.add(uid);
      }
      normalizedTasks.push(cloned);
    });
    const orderIds = normalizedTasks
      .map((task) => (task && task.uid ? String(task.uid) : ''))
      .filter((uid) => uid);
    stageMap.set(normalizedStage, { tasks: normalizedTasks, orders: orderIds });
  });

  const normalizedEntries = [];
  const orderEntries = [];
  const seenStages = new Set();

  PLANNER_STAGE_CODES.forEach((stage) => {
    const bucket = stageMap.get(stage);
    if (bucket) {
      normalizedEntries.push([stage, bucket.tasks]);
      orderEntries.push([stage, bucket.orders]);
    } else {
      normalizedEntries.push([stage, []]);
      orderEntries.push([stage, []]);
    }
    seenStages.add(stage);
  });

  stageMap.forEach((bucket, stage) => {
    if (seenStages.has(stage)) {
      return;
    }
    normalizedEntries.push([stage, bucket.tasks]);
    orderEntries.push([stage, bucket.orders]);
  });

  if (!isPlainObject(snapshot.modeScoped)) {
    snapshot.modeScoped = {};
  }
  if (!isPlainObject(snapshot.modeScoped.crm)) {
    snapshot.modeScoped.crm = buildEmptyModeScopedSnapshot();
  }
  const scoped = snapshot.modeScoped.crm;
  scoped.stageTasks = normalizedEntries.map(([stage, list]) => [stage, cloneJson(list)]);
  scoped.orders = orderEntries.map(([stage, ids]) => [stage, ids.slice()]);

  snapshot.orders = orderEntries.map(([stage, ids]) => [stage, ids.slice()]);

  return { entries: normalizedEntries, orders: orderEntries };
}

function writeStageAllocationsToSql(stageEntries) {
  try {
    const db = getDatabase();
    const normalized = Array.isArray(stageEntries) ? stageEntries : [];
    const now = new Date().toISOString();
    const tx = db.transaction((entries) => {
      db.prepare('DELETE FROM stage_allocations').run();
      if (!entries.length) {
        return;
      }
      const insert = db.prepare(
        'INSERT INTO stage_allocations (stage, tasks_json, updated_at) VALUES (@stage, @tasks_json, @updated_at)'
      );
      entries.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length < 2) {
          return;
        }
        const [stageKey, list] = entry;
        const normalizedStage = normalizeStage(stageKey) || sanitizeString(stageKey);
        if (!normalizedStage) {
          return;
        }
        const tasks = Array.isArray(list) ? list : [];
        insert.run({ stage: normalizedStage, tasks_json: JSON.stringify(tasks), updated_at: now });
      });
    });
    tx(normalized);
  } catch (err) {
    if (isStoragePermissionError(err)) {
      throw new StorageWriteError('Недостаточно прав для записи распределений переделов', {
        cause: err,
        path: SQLITE_FILE
      });
    }
    console.warn('Failed to persist stage allocations to sqlite', err);
  }
}

function readStageAllocationsFromSql() {
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT stage, tasks_json FROM stage_allocations').all();
    if (!Array.isArray(rows) || !rows.length) {
      return [];
    }
    const entries = [];
    rows.forEach((row) => {
      const stageKey = normalizeStage(row.stage) || sanitizeString(row.stage);
      if (!stageKey) {
        return;
      }
      const tasks = safeParseJson(row.tasks_json, []);
      if (!Array.isArray(tasks)) {
        return;
      }
      entries.push([stageKey, tasks.map((task) => (isPlainObject(task) ? cloneJson(task) : null)).filter(Boolean)]);
    });
    return entries;
  } catch (err) {
    console.warn('Failed to read stage allocations from sqlite', err);
    return [];
  }
}

function mergeCrmTasksIntoSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    return { tasks: Array.isArray(snapshot?.t) ? snapshot.t : [], crmTasks: [], stageAllocations: [] };
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

  const stageAllocations = collectStageAllocationsFromSnapshot(snapshot);
  const applied = applyStageAllocationsToSnapshot(snapshot, stageAllocations);

  const crmTasks = tasks.filter((task) => isCrmTaskRecord(task));

  return { tasks, crmTasks, stageAllocations: applied.entries };
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
    applyStoredSettingsToSnapshot(snapshotObj);
    const { stageAllocations } = mergeCrmTasksIntoSnapshot(snapshotObj);
    writeStageAllocationsToSql(stageAllocations);
    const normalizedSettings = writePlannerSettingsToSql(snapshotObj.meta?.settings || {});
    if (isPlainObject(snapshotObj.meta)) {
      snapshotObj.meta.settings = normalizedSettings;
    }
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

function validateSnapshotStructure(snapshot, { autoFix = false } = {}) {
  const missing = [];
  const target = isPlainObject(snapshot) ? snapshot : {};

  const ensureArray = (key, label) => {
    if (!Array.isArray(target[key])) {
      missing.push(label);
      if (autoFix) {
        target[key] = [];
      }
    }
  };

  ensureArray('t', 'tasks');
  ensureArray('done', 'done');
  ensureArray('trash', 'trash');
  ensureArray('orders', 'orders');

  return { ok: missing.length === 0 || autoFix, missing };
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
  const persistedSettings = writePlannerSettingsToSql(parsedSnapshot.meta?.settings || {});
  if (isPlainObject(parsedSnapshot.meta)) {
    parsedSnapshot.meta.settings = persistedSettings;
  }

  const { stageAllocations } = mergeCrmTasksIntoSnapshot(parsedSnapshot);

  writeStageAllocationsToSql(stageAllocations);

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

function parseDataSize(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return value;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?i?b?|[kmgt])?$/i);
  if (!match) {
    return fallback;
  }
  const numeric = Number.parseFloat(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  const unitRaw = (match[2] || 'b').toLowerCase();
  const unit = unitRaw.replace(/bytes?$/, 'b');
  const unitMap = new Map([
    ['b', 1],
    ['kb', 1024],
    ['kib', 1024],
    ['k', 1024],
    ['mb', 1024 * 1024],
    ['mib', 1024 * 1024],
    ['m', 1024 * 1024],
    ['gb', 1024 * 1024 * 1024],
    ['gib', 1024 * 1024 * 1024],
    ['g', 1024 * 1024 * 1024],
    ['tb', 1024 * 1024 * 1024 * 1024],
    ['tib', 1024 * 1024 * 1024 * 1024],
    ['t', 1024 * 1024 * 1024 * 1024]
  ]);
  const multiplier = unitMap.get(unit) || unitMap.get(`${unit}b`);
  if (!multiplier) {
    return fallback;
  }
  return numeric * multiplier;
}

function formatByteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = value >= 10 || index === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[index]}`;
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
    writePlannerSettingsToSql(snapshot.snapshot?.meta?.settings || {});
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

app.get('/api/state', requireAuth('view'), async (req, res) => {
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

app.put('/api/state', requireAuth('write'), async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  try {
    const { snapshot, stateString, requestMeta } = extractSnapshotPayload(req.body);
    if (!isPlainObject(snapshot)) {
      res.status(400).json({ error: 'Snapshot must be an object' });
      return;
    }

    const structure = validateSnapshotStructure(snapshot, { autoFix: true });
    if (structure.missing.length) {
      logSaveEvent('warn', 'snapshot missing required sections', { requestId, missing: structure.missing });
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
    if (err && (err instanceof StorageWriteError || err.code === 'STORAGE_PERMISSION')) {
      const detail = {
        error: 'StoragePermission',
        message: 'Сервер не может записать данные CRM. Проверьте права доступа к каталогу data/.',
        path: err.path || DATA_DIR
      };
      logSaveEvent('error', 'save failed due to storage permissions', { requestId, path: detail.path });
      res.status(507).json(detail);
      return;
    }
    logSaveEvent('error', 'save failed', { requestId, error: err?.message || String(err) });
    console.error('PUT /api/state failed error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/events', requireAuth('view'), async (req, res) => {
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

app.get('/api/admin/history', requireAuth('viewAudit'), (req, res) => {
  res.json({ items: [] });
});

app.get('/api/admin/history/:hash', requireAuth('viewAudit'), (req, res) => {
  res.status(404).json({ error: 'History disabled' });
});

app.delete('/api/admin/history', requireAuth('manageUsers'), (_req, res) => {
  res.status(410).json({ error: 'History storage disabled' });
});

app.post('/api/admin/snapshot', requireAuth('manageUsers'), (_req, res) => {
  res.status(410).json({ error: 'Snapshot storage disabled' });
});

app.post('/api/admin/rollback', requireAuth('manageUsers'), (_req, res) => {
  res.status(410).json({ error: 'Rollback disabled' });
});

app.get('/api/reports/settings', requireAuth('viewReports'), (req, res) => {
  const settings = readReportSettings();
  res.json(settings);
});

app.post('/api/reports/preview', requireAuth('viewReports'), async (req, res) => {
  try {
    const widget = sanitizeWidget(req.body?.widget || req.body || {}, 0);
    const snapshotRecord = await getCachedSnapshot();
    const snapshot = snapshotRecord?.snapshot || buildEmptySnapshot();
    const preview = buildReportPreview(snapshot, widget);
    res.json({ preview });
  } catch (err) {
    console.error('Preview build failed', err);
    res.status(400).json({ error: err?.message || 'Не удалось сформировать предпросмотр' });
  }
});

app.patch('/api/reports/settings', requireAuth('accessReportBuilder'), (req, res) => {
  try {
    const settings = writeReportSettings(req.body || {}, req.user);
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Не удалось сохранить настройки отчётов' });
  }
});

app.get('/api/reports/presets', requireAuth('viewReports'), (req, res) => {
  const includeInactive = parseBoolean(req.query.includeInactive, false);
  const includeAll = !!req.user?.permissions?.editReportPresets || !!req.user?.permissions?.accessReportBuilder;
  const presets = listReportPresetsForUser(req.user, { includeInactive, includeAll });
  res.json({ presets, settings: readReportSettings() });
});

app.get('/api/reports/presets/:id', requireAuth('viewReports'), (req, res) => {
  const presetId = Number(req.params.id);
  if (!Number.isFinite(presetId) || presetId <= 0) {
    res.status(400).json({ error: 'Некорректный идентификатор пресета' });
    return;
  }
  const preset = readReportPresetById(presetId);
  if (!preset) {
    res.status(404).json({ error: 'Пресет не найден' });
    return;
  }
  const allowManage = !!req.user?.permissions?.editReportPresets || !!req.user?.permissions?.accessReportBuilder;
  if (!presetAccessibleForUser(preset, req.user, { allowManage, includeInactive: true })) {
    res.status(403).json({ error: 'Недостаточно прав для доступа к пресету' });
    return;
  }
  const visibilityMap = req.user?.id ? readReportVisibilityMap(req.user.id) : new Map();
  const isVisible = visibilityMap.has(preset.id) ? visibilityMap.get(preset.id) : true;
  res.json({ preset: { ...preset, isVisible } });
});

app.post('/api/reports/presets', requireAuth('editReportPresets'), (req, res) => {
  try {
    const preset = saveReportPreset(req.body || {}, req.user, null);
    res.status(201).json({ preset });
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Не удалось создать пресет' });
  }
});

app.patch('/api/reports/presets/:id', requireAuth('editReportPresets'), (req, res) => {
  const presetId = Number(req.params.id);
  if (!Number.isFinite(presetId) || presetId <= 0) {
    res.status(400).json({ error: 'Некорректный идентификатор пресета' });
    return;
  }
  try {
    const preset = saveReportPreset(req.body || {}, req.user, presetId);
    if (!preset) {
      res.status(404).json({ error: 'Пресет не найден' });
      return;
    }
    res.json({ preset });
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Не удалось обновить пресет' });
  }
});

app.delete('/api/reports/presets/:id', requireAuth('deleteReportPresets'), (req, res) => {
  const presetId = Number(req.params.id);
  if (!Number.isFinite(presetId) || presetId <= 0) {
    res.status(400).json({ error: 'Некорректный идентификатор пресета' });
    return;
  }
  const db = getDatabase();
  const preset = readReportPresetById(presetId);
  if (!preset) {
    res.status(404).json({ error: 'Пресет не найден' });
    return;
  }
  db
    .prepare('UPDATE report_presets SET is_active = 0, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(new Date().toISOString(), req.user?.id ?? null, presetId);
  recordAuditEvent({ user: req.user, action: 'reports.presets.delete', details: { presetId, name: preset.name } });
  res.status(204).end();
});

app.post('/api/reports/presets/:id/visibility', requireAuth('viewReports'), (req, res) => {
  if (!req.user?.id) {
    res.status(400).json({ error: 'Не удалось определить пользователя' });
    return;
  }
  const presetId = Number(req.params.id);
  if (!Number.isFinite(presetId) || presetId <= 0) {
    res.status(400).json({ error: 'Некорректный идентификатор пресета' });
    return;
  }
  const preset = readReportPresetById(presetId);
  if (!preset) {
    res.status(404).json({ error: 'Пресет не найден' });
    return;
  }
  const allowManage = !!req.user?.permissions?.editReportPresets || !!req.user?.permissions?.accessReportBuilder;
  if (!presetAccessibleForUser(preset, req.user, { allowManage })) {
    res.status(403).json({ error: 'Недостаточно прав' });
    return;
  }
  const isVisible = parseBoolean(req.body?.isVisible ?? req.body?.visible ?? req.body?.value, true);
  try {
    setReportPresetVisibility(req.user.id, presetId, isVisible);
    res.json({ presetId, isVisible });
  } catch (err) {
    res.status(400).json({ error: err?.message || 'Не удалось обновить видимость' });
  }
});


app.get(['/CRM.html', '/crm.html'], (req, res) => {
  if (!req.user) {
    res.redirect('/login');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'CRM.html'));
});

app.get(['/reports', '/reports.html'], (req, res) => {
  if (!req.user) {
    res.redirect('/login');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'reports.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('/login', (req, res) => {
  if (req.user) {
    res.redirect('/');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/', (req, res) => {
  if (!req.user) {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'CRM.html'));
});

app.get('/crm', (req, res) => {
  if (!req.user) {
    res.redirect('/login');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'CRM.html'));
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    if (!req.user) {
      res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
    } else {
      res.sendFile(path.join(PUBLIC_DIR, 'CRM.html'));
    }
    return;
  }
  next();
});

async function bootstrap() {
  await runMigrations();
  await getLatestRevision();
  await getCachedSnapshot();
  await ensureSqlHydrated();
  await runPersistenceHealthcheck();
  app.listen(PORT, () => {
    console.log(`Planner hybrid storage server listening on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap application', err);
  process.exit(1);
});
