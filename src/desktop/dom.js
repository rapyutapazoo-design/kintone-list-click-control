/**
 * 一覧画面コントローラ（desktop / mobile 共用）。
 * グローバルの kintone / KUC は参照せず、依存はすべて注入で受け取る。
 */
import { isTargetView, resolveLookupMode, loadConfig } from '../core/config.js';
import { parseRecordUrl, buildRecordUrl, getGuestSpaceIdFromPath, getGuestSpaceIdFromApiUrl } from '../core/url.js';
import { createAclChecker, createKintoneFetcher, createKintoneRecordFetcher } from '../core/acl.js';
import { decideRowClick, decideLinkClick, resolveOpenMode, INTERACTIVE_SELECTOR } from '../core/rowClick.js';

const MSG_PENDING = '遷移先の権限を確認しています…';
const MSG_DENY = '遷移先レコードの閲覧権限がありません';
const MSG_ERROR = '権限を確認できませんでした';
const MSG_NOTFOUND = 'リンク先のレコードが見つかりません';

const MSG_TOAST = {
  lookup: {
    deny: 'ルックアップ先レコードの閲覧権限がないため開けません',
    notfound: 'ルックアップ先のレコードが見つかりません',
    error: '閲覧権限を確認できなかったため開けません',
  },
  recordLink: {
    deny: 'リンク先レコードの閲覧権限がないため開けません',
    notfound: 'リンク先のレコードが見つかりません',
    error: '閲覧権限を確認できなかったため開けません',
  },
};
const MSG_TAB_FAIL = '新しいタブを開けませんでした。もう一度クリックしてください';
const MSG_POPUP = 'ポップアップがブロックされました。もう一度クリックしてください';

const CLS_CHECKING = 'klc-acl-checking';
const CLS_BUSY = 'klc-busy';
const CLICK_TIMEOUT_MS = 1500;
const TOAST_MS = 3000;
const CLS_PENDING = 'klc-acl-pending';
const CLS_DENIED = 'klc-acl-denied';
const CLS_TEXT = 'klc-lookup-text';
const CLS_ROW = 'klc-row-clickable';
const CLS_ROWLINK = 'klc-row-link';
const ATTR_STATE = 'data-klc-state';
const ATTR_HREF = 'data-klc-href';
const ATTR_TITLE = 'data-klc-title';
const DISABLED_STATES = new Set(['pending', 'deny', 'notfound', 'error', 'text']);

/** @param {HTMLAnchorElement} a */
export function applyPending(a) {
  if (!a.hasAttribute(ATTR_STATE) && a.hasAttribute('title')) {
    a.setAttribute(ATTR_TITLE, a.getAttribute('title'));
  }
  a.classList.remove(CLS_DENIED, CLS_TEXT, CLS_ROWLINK);
  a.classList.add(CLS_PENDING);
  a.setAttribute('aria-busy', 'true');
  a.setAttribute('title', MSG_PENDING);
  a.setAttribute(ATTR_STATE, 'pending');
}

/** @param {HTMLAnchorElement} a */
export function applyAllow(a) {
  const state = a.getAttribute(ATTR_STATE);
  a.classList.remove(CLS_PENDING, CLS_DENIED, CLS_TEXT, CLS_ROWLINK);
  a.removeAttribute('aria-busy');
  a.removeAttribute('aria-disabled');
  if (a.hasAttribute(ATTR_HREF)) {
    a.setAttribute('href', a.getAttribute(ATTR_HREF));
    a.removeAttribute(ATTR_HREF);
  }
  if (state && state !== 'text') {
    if (a.hasAttribute(ATTR_TITLE)) {
      a.setAttribute('title', a.getAttribute(ATTR_TITLE));
      a.removeAttribute(ATTR_TITLE);
    } else {
      a.removeAttribute('title');
    }
  }
  a.removeAttribute(ATTR_STATE);
}

/**
 * @param {HTMLAnchorElement} a
 * @param {'deny'|'notfound'|'text'|'error'} reason
 */
