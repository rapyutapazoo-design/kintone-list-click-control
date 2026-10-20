/**
 * 遷移先レコードの閲覧権限判定（records.json の in クエリで「見えるレコード集合」を取得する方式）。
 * 実際の権限は kintone サーバー側で強制される。ここでの判定は UX 改善のための補助。
 *
 * @typedef {{spaceId: string|null, appId: string, keyType: 'id'|'key', keyField: string|null, value: string}} AclRequest
 * @typedef {'allow'|'deny'|'error'} AclState
 * @typedef {(p: {spaceId: string|null, appId: string, query: string, fields: string[]}) => Promise<{records: object[]}>} Fetcher
 */
import { buildApiPath } from './url.js';

/**
 * アプリ全体に権限がない・存在しない場合のエラーコード。【要検証】実機で確認すること。
 * URL・パラメータ不整合系（GAIA_IL23, CB_IJ01 など）は含めない（error として非キャッシュで標準動作に戻す）。
 */
export const APP_DENY_CODES = ['CB_NO02', 'GAIA_AP01'];

// kintone のフィールドコード許容文字（記号を除く任意の文字・数字・_・・・＿）。空白・引用符・演算子記号は不可。
const KEY_FIELD_PATTERN = /^[\p{L}\p{M}\p{N}_$・＿]+$/u;
const MAX_STORAGE_ENTRIES = 2000;

/** @param {AclRequest} req */
export function groupKey(req) {
  return `${req.spaceId ?? ''}|${req.appId}|${req.keyType}|${req.keyField ?? ''}`;
}

/**
 * @param {string} host
 * @param {AclRequest} req
 */
export function cacheKey(host, req) {
  return `${host}|${groupKey(req)}|${String(req.value).trim()}`;
}

/**
 * @param {AclRequest[]} reqs
 * @returns {Map<string, {spaceId: string|null, appId: string, keyType: 'id'|'key', keyField: string|null, values: string[]}>}
 */
export function groupRequests(reqs) {
  const map = new Map();
  for (const r of reqs) {
    const value = String(r.value ?? '').trim();
    if (value === '') continue;
    const k = groupKey(r);
    let g = map.get(k);
    if (!g) {
      g = { spaceId: r.spaceId ?? null, appId: r.appId, keyType: r.keyType, keyField: r.keyField ?? null, values: [] };
      map.set(k, g);
    }
    if (!g.values.includes(value)) g.values.push(value);
  }
  return map;
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} [size]
 * @returns {T[][]}
 */
