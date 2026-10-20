// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createListController } from '../src/desktop/dom.js';
import { normalize } from '../src/core/config.js';

const HOST = 'x.cybozu.com';
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const PROPS = {
  text: { type: 'SINGLE_LINE_TEXT' },
  cust: { type: 'SINGLE_LINE_TEXT', lookup: { relatedApp: { app: '2' }, relatedKeyField: 'code' } },
  link: { type: 'LINK', protocol: 'WEB' },
};

/** 行ごとの DOM を作り、field code -> td 配列 を返す */
function buildList(rows, { detailLink = true, custHref = (r) => `/k/2/show#record=${r.cust}`, linkHref = (r) => `/k/3/show#record=${r.cust}` } = {}) {
  document.body.innerHTML = '<table><tbody></tbody></table>';
  const tbody = document.querySelector('tbody');
  const cells = { text: [], cust: [], link: [] };
  const records = [];
  for (const r of rows) {
    const tr = document.createElement('tr');
    const icon = document.createElement('td');
    if (detailLink) icon.innerHTML = `<a class="detail" href="/k/1/show#record=${r.id}">詳細</a>`;
    tr.appendChild(icon);
    const tdText = document.createElement('td');
    tdText.textContent = 'text' + r.id;
    const tdCust = document.createElement('td');
    const href = custHref(r);
    tdCust.innerHTML = href ? `<a class="lk" href="${href}" title="orig">顧客${r.cust}</a>` : `<a class="lk">顧客${r.cust}</a>`;
    const tdLink = document.createElement('td');
    tdLink.innerHTML = `<a class="ln" href="${linkHref(r)}">link</a>`;
    tr.append(tdText, tdCust, tdLink);
    tbody.appendChild(tr);
    cells.text.push(tdText);
    cells.cust.push(tdCust);
    cells.link.push(tdLink);
    records.push({ $id: { value: String(r.id) }, text: {}, cust: {}, link: {} });
  }
  return { cells, records, icons: [...tbody.querySelectorAll('tr')].map((tr) => tr.firstChild) };
}

function fakeAcl() {
  const pending = [];
  const api = {
    peek: vi.fn(() => null),
    cacheKey: (r) => `${r.appId}|${r.keyType}|${r.value}`,
    check: vi.fn((reqs) => new Promise((resolve) => pending.push({ reqs, resolve }))),
    resolveLast: (stateFn) => {
      const p = pending.shift();
      p.resolve(new Map(p.reqs.map((r) => [api.cacheKey(r), stateFn(r)])));
    },
  };
  return api;
}

function setup(over = {}, cfgOver = {}) {
  const list = over.list || buildList([{ id: 10, cust: 5 }, { id: 11, cust: 6 }]);
  const config = normalize({ rowClick: 'row', ...cfgOver });
  const navigate = vi.fn();
  let sel = null;
  const deps = {
    platform: 'desktop',
    config,
    getAppId: () => '1',
    getFieldElements: (code) => list.cells[code] || null,
    fetchFormFields: async () => PROPS,
    aclChecker: null,
    host: HOST,
    currentSpaceId: null,
    navigate,
    root: window,
    getSelection: () => sel,
    ...over.deps,
  };
  const controller = createListController(deps);
  return { list, controller, navigate, deps, setSel: (s) => (sel = s) };
}

const click = (el, init = {}) => {
  const ev = new MouseEvent(init.type || 'click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
};

let controllers = [];
beforeEach(() => {
  controllers = [];
});
afterEach(() => {
  controllers.forEach((c) => c.dispose());
  vi.restoreAllMocks();
});
const mk = (...a) => {
  const s = setup(...a);
  controllers.push(s.controller);
  return s;
};

describe('バインド', () => {
  it('index.show を3回呼んでも click/auxclick は1回ずつ登録', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    const { controller, list } = mk();
    for (let i = 0; i < 3; i++) controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    const calls = spy.mock.calls.filter((c) => c[2] === true).map((c) => c[0]);
    expect(calls.filter((t) => t === 'click')).toHaveLength(1);
    expect(calls.filter((t) => t === 'auxclick')).toHaveLength(1);
  });
});

