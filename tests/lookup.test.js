import { describe, it, expect } from 'vitest';
import { detectLookupCell } from '../src/core/lookup.js';

const HOST = 'x.cybozu.com';
const det = (o) => detectLookupCell({ host: HOST, currentAppId: '1', href: null, ...o });
const TXT = { type: 'SINGLE_LINE_TEXT' };

describe('detectLookupCell', () => {
  it('prop.lookup あり + href あり', () => {
    const r = det({ prop: { ...TXT, lookup: {} }, href: '/k/2/show#record=5' });
    expect(r).toMatchObject({ isLookup: true, source: 'form' });
    expect(r.parsed.appId).toBe('2');
  });
  it('prop.lookup あり + href なし', () => {
    expect(det({ prop: { ...TXT, lookup: {} }, href: null })).toEqual({ isLookup: true, source: 'form', parsed: null });
  });
  it('lookup なしでも別アプリ宛なら dom', () => {
    const r = det({ prop: TXT, href: '/k/2/show#record=5' });
    expect(r).toMatchObject({ isLookup: true, source: 'dom' });
    expect(r.parsed.appId).toBe('2');
    expect(det({ prop: { ...TXT, lookup: false }, href: '/k/2/show#record=5' }).source).toBe('dom');
  });
  it('prop 無し + recordType NUMBER', () => {
    expect(det({ prop: null, recordType: 'NUMBER', href: '/k/2/show#record=5' }).source).toBe('dom');
  });
  it('同一アプリは false（数値・文字列）', () => {
    for (const currentAppId of ['1', 1]) {
      expect(det({ prop: TXT, currentAppId, href: '/k/1/show#record=10' }).isLookup).toBe(false);
    }
  });
  it('recordId なしは false', () => {
    expect(det({ prop: TXT, href: '/k/2/show' }).isLookup).toBe(false);
  });
  it('対象外の type は false', () => {
    for (const t of ['LINK', 'RICH_TEXT', 'MULTI_LINE_TEXT', 'DROP_DOWN', undefined]) {
      expect(det({ prop: null, recordType: t, href: '/k/2/show#record=5' }).isLookup).toBe(false);
    }
  });
  it('別ホスト・不正 href は false', () => {
    for (const href of ['https://other.cybozu.com/k/2/show#record=5', 'javascript:void(0)', '#', '']) {
      expect(det({ prop: TXT, href }).isLookup).toBe(false);
    }
  });
  it('ゲスト / モバイル形式', () => {
    const g = det({ prop: TXT, href: '/k/guest/7/2/show#record=5' });
    expect(g.isLookup).toBe(true);
    expect(g.parsed.spaceId).toBe('7');
    expect(det({ prop: TXT, href: '/k/m/2/show?record=5' }).isLookup).toBe(true);
  });
  it('prop.type を recordType より優先', () => {
    expect(det({ prop: { type: 'LINK' }, recordType: 'SINGLE_LINE_TEXT', href: '/k/2/show#record=5' }).isLookup).toBe(false);
  });
});
