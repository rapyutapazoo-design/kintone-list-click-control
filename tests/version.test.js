import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVersionedStage } from '../scripts/lib/stage.mjs';
import {
  parseVersion,
  assertValidVersion,
  compareVersions,
  checkVersionBump,
  applyVersionToManifest,
  parseArgs,
  maxVersion,
  isExcludedFromStage,
} from '../scripts/lib/version.mjs';

describe('parseVersion', () => {
  it('parses X.Y.Z', () => {
    expect(parseVersion('1.1.0')).toEqual([1, 1, 0]);
    expect(parseVersion('0.0.1')).toEqual([0, 0, 1]);
  });
  it.each(['1.1', '1', '01.1.0', '1.1.0-beta', 'v1.1.0', '', undefined, 1])('rejects %s', (v) => {
    expect(parseVersion(v)).toBeNull();
  });
});

describe('assertValidVersion', () => {
  it('returns valid value', () => {
    expect(assertValidVersion('1.2.3')).toBe('1.2.3');
  });
  it('throws with value in message', () => {
    expect(() => assertValidVersion('1.2')).toThrow(/1\.2/);
  });
});

describe('compareVersions', () => {
  it('compares numerically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });
});

describe('checkVersionBump', () => {
  it('first when no record', () => {
    expect(checkVersionBump('1.1.0', null)).toMatchObject({ ok: true, reason: 'first' });
    expect(checkVersionBump('1.1.0', '')).toMatchObject({ ok: true, reason: 'first' });
    expect(checkVersionBump('1.1.0', undefined)).toMatchObject({ ok: true, reason: 'first' });
  });
  it('bumped', () => {
    expect(checkVersionBump('1.1.0', '1.0.0')).toMatchObject({ ok: true, reason: 'bumped' });
  });
  it('same is rejected', () => {
    const r = checkVersionBump('1.1.0', '1.1.0');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('same');
    expect(r.message).toContain('npm version');
  });
  it('lower is rejected', () => {
    const r = checkVersionBump('1.0.0', '1.1.0');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lower');
    expect(r.message).toContain('低い');
  });
  it('force passes same and lower', () => {
    expect(checkVersionBump('1.1.0', '1.1.0', { force: true })).toMatchObject({ ok: true, reason: 'forced' });
    expect(checkVersionBump('1.0.0', '1.1.0', { force: true })).toMatchObject({ ok: true, reason: 'forced' });
  });
  it('corrupt record is treated as first', () => {
    expect(checkVersionBump('1.1.0', 'garbage')).toMatchObject({ ok: true, reason: 'first' });
  });
});

describe('applyVersionToManifest', () => {
  it('replaces version, keeps keys, does not mutate', () => {
    const m = { version: 1, name: { ja: 'x' }, desktop: { js: ['a'] } };
    const r = applyVersionToManifest(m, '1.1.0');
    expect(r.version).toBe('1.1.0');
    expect(r.name).toEqual({ ja: 'x' });
    expect(r.desktop).toEqual({ js: ['a'] });
    expect(m.version).toBe(1);
  });
  it('throws for non-object', () => {
    expect(() => applyVersionToManifest(null, '1.1.0')).toThrow();
    expect(() => applyVersionToManifest('x', '1.1.0')).toThrow();
  });
});

describe('parseArgs', () => {
  it('detects --force', () => {
    expect(parseArgs([])).toEqual({ force: false });
    expect(parseArgs(['--force'])).toEqual({ force: true });
    expect(parseArgs(['--foo'])).toEqual({ force: false });
  });
});

describe('maxVersion', () => {
  it('returns the larger of current and last', () => {
    expect(maxVersion('1.2.0', '1.1.0')).toBe('1.2.0');
    expect(maxVersion('1.0.0', '1.1.0')).toBe('1.1.0');
    expect(maxVersion('1.1.0', '1.1.0')).toBe('1.1.0');
  });
  it('returns current when last is missing or invalid', () => {
    expect(maxVersion('1.0.0', null)).toBe('1.0.0');
    expect(maxVersion('1.0.0', 'abc')).toBe('1.0.0');
  });
});

describe('isExcludedFromStage', () => {
  it('excludes hidden and OS junk files only', () => {
    expect(isExcludedFromStage('.DS_Store')).toBe(true);
    expect(isExcludedFromStage('Thumbs.db')).toBe(true);
    expect(isExcludedFromStage('manifest.json')).toBe(false);
    expect(isExcludedFromStage('desktop.js')).toBe(false);
  });
});

describe('withVersionedStage', () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'stage-test-'));
    const src = join(root, 'plugin');
    mkdirSync(join(src, 'js'), { recursive: true });
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'x', version: 1 }));
    writeFileSync(join(src, 'js', 'a.js'), '//a');
    writeFileSync(join(src, '.DS_Store'), 'junk');
    return { root, src, stage: join(root, 'dist', '.stage') };
  }

  it('writes version into stage manifest only, excludes junk, and cleans up', async () => {
    const { root, src, stage } = setup();
    try {
      const seen = await withVersionedStage({ srcDir: src, stageDir: stage, version: '1.1.0' }, (mp) => ({
        manifest: JSON.parse(readFileSync(mp, 'utf-8')),
        hasJs: existsSync(join(stage, 'js', 'a.js')),
        hasJunk: existsSync(join(stage, '.DS_Store')),
      }));
      expect(seen.manifest.version).toBe('1.1.0');
      expect(seen.hasJs).toBe(true);
      expect(seen.hasJunk).toBe(false);
      expect(JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf-8')).version).toBe(1);
      expect(existsSync(stage)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes stage even when fn throws', async () => {
    const { root, src, stage } = setup();
    try {
      await expect(
        withVersionedStage({ srcDir: src, stageDir: stage, version: '1.1.0' }, () => {
          expect(existsSync(stage)).toBe(true);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(existsSync(stage)).toBe(false);
      expect(JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf-8')).version).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
