import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chunk, escapeQueryValue, buildInQuery, groupRequests, extractValues, classifyError,
  nextBackoffMs, createAclChecker, createKintoneFetcher, cacheKey,
  classifyRecordError, createKintoneRecordFetcher, MAX_RECHECK_PER_CHECK,
} from '../src/core/acl.js';

const HOST = 'x.cybozu.com';
const idReq = (value, appId = '1', spaceId = null) => ({ spaceId, appId, keyType: 'id', keyField: null, value });
const keyReq = (value, appId = '1', keyField = 'code') => ({ spaceId: null, appId, keyType: 'key', keyField, value });

function fakeStorage(initial) {
  const m = new Map(initial ? Object.entries(initial) : []);
  return { getItem: vi.fn((k) => (m.has(k) ? m.get(k) : null)), setItem: vi.fn((k, v) => m.set(k, v)), removeItem: vi.fn((k) => m.delete(k)), m };
}
/** 渡された in クエリの値をそのまま「見える」として返す fetcher */
const echoFetcher = (visible) =>
  vi.fn(async ({ query }) => {
    const vals = [...query.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
    return { records: vals.filter((v) => visible.includes(v)).map((v) => ({ $id: { value: v } })) };
  });

afterEach(() => vi.useRealTimers());

describe('helpers', () => {
  it('chunk', () => {
    expect(chunk([])).toEqual([]);
    expect(chunk(Array(100).fill(1))).toHaveLength(1);
    const c = chunk(Array(101).fill(1));
    expect(c.map((x) => x.length)).toEqual([100, 1]);
  });
  it('escapeQueryValue / buildInQuery', () => {
    expect(escapeQueryValue('a"b\\c')).toBe('a\\"b\\\\c');
    expect(buildInQuery({ keyType: 'id', keyField: null, values: ['1', '2'] })).toBe('$id in ("1","2") limit 100');
    expect(buildInQuery({ keyType: 'key', keyField: 'code', values: ['a"b'] })).toBe('code in ("a\\"b") limit 100');
    expect(buildInQuery({ keyType: 'key', keyField: '顧客コード', values: ['a'] })).toContain('顧客コード in');
    expect(() => buildInQuery({ keyType: 'key', keyField: 'a in (1) or b', values: ['x'] })).toThrow();
    expect(() => buildInQuery({ keyType: 'key', keyField: null, values: ['x'] })).toThrow();
  });
  it('groupRequests は trim・重複・空を除く', () => {
    const g = groupRequests([idReq(' 1 '), idReq('1'), idReq(''), idReq('2'), idReq('3', '2')]);
    expect(g.size).toBe(2);
    expect([...g.values()][0].values).toEqual(['1', '2']);
  });
  it('extractValues', () => {
    expect(extractValues([{ $id: { value: '1' } }, { $id: { value: ' 2 ' } }], { keyType: 'id', keyField: null })).toEqual(new Set(['1', '2']));
    expect(extractValues([{ code: { value: 'a' }, $id: { value: '1' } }], { keyType: 'key', keyField: 'code' })).toEqual(new Set(['a']));
  });
  it('URL 不整合系エラー（GAIA_IL23, CB_IJ01）は error、Unicode のキーフィールドは許可', () => {
    expect(classifyError({ code: 'GAIA_IL23' })).toBe('error');
    expect(classifyError({ code: 'GAIA_NO01' })).toBe('error');
    expect(classifyError({ code: 'CB_IJ01' })).toBe('error');
    expect(buildInQuery({ keyType: 'key', keyField: '々コード_１', values: ['a'] })).toContain('々コード_１ in');
    expect(() => buildInQuery({ keyType: 'key', keyField: 'a"b', values: ['x'] })).toThrow();
    expect(() => buildInQuery({ keyType: 'key', keyField: 'a b', values: ['x'] })).toThrow();
    expect(() => buildInQuery({ keyType: 'key', keyField: 'a=b', values: ['x'] })).toThrow();
  });
  it('classifyError / nextBackoffMs', () => {
    expect(classifyError({ code: 'CB_NO02' })).toBe('appDeny');
    expect(classifyError({ code: 'GAIA_AP01' })).toBe('appDeny');
    expect(classifyError({ code: 'TIMEOUT' })).toBe('error');
    expect(classifyError(new Error('x'))).toBe('error');
    expect(classifyError(null)).toBe('error');
    expect([1, 2, 3, 4].map(nextBackoffMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(nextBackoffMs(20)).toBe(60000);
  });
});

describe('createAclChecker', () => {
  it('含まれる値は allow、含まれない値は deny', async () => {
    const f = echoFetcher(['1']);
    const c = createAclChecker({ fetcher: f, host: HOST });
    const r = await c.check([idReq('1'), idReq('2')]);
    expect(r.get(cacheKey(HOST, idReq('1')))).toBe('allow');
    expect(r.get(cacheKey(HOST, idReq('2')))).toBe('deny');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0].fields).toEqual(['$id']);
  });

  it('key 型は fields に keyField を含む', async () => {
    const f = vi.fn(async () => ({ records: [{ $id: { value: '1' }, code: { value: 'a' } }] }));
    const c = createAclChecker({ fetcher: f, host: HOST });
    const r = await c.check([keyReq('a'), keyReq('b')]);
    expect(f.mock.calls[0][0].fields).toEqual(['$id', 'code']);
    expect(r.get(cacheKey(HOST, keyReq('a')))).toBe('allow');
    expect(r.get(cacheKey(HOST, keyReq('b')))).toBe('deny');
  });

  it('101 件は 2 回に分割される', async () => {
    const f = echoFetcher([]);
    const c = createAclChecker({ fetcher: f, host: HOST });
    await c.check(Array.from({ length: 101 }, (_, i) => idReq(String(i + 1))));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('重複と空白で呼び出しは 1 回', async () => {
    const f = echoFetcher(['1']);
    const c = createAclChecker({ fetcher: f, host: HOST });
    await c.check([idReq('1'), idReq(' 1 '), idReq('1')]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0].query).toBe('$id in ("1") limit 100');
  });

  it('空の値は deny で呼び出さない', async () => {
    const f = echoFetcher([]);
    const c = createAclChecker({ fetcher: f, host: HOST });
    const r = await c.check([idReq('')]);
    expect(r.get(cacheKey(HOST, idReq('')))).toBe('deny');
    expect(f).not.toHaveBeenCalled();
  });

  it('TTL 内は再取得せず、経過後は再取得、ttl=0 は毎回取得', async () => {
    let t = 0;
    const f = echoFetcher(['1']);
    const c = createAclChecker({ fetcher: f, host: HOST, now: () => t, ttlSec: 300 });
    await c.check([idReq('1')]);
    t = 299_000;
    await c.check([idReq('1')]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.peek(idReq('1'))).toBe('allow');
    t = 301_000;
    expect(c.peek(idReq('1'))).toBeNull();
    await c.check([idReq('1')]);
    expect(f).toHaveBeenCalledTimes(2);

    const f0 = echoFetcher(['1']);
    const c0 = createAclChecker({ fetcher: f0, host: HOST, ttlSec: 0 });
    await c0.check([idReq('1')]);
    await c0.check([idReq('1')]);
    expect(f0).toHaveBeenCalledTimes(2);
  });

  it('同時 check は in-flight を共有する', async () => {
    let resolve;
    const f = vi.fn(() => new Promise((r) => (resolve = r)));
    const c = createAclChecker({ fetcher: f, host: HOST });
    const p1 = c.check([idReq('1')]);
    expect(c.peek(idReq('1'))).toBe('pending');
    const p2 = c.check([idReq('1')]);
    expect(f).toHaveBeenCalledTimes(1);
    resolve({ records: [{ $id: { value: '1' } }] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.get(cacheKey(HOST, idReq('1')))).toBe('allow');
    expect(r2.get(cacheKey(HOST, idReq('1')))).toBe('allow');
  });

  it('アプリ権限エラーでそのアプリ全件 deny、以後 0 回、別アプリは影響なし', async () => {
    const f = vi.fn(async ({ appId }) => {
      if (appId === '1') throw { code: 'CB_NO02' };
      return { records: [{ $id: { value: '9' } }] };
    });
    const c = createAclChecker({ fetcher: f, host: HOST });
    const r = await c.check([idReq('5', '1'), idReq('6', '1'), idReq('9', '2')]);
    expect(r.get(cacheKey(HOST, idReq('5', '1')))).toBe('deny');
    expect(r.get(cacheKey(HOST, idReq('6', '1')))).toBe('deny');
    expect(r.get(cacheKey(HOST, idReq('9', '2')))).toBe('allow');
    const calls = f.mock.calls.length;
    const r2 = await c.check([idReq('7', '1')]);
    expect(r2.get(cacheKey(HOST, idReq('7', '1')))).toBe('deny');
    expect(f.mock.calls.length).toBe(calls);
    expect(c.peek(idReq('8', '1'))).toBe('deny');
  });

  it('一般エラーは非キャッシュ、バックオフ中は呼ばない、期間後に再試行、成功でリセット', async () => {
    let t = 0;
    let fail = true;
    const f = vi.fn(async () => {
      if (fail) throw new Error('net');
      return { records: [{ $id: { value: '1' } }] };
    });
    const c = createAclChecker({ fetcher: f, host: HOST, now: () => t });
    const k = cacheKey(HOST, idReq('1'));
    expect((await c.check([idReq('1')])).get(k)).toBe('error');
    expect(f).toHaveBeenCalledTimes(1);
    t = 500;
    expect((await c.check([idReq('1')])).get(k)).toBe('error');
    expect(f).toHaveBeenCalledTimes(1);
    t = 1000;
    expect((await c.check([idReq('1')])).get(k)).toBe('error'); // 2 回目失敗 -> 次は 2s 後
    expect(f).toHaveBeenCalledTimes(2);
    t = 2500;
    await c.check([idReq('1')]);
    expect(f).toHaveBeenCalledTimes(2);
    t = 3000;
    fail = false;
    expect((await c.check([idReq('1')])).get(k)).toBe('allow');
    expect(f).toHaveBeenCalledTimes(3);
    // リセット確認: 再度失敗しても 1 秒後に再試行可能
    t = 3000 + 301_000;
    fail = true;
    await c.check([idReq('1')]);
    t += 1000;
    await c.check([idReq('1')]);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('タイムアウトで error', async () => {
    vi.useFakeTimers();
    const f = vi.fn(() => new Promise(() => {}));
    const c = createAclChecker({ fetcher: f, host: HOST, timeoutMs: 5000 });
    const p = c.check([idReq('1')]);
    await vi.advanceTimersByTimeAsync(5001);
    const r = await p;
    expect(r.get(cacheKey(HOST, idReq('1')))).toBe('error');
  });

  it('並列度は最大 3', async () => {
    let active = 0;
    let max = 0;
    const resolvers = [];
    const f = vi.fn(
      () =>
        new Promise((resolve) => {
          active++;
          max = Math.max(max, active);
          resolvers.push(() => {
            active--;
            resolve({ records: [] });
          });
        }),
    );
    const c = createAclChecker({ fetcher: f, host: HOST, concurrency: 3 });
    const p = c.check([1, 2, 3, 4, 5].map((n) => idReq('1', String(n))));
    await Promise.resolve();
    expect(f).toHaveBeenCalledTimes(3);
    while (resolvers.length) {
      resolvers.shift()();
      await new Promise((r) => setTimeout(r, 0));
    }
    await p;
    expect(f).toHaveBeenCalledTimes(5);
    expect(max).toBe(3);
  });

  describe('storage', () => {
    it('id 型とアプリ deny のみ保存し key 型は保存しない', async () => {
      const s = fakeStorage();
      const f = vi.fn(async ({ appId }) => {
        if (appId === '3') throw { code: 'CB_NO02' };
        return { records: [{ $id: { value: '1' } }] };
      });
      const c = createAclChecker({ fetcher: f, host: HOST, storage: s });
      await c.check([idReq('1'), keyReq('secret-name', '2'), idReq('4', '3')]);
      const saved = s.m.get('klc-acl-v2');
      expect(saved).toBeTruthy();
      expect(saved).not.toContain('secret-name');
      const data = JSON.parse(saved);
      expect(data.entries.map((e) => e[0])).toEqual([cacheKey(HOST, idReq('1'))]);
      expect(data.apps).toHaveLength(1);
    });

    it('getItem/setItem が throw しても動く', async () => {
      const s = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('y'); } };
      const c = createAclChecker({ fetcher: echoFetcher(['1']), host: HOST, storage: s });
      const r = await c.check([idReq('1')]);
      expect(r.get(cacheKey(HOST, idReq('1')))).toBe('allow');
    });

    it('新インスタンスが storage から復元する', async () => {
      const s = fakeStorage();
      let t = 1000;
      const c1 = createAclChecker({ fetcher: echoFetcher(['1']), host: HOST, storage: s, now: () => t });
      await c1.check([idReq('1'), idReq('2')]);
      const f2 = echoFetcher([]);
      const c2 = createAclChecker({ fetcher: f2, host: HOST, storage: s, now: () => t + 1000 });
      const r = await c2.check([idReq('1'), idReq('2')]);
      expect(r.get(cacheKey(HOST, idReq('1')))).toBe('allow');
      // deny は永続化されないので復元されず、'2' だけ再取得される
      expect(f2).toHaveBeenCalledTimes(1);
      expect(f2.mock.calls[0][0].query).toBe('$id in ("2") limit 100');
      expect(r.get(cacheKey(HOST, idReq('2')))).toBe('deny');
      // 期限切れは捨てる
      const f3 = echoFetcher([]);
      const c3 = createAclChecker({ fetcher: f3, host: HOST, storage: s, now: () => t + 400_000 });
      await c3.check([idReq('1')]);
      expect(f3).toHaveBeenCalledTimes(1);
    });
  });
});

/** map: id -> 'ok' | {code} */
const recFetcher = (map) =>
  vi.fn(async ({ id }) => {
    const r = map[id];
    if (r && r.code) throw r;
    return { record: { $id: { value: id } } };
  });

describe('二段階確認', () => {
  const key = (v) => cacheKey(HOST, idReq(v));

  it('classifyRecordError', () => {
    expect(classifyRecordError({ code: 'CB_NO02' })).toBe('deny');
    expect(classifyRecordError({ code: 'GAIA_RE01' })).toBe('notfound');
    for (const e of [{ code: 'GAIA_AP01' }, { code: 'GAIA_IL23' }, { code: 'TIMEOUT' }, new Error('x'), null, undefined, 'str']) {
      expect(classifyRecordError(e)).toBe('error');
    }
  });

  it('返らない ID 型を record.json で個別に再確認する', async () => {
    const rf = recFetcher({ 2: 'ok', 3: { code: 'CB_NO02' }, 4: { code: 'GAIA_RE01' }, 5: { code: 'GAIA_XX' } });
    const c = createAclChecker({ fetcher: echoFetcher(['1']), recordFetcher: rf, host: HOST });
    const r = await c.check(['1', '2', '3', '4', '5'].map((v) => idReq(v)));
    expect(r.get(key('1'))).toBe('allow');
    expect(r.get(key('2'))).toBe('allow');
    expect(r.get(key('3'))).toBe('deny');
    expect(r.get(key('4'))).toBe('notfound');
    expect(r.get(key('5'))).toBe('error');
    expect(rf).toHaveBeenCalledTimes(4);
    expect(rf).toHaveBeenCalledWith({ spaceId: null, appId: '1', id: '2' });
    expect(c.peek(idReq('4'))).toBe('notfound');
    expect(c.peek(idReq('5'))).toBeNull();
  });

  it('一括で返った値には recordFetcher を呼ばない', async () => {
    const rf = recFetcher({});
    const c = createAclChecker({ fetcher: echoFetcher(['1', '2']), recordFetcher: rf, host: HOST });
    await c.check([idReq('1'), idReq('2')]);
    expect(rf).toHaveBeenCalledTimes(0);
  });

  it('key 型で返らない値は recordFetcher を呼ばず deny', async () => {
    const rf = recFetcher({});
    const c = createAclChecker({ fetcher: echoFetcher([]), recordFetcher: rf, host: HOST });
    const r = await c.check([keyReq('abc')]);
    expect(r.get(cacheKey(HOST, keyReq('abc')))).toBe('deny');
    expect(rf).toHaveBeenCalledTimes(0);
  });

  it('recordFetcher 未指定なら従来どおり deny', async () => {
    const c = createAclChecker({ fetcher: echoFetcher([]), host: HOST });
    const r = await c.check([idReq('9')]);
    expect(r.get(key('9'))).toBe('deny');
  });

  it('数字以外の ID は再確認せず deny', async () => {
    const rf = recFetcher({});
    const c = createAclChecker({ fetcher: echoFetcher([]), recordFetcher: rf, host: HOST });
    const r = await c.check([idReq('abc')]);
    expect(r.get(key('abc'))).toBe('deny');
    expect(rf).toHaveBeenCalledTimes(0);
  });

  it('再確認の上限（超過分は error、次の check で再確認できる）', async () => {
    expect(MAX_RECHECK_PER_CHECK).toBe(10);
    const rf = recFetcher({});
    const c = createAclChecker({ fetcher: echoFetcher([]), recordFetcher: rf, host: HOST });
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const r = await c.check(ids.map((v) => idReq(v)));
    expect(rf).toHaveBeenCalledTimes(10);
    const states = ids.map((v) => r.get(key(v)));
    expect(states.filter((x) => x === 'allow')).toHaveLength(10);
    expect(states.filter((x) => x === 'error')).toHaveLength(2);
    expect(c.peek(idReq('11'))).toBeNull(); // error はキャッシュされない
    const r2 = await c.check([idReq('11'), idReq('12')]);
    expect(rf).toHaveBeenCalledTimes(12);
    expect(r2.get(key('11'))).toBe('allow');
    expect(r2.get(key('12'))).toBe('allow');
  });

  it('再確認の並列度は concurrency に従う', async () => {
    let cur = 0;
    let max = 0;
    const resolvers = [];
    const rf = vi.fn(() => {
      cur++;
      max = Math.max(max, cur);
      return new Promise((res) => resolvers.push(() => { cur--; res({ record: {} }); }));
    });
    const c = createAclChecker({ fetcher: echoFetcher([]), recordFetcher: rf, host: HOST, concurrency: 2 });
    const p = c.check(['1', '2', '3', '4', '5'].map((v) => idReq(v)));
    for (let i = 0; i < 40 && resolvers.length < 5; i++) {
      await Promise.resolve();
      while (resolvers.length > 0 && rf.mock.calls.length > 0 && cur > 0) {
        resolvers.shift()();
        await Promise.resolve();
      }
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
      while (resolvers.length) resolvers.shift()();
    }
    const r = await p;
    expect(rf).toHaveBeenCalledTimes(5);
    expect(max).toBeLessThanOrEqual(2);
    expect(r.get(key('5'))).toBe('allow');
  });

  it('再確認の timeout は error で、バックオフせず次の check で bulk が呼ばれる', async () => {
    vi.useFakeTimers();
    const f = echoFetcher([]);
    const rf = vi.fn(() => new Promise(() => {}));
    const c = createAclChecker({ fetcher: f, recordFetcher: rf, host: HOST, timeoutMs: 5000 });
    const p = c.check([idReq('1')]);
    await vi.advanceTimersByTimeAsync(5001);
    const r = await p;
    expect(r.get(key('1'))).toBe('error');
    expect(f).toHaveBeenCalledTimes(1);
    const p2 = c.check([idReq('1')]);
    await vi.advanceTimersByTimeAsync(5001);
    await p2;
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('allow(ID 型) と appDeny のみ永続化し deny / notfound は保存しない', async () => {
    const s = fakeStorage();
    const f = vi.fn(async ({ appId, query }) => {
      if (appId === '3') throw { code: 'CB_NO02' };
      return echoFetcher(['1'])({ query });
    });
    const rf = recFetcher({ 2: 'ok', 3: { code: 'CB_NO02' }, 4: { code: 'GAIA_RE01' } });
    const c = createAclChecker({ fetcher: f, recordFetcher: rf, host: HOST, storage: s });
    await c.check([idReq('1'), idReq('2'), idReq('3'), idReq('4'), idReq('7', '3')]);
    const data = JSON.parse(s.m.get('klc-acl-v2'));
    expect(data.entries.map((e) => e[0]).sort()).toEqual([key('1'), key('2')].sort());
    expect(data.entries.every((e) => e[1] === 'allow')).toBe(true);
    expect(data.apps).toHaveLength(1);
  });

  it('v1 キーは読まず removeItem で削除する', async () => {
    const s = fakeStorage({ 'klc-acl-v1': JSON.stringify({ entries: [[key('1'), 'deny', 1000]], apps: [] }) });
    const f = echoFetcher(['1']);
    const c = createAclChecker({ fetcher: f, host: HOST, storage: s, now: () => 2000 });
    expect(c.peek(idReq('1'))).toBeNull();
    await c.check([idReq('1')]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(s.removeItem).toHaveBeenCalledWith('klc-acl-v1');
  });

  it('v2 に deny / notfound が混入していても読まない', () => {
    const s = fakeStorage({
      'klc-acl-v2': JSON.stringify({ entries: [[key('1'), 'deny', 1000], [key('2'), 'notfound', 1000], [key('3'), 'allow', 1000]], apps: [] }),
    });
    const c = createAclChecker({ fetcher: echoFetcher([]), host: HOST, storage: s, now: () => 2000 });
    expect(c.peek(idReq('1'))).toBeNull();
    expect(c.peek(idReq('2'))).toBeNull();
    expect(c.peek(idReq('3'))).toBe('allow');
  });

  it('deny / notfound はメモリ上で TTL 内は再取得しない', async () => {
    const rf = recFetcher({ 3: { code: 'CB_NO02' }, 4: { code: 'GAIA_RE01' } });
    const f = echoFetcher([]);
    const c = createAclChecker({ fetcher: f, recordFetcher: rf, host: HOST });
    await c.check([idReq('3'), idReq('4')]);
    await c.check([idReq('3'), idReq('4')]);
    expect(rf).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('createKintoneRecordFetcher', async () => {
    const api = vi.fn(async () => ({ record: {} }));
    const rf = createKintoneRecordFetcher({ api });
    await rf({ spaceId: null, appId: '1', id: '5' });
    expect(api).toHaveBeenLastCalledWith('/k/v1/record.json', 'GET', { app: '1', id: '5' });
    await rf({ spaceId: '7', appId: '1', id: '5' });
    expect(api).toHaveBeenLastCalledWith('/k/guest/7/v1/record.json', 'GET', { app: '1', id: '5' });
  });
});

describe('createKintoneFetcher', () => {
  it('通常/ゲストのパスと params', async () => {
    const api = vi.fn(async () => ({ records: [] }));
    const f = createKintoneFetcher({ api });
    await f({ spaceId: null, appId: '1', query: 'q', fields: ['$id'] });
    expect(api).toHaveBeenLastCalledWith('/k/v1/records.json', 'GET', { app: '1', query: 'q', fields: ['$id'], totalCount: false });
    await f({ spaceId: '7', appId: '2', query: 'q2', fields: ['$id', 'code'] });
    expect(api).toHaveBeenLastCalledWith('/k/guest/7/v1/records.json', 'GET', { app: '2', query: 'q2', fields: ['$id', 'code'], totalCount: false });
  });
});
