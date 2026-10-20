// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createListController, showToast, openBlankTab } from '../src/desktop/dom.js';
import { normalize } from '../src/core/config.js';

const HOST = 'x.cybozu.com';
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
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
    states: new Map(),
    peek: vi.fn((r) => api.states.get(api.cacheKey(r)) ?? null),
    cacheKey: (r) => `${r.appId}|${r.keyType}|${r.value}`,
    check: vi.fn((reqs) => new Promise((resolve, reject) => pending.push({ reqs, resolve, reject }))),
    /** 保留中の check の先頭（FIFO）を解決する。プリフェッチが 1 番目、クリック時が 2 番目 */
    resolveLast: (stateFn) => {
      const p = pending.shift();
      p.resolve(new Map(p.reqs.map((r) => [api.cacheKey(r), stateFn(r)])));
    },
    /** 保留中の check をすべて解決する */
    resolveAll: (stateFn) => {
      while (pending.length) api.resolveLast(stateFn);
    },
    rejectNext: (err = new Error('x')) => {
      pending.shift().reject(err);
    },
  };
  return api;
}

function setup(over = {}, cfgOver = {}) {
  const list = over.list || buildList([{ id: 10, cust: 5 }, { id: 11, cust: 6 }]);
  const config = normalize({ rowClick: 'row', ...cfgOver });
  const navigate = vi.fn();
  const tab = { blocked: false, go: vi.fn(), close: vi.fn() };
  const toast = vi.fn();
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
    openTab: vi.fn(() => tab),
    toast,
    root: window,
    getSelection: () => sel,
    ...over.deps,
  };
  const controller = createListController(deps);
  return { list, controller, navigate, deps, tab, toast, setSel: (s) => (sel = s) };
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
  vi.useRealTimers();
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
    expect(navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same'); // 無効リンクのクリックは行遷移に回る
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
    const list = buildList([{ id: 10, cust: 5 }], { custHref: () => '#' });
    const { controller } = mk({ list, deps: { aclChecker: acl, currentSpaceId: '5' } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const r = acl.check.mock.calls[0][0].find((x) => x.keyType === 'key');
    expect(r.spaceId).toBe('5');
  });

  it("クリック時の error で onError:'standard' なら warn 1 回・元の href へ navigate", async () => {
    const acl = fakeAcl();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = { permission: { enabled: true, onError: 'standard', targets: { lookup: true, recordLink: false } } };
    const { controller, list, navigate } = mk({ deps: { aclChecker: acl } }, cfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    click(list.cells.cust[0].querySelector('a'));
    await flush();
    acl.resolveAll(() => 'error');
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/k/2/show#record=5', 'same');
  });

  it('表示後は deny / notfound / pending のどれでも href・class・title・aria が元のまま', async () => {
    const acl = fakeAcl();
    const { controller, list } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const a0 = list.cells.cust[0].querySelector('a');
    const a1 = list.cells.cust[1].querySelector('a');
    const names = (a) => [...a.attributes].map((x) => x.name).sort();
    // pending（判定中）
    expect(names(a0)).toEqual(['class', 'href', 'title']);
    expect(a0.getAttribute('href')).toBe('/k/2/show#record=5');
    acl.resolveLast((r) => (r.value === '5' ? 'deny' : 'notfound'));
    await flush();
    for (const [a, h] of [[a0, '/k/2/show#record=5'], [a1, '/k/2/show#record=6']]) {
      expect(names(a)).toEqual(['class', 'href', 'title']);
      expect(a.getAttribute('href')).toBe(h);
      expect(a.className).toBe('lk');
      expect(a.getAttribute('title')).toBe('orig');
    }
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

  it('peek=deny ならプリフェッチの check は呼ばれず DOM も変わらず、クリックで同期的に自レコードへ遷移', async () => {
    const acl = fakeAcl();
    acl.peek = vi.fn(() => 'deny');
    const { controller, list, navigate } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const a = list.cells.cust[0].querySelector('a');
    expect(acl.check).not.toHaveBeenCalled();
    expect(a.className).toBe('lk');
    expect(a.getAttribute('href')).toBe('/k/2/show#record=5');
    const ev = click(a);
    expect(ev.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
  });

  it("クリック時の error で onError:'disable' なら navigate せずトースト", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = fakeAcl();
    const cfg = { permission: { enabled: true, onError: 'disable', targets: { lookup: true, recordLink: false } } };
    const { controller, list, navigate, toast } = mk({ deps: { aclChecker: acl } }, cfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    click(list.cells.cust[0].querySelector('a'));
    await flush();
    acl.resolveAll(() => 'error');
    await flush();
    expect(navigate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('閲覧権限を確認できなかったため開けません');
  });

  it('クリック時の check が reject したら onError（既定 self）で自レコードへ遷移', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const acl = fakeAcl();
    const { controller, list, navigate } = mk({ deps: { aclChecker: acl } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    click(list.cells.cust[0].querySelector('a'));
    await flush();
    acl.resolveLast(() => 'allow'); // プリフェッチ分
    acl.rejectNext(); // クリック時の分
    await flush();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
    expect(list.cells.cust[0].querySelector('a').classList.contains('klc-acl-checking')).toBe(false);
  });

  it('再描画のあとも check は世代ごとに呼ばれ、どちらの DOM も変わらない', async () => {
    let current = buildList([{ id: 10, cust: 5 }]);
    const acl = fakeAcl();
    const { controller } = mk({ list: current, deps: { aclChecker: acl, getFieldElements: (c) => current.cells[c] || null } }, permCfg);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: current.records });
    await flush();
    const detached = current.cells.cust[0].querySelector('a');

    current = buildList([{ id: 20, cust: 8 }]);
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: current.records });
    await flush();
    expect(acl.check).toHaveBeenCalledTimes(2);
    expect(detached.isConnected).toBe(false);

    acl.resolveAll(() => 'deny');
    await flush();
    const newAnchor = current.cells.cust[0].querySelector('a');
    expect(newAnchor.className).toBe('lk');
    expect(newAnchor.getAttribute('href')).toBe('/k/2/show#record=8');
    expect(detached.className).toBe('lk');
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

describe('リンククリック時の権限判定', () => {
  const permCfg = (extra = {}, perm = {}) => ({
    permission: { enabled: true, targets: { lookup: true, recordLink: false }, ...perm },
    ...extra,
  });
  const KEY0 = '2|id|5';
  /** 表示 → プリフェッチ済みの状態にする */
  async function shown(cfg = permCfg(), over = {}) {
    const acl = fakeAcl();
    const s = mk({ ...over, deps: { aclChecker: acl, ...(over.deps || {}) } }, cfg);
    s.controller.onIndexShow({ viewType: 'list', viewId: 1, records: s.list.records });
    await flush();
    s.acl = acl;
    s.a = s.list.cells.cust[0].querySelector('a');
    return s;
  }

  it("text モード: rowClick:'default' では遷移しない", async () => {
    const { controller, list, navigate } = mk({}, { rowClick: 'default', lookup: { mode: 'text' } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    const ev = click(list.cells.cust[0].querySelector('a'));
    expect(ev.defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('deny（キャッシュあり）: preventDefault され自レコードへフォールバック', async () => {
    const s = await shown();
    s.acl.states.set(KEY0, 'deny');
    const ev = click(s.a);
    expect(ev.defaultPrevented).toBe(true);
    expect(s.navigate).toHaveBeenCalledTimes(1);
    expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
  });

  it('notfound（キャッシュあり）: DOM は変わらず自レコードへ遷移', async () => {
    const s = await shown();
    s.acl.states.set(KEY0, 'notfound');
    click(s.a);
    expect(s.a.className).toBe('lk');
    expect(s.a.getAttribute('href')).toBe('/k/2/show#record=5');
    expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
  });

  it('rowClick:default でも row でも自レコードへ遷移し、行クリックは重ねて発火しない', async () => {
    for (const rowClick of ['default', 'row']) {
      document.body.innerHTML = '';
      const s = await shown(permCfg({ rowClick }));
      s.acl.states.set(KEY0, 'deny');
      click(s.a);
      expect(s.navigate).toHaveBeenCalledTimes(1);
      expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
      s.controller.dispose();
    }
  });

  it('allow（キャッシュあり）の same は素通し', async () => {
    const s = await shown();
    s.acl.states.set(KEY0, 'allow');
    const ev = click(s.a);
    expect(ev.defaultPrevented).toBe(false);
    expect(s.navigate).not.toHaveBeenCalled();
  });

  it('allow（キャッシュあり）+ Ctrl は元のリンク先を new で開く（openTab は使わない）', async () => {
    const s = await shown();
    s.acl.states.set(KEY0, 'allow');
    click(s.a, { ctrlKey: true });
    expect(s.navigate).toHaveBeenCalledWith('/k/2/show#record=5', 'new');
    expect(s.deps.openTab).not.toHaveBeenCalled();
  });

  it('キャッシュあり deny の中クリックと Ctrl クリックは自レコードを new で開く', async () => {
    const s = await shown();
    s.acl.states.set(KEY0, 'deny');
    click(s.a, { type: 'auxclick', button: 1 });
    expect(s.navigate).toHaveBeenLastCalledWith('/k/1/show#record=10', 'new');
    click(s.a, { ctrlKey: true });
    expect(s.navigate).toHaveBeenLastCalledWith('/k/1/show#record=10', 'new');
  });

  it('自レコードの URL: ゲスト形式 / モバイル形式', async () => {
    const list = buildList([{ id: 10, cust: 5 }], { detailLink: false });
    const g = await shown(permCfg(), { list, deps: { currentSpaceId: '7' } });
    g.acl.states.set('2|id|5', 'deny');
    click(g.a);
    expect(g.navigate).toHaveBeenCalledWith('/k/guest/7/1/show#record=10', 'same');

    document.body.innerHTML = '';
    const list2 = buildList([{ id: 10, cust: 5 }], { detailLink: false });
    const acl = fakeAcl();
    const m = mk({ list: list2, deps: { platform: 'mobile', aclChecker: acl } }, permCfg());
    m.controller.onIndexShow({ records: list2.records });
    await flush();
    acl.states.set('2|id|5', 'deny');
    const ev = click(list2.cells.cust[0].querySelector('a'));
    expect(ev.defaultPrevented).toBe(true);
    expect(m.navigate).toHaveBeenCalledWith('/k/m/1/show?record=10', 'same');
  });

  it('onDeny:disable: deny / notfound は navigate せずトースト', async () => {
    const s = await shown(permCfg({}, { onDeny: 'disable' }));
    s.acl.states.set(KEY0, 'deny');
    click(s.a);
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.toast).toHaveBeenLastCalledWith('ルックアップ先レコードの閲覧権限がないため開けません');
    s.acl.states.set(KEY0, 'notfound');
    click(s.a);
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.toast).toHaveBeenLastCalledWith('ルックアップ先のレコードが見つかりません');
  });

  it('キャッシュなし: 判定中の表示が付き、allow で解決すると遷移して表示が外れる', async () => {
    const s = await shown();
    click(s.a);
    expect(s.a.classList.contains('klc-acl-checking')).toBe(true);
    expect(s.a.getAttribute('aria-busy')).toBe('true');
    expect(document.documentElement.classList.contains('klc-busy')).toBe(true);
    expect(s.navigate).not.toHaveBeenCalled();
    await flush();
    s.acl.resolveAll(() => 'allow');
    await flush();
    expect(s.navigate).toHaveBeenCalledTimes(1);
    expect(s.navigate).toHaveBeenCalledWith('/k/2/show#record=5', 'same');
    expect(s.a.classList.contains('klc-acl-checking')).toBe(false);
    expect(s.a.hasAttribute('aria-busy')).toBe(false);
    expect(document.documentElement.classList.contains('klc-busy')).toBe(false);
  });

  it('キャッシュなし → deny で解決すると自レコードへ遷移', async () => {
    const s = await shown();
    click(s.a);
    await flush();
    s.acl.resolveAll(() => 'deny');
    await flush();
    expect(s.navigate).toHaveBeenCalledTimes(1);
    expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
  });

  describe('タイムアウト', () => {
    const run = async (onError) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = await shown(permCfg({}, onError ? { onError } : {}));
      click(s.a);
      await vi.advanceTimersByTimeAsync(1499);
      expect(s.navigate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      return s;
    };

    it('onError=self（既定）: 自レコードへ。後から allow が届いても 1 回だけ', async () => {
      const s = await run();
      expect(s.navigate).toHaveBeenCalledTimes(1);
      expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
      s.acl.resolveAll(() => 'allow');
      await flush();
      expect(s.navigate).toHaveBeenCalledTimes(1);
    });

    it('onError=standard: 元の href へ', async () => {
      const s = await run('standard');
      expect(s.navigate).toHaveBeenCalledTimes(1);
      expect(s.navigate).toHaveBeenCalledWith('/k/2/show#record=5', 'same');
      s.acl.resolveAll(() => 'allow');
      await flush();
      expect(s.navigate).toHaveBeenCalledTimes(1);
    });

    it('onError=disable: navigate せず error のトースト', async () => {
      const s = await run('disable');
      expect(s.navigate).not.toHaveBeenCalled();
      expect(s.toast).toHaveBeenCalledWith('閲覧権限を確認できなかったため開けません');
      s.acl.resolveAll(() => 'allow');
      await flush();
      expect(s.navigate).not.toHaveBeenCalled();
    });
  });

  it('判定中の連打は無視され、check は 1 回・遷移も 1 回', async () => {
    const s = await shown();
    const before = s.acl.check.mock.calls.length;
    click(s.a);
    click(s.a);
    click(s.a);
    await flush();
    expect(s.acl.check.mock.calls.length - before).toBe(1);
    s.acl.resolveAll(() => 'deny');
    await flush();
    expect(s.navigate).toHaveBeenCalledTimes(1);
  });

  describe('新しいタブ（キャッシュなし）', () => {
    const cases = [
      ['Ctrl', { ctrlKey: true }, {}],
      ['Meta', { metaKey: true }, {}],
      ['Shift', { shiftKey: true }, {}],
      ['auxclick button=1', { type: 'auxclick', button: 1 }, {}],
      ['openMode:new', {}, { openMode: 'new' }],
    ];
    it.each(cases)('%s: クリック中に同期的に openTab し、解決後に tab.go', async (_n, init, extra) => {
      const s = await shown(permCfg(extra));
      const ev = click(s.a, init);
      expect(s.deps.openTab).toHaveBeenCalledTimes(1);
      if (init.type === 'auxclick') expect(ev.defaultPrevented).toBe(true);
      await flush();
      s.acl.resolveAll(() => 'allow');
      await flush();
      expect(s.tab.go).toHaveBeenCalledWith('/k/2/show#record=5');
      expect(s.navigate).not.toHaveBeenCalled();
    });

    it('block（onDeny=disable + deny）: tab.close とトースト', async () => {
      const s = await shown(permCfg({}, { onDeny: 'disable' }));
      click(s.a, { ctrlKey: true });
      await flush();
      s.acl.resolveAll(() => 'deny');
      await flush();
      expect(s.tab.close).toHaveBeenCalledTimes(1);
      expect(s.tab.go).not.toHaveBeenCalled();
      expect(s.toast).toHaveBeenCalledWith('ルックアップ先レコードの閲覧権限がないため開けません');
    });

    it('ポップアップがブロックされたら navigate(url,new) とトースト', async () => {
      const blocked = { blocked: true, go: vi.fn(), close: vi.fn() };
      const s = await shown(permCfg(), { deps: { openTab: vi.fn(() => blocked) } });
      click(s.a, { ctrlKey: true });
      await flush();
      s.acl.resolveAll(() => 'allow');
      await flush();
      expect(s.navigate).toHaveBeenCalledWith('/k/2/show#record=5', 'new');
      expect(s.toast).toHaveBeenCalledWith('ポップアップがブロックされました。もう一度クリックしてください');
    });
  });

  it('href なし: プリフェッチに含まれず、check せず同期的に自レコードへ（disable なら notfound のトースト）', async () => {
    const list = buildList([{ id: 10, cust: 5 }], { custHref: () => null });
    const s = await shown(permCfg(), { list });
    expect(s.acl.check).not.toHaveBeenCalled();
    click(s.a);
    expect(s.acl.check).not.toHaveBeenCalled();
    expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');

    document.body.innerHTML = '';
    const list2 = buildList([{ id: 10, cust: 5 }], { custHref: () => null });
    const d = await shown(permCfg({}, { onDeny: 'disable' }), { list: list2 });
    click(d.a);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.toast).toHaveBeenCalledWith('ルックアップ先のレコードが見つかりません');
  });

  it('javascript: の href には介入しない', async () => {
    const list = buildList([{ id: 10, cust: 5 }], { custHref: () => 'javascript:void(0)' });
    const s = await shown(permCfg(), { list });
    const before = s.acl.check.mock.calls.length;
    const ev = click(s.a);
    expect(ev.defaultPrevented).toBe(false);
    expect(s.navigate).not.toHaveBeenCalled();
    expect(s.acl.check.mock.calls.length).toBe(before);
  });

  it('permission.enabled:false では check せず、クリックは素通し', async () => {
    const acl = fakeAcl();
    const { controller, list, navigate } = mk({ deps: { aclChecker: acl } }, { permission: { enabled: false } });
    controller.onIndexShow({ viewType: 'list', viewId: 1, records: list.records });
    await flush();
    expect(acl.check).not.toHaveBeenCalled();
    const ev = click(list.cells.cust[0].querySelector('a'));
    expect(ev.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    // lookup mode=self と text の挙動は 'ルックアップ' の describe（既存テスト）で担保
  });

  it('recordLink の deny でも自レコードへ遷移する', async () => {
    const s = await shown({ permission: { enabled: true, targets: { lookup: true, recordLink: true } } });
    s.acl.states.set('3|id|5', 'deny');
    const ev = click(s.list.cells.link[0].querySelector('a'));
    expect(ev.defaultPrevented).toBe(true);
    expect(s.navigate).toHaveBeenCalledWith('/k/1/show#record=10', 'same');
  });

  it('プリフェッチ: 表示時に check が 1 回呼ばれ、deny で解決しても anchor の属性は変わらない', async () => {
    const s = await shown();
    expect(s.acl.check).toHaveBeenCalledTimes(1);
    s.acl.resolveAll(() => 'deny');
    await flush();
    expect(s.a.getAttribute('href')).toBe('/k/2/show#record=5');
    expect(s.a.className).toBe('lk');
    expect(s.a.getAttribute('title')).toBe('orig');
    expect([...s.a.attributes].map((x) => x.name).sort()).toEqual(['class', 'href', 'title']);
  });
});

describe('showToast', () => {
  it('要素を使い回し、textContent のみ、3 秒後に hidden', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    showToast(document, '<b>x</b>');
    showToast(document, '<b>y</b>');
    const els = document.querySelectorAll('div.klc-toast');
    expect(els).toHaveLength(1);
    const el = els[0];
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('<b>y</b>');
    expect(el.hidden).toBe(false);
    vi.advanceTimersByTime(2999);
    expect(el.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hidden).toBe(true);
  });
});

describe('openBlankTab', () => {
  const mkWin = (w) => ({ open: vi.fn(() => w), location: { href: 'https://x.cybozu.com/k/1/' } });
  const mkTab = () => ({ opener: 'x', closed: false, location: { replace: vi.fn() }, close: vi.fn() });

  it('空タブを開き opener=null、go は location.replace', () => {
    const w = mkTab();
    const win = mkWin(w);
    const t = openBlankTab(win);
    expect(win.open).toHaveBeenCalledWith('', '_blank');
    expect(w.opener).toBeNull();
    expect(t.blocked).toBe(false);
    t.go('/k/2/show#record=5');
    expect(w.location.replace).toHaveBeenCalledWith('https://x.cybozu.com/k/2/show#record=5');
  });

  it('closed なら replace しない。close() が呼ばれる', () => {
    const w = mkTab();
    const t = openBlankTab(mkWin(w));
    w.closed = true;
    t.go('/k/2/show#record=5');
    expect(w.location.replace).not.toHaveBeenCalled();
    w.closed = false;
    t.close();
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it('open が null を返すか throw したら blocked', () => {
    expect(openBlankTab({ open: () => null, location: { href: 'https://x/' } }).blocked).toBe(true);
    expect(
      openBlankTab({ open: () => { throw new Error('x'); }, location: { href: 'https://x/' } }).blocked,
    ).toBe(true);
  });
});
