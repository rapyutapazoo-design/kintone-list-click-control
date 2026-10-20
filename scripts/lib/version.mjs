// 版番号に関する純粋関数（fs / process に依存しない）。

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
  return { force: argv.includes('--force') };
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