describe('行クリック', () => {
  it('データ td のクリックで詳細リンクの href へ遷移', async () => {
    const { controller, list, navigate } = mk();
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    click(list.cells.text[0]);
    expect(navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
    click(list.cells.text[1]);
    expect(navigate).toHaveBeenLastCalledWith('/k/1/show#record=11', 'same');
  });

  it('詳細リンクがない行は buildRecordUrl の結果（ゲスト対応）', () => {
    const list = buildList([{ id: 10, cust: 5 }], { detailLink: false });
    const { controller, navigate } = mk({ list, deps: { currentSpaceId: '7' } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    click(list.cells.text[0]);
    expect(navigate).toHaveBeenCalledWith('/k/guest/7/1/show#record=10', 'same');
  });

  it('除外: 詳細アイコン td / button / 右クリック / 選択中 / input あり', () => {
    const { controller, list, navigate, setSel } = mk();
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    click(list.icons[0]); // 非データセル
    click(list.icons[0].querySelector('a')); // a の内側
    const btn = document.createElement('button');
    list.cells.text[0].appendChild(btn);
    click(btn);
    click(list.cells.text[0], { button: 2 });
    setSel({ toString: () => 'abc', anchorNode: list.cells.text[0] });
    click(list.cells.text[0]);
    setSel(null);
    expect(navigate).not.toHaveBeenCalled();
    const input = document.createElement('input');
    list.cells.text[1].appendChild(input);
    click(list.cells.text[1]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Ctrl クリックと中クリックは new', () => {
    const { controller, list, navigate } = mk();
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    click(list.cells.text[0], { ctrlKey: true });
    expect(navigate).toHaveBeenLastCalledWith('/k/1/show#record=10', 'new');
    click(list.cells.text[0], { type: 'auxclick', button: 1 });
    expect(navigate).toHaveBeenLastCalledWith('/k/1/show#record=10', 'new');
    expect(navigate).toHaveBeenCalledTimes(2);
    click(list.cells.text[0], { type: 'auxclick', button: 2 });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('openMode:new の設定が反映される', () => {
    const { controller, list, navigate } = mk({}, { openMode: 'new' });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    click(list.cells.text[0]);
    expect(navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'new');
  });

  it('rowClick:default や対象外 viewId では何もしない', () => {
    const a = mk({}, { rowClick: 'default' });
    a.controller.onIndexShow({ viewType: 'list', viewId: 1, records: a.list.records });
    click(a.list.cells.text[0]);
    expect(a.navigate).not.toHaveBeenCalled();

    const b = mk({}, { views: { mode: 'selected', ids: ['9'] } });
    b.controller.onIndexShow({ viewType: 'list', viewId: 1, records: b.list.records });
    click(b.list.cells.text[0]);
    expect(b.navigate).not.toHaveBeenCalled();

    const c = mk();
    c.controller.onIndexShow({ viewType: 'calendar', viewId: 1, records: c.list.records });
    click(c.list.cells.text[0]);
    expect(c.navigate).not.toHaveBeenCalled();
  });

  it('ホバー有効時は tr に klc-row-clickable が付く', () => {
    const on = mk();
    on.controller.onIndexShow({ viewType: 'list', viewId: 1, records: on.list.records });
    expect(document.querySelectorAll('tr.klc-row-clickable')).toHaveLength(2);
    const off = mk({}, { hover: false });
    off.controller.onIndexShow({ viewType: 'list', viewId: 1, records: off.list.records });
    expect(document.querySelectorAll('tr.klc-row-clickable')).toHaveLength(0);
  });
});

describe('ルックアップ', () => {
  it('text: href が退避されクリックは defaultPrevented', async () => {
    const { controller, list, navigate } = mk({}, { lookup: { mode: 'text' } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const a = list.cells.cust[0].querySelector('a');
    expect(a.hasAttribute('href')).toBe(false);
    expect(a.getAttribute('data-klc-href')).toBe('/k/2/show#record=5');
    expect(a.classList.contains('klc-lookup-text')).toBe(true);
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled(); // 行遷移にも波及しない
  });

  it('個別設定が全体設定より優先される', async () => {
    const { controller, list } = mk({}, { lookup: { mode: 'text', fields: { cust: 'standard' } } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    expect(list.cells.cust[0].querySelector('a').getAttribute('href')).toBe('/k/2/show#record=5');
  });

  it('self: クリックで自行 recordId へ navigate', async () => {
    const { controller, list, navigate } = mk({}, { lookup: { mode: 'self' } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const ev = click(list.cells.cust[1].querySelector('a'));
    expect(ev.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/k/1/show#record=11', 'same');
  });
});

describe('権限判定', () => {
  const permCfg = { permission: { enabled: true, targets: { lookup: true, recordLink: true } } };

  it('ゲストスペース内でも href が通常アプリなら spaceId は null（href を優先）', async () => {
    const acl = fakeAcl();
    const list = buildList([{ id: 10, cust: 5 }, { id: 11, cust: 6 }], {
      custHref: (r) => (r.id === 10 ? '/k/2/show#record=5' : '/k/guest/7/2/show#record=6'),
      linkHref: () => '/k/3/show#record=1',
    });
    const { controller } = mk({ list, deps: { aclChecker: acl, currentSpaceId: '5' } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const reqs = acl.check.mock.calls[0][0];
    expect(reqs.find((r) => r.value === '5' && r.appId === '2').spaceId).toBeNull();
    expect(reqs.find((r) => r.value === '6').spaceId).toBe('7');
    expect(reqs.find((r) => r.appId === '3').spaceId).toBeNull();
  });

  it('href が解析できないキー型は currentSpaceId を使う', async () => {
    const acl = fakeAcl();
    const list = buildList([{ id: 10, cust: 5 }], { custHref: () => null });
    const { controller } = mk({ list, deps: { aclChecker: acl, currentSpaceId: '5' } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const r = acl.check.mock.calls[0][0].find((x) => x.keyType === 'key');
    expect(r.spaceId).toBe('5');
  });

  it('標準動作へ戻るエラーの警告は 1 回の判定につき 1 回', async () => {
    const acl = fakeAcl();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    acl.resolveLast(() => 'error');
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('pending -> deny -> 退避、allow -> 復元', async () => {
    const acl = fakeAcl();
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const a0 = list.cells.cust[0].querySelector('a');
    const a1 = list.cells.cust[1].querySelector('a');
    expect(a0.classList.contains('klc-acl-pending')).toBe(true);
    expect(a0.getAttribute('aria-busy')).toBe('true');
    expect(click(a0).defaultPrevented).toBe(true); // pending 中は抑止
    expect(acl.check).toHaveBeenCalledTimes(1);

    acl.resolveLast((r) => (r.value === '5' ? 'deny' : 'allow'));
    await flush();
    expect(a0.hasAttribute('href')).toBe(false);
    expect(a0.getAttribute('data-klc-href')).toBe('/k/2/show#record=5');
    expect(a0.classList.contains('klc-acl-denied')).toBe(true);
    expect(a0.classList.contains('klc-acl-pending')).toBe(false);
    expect(a0.getAttribute('aria-disabled')).toBe('true');
    expect(a0.getAttribute('title')).toBe('遷移先レコードの閲覧権限がありません');
    expect(click(a0).defaultPrevented).toBe(true);

    // allow: href・title・class が元に戻る
    expect(a1.getAttribute('href')).toBe('/k/2/show#record=6');
    expect(a1.getAttribute('title')).toBe('orig');
    expect(a1.className).toBe('lk');
    expect(a1.hasAttribute('aria-busy')).toBe(false);
    expect(a1.hasAttribute('data-klc-state')).toBe(false);
    expect(click(a1).defaultPrevented).toBe(false);
  });

  it('リンクフィールド（kintone レコード URL）も判定対象になる', async () => {
    const acl = fakeAcl();
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const reqs = acl.check.mock.calls[0][0];
    expect(reqs.filter((r) => r.appId === '3')).toHaveLength(2);
    expect(reqs.filter((r) => r.appId === '2')).toHaveLength(2);
  });

  it('peek で解決済みの結果は即時反映される', async () => {
    const acl = fakeAcl();
    acl.peek = vi.fn(() => 'deny');
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    expect(list.cells.cust[0].querySelector('a').classList.contains('klc-acl-denied')).toBe(true);
    expect(acl.check).not.toHaveBeenCalled();
  });

  it("onError:'standard' の error は allow 表示と warn", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = fakeAcl();
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    acl.resolveLast(() => 'error');
    await flush();
    const a = list.cells.cust[0].querySelector('a');
    expect(a.getAttribute('href')).toBe('/k/2/show#record=5');
    expect(a.classList.contains('klc-acl-pending')).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("onError:'disable' の error は無効表示", async () => {
    const acl = fakeAcl();
    const cfg = { permission: { enabled: true, onError: 'disable', targets: { lookup: true, recordLink: false } } };
    const { controller, list } = mk({ deps: { aclChecker: acl } }, cfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    acl.resolveLast(() => 'error');
    await flush();
    const a = list.cells.cust[0].querySelector('a');
    expect(a.hasAttribute('href')).toBe(false);
    expect(a.getAttribute('title')).toBe('権限を確認できませんでした');
    expect(a.classList.contains('klc-acl-denied')).toBe(true);
  });

  it('check が reject したら error 扱い', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = fakeAcl();
    acl.check = vi.fn(() => Promise.reject(new Error('x')));
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    expect(list.cells.cust[0].querySelector('a').classList.contains('klc-acl-pending')).toBe(false);
  });

  it('旧世代の結果は新 DOM にも切り離された旧 anchor にも適用されない', async () => {
    let current = buildList([{ id: 10, cust: 5 }]);
    const acl = fakeAcl();
    const { controller } = mk({ list: current, deps: { aclChecker: acl, getFieldElements: (c) => current.cells[c] || null } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: current.records });
    await flush();
    const detached = current.cells.cust[0].querySelector('a');

    // DOM 差し替え（改ページ等）後に 2 回目の index.show
    current = buildList([{ id: 20, cust: 8 }]);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: current.records });
    await flush();
    expect(acl.check).toHaveBeenCalledTimes(2);
    expect(detached.isConnected).toBe(false);

    // 1 回目（旧世代）を deny で解決
    acl.resolveLast(() => 'deny');
    await flush();
    const newAnchor = current.cells.cust[0].querySelector('a');
    expect(newAnchor.classList.contains('klc-acl-denied')).toBe(false);
    expect(newAnchor.classList.contains('klc-acl-pending')).toBe(true);
    expect(newAnchor.getAttribute('href')).toBe('/k/2/show#record=8');
    expect(detached.classList.contains('klc-acl-denied')).toBe(false);
    expect(detached.getAttribute('href')).toBe('/k/2/show#record=5');
  });

  it('href に recordId がないルックアップは key 型で check に渡る', async () => {
    const acl = fakeAcl();
    const list = buildList([{ id: 10, cust: 5 }], { custHref: () => '/k/2/show' });
    const { controller } = mk({ list, deps: { aclChecker: acl } }, { permission: { enabled: true, targets: { lookup: true, recordLink: false } } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    expect(acl.check.mock.calls[0][0]).toEqual([
      { spaceId: null, appId: '2', keyType: 'key', keyField: 'code', value: '顧客5' },
    ]);
  });
});

describe('モバイル', () => {
  const mobile = (over = {}, cfg = {}) =>
    mk({ ...over, deps: { platform: 'mobile', ...(over.deps || {}) } }, cfg);

  it('self は /k/m/{app}/show?record= 形式へ遷移（ゲスト含む）', async () => {
    const list = buildList([{ id: 10, cust: 5 }], { detailLink: false });
    const a = mobile({ list }, { lookup: { mode: 'self' } });
    a.controller.onIndexShow({ records: list.records });
    await flush();
    click(list.cells.cust[0].querySelector('a'));
    expect(a.navigate).toHaveBeenCalledWith('/k/m/1/show?record=10', 'same');

    const list2 = buildList([{ id: 10, cust: 5 }], { detailLink: false });
    const b = mobile({ list: list2, deps: { currentSpaceId: '5' } }, { lookup: { mode: 'self' } });
    b.controller.onIndexShow({ records: list2.records });
    await flush();
    click(list2.cells.cust[0].querySelector('a'));
    expect(b.navigate).toHaveBeenCalledWith('/k/guest/5/m/1/show?record=10', 'same');
  });

  it('モバイル形式の href から ID 型で権限判定する', async () => {
    const acl = fakeAcl();
    const permCfg = { permission: { enabled: true, targets: { lookup: true, recordLink: true } } };
    const list = buildList([{ id: 10, cust: 5 }], {
      custHref: (r) => `/k/guest/7/m/2/show?record=${r.cust}`,
    });
    const { controller } = mobile({ list, deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ records: list.records });
    await flush();
    const r = acl.check.mock.calls[0][0].find((x) => x.appId === '2');
    expect(r).toMatchObject({ keyType: 'id', value: '5', spaceId: '7' });
  });

  it('モバイルでは行クリックで遷移しない', async () => {
    const { controller, list, navigate } = mobile();
    controller.onIndexShow({ records: list.records });
    click(list.cells.text[0]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('td 内の要素が getFieldElements から返っても行クリックが効く', () => {
    const list = buildList([{ id: 10, cust: 5 }]);
    const inner = document.createElement('span');
    list.cells.text[0].appendChild(inner);
    list.cells.text[0] = inner;
    const { controller, navigate } = mk({ list });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    click(inner);
    click(inner.parentElement);
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
