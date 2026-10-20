// 版番号に関する純粋関数（fs / process に依存しない）。
import { resolve, join, relative, isAbsolute, extname } from 'node:path';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** @param {unknown} str @returns {number[] | null} */
export function parseVersion(str) {
  if (typeof str !== 'string') return null;
  const m = VERSION_RE.exec(str);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** @param {unknown} str */
export function assertValidVersion(str) {
  if (parseVersion(str) === null) {
    throw new Error(`バージョン ${JSON.stringify(str)} は不正です。X.Y.Z 形式（例: 1.1.0、先頭ゼロなし）にしてください。`);
  }
  return str;
}

/** @param {string} a @param {string} b @returns {-1 | 0 | 1} */
export function compareVersions(a, b) {
  const pa = /** @type {number[]} */ (parseVersion(a));
  const pb = /** @type {number[]} */ (parseVersion(b));
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * @param {string} current
 * @param {string | null | undefined} last
 * @param {{ force?: boolean }} [opts]
 * @returns {{ ok: boolean, reason: 'first' | 'bumped' | 'same' | 'lower' | 'forced', message?: string }}
 */
export function checkVersionBump(current, last, { force = false } = {}) {
  if (!last || parseVersion(last) === null) return { ok: true, reason: 'first' };
  const cmp = compareVersions(current, last);
  if (cmp > 0) return { ok: true, reason: 'bumped' };
  const reason = cmp === 0 ? 'same' : 'lower';
  if (force) return { ok: true, reason: 'forced' };
  const message =
    cmp === 0
      ? `バージョン ${current} は前回パッケージと同じです。バージョンを上げてください（npm version patch|minor|major）。強制する場合は --force を付けてください。`
      : `バージョン ${current} は前回パッケージ（${last}）より低いバージョンです。バージョンを上げてください（npm version patch|minor|major）。強制する場合は --force を付けてください。`;
  return { ok: false, reason, message };
}

/** @param {Record<string, unknown>} manifest @param {string} version */
export function applyVersionToManifest(manifest, version) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest はオブジェクトである必要があります。');
  }
  return { ...manifest, version };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  return {
    force: argv.includes('--force'),
    initKey: argv.includes('--init-key'),
    syncManifest: argv.includes('--sync-manifest'),
  };
}

/**
 * 秘密鍵のパスを解決する（環境変数 > .env > ./private.ppk）。
 * @param {{env?: Record<string, string|undefined>, dotenv?: Record<string, string|undefined>, cwd: string, homedir: string}} p
 */
export function resolveKeyPath({ env = {}, dotenv = {}, cwd, homedir }) {
  const pick = [env.KLC_PPK_PATH, dotenv.KLC_PPK_PATH, 'private.ppk']
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find((v) => v !== '');
  const raw = /** @type {string} */ (pick);
  if (raw === '~' || raw.startsWith('~/')) return join(homedir, raw.slice(2));
  return resolve(cwd, raw);
}

/**
 * 鍵がリポジトリ内にある場合、.ppk かつ .gitignore で除外済みであることを確認する。違反は throw。
 * @param {{keyPath: string, repoRoot: string, gitignoreText?: string}} p
 */
export function assertKeyPathSafe({ keyPath, repoRoot, gitignoreText = '' }) {
  const rel = relative(repoRoot, keyPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return;
  if (extname(keyPath).toLowerCase() !== '.ppk') {
    throw new Error(`鍵ファイル ${keyPath} はリポジトリ内にありますが、拡張子が .ppk ではありません。コミット事故を防ぐため .ppk にするか、リポジトリ外に置いてください。`);
  }
  const lines = gitignoreText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  if (!lines.includes('*.ppk')) {
    throw new Error(`鍵ファイル ${keyPath} はリポジトリ内にありますが、.gitignore に *.ppk がありません。追加するか、リポジトリ外に置いてください。`);
  }
}

/**
 * @param {{keyExists: boolean, initKey: boolean, expectedId?: string|null}} p
 * @returns {{ok: true, mode: 'use'|'init'} | {ok: false, reason: 'missing'|'init-recorded'|'init-exists', message: string}}
 */
export function decideKeyMode({ keyExists, initKey, expectedId }) {
  if (keyExists && initKey) {
    return { ok: false, reason: 'init-exists', message: '鍵は既にあります。--init-key は不要です。' };
  }
  if (keyExists) return { ok: true, mode: 'use' };
  if (initKey && expectedId) {
    return {
      ok: false,
      reason: 'init-recorded',
      message: 'pluginId が記録済みのため新しい鍵は作れません。新しい鍵では ID が変わります。',
    };
  }
  if (initKey) return { ok: true, mode: 'init' };
  return {
    ok: false,
    reason: 'missing',
    message:
      '秘密鍵が見つかりません。KLC_PPK_PATH（環境変数または .env）で鍵のパスを指定してください。初めて鍵を作る場合のみ --init-key を付けて実行します（自動では生成しません）。',
  };
}

/**
 * @param {string|null|undefined} expected
 * @param {string} actual
 * @returns {{ok: boolean, reason: 'unrecorded'|'match'|'mismatch', message?: string}}
 */
export function checkPluginId(expected, actual) {
  if (!expected) {
    return { ok: true, reason: 'unrecorded', message: `プラグイン ID が未記録です。package.json の kintone.pluginId に ${actual} を記録してください。` };
  }
  if (expected === actual) return { ok: true, reason: 'match' };
  return {
    ok: false,
    reason: 'mismatch',
    message: `プラグイン ID が一致しません（記録: ${expected} / 今回: ${actual}）。鍵が違う可能性があります。何も書き込まずに停止しました。`,
  };
}

/** @param {string} version */
export function releaseZipPath(version) {
  return `dist/releases/plugin-${assertValidVersion(version)}.zip`;
}

/** @param {number} mode */
export function isKeyFilePermissive(mode) {
  return (mode & 0o077) !== 0;
}

/** 記録済みと今回の大きい方を返す（記録が無い/不正なら今回）。 @param {string} current @param {string | null | undefined} last */
export function maxVersion(current, last) {
  if (!last || parseVersion(last) === null) return current;
  return compareVersions(current, last) >= 0 ? current : last;
}

/** ステージへ複製しないファイルか（.DS_Store 等の隠しファイル、Thumbs.db）。 @param {string} name ファイル名（basename） */
export function isExcludedFromStage(name) {
  return name.startsWith('.') || name === 'Thumbs.db';
}
