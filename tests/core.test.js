import { describe, it, expect, vi } from 'vitest';
import {
  defaultConfig, migrate, normalize, loadConfig, serializeConfig, sanitizeForSave,
  resolveLookupMode, isTargetView, buildConfigFromForm,
} from '../src/core/config.js';
import { parseRecordUrl, buildRecordUrl, getGuestSpaceIdFromPath, buildApiPath } from '../src/core/url.js';
import { decideRowClick, resolveOpenMode, INTERACTIVE_SELECTOR } from '../src/core/rowClick.js';

describe('config', () => {
  it('defaultConfig が design の既定値と一致する', () => {
    expect(defaultConfig()).toEqual({
      schemaVersion: 1, rowClick: 'default', openMode: 'same',
      lookup: { mode: 'standard', fields: {} }, views: { mode: 'all', ids: [] }, hover: true,
      permission: { enabled: false, targets: { lookup: true, recordLink: false }, onError: 'standard', cacheTtlSec: 300 },
    });
  });

  it('未設定・破損で既定値になり破損時は warn が出る', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadConfig(undefined)).toEqual(defaultConfig());
    expect(loadConfig({})).toEqual(defaultConfig());
    expect(warn).not.toHaveBeenCalled();
    expect(loadConfig({ config: '{broken' })).toEqual(defaultConfig());
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('serialize -> load の往復', () => {
    const c = { ...defaultConfig(), rowClick: 'row', openMode: 'new' };
    expect(loadConfig(serializeConfig(c))).toEqual(c);
  });

  it('未知キーを除去する', () => {
    const n = normalize({ foo: 1, rowClick: 'row', lookup: { bar: 2, mode: 'text' }, permission: { x: 1 } });
    expect(n).not.toHaveProperty('foo');
    expect(n.lookup).not.toHaveProperty('bar');
    expect(n.permission).not.toHaveProperty('x');
    expect(n.rowClick).toBe('row');
    expect(n.lookup.mode).toBe('text');
  });

  it('不正な列挙値を既定値に補正する', () => {
    const n = normalize({
      rowClick: 'x', openMode: 1, hover: 'yes',
      lookup: { mode: 'zzz', fields: { a: 'text', b: 'bad', c: 'inherit' } },
      views: { mode: 'q', ids: [1, '1', 2, null] },
      permission: { enabled: 'true', onError: 'boom', targets: { lookup: 0 } },
    });
    expect(n.rowClick).toBe('default');
    expect(n.openMode).toBe('same');
    expect(n.hover).toBe(true);
    expect(n.lookup.mode).toBe('standard');
    expect(n.lookup.fields).toEqual({ a: 'text', c: 'inherit' });
    expect(n.views.mode).toBe('all');
    expect(n.views.ids).toEqual(['1', '2']);
    expect(n.permission.enabled).toBe(false);
    expect(n.permission.onError).toBe('standard');
    expect(n.permission.targets.lookup).toBe(true);
  });

  it('cacheTtlSec の補正', () => {
    const t = (v) => normalize({ permission: { cacheTtlSec: v } }).permission.cacheTtlSec;
    expect(t(-1)).toBe(0);
    expect(t(5000)).toBe(3600);
    expect(t('abc')).toBe(300);
    expect(t('120')).toBe(120);
  });

  it('schemaVersion なしの migrate', () => {
    expect(migrate({ rowClick: 'row' }).schemaVersion).toBe(1);
    expect(migrate({ schemaVersion: 0 }).schemaVersion).toBe(1);
    expect(migrate(null).schemaVersion).toBe(1);
    expect(loadConfig({ config: JSON.stringify({ rowClick: 'row' }) }).rowClick).toBe('row');
  });

  it('sanitizeForSave', () => {
    const c = normalize({
      lookup: { mode: 'standard', fields: { a: 'text', gone: 'self', b: 'inherit' } },
      views: { mode: 'selected', ids: ['10', '99'] },
    });
    const s = sanitizeForSave(c, { fieldCodes: ['a', 'b'], viewIds: ['10', '11'] });
    expect(s.lookup.fields).toEqual({ a: 'text' });
    expect(s.views.ids).toEqual(['10']);
  });

  it('resolveLookupMode', () => {
    const c = normalize({ lookup: { mode: 'text', fields: { a: 'inherit', b: 'self' } } });
    expect(resolveLookupMode(c, 'a')).toBe('text');
    expect(resolveLookupMode(c, 'b')).toBe('self');
    expect(resolveLookupMode(c, 'zz')).toBe('text');
  });

  it('isTargetView', () => {
    const all = defaultConfig();
    expect(isTargetView(all, { viewType: 'list', viewId: 1 })).toBe(true);
    expect(isTargetView(all, { viewType: 'calendar', viewId: 1 })).toBe(false);
    const sel = normalize({ views: { mode: 'selected', ids: ['5'] } });
    expect(isTargetView(sel, { viewType: 'list', viewId: 5 })).toBe(true);
    expect(isTargetView(sel, { viewType: 'list', viewId: '5' })).toBe(true);
    expect(isTargetView(sel, { viewType: 'list', viewId: 6 })).toBe(false);
  });

  it('buildConfigFromForm', () => {
    const c = buildConfigFromForm({
      rowClick: 'row', openMode: 'new', lookupMode: 'text', lookupFields: { a: 'self' },
      viewsMode: 'selected', viewIds: ['3'], hover: false, permEnabled: true, permLookup: true,
      permRecordLink: true, onError: 'disable', cacheTtlSec: '60',
    });
    expect(c.rowClick).toBe('row');
    expect(c.lookup.fields).toEqual({ a: 'self' });
    expect(c.views.ids).toEqual(['3']);
    expect(c.hover).toBe(false);
    expect(c.permission).toEqual({ enabled: true, targets: { lookup: true, recordLink: true }, onError: 'disable', cacheTtlSec: 60 });
  });
});