export function applyDisabled(a, reason) {
  if (!a.hasAttribute(ATTR_STATE) && reason !== 'text' && a.hasAttribute('title')) {
    a.setAttribute(ATTR_TITLE, a.getAttribute('title'));
  }
  if (!a.hasAttribute(ATTR_HREF) && a.hasAttribute('href')) {
    a.setAttribute(ATTR_HREF, a.getAttribute('href'));
  }
  a.removeAttribute('href');
  a.classList.remove(CLS_PENDING, CLS_DENIED, CLS_TEXT, CLS_ROWLINK);
  a.removeAttribute('aria-busy');
  a.classList.add(reason === 'text' ? CLS_TEXT : CLS_DENIED);
  a.setAttribute('aria-disabled', 'true');
  if (reason === 'deny') a.setAttribute('title', MSG_DENY);
  else if (reason === 'notfound') a.setAttribute('title', MSG_NOTFOUND);
  else if (reason === 'error') a.setAttribute('title', MSG_ERROR);
  else if (a.getAttribute(ATTR_STATE) === 'pending') a.removeAttribute('title');
  a.setAttribute(ATTR_STATE, reason === 'text' ? 'text' : reason);
}

let toastTimer = null;

/**
 * 画面下部に短いメッセージを出す（textContent のみ。要素は使い回す）。
 * @param {Document} doc
 * @param {string} text
 * @param {number} [ms]
 */
