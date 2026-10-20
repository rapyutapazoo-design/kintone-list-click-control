/**
 * 一覧画面コントローラ（desktop / mobile 共用）。
 * グローバルの kintone / KUC は参照せず、依存はすべて注入で受け取る。
 */
import { isTargetView, resolveLookupMode } from '../core/config.js';
import { parseRecordUrl, buildRecordUrl } from '../core/url.js';
import { decideRowClick, resolveOpenMode, INTERACTIVE_SELECTOR } from '../core/rowClick.js';

const MSG_PENDING = '遷移先の権限を確認しています…';
const MSG_DENY = '遷移先レコードの閲覧権限がありません';
const MSG_ERROR = '権限を確認できませんでした';

const CLS_PENDING = 'klc-acl-pending';
const CLS_DENIED = 'klc-acl-denied';
const CLS_TEXT = 'klc-lookup-text';
const CLS_ROW = 'klc-row-clickable';
const ATTR_STATE = 'data-klc-state';
const ATTR_HREF = 'data-klc-href';
const ATTR_TITLE = 'data-klc-title';

/** @param {HTMLAnchorElement} a */
export function applyPending(a) {
  if (!a.hasAttribute(ATTR_STATE) && a.hasAttribute('title')) {
    a.setAttribute(ATTR_TITLE, a.getAttribute('title'));
  }
  a.classList.remove(CLS_DENIED, CLS_TEXT);
  a.classList.add(CLS_PENDING);
  a.setAttribute('aria-busy', 'true');
  a.setAttribute('title', MSG_PENDING);
  a.setAttribute(ATTR_STATE, 'pending');
}

/** @param {HTMLAnchorElement} a */
export function applyAllow(a) {
  const state = a.getAttribute(ATTR_STATE);
  a.classList.remove(CLS_PENDING, CLS_DENIED, CLS_TEXT);
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
 * @param {'deny'|'text'|'error'} reason
 */
export function applyDisabled(a, reason) {
  if (!a.hasAttribute(ATTR_STATE) && reason !== 'text' && a.hasAttribute('title')) {
    a.setAttribute(ATTR_TITLE, a.getAttribute('title'));
  }
  if (!a.hasAttribute(ATTR_HREF) && a.hasAttribute('href')) {
    a.setAttribute(ATTR_HREF, a.getAttribute('href'));
  }
  a.removeAttribute('href');
  a.classList.remove(CLS_PENDING, CLS_DENIED, CLS_TEXT);
  a.removeAttribute('aria-busy');
  a.classList.add(reason === 'text' ? CLS_TEXT : CLS_DENIED);
  a.setAttribute('aria-disabled', 'true');
  if (reason === 'deny') a.setAttribute('title', MSG_DENY);
  else if (reason === 'error') a.setAttribute('title', MSG_ERROR);
  else if (a.getAttribute(ATTR_STATE) === 'pending') a.removeAttribute('title');
  a.setAttribute(ATTR_STATE, reason === 'text' ? 'text' : reason);
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
  /** @type {WeakMap<Element, {kind: 'lookup'|'recordLink', fieldCode: string, rowRecordId: string, mode: string}>} */
  const anchorInfo = new WeakMap();

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
          anchorInfo.set(anchor, { kind: 'lookup', fieldCode: code, rowRecordId: String(rowRecordId), mode });
          if (mode === 'text') return applyDisabled(anchor, 'text');
          if (mode === 'self') return;
          if (!(permOn && config.permission.targets.lookup)) return;
          const lk = prop.lookup;
          const appId = lk?.relatedApp?.app ?? parsed?.appId;
          if (!appId) return;
          const spaceId = parsed?.spaceId ?? currentSpaceId;
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
          entries.push({ anchor, req, kind: 'lookup' });
        } else {
          anchorInfo.set(anchor, { kind: 'recordLink', fieldCode: code, rowRecordId: String(rowRecordId), mode: 'standard' });
          if (!(permOn && config.permission.targets.recordLink)) return;
          if (!parsed || !parsed.recordId) return;
          entries.push({
            anchor,
            req: { spaceId: parsed.spaceId ?? currentSpaceId, appId: parsed.appId, keyType: 'id', keyField: null, value: parsed.recordId },
            kind: 'recordLink',
          });
        }
      });
    }
    return entries;
  }

  function applyState(anchor, state) {
    if (state === 'allow') return applyAllow(anchor);
    if (state === 'deny') return applyDisabled(anchor, 'deny');
    // error
    if (config.permission.onError === 'disable') return applyDisabled(anchor, 'error');
    warn('権限を確認できなかったため標準動作にします');
    applyAllow(anchor);
  }

  function runAcl(gen, entries) {
    if (!aclChecker || entries.length === 0) return;
    const unresolved = [];
    for (const e of entries) {
      const s = aclChecker.peek(e.req);
      if (s === 'allow' || s === 'deny') applyState(e.anchor, s);
      else {
        applyPending(e.anchor);
        unresolved.push(e);
      }
    }
    if (unresolved.length === 0) return;
    let p;
    try {
      p = Promise.resolve(aclChecker.check(unresolved.map((e) => e.req)));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (map) => {
        if (gen !== generation) return;
        for (const e of unresolved) {
          if (!e.anchor.isConnected) continue;
          applyState(e.anchor, map.get(aclChecker.cacheKey(e.req)) || 'error');
        }
      },
      () => {
        if (gen !== generation) return;
        for (const e of unresolved) {
          if (e.anchor.isConnected) applyState(e.anchor, 'error');
        }
      },
    );
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
        runAcl(gen, entries);
      })
      .catch((e) => warn(e));
  }

  function openModeOf(e) {
    return resolveOpenMode({
      openMode: config.openMode,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      button: e.button,
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
    if (a && info) {
      const state = a.getAttribute(ATTR_STATE);
      if (state === 'pending' || state === 'deny' || state === 'error' || state === 'text') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (info.mode === 'self' && info.kind === 'lookup') {
        e.preventDefault();
        e.stopPropagation();
        const appId = deps.getAppId();
        const url =
          findOwnRecordUrl(a.closest('tr'), appId, info.rowRecordId, host) ||
          buildRecordUrl({ appId, recordId: info.rowRecordId, spaceId: currentSpaceId });
        deps.navigate(url, openModeOf(e));
        return;
      }
      return; // standard: 素通し
    }

    if (platform !== 'desktop') return;
    const tr = target.closest('tr');
    const row = tr ? rowInfo.get(tr) : null;
    if (!tr || !row) return;
    const td = target.closest('td');
    const sel = deps.getSelection ? deps.getSelection() : null;
    const interactive = target.closest(INTERACTIVE_SELECTOR);
    const decision = decideRowClick({
      targetView,
      rowClick: config.rowClick,
      button: e.button,
      hasSelectionInRow: !!(sel && String(sel.toString()) !== '' && sel.anchorNode && tr.contains(sel.anchorNode)),
      insideInteractive: !!(interactive && tr.contains(interactive)),
      isDataCell: !!(td && row.dataCells.has(td)),
      rowHasFormControl: !!tr.querySelector('input, select, textarea'),
      recordId: row.recordId,
    });
    if (decision.action !== 'navigate') return;
    const appId = deps.getAppId();
    const url =
      findOwnRecordUrl(tr, appId, row.recordId, host) ||
      buildRecordUrl({ appId, recordId: row.recordId, spaceId: currentSpaceId });
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