export function chunk(arr, size = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** @param {string} v */
export function escapeQueryValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * @param {{keyType: 'id'|'key', keyField: string|null, values: string[]}} p
 * @returns {string}
 */
export function buildInQuery({ keyType, keyField, values }) {
  let field = '$id';
  if (keyType === 'key') {
    if (typeof keyField !== 'string' || !KEY_FIELD_PATTERN.test(keyField)) {
      throw new Error('invalid keyField');
    }
    field = keyField;
  }
  const list = values.map((v) => `"${escapeQueryValue(v)}"`).join(',');
  return `${field} in (${list}) limit 100`;
}

/**
 * @param {object[]} records
 * @param {{keyType: 'id'|'key', keyField: string|null}} p
 * @returns {Set<string>}
 */
export function extractValues(records, { keyType, keyField }) {
  const out = new Set();
  for (const r of records || []) {
    const cell = keyType === 'id' ? r?.$id : r?.[keyField];
    if (cell && cell.value !== undefined && cell.value !== null) out.add(String(cell.value).trim());
  }
  return out;
}

/**
 * @param {any} err
 * @returns {'appDeny'|'error'}
 */
export function classifyError(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  return typeof code === 'string' && APP_DENY_CODES.includes(code) ? 'appDeny' : 'error';
}

/** @param {number} failCount */
export function nextBackoffMs(failCount) {
  return Math.min(60000, 1000 * 2 ** Math.max(0, failCount - 1));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject({ code: 'TIMEOUT' }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{
 *  fetcher: Fetcher, host: string, now?: () => number,
 *  storage?: {getItem: Function, setItem: Function}|null,
 *  ttlSec?: number, concurrency?: number, timeoutMs?: number, storageKey?: string
 * }} opts
 */
export function createAclChecker({
  fetcher,
  host,
  now = Date.now,
  storage = null,
  ttlSec = 300,
  concurrency = 3,
  timeoutMs = 5000,
  storageKey = 'klc-acl-v1',
}) {
  const ttlMs = ttlSec * 1000;
  const caching = ttlSec > 0;
  /** @type {Map<string, {state: 'allow'|'deny', ts: number, persist: boolean}>} */
  const cache = new Map();
  /** @type {Map<string, number>} */
  const appDeny = new Map();
  /** @type {Map<string, Promise<AclState>>} */
  const inflight = new Map();
  /** @type {Map<string, {count: number, retryAt: number}>} */
  const failures = new Map();
  /** @type {Array<() => Promise<void>>} */
  const queue = [];
  let running = 0;

  const appKey = (r) => `${host}|${r.spaceId ?? ''}|${r.appId}`;
  const fresh = (ts) => now() - ts < ttlMs;

  function loadStorage() {
    if (!storage || !caching) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      for (const [k, state, ts] of data.entries || []) {
        if ((state === 'allow' || state === 'deny') && typeof ts === 'number' && fresh(ts)) {
          cache.set(k, { state, ts, persist: true });
        }
      }
      for (const [k, ts] of data.apps || []) {
        if (typeof ts === 'number' && fresh(ts)) appDeny.set(k, ts);
      }
    } catch {
      /* 破損・利用不可は無視 */
    }
  }

  function saveStorage() {
    if (!storage || !caching) return;
    try {
      let entries = [];
      for (const [k, v] of cache) if (v.persist && fresh(v.ts)) entries.push([k, v.state, v.ts]);
      if (entries.length > MAX_STORAGE_ENTRIES) {
        entries.sort((a, b) => a[2] - b[2]);
        entries = entries.slice(entries.length - MAX_STORAGE_ENTRIES);
      }
      const apps = [];
      for (const [k, ts] of appDeny) if (fresh(ts)) apps.push([k, ts]);
      storage.setItem(storageKey, JSON.stringify({ entries, apps }));
    } catch {
      /* 保存失敗は無視 */
    }
  }

  function readCache(ck) {
    const e = cache.get(ck);
    if (!e) return null;
    if (!fresh(e.ts)) {
      cache.delete(ck);
      return null;
    }
    return e.state;
  }

  function isAppDenied(r) {
    const ts = appDeny.get(appKey(r));
    if (ts === undefined) return false;
    if (!fresh(ts)) {
      appDeny.delete(appKey(r));
      return false;
    }
    return true;
  }

  function pump() {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift();
      running++;
      task().finally(() => {
        running--;
        pump();
      });
    }
  }

  /**
   * @param {{spaceId: string|null, appId: string, keyType: 'id'|'key', keyField: string|null}} g
   * @param {string[]} values
   * @param {Map<string, (s: AclState) => void>} resolvers cacheKey -> resolve
   */
  async function runChunk(g, values, resolvers) {
    const gk = groupKey(g);
    const settle = (state, cacheIt, persist) => {
      for (const v of values) {
        const ck = cacheKey(host, { ...g, value: v });
        const s = typeof state === 'function' ? state(v) : state;
        if (cacheIt && caching && (s === 'allow' || s === 'deny')) {
          cache.set(ck, { state: s, ts: now(), persist: persist && g.keyType === 'id' });
        }
        resolvers.get(ck)(s);
      }
    };
    if (isAppDenied(g)) return settle('deny', false, false);
    const f = failures.get(gk);
    if (f && f.retryAt > now()) return settle('error', false, false);
    try {
      const query = buildInQuery({ keyType: g.keyType, keyField: g.keyField, values });
      const fields = g.keyType === 'id' ? ['$id'] : ['$id', g.keyField];
      const res = await withTimeout(Promise.resolve(fetcher({ spaceId: g.spaceId, appId: g.appId, query, fields })), timeoutMs);
      const found = extractValues(res && res.records, g);
      failures.delete(gk);
      settle((v) => (found.has(v) ? 'allow' : 'deny'), true, true);
    } catch (err) {
      if (classifyError(err) === 'appDeny') {
        if (caching) appDeny.set(appKey(g), now());
        settle('deny', false, false);
      } else {
        const count = (failures.get(gk)?.count ?? 0) + 1;
        failures.set(gk, { count, retryAt: now() + nextBackoffMs(count) });
        settle('error', false, false);
      }
    }
    saveStorage();
  }

  loadStorage();

  return {
    cacheKey: (req) => cacheKey(host, req),

    /** @returns {AclState|'pending'|null} */
    peek(req) {
      if (String(req.value ?? '').trim() === '') return 'deny';
      if (isAppDenied(req)) return 'deny';
      const ck = cacheKey(host, req);
      const s = readCache(ck);
      if (s) return s;
      return inflight.has(ck) ? 'pending' : null;
    },

    /**
     * @param {AclRequest[]} reqs
     * @returns {Promise<Map<string, AclState>>}
     */
    async check(reqs) {
      /** @type {Map<string, AclState>} */
      const result = new Map();
      /** @type {Array<[string, Promise<AclState>]>} */
      const waits = [];

      for (const r of reqs) {
        if (String(r.value ?? '').trim() === '') result.set(cacheKey(host, r), 'deny');
      }

      for (const g of groupRequests(reqs).values()) {
        const toFetch = [];
        for (const v of g.values) {
          const ck = cacheKey(host, { ...g, value: v });
          if (isAppDenied(g)) {
            result.set(ck, 'deny');
            continue;
          }
          const cached = readCache(ck);
          if (cached) {
            result.set(ck, cached);
            continue;
          }
          const running_ = inflight.get(ck);
          if (running_) {
            waits.push([ck, running_]);
            continue;
          }
          toFetch.push(v);
        }
        for (const part of chunk(toFetch, 100)) {
          /** @type {Map<string, (s: AclState) => void>} */
          const resolvers = new Map();
          for (const v of part) {
            const ck = cacheKey(host, { ...g, value: v });
            const p = new Promise((resolve) => resolvers.set(ck, resolve));
            const tracked = p.finally(() => inflight.delete(ck));
            inflight.set(ck, tracked);
            waits.push([ck, tracked]);
          }
          queue.push(() => runChunk(g, part, resolvers));
        }
      }
      pump();

      await Promise.all(
        waits.map(async ([ck, p]) => {
          result.set(ck, await p);
        }),
      );
      return result;
    },
  };
}

/**
 * kintone.api を使う fetcher。グローバルの kintone は直接参照せず引数で受け取る。
 * @param {{api: Function}} kintoneObj
 * @returns {Fetcher}
 */
export function createKintoneFetcher(kintoneObj) {
  return ({ spaceId, appId, query, fields }) =>
    kintoneObj.api(buildApiPath('/k/v1/records.json', spaceId), 'GET', {
      app: appId,
      query,
      fields,
      totalCount: false,
    });
}