export function showToast(doc, text, ms = TOAST_MS) {
  let el = doc.querySelector('div.klc-toast');
  if (!el) {
    el = doc.createElement('div');
    el.className = 'klc-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    doc.body.appendChild(el);
  }
  el.textContent = String(text);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/**
 * クリックハンドラ内で同期的に空タブを開くためのハンドル。
 * @param {Window} win
 * @returns {{blocked: boolean, go: (url: string) => boolean|void, close: () => void}}
 *   go は遷移に失敗したら（空タブを閉じて）false を返す
 */
export function openBlankTab(win) {
  let w = null;
  try {
    w = win.open('', '_blank');
  } catch {
    w = null;
  }
  if (!w) return { blocked: true, go() {}, close() {} };
  try {
    w.opener = null;
  } catch {
    /* 無視 */
  }
  return {
    blocked: false,
    go(url) {
      if (w.closed) return true;
      try {
        w.location.replace(new URL(url, win.location.href).href);
        return true;
      } catch {
        // 一覧のタブは遷移させない。空タブを閉じ、呼び出し側が再クリックを促す
        try {
          w.close();
        } catch {
          /* 無視 */
        }
        return false;
      }
    },
    close() {
      try {
        if (!w.closed) w.close();
      } catch {
        /* 無視 */
      }
    },
  };
}

/** href（退避中なら退避先）を取得 */
function currentHref(a) {
  return a.getAttribute('href') ?? a.getAttribute(ATTR_HREF);
}

/**
 * 行内の a[href] から、指定アプリ・レコードに一致する href を返す。
 * @returns {string|null}
 */
export function findOwnRecordUrl(tr, appId, recordId, host) {
  if (!tr) return null;
  for (const a of tr.querySelectorAll('a[href]')) {
    const p = parseRecordUrl(a.getAttribute('href'), host);
    if (p && p.appId === String(appId) && p.recordId === String(recordId)) return a.getAttribute('href');
  }
  return null;
}

/**
 * @param {{
 *  platform: 'desktop'|'mobile', config: import('../core/config.js').Config,
 *  getAppId: () => string, getFieldElements: (code: string) => (HTMLElement[]|null),
 *  fetchFormFields: () => Promise<Record<string, any>>,
 *  aclChecker: ReturnType<typeof import('../core/acl.js').createAclChecker>|null,
 *  host: string, currentSpaceId: string|null,
 *  navigate: (url: string, mode: 'same'|'new') => void,
 *  openTab?: () => {blocked: boolean, go: (url: string) => void, close: () => void},
 *  toast?: (msg: string) => void,
 *  clickTimeoutMs?: number,
 *  root: Window|Document, getSelection: () => Selection|null
 * }} deps
 */
export function createListController(deps) {
  const { platform, config, aclChecker, host, currentSpaceId, root } = deps;
  let generation = 0;
  let bound = false;
  let targetView = false;
  /** @type {WeakMap<Element, {recordId: string, dataCells: Set<Element>}>} */
  const rowInfo = new WeakMap();
  /** @type {WeakMap<Element, {kind: 'lookup'|'recordLink', fieldCode: string, rowRecordId: string, mode: string, checked: boolean, req: any}>} */
  const anchorInfo = new WeakMap();
  /** クリック時の判定中のアンカー */
  const checking = new WeakSet();
  let busyCount = 0;

  function ensureBound() {
    if (bound) return;
    bound = true;
    root.addEventListener('click', handleEvent, true);
    root.addEventListener('auxclick', handleEvent, true);
  }

  function warn(...args) {
    console.warn('[klc]', ...args);
  }

  /** 行とセルの対応付け（同期）。 */
  function mapRows(records) {
    /** @type {Map<string, HTMLElement[]>} */
    const cellsByCode = new Map();
    if (!Array.isArray(records) || records.length === 0) return cellsByCode;
    const codes = Object.keys(records[0]).filter((c) => c !== '$id' && c !== '$revision');
    for (const code of codes) {
      let els = null;
      try {
        els = deps.getFieldElements(code);
      } catch {
        els = null;
      }
      if (!els || els.length !== records.length) continue;
      cellsByCode.set(code, els);
      if (platform !== 'desktop') continue;
      els.forEach((cell, i) => {
        const recordId = records[i]?.$id?.value;
        const tr = cell && cell.closest ? cell.closest('tr') : null;
        if (!tr || recordId === undefined || recordId === null) return;
        let info = rowInfo.get(tr);
        if (!info || info.recordId !== String(recordId)) {
          info = { recordId: String(recordId), dataCells: new Set() };
          rowInfo.set(tr, info);
        }
        info.dataCells.add(cell);
      });
    }
    return cellsByCode;
  }

  function markHover(records, cellsByCode) {
    if (!(platform === 'desktop' && config.hover && config.rowClick === 'row')) return;
    for (const els of cellsByCode.values()) {
      for (const cell of els) {
        const tr = cell.closest('tr');
        if (tr && rowInfo.has(tr)) tr.classList.add(CLS_ROW);
      }
    }
  }

  function buildEntries(records, cellsByCode, props) {
    /** @type {Array<{anchor: HTMLAnchorElement, req: any, kind: string}>} */
    const entries = [];
    const permOn = !!(aclChecker && config.permission.enabled);
    for (const [code, els] of cellsByCode) {
      const prop = props[code];
      if (!prop) continue;
      const isLookup = !!prop.lookup;
      const isLink = prop.type === 'LINK' && prop.protocol === 'WEB';
      if (!isLookup && !isLink) continue;
      els.forEach((cell, i) => {
        const anchor = cell.querySelector('a');
        const rowRecordId = records[i]?.$id?.value;
        if (!anchor || rowRecordId === undefined) return;
        const href = currentHref(anchor);
        const parsed = href ? parseRecordUrl(href, host) : null;
        if (isLookup) {
          const mode = resolveLookupMode(config, code);
          const info = { kind: 'lookup', fieldCode: code, rowRecordId: String(rowRecordId), mode, checked: false, req: null };
          anchorInfo.set(anchor, info);
          if (mode === 'text') return disable(anchor, 'text');
          if (mode === 'self') return;
          if (!(permOn && config.permission.targets.lookup)) return;
          if (!href) {
            info.checked = true; // リンク先なし: API は呼ばずクリック時に notfound 扱い
            return;
          }
          const lk = prop.lookup;
          const appId = lk?.relatedApp?.app ?? parsed?.appId;
          if (!appId) return;
          // href を解析できたときはその spaceId（null＝通常スペース）を正とする
          const spaceId = parsed ? parsed.spaceId : currentSpaceId;
          let req;
          if (parsed?.recordId) {
            req = { spaceId, appId: String(appId), keyType: 'id', keyField: null, value: parsed.recordId };
          } else if (lk?.relatedKeyField) {
            let value = (cell.textContent || '').trim();
            if (prop.type === 'NUMBER') value = value.replace(/,/g, '');
            req = { spaceId, appId: String(appId), keyType: 'key', keyField: lk.relatedKeyField, value };
          } else {
            return;
          }
          info.checked = true;
          info.req = req;
          entries.push({ anchor, req, kind: 'lookup' });
        } else {
          const info = { kind: 'recordLink', fieldCode: code, rowRecordId: String(rowRecordId), mode: 'standard', checked: false, req: null };
          anchorInfo.set(anchor, info);
          if (!(permOn && config.permission.targets.recordLink)) return;
          if (!href) {
            info.checked = true;
            return;
          }
          if (!parsed || !parsed.recordId) return;
          const req = { spaceId: parsed.spaceId, appId: parsed.appId, keyType: 'id', keyField: null, value: parsed.recordId };
          info.checked = true;
          info.req = req;
          entries.push({ anchor, req, kind: 'recordLink' });
        }
      });
    }
    return entries;
  }

  const rowMode = platform === 'desktop' && config.rowClick === 'row';
  /** 無効化し、rowClick=row の行内では cursor を pointer にするクラスを付ける */
  function disable(anchor, reason) {
    applyDisabled(anchor, reason);
    if (rowMode) anchor.classList.add(CLS_ROWLINK);
  }

  /** 表示時: 判定を裏で実行してキャッシュを温めるだけ（DOM には触れない） */
  function prefetch(entries) {
    if (!aclChecker || entries.length === 0) return;
    const reqs = entries.filter((e) => aclChecker.peek(e.req) === null).map((e) => e.req);
    if (reqs.length === 0) return;
    try {
      Promise.resolve(aclChecker.check(reqs)).catch(() => {});
    } catch {
      /* 無視 */
    }
  }

  /** @param {{records?: any[], viewType?: string, viewId?: number|string}} event */
  function onIndexShow(event) {
    const gen = ++generation;
    const ev = platform === 'mobile' && !event.viewType ? { ...event, viewType: 'list' } : event;
    targetView = isTargetView(config, ev);
    if (!targetView) return;
    ensureBound();
    const records = event.records || [];
    const cellsByCode = mapRows(records);
    markHover(records, cellsByCode);
    Promise.resolve()
      .then(() => deps.fetchFormFields())
      .catch(() => ({}))
      .then((props) => {
        if (gen !== generation) return;
        const entries = buildEntries(records, cellsByCode, props || {});
        prefetch(entries);
      })
      .catch((e) => warn(e));
  }

  function openModeOf(e, a) {
    const t = a && typeof a.getAttribute === 'function' ? a.getAttribute('target') : null;
    return resolveOpenMode({
      targetBlank: typeof t === 'string' && t.trim().toLowerCase() === '_blank',
      openMode: config.openMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      button: e.button,
    });
  }

  function ownRecordUrl(a, info) {
    const appId = deps.getAppId();
    return (
      findOwnRecordUrl(a.closest('tr'), appId, info.rowRecordId, host) ||
      buildRecordUrl({ appId, recordId: info.rowRecordId, spaceId: currentSpaceId, platform })
    );
  }

  function isHttpHref(href) {
    try {
      const u = new URL(href, 'https://' + host);
      return u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      return false;
    }
  }

  function setBusy(a, on) {
    const html = a.ownerDocument.documentElement;
    if (on) {
      a.classList.add(CLS_CHECKING);
      a.setAttribute('aria-busy', 'true');
      busyCount++;
      html.classList.add(CLS_BUSY);
    } else {
      a.classList.remove(CLS_CHECKING);
      a.removeAttribute('aria-busy');
      busyCount = Math.max(0, busyCount - 1);
      if (busyCount === 0) html.classList.remove(CLS_BUSY);
    }
  }

  function finishLinkClick(ctx, state) {
    const d = decideLinkClick({ state, onDeny: config.permission.onDeny, onError: config.permission.onError });
    if (d.reason === 'error' || d.reason === 'timeout') warn('遷移先の権限を確認できませんでした', d.action);
    const toast = deps.toast || ((m) => showToast(document, m));
    if (d.action === 'block') {
      if (ctx.tab && !ctx.tab.blocked) ctx.tab.close();
      const msgs = MSG_TOAST[ctx.info && ctx.info.kind === 'recordLink' ? 'recordLink' : 'lookup'];
      toast(msgs[d.reason === 'timeout' ? 'error' : d.reason]);
      return;
    }
    const url = d.action === 'target' ? ctx.href : ownRecordUrl(ctx.a, ctx.info);
    if (ctx.tab) {
      if (ctx.tab.blocked) {
        deps.navigate(url, 'new');
        toast(MSG_POPUP);
      } else {
        if (ctx.tab.go(url) === false) toast(MSG_TAB_FAIL);
      }
      return;
    }
    deps.navigate(url, ctx.mode);
  }

  function handleCheckedLink(e, a, info) {
    const href = currentHref(a);
    let state = null;
    if (!href) state = 'notfound';
    else if (!isHttpHref(href)) return; // javascript: など → 介入しない
    const mode = openModeOf(e, a);
    if (!state) {
      if (!info.req) return; // 表示時に href がなかったが今はある → 介入しない
      const s = aclChecker ? aclChecker.peek(info.req) : null;
      if (s === 'allow' || s === 'deny' || s === 'notfound') state = s;
    }
    if (state === 'allow' && mode === 'same') return; // 標準のリンク動作
    e.preventDefault();
    e.stopPropagation();
    if (checking.has(a)) return;
    const ctx = { a, info, href, mode, tab: null };
    if (state) {
      finishLinkClick(ctx, state);
      return;
    }
    if (mode === 'new') ctx.tab = (deps.openTab || (() => openBlankTab(window)))();
    checking.add(a);
    setBusy(a, true);
    let timer;
    const timeoutMs = deps.clickTimeoutMs ?? CLICK_TIMEOUT_MS;
    const verdict = Promise.resolve()
      .then(() => aclChecker.check([info.req]))
      .then(
        (m) => (m && m.get(aclChecker.cacheKey(info.req))) || 'error',
        () => 'error',
      );
    Promise.race([
      verdict,
      new Promise((r) => {
        timer = setTimeout(() => r('timeout'), timeoutMs);
      }),
    ])
      .then((st) => {
        clearTimeout(timer);
        finishLinkClick(ctx, st);
      })
      .catch((err) => warn(err))
      .finally(() => {
        checking.delete(a);
        setBusy(a, false);
      });
  }

  function handleEvent(e) {
    try {
      handle(e);
    } catch (err) {
      warn(err);
    }
  }

  function handle(e) {
    const isAux = e.type === 'auxclick';
    if (isAux && e.button !== 1) return;
    if (!isAux && e.button !== 0) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;

    const a = target.closest('a');
    const info = a ? anchorInfo.get(a) : null;
    let disabledAnchor = null;
    if (a && info) {
      const state = a.getAttribute(ATTR_STATE);
      if (DISABLED_STATES.has(state)) {
        // リンク遷移だけ止める（stopPropagation はしない）。行クリック判定へ回す
        e.preventDefault();
        disabledAnchor = a;
      } else if (info.mode === 'self' && info.kind === 'lookup') {
        e.preventDefault();
        e.stopPropagation();
        deps.navigate(ownRecordUrl(a, info), openModeOf(e, a));
        return;
      } else if (info.checked) {
        handleCheckedLink(e, a, info);
        return;
      } else {
        return; // standard: 素通し
      }
    }

    if (platform !== 'desktop') return;
    const tr = target.closest('tr');
    const row = tr ? rowInfo.get(tr) : null;
    if (!tr || !row) return;
    const td = target.closest('td');
    const sel = deps.getSelection ? deps.getSelection() : null;
    let interactive = target.closest(INTERACTIVE_SELECTOR);
    if (disabledAnchor && interactive === disabledAnchor) {
      interactive = disabledAnchor.parentElement ? disabledAnchor.parentElement.closest(INTERACTIVE_SELECTOR) : null;
    }
    const decision = decideRowClick({
      targetView,
      rowClick: config.rowClick,
      button: e.button,
      hasSelectionInRow: !!(sel && String(sel.toString()) !== '' && sel.anchorNode && tr.contains(sel.anchorNode)),
      insideInteractive: !!(interactive && tr.contains(interactive)),
      isDataCell: !!(td && [...row.dataCells].some((c) => c === td || c.contains(target) || td.contains(c))),
      rowHasFormControl: !!tr.querySelector('input, select, textarea'),
      recordId: row.recordId,
    });
    if (decision.action !== 'navigate') return;
    const appId = deps.getAppId();
    const url =
      findOwnRecordUrl(tr, appId, row.recordId, host) ||
      buildRecordUrl({ appId, recordId: row.recordId, spaceId: currentSpaceId, platform });
    deps.navigate(url, openModeOf(e));
  }

  function dispose() {
    if (!bound) return;
    root.removeEventListener('click', handleEvent, true);
    root.removeEventListener('auxclick', handleEvent, true);
    bound = false;
  }

  return { onIndexShow, dispose };
}

/**
 * 共有のエントリ初期化（desktop / mobile 共通）。kintone オブジェクトは引数で受け取る。
 * @param {{platform: 'desktop'|'mobile', eventName: string, kintone: any, getAppId: () => any, getFieldElements: (code: string) => any}} p
 */
export function setupEntry({ platform, eventName, kintone, getAppId, getFieldElements }) {
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const config = loadConfig(kintone.plugin.app.getConfig(PLUGIN_ID));

  const noLookupControl =
    config.lookup.mode === 'standard' && Object.values(config.lookup.fields).every((m) => m === 'standard' || m === 'inherit');
  const rowOff = platform !== 'desktop' || config.rowClick === 'default';
  if (rowOff && noLookupControl && !config.permission.enabled) return;

  // ページのパスから判定し、取れなければ kintone.api.url の結果（ゲスト用パス）から判定する（モバイルのパス形式に依存しない）
  let currentSpaceId = getGuestSpaceIdFromPath(location.pathname);
  if (currentSpaceId === null) {
    try {
      currentSpaceId = getGuestSpaceIdFromApiUrl(kintone.api.url('/k/v1/app', true));
    } catch {
      /* 判定不能時は通常スペース扱い */
    }
  }

  let fieldsPromise = null;
  const fetchFormFields = () => {
    if (!fieldsPromise) {
      fieldsPromise = kintone
        // ゲストスペースの判定は kintone に任せる（desktop / mobile 共通）
        .api(kintone.api.url('/k/v1/app/form/fields.json', true), 'GET', { app: getAppId() })
        .then((r) => r.properties || {})
        .catch((e) => {
          console.warn('[klc] フォーム情報の取得に失敗しました', e);
          return {};
        });
    }
    return fieldsPromise;
  };

  const aclChecker = config.permission.enabled
    ? createAclChecker({
        fetcher: createKintoneFetcher(kintone),
        recordFetcher: createKintoneRecordFetcher(kintone),
        host: location.host,
        ttlSec: config.permission.cacheTtlSec,
        storage: safeSessionStorage(),
      })
    : null;

  const controller = createListController({
    platform,
    config,
    getAppId: () => String(getAppId()),
    getFieldElements,
    fetchFormFields,
    aclChecker,
    host: location.host,
    currentSpaceId,
    navigate: (url, mode) => {
      if (mode === 'new') window.open(url, '_blank', 'noopener');
      else location.href = url;
    },
    openTab: () => openBlankTab(window),
    toast: (m) => showToast(document, m),
    root: window,
    getSelection: () => window.getSelection(),
  });

  kintone.events.on(eventName, (event) => {
    try {
      controller.onIndexShow(event);
    } catch (e) {
      console.warn('[klc]', e);
    }
    return event;
  });
}

function safeSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

