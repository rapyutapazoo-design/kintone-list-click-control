import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { withVersionedStage } from '../scripts/lib/stage.mjs';
import {
  parseVersion,
  assertValidVersion,
  compareVersions,
  checkVersionBump,
  applyVersionToManifest,
  parseArgs,
  resolveKeyPath,
  assertKeyPathSafe,
  decideKeyMode,
  checkPluginId,
  releaseZipPath,
  isKeyFilePermissive,
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
    expect(parseArgs([])).toEqual({ force: false, initKey: false, syncManifest: false });
    expect(parseArgs(['--force'])).toEqual({ force: true, initKey: false, syncManifest: false });
    expect(parseArgs(['--foo'])).toEqual({ force: false, initKey: false, syncManifest: false });
  });
  it('detects --init-key / --sync-manifest and combinations', () => {
    expect(parseArgs(['--init-key'])).toEqual({ force: false, initKey: true, syncManifest: false });
    expect(parseArgs(['--sync-manifest'])).toEqual({ force: false, initKey: false, syncManifest: true });
    expect(parseArgs(['--force', '--init-key', '--sync-manifest'])).toEqual({ force: true, initKey: true, syncManifest: true });
  });
});

describe('resolveKeyPath', () => {
  const base = { cwd: '/repo', homedir: '/home/u' };
  it('env > dotenv > default', () => {
    expect(resolveKeyPath({ ...base, env: { KLC_PPK_PATH: '/a/k.ppk' }, dotenv: { KLC_PPK_PATH: '/b/k.ppk' } })).toBe('/a/k.ppk');
    expect(resolveKeyPath({ ...base, env: {}, dotenv: { KLC_PPK_PATH: '/b/k.ppk' } })).toBe('/b/k.ppk');
    expect(resolveKeyPath({ ...base })).toBe('/repo/private.ppk');
  });
  it('expands ~/ to homedir and resolves relative paths from cwd', () => {
    expect(resolveKeyPath({ ...base, env: { KLC_PPK_PATH: '~/x/k.ppk' } })).toBe('/home/u/x/k.ppk');
    expect(resolveKeyPath({ ...base, env: { KLC_PPK_PATH: 'keys/k.ppk' } })).toBe('/repo/keys/k.ppk');
  });
  it('treats empty / whitespace env as unset', () => {
    expect(resolveKeyPath({ ...base, env: { KLC_PPK_PATH: '' }, dotenv: { KLC_PPK_PATH: '/b/k.ppk' } })).toBe('/b/k.ppk');
    expect(resolveKeyPath({ ...base, env: { KLC_PPK_PATH: '   ' } })).toBe('/repo/private.ppk');
  });
});

describe('assertKeyPathSafe', () => {
  const repoRoot = '/repo';
  it('allows paths outside the repo', () => {
    expect(() => assertKeyPathSafe({ keyPath: '/tmp/other/k.ppk', repoRoot, gitignoreText: '' })).not.toThrow();
  });
  it('allows .ppk inside the repo when *.ppk is ignored', () => {
    expect(() => assertKeyPathSafe({ keyPath: '/repo/private.ppk', repoRoot, gitignoreText: 'dist/\n*.ppk\n' })).not.toThrow();
  });
  it('throws for non-.ppk inside the repo', () => {
    expect(() => assertKeyPathSafe({ keyPath: '/repo/k.pem', repoRoot, gitignoreText: '*.ppk' })).toThrow(/\.ppk/);
  });
  it('throws when *.ppk is not in .gitignore (including comment-only)', () => {
    expect(() => assertKeyPathSafe({ keyPath: '/repo/k.ppk', repoRoot, gitignoreText: 'dist/' })).toThrow(/\*\.ppk/);
    expect(() => assertKeyPathSafe({ keyPath: '/repo/k.ppk', repoRoot, gitignoreText: '# *.ppk\n' })).toThrow(/\*\.ppk/);
  });
});

describe('decideKeyMode', () => {
  it('use / init / missing / init-recorded / init-exists', () => {
    expect(decideKeyMode({ keyExists: true, initKey: false, expectedId: 'x' })).toEqual({ ok: true, mode: 'use' });
    expect(decideKeyMode({ keyExists: false, initKey: true, expectedId: null })).toEqual({ ok: true, mode: 'init' });
    const missing = decideKeyMode({ keyExists: false, initKey: false, expectedId: 'x' });
    expect(missing).toMatchObject({ ok: false, reason: 'missing' });
    expect(missing.message).toContain('KLC_PPK_PATH');
    expect(missing.message).toContain('--init-key');
    expect(decideKeyMode({ keyExists: false, initKey: true, expectedId: 'x' })).toMatchObject({ ok: false, reason: 'init-recorded' });
    expect(decideKeyMode({ keyExists: true, initKey: true, expectedId: null })).toMatchObject({ ok: false, reason: 'init-exists' });
  });
});