describe('url', () => {
  const host = 'example.cybozu.com';
  it('通常 URL', () => {
    expect(parseRecordUrl('/k/12/show#record=34', host)).toEqual({ host, spaceId: null, appId: '12', recordId: '34' });
    expect(parseRecordUrl(`https://${host}/k/12/show#record=34`, host)?.recordId).toBe('34');
  });
  it('ゲスト URL', () => {
    expect(parseRecordUrl('/k/guest/5/12/show#record=34', host)).toEqual({ host, spaceId: '5', appId: '12', recordId: '34' });
  });
  it('hash に追加パラメータ', () => {
    expect(parseRecordUrl('/k/12/show#record=34&l.view=1&l.q=a', host)?.recordId).toBe('34');
    expect(parseRecordUrl('/k/12/show#l.view=1&record=34', host)?.recordId).toBe('34');
  });
  it('別ホスト・非 show・不正は null', () => {
    expect(parseRecordUrl('https://other.example.com/k/12/show#record=1', host)).toBeNull();
    expect(parseRecordUrl('/k/12/', host)).toBeNull();
    expect(parseRecordUrl('/k/12/edit#record=1', host)).toBeNull();
    expect(parseRecordUrl('javascript:alert(1)', host)).toBeNull();
    expect(parseRecordUrl('http://[bad', host)).toBeNull();
  });
  it('record= なしは recordId:null', () => {
    expect(parseRecordUrl('/k/12/show', host)).toEqual({ host, spaceId: null, appId: '12', recordId: null });
  });
  it('buildRecordUrl', () => {
    expect(buildRecordUrl({ appId: 1, recordId: 2 })).toBe('/k/1/show#record=2');
    expect(buildRecordUrl({ appId: '1', recordId: '2', spaceId: '9' })).toBe('/k/guest/9/1/show#record=2');
    expect(() => buildRecordUrl({ appId: 'a', recordId: '2' })).toThrow();
    expect(() => buildRecordUrl({ appId: '1', recordId: '2/x' })).toThrow();
    expect(() => buildRecordUrl({ appId: '1', recordId: '2', spaceId: 'x' })).toThrow();
  });
  it('getGuestSpaceIdFromPath / buildApiPath', () => {
    expect(getGuestSpaceIdFromPath('/k/guest/7/3/')).toBe('7');
    expect(getGuestSpaceIdFromPath('/k/3/')).toBeNull();
    expect(buildApiPath('/k/v1/records.json', null)).toBe('/k/v1/records.json');
    expect(buildApiPath('/k/v1/records.json', '7')).toBe('/k/guest/7/v1/records.json');
  });
});

describe('rowClick', () => {
  const ok = {
    targetView: true, rowClick: 'row', button: 0, hasSelectionInRow: false, insideInteractive: false,
    isDataCell: true, rowHasFormControl: false, recordId: '10',
  };
  const reason = (o) => decideRowClick({ ...ok, ...o }).reason;
  it('正常系', () => {
    expect(decideRowClick(ok)).toEqual({ action: 'navigate', reason: 'ok' });
  });
  it('除外理由', () => {
    expect(reason({ targetView: false })).toBe('disabled');
    expect(reason({ rowClick: 'default' })).toBe('disabled');
    expect(reason({ button: 2 })).toBe('right-click');
    expect(reason({ hasSelectionInRow: true })).toBe('selection');
    expect(reason({ insideInteractive: true })).toBe('interactive');
    expect(reason({ isDataCell: false })).toBe('non-data-cell');
    expect(reason({ rowHasFormControl: true })).toBe('inline-edit');
    expect(reason({ recordId: null })).toBe('no-record');
    expect(decideRowClick({ ...ok, recordId: null }).action).toBe('none');
  });
  it('resolveOpenMode', () => {
    expect(resolveOpenMode({ openMode: 'same' })).toBe('same');
    expect(resolveOpenMode({ openMode: 'new' })).toBe('new');
    expect(resolveOpenMode({ openMode: 'same', ctrlKey: true })).toBe('new');
    expect(resolveOpenMode({ openMode: 'same', metaKey: true })).toBe('new');
    expect(resolveOpenMode({ openMode: 'same', shiftKey: true })).toBe('new');
    expect(resolveOpenMode({ openMode: 'same', button: 1 })).toBe('new');
  });
  it('INTERACTIVE_SELECTOR', () => {
    expect(INTERACTIVE_SELECTOR).toContain('button');
  });
});
