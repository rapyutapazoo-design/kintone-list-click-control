/**
 * 設定スキーマ（schemaVersion 付き JSON を1キーに保存する）。
 * すべて純粋関数。kintone / DOM に依存しない。
 * @typedef {Object} Config
 * @property {number} schemaVersion
 * @property {'default'|'row'} rowClick
 * @property {'same'|'new'} openMode
 * @property {{mode: 'standard'|'text'|'self', fields: Record<string, 'inherit'|'standard'|'text'|'self'>}} lookup
 * @property {{mode: 'all'|'selected', ids: string[]}} views
 * @property {boolean} hover
 * @property {{enabled: boolean, targets: {lookup: boolean, recordLink: boolean}, onError: 'standard'|'disable', cacheTtlSec: number}} permission
 */

export const SCHEMA_VERSION = 1;

const ROW_CLICK = ['default', 'row'];
const OPEN_MODE = ['same', 'new'];
const LOOKUP_MODE = ['standard', 'text', 'self'];
const LOOKUP_FIELD_MODE = ['inherit', 'standard', 'text', 'self'];
const VIEWS_MODE = ['all', 'selected'];
const ON_ERROR = ['standard', 'disable'];
const DEFAULT_TTL = 300;

/** @returns {Config} */
export function defaultConfig() {
  return {
    schemaVersion: SCHEMA_VERSION,
    rowClick: 'default',
    openMode: 'same',
    lookup: { mode: 'standard', fields: {} },
    views: { mode: 'all', ids: [] },
    hover: true,
    permission: {
      enabled: false,
      targets: { lookup: true, recordLink: false },
      onError: 'standard',
      cacheTtlSec: DEFAULT_TTL,
    },
  };
}

/**
 * @param {object} raw
 * @returns {object}
 */
export function migrate(raw) {
  const obj = raw && typeof raw === 'object' ? { ...raw } : {};
  const v = Number(obj.schemaVersion);
  if (!Number.isFinite(v) || v < 1) {
    obj.schemaVersion = 1;
  }
  // 将来の版用の分岐雛形:
  // if (obj.schemaVersion === 1) { ...; obj.schemaVersion = 2; }
  return obj;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pickEnum = (v, list, def) => (list.includes(v) ? v : def);
const pickBool = (v, def) => (v === true || v === false ? v : def);

/**
 * @param {object} raw
 * @returns {Config}
 */
export function normalize(raw) {
  const d = defaultConfig();
  const r = isObj(raw) ? raw : {};
  const lookup = isObj(r.lookup) ? r.lookup : {};
  const views = isObj(r.views) ? r.views : {};
  const perm = isObj(r.permission) ? r.permission : {};
  const targets = isObj(perm.targets) ? perm.targets : {};

  /** @type {Config['lookup']['fields']} */
  const fields = {};
  if (isObj(lookup.fields)) {
    for (const [code, mode] of Object.entries(lookup.fields)) {
      if (LOOKUP_FIELD_MODE.includes(mode)) fields[code] = mode;
    }
  }

  const ids = Array.isArray(views.ids)
    ? [...new Set(views.ids.filter((x) => x !== null && x !== undefined && typeof x !== 'object').map(String))]
    : [];

  let ttl = Number.parseInt(perm.cacheTtlSec, 10);
  if (!Number.isFinite(ttl)) ttl = d.permission.cacheTtlSec;
  ttl = Math.min(3600, Math.max(0, ttl));

  return {
    schemaVersion: SCHEMA_VERSION,
    rowClick: pickEnum(r.rowClick, ROW_CLICK, d.rowClick),
    openMode: pickEnum(r.openMode, OPEN_MODE, d.openMode),
    lookup: { mode: pickEnum(lookup.mode, LOOKUP_MODE, d.lookup.mode), fields },
    views: { mode: pickEnum(views.mode, VIEWS_MODE, d.views.mode), ids },
    hover: pickBool(r.hover, d.hover),
    permission: {
      enabled: pickBool(perm.enabled, d.permission.enabled),
      targets: {
        lookup: pickBool(targets.lookup, d.permission.targets.lookup),
        recordLink: pickBool(targets.recordLink, d.permission.targets.recordLink),
      },
      onError: pickEnum(perm.onError, ON_ERROR, d.permission.onError),
      cacheTtlSec: ttl,
    },
  };
}

/**
 * @param {{config?: string}|null|undefined} stored
 * @returns {Config}
 */
export function loadConfig(stored) {
  try {
    if (!stored || typeof stored.config !== 'string' || stored.config === '') {
      return defaultConfig();
    }
    return normalize(migrate(JSON.parse(stored.config)));
  } catch (e) {
    console.warn('[klc] 設定の読み込みに失敗したため既定値を使用します', e);
    return defaultConfig();
  }
}

/**
 * @param {Config} cfg
 * @returns {{config: string}}
 */
export function serializeConfig(cfg) {
  return { config: JSON.stringify(cfg) };
}

/**
 * 存在しないフィールドコード・viewId を除き、inherit のフィールドは削る。
 * @param {Config} cfg
 * @param {{fieldCodes: string[], viewIds: string[]}} known
 * @returns {Config}
 */
export function sanitizeForSave(cfg, known) {
  const codes = new Set(known.fieldCodes);
  const viewIds = new Set(known.viewIds.map(String));
  const fields = {};
  for (const [code, mode] of Object.entries(cfg.lookup.fields)) {
    if (codes.has(code) && mode !== 'inherit') fields[code] = mode;
  }
  return {
    ...cfg,
    lookup: { ...cfg.lookup, fields },
    views: { ...cfg.views, ids: cfg.views.ids.filter((id) => viewIds.has(String(id))) },
  };
}

/**
 * @param {Config} cfg
 * @param {string} fieldCode
 * @returns {'standard'|'text'|'self'}
 */
export function resolveLookupMode(cfg, fieldCode) {
  const m = cfg.lookup.fields[fieldCode];
  if (m === undefined || m === 'inherit') return cfg.lookup.mode;
  return m;
}

/**
 * @param {Config} cfg
 * @param {{viewType?: string, viewId?: number|string}} event
 * @returns {boolean}
 */
export function isTargetView(cfg, event) {
  if (!event || event.viewType !== 'list') return false;
  if (cfg.views.mode === 'all') return true;
  return cfg.views.ids.map(String).includes(String(event.viewId));
}

/**
 * 設定画面のフォーム値から Config を作る（UI 非依存）。
 * @param {{
 *  rowClick?: string, openMode?: string, lookupMode?: string,
 *  lookupFields?: Record<string,string>, viewsMode?: string, viewIds?: string[],
 *  hover?: boolean, permEnabled?: boolean, permLookup?: boolean, permRecordLink?: boolean,
 *  onError?: string, cacheTtlSec?: string|number
 * }} v
 * @returns {Config}
 */
export function buildConfigFromForm(v) {
  return normalize({
    rowClick: v.rowClick,
    openMode: v.openMode,
    lookup: { mode: v.lookupMode, fields: v.lookupFields || {} },
    views: { mode: v.viewsMode, ids: v.viewIds || [] },
    hover: v.hover,
    permission: {
      enabled: v.permEnabled,
      targets: { lookup: v.permLookup, recordLink: v.permRecordLink },
      onError: v.onError,
      cacheTtlSec: v.cacheTtlSec,
    },
  });
}