describe('checkPluginId', () => {
  it('match / mismatch / unrecorded', () => {
    expect(checkPluginId('abc', 'abc')).toEqual({ ok: true, reason: 'match' });
    const mm = checkPluginId('abc', 'xyz');
    expect(mm).toMatchObject({ ok: false, reason: 'mismatch' });
    expect(mm.message).toContain('abc');
    expect(mm.message).toContain('xyz');
    expect(checkPluginId(null, 'xyz')).toMatchObject({ ok: true, reason: 'unrecorded' });
    expect(checkPluginId('', 'xyz')).toMatchObject({ ok: true, reason: 'unrecorded' });
  });
});

describe('releaseZipPath / isKeyFilePermissive', () => {
  it('builds the releases path and rejects invalid versions', () => {
    expect(releaseZipPath('1.2.0')).toBe('dist/releases/plugin-1.2.0.zip');
    expect(() => releaseZipPath('1.2')).toThrow();
  });
  it('detects group/other readable key files', () => {
    expect(isKeyFilePermissive(0o100600)).toBe(false);
    expect(isKeyFilePermissive(0o100644)).toBe(true);
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


describe('package.mjs', () => {
  const REPO = fileURLToPath(new URL('..', import.meta.url));
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  function makeProject({ pluginId, version = '1.2.0' }) {
    const proj = mkdtempSync(join(tmpdir(), 'klc-proj-'));
    dirs.push(proj);
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ version, kintone: { pluginId } }));
    mkdirSync(join(proj, 'plugin/image'), { recursive: true });
    mkdirSync(join(proj, 'plugin/js'), { recursive: true });
    writeFileSync(
      join(proj, 'plugin/manifest.json'),
      JSON.stringify({
        manifest_version: 1,
        version: '0.0.1',
        type: 'APP',
        name: { en: 'test' },
        icon: 'image/icon.png',
        desktop: { js: ['js/desktop.js'] },
      }),
    );
    copyFileSync(join(REPO, 'plugin/image/icon.png'), join(proj, 'plugin/image/icon.png'));
    for (const n of ['desktop', 'mobile', 'config']) writeFileSync(join(proj, `plugin/js/${n}.js`), '//stub');
    return proj;
  }

  function makeKey() {
    const dir = mkdtempSync(join(tmpdir(), 'klc-key-'));
    dirs.push(dir);
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keyPath = join(dir, 'k.ppk');
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
    const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
    const id = [...hex].map((c) => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
    return { keyPath, id, dir };
  }

  const run = (proj, keyPath, args = []) =>
    spawnSync(process.execPath, [join(REPO, 'scripts/package.mjs'), ...args], {
      cwd: proj,
      env: { ...process.env, KLC_PPK_PATH: keyPath },
      encoding: 'utf-8',
    });

  const noArtifacts = (proj) => {
    expect(existsSync(join(proj, 'dist/plugin.zip'))).toBe(false);
    expect(existsSync(join(proj, 'dist/releases'))).toBe(false);
    expect(existsSync(join(proj, 'dist/.last-packaged-version'))).toBe(false);
  };

  it('鍵がないと停止する', () => {
    const proj = makeProject({ pluginId: 'a'.repeat(32) });
    const keyPath = join(dirname(proj), 'klc-no-such-dir', 'none.ppk');
    const r = run(proj, keyPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('KLC_PPK_PATH');
    noArtifacts(proj);
    expect(existsSync(keyPath)).toBe(false);
  }, 30000);

  it('ID が違うと停止する', () => {
    const proj = makeProject({ pluginId: 'a'.repeat(32) });
    const { keyPath, id } = makeKey();
    const r = run(proj, keyPath);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a'.repeat(32));
    expect(r.stderr).toContain(id);
    noArtifacts(proj);
  }, 30000);

  it('ID が一致すると成功する', () => {
    const { keyPath, id } = makeKey();
    const proj = makeProject({ pluginId: id });
    const before = readFileSync(join(proj, 'plugin/manifest.json'), 'utf-8');
    const r = run(proj, keyPath);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(proj, 'dist/plugin.zip'))).toBe(true);
    expect(existsSync(join(proj, 'dist/releases/plugin-1.2.0.zip'))).toBe(true);
    expect(readFileSync(join(proj, 'dist/.last-packaged-version'), 'utf-8').trim()).toBe('1.2.0');
    expect(readFileSync(join(proj, 'plugin/manifest.json'), 'utf-8')).toBe(before);
  }, 30000);

  it('--init-key は pluginId が記録済みなら拒否する', () => {
    const proj = makeProject({ pluginId: 'a'.repeat(32) });
    const keyPath = join(dirname(proj), 'klc-init-none', 'k.ppk');
    const r = run(proj, keyPath, ['--init-key']);
    expect(r.status).toBe(1);
    expect(existsSync(keyPath)).toBe(false);
    noArtifacts(proj);
  }, 30000);

  it('--sync-manifest で manifest の version が同期される', () => {
    const { keyPath, id } = makeKey();
    const proj = makeProject({ pluginId: id });
    const r = run(proj, keyPath, ['--sync-manifest']);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(proj, 'plugin/manifest.json'), 'utf-8')).version).toBe('1.2.0');
  }, 30000);
});
