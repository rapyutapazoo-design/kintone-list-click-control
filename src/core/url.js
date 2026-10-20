/**
 * kintone レコード URL のユーティリティ（純粋関数）。
 */

// desktop: /k/{app}/show, /k/guest/{space}/{app}/show
// mobile : /k/m/{app}/show, /k/guest/{space}/m/{app}/show
const SHOW_PATH = /^\/k\/(?:guest\/(\d+)\/)?(m\/)?(\d+)\/show\/?$/;

/**
 * @param {string} href
 * @param {string} baseHost
 * @returns {{host: string, spaceId: string|null, appId: string, recordId: string|null}|null}
 */
export function parseRecordUrl(href, baseHost) {
  let u;
  try {
    u = new URL(href, 'https://' + baseHost);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.host !== baseHost) return null;
  const m = SHOW_PATH.exec(u.pathname);
  if (!m) return null;
  // desktop は hash（#record=）、mobile は query（?record=）。どちらの形式でも解析する
  const recRe = /(?:^[#?]|&)record=(\d+)(?:&|$)/;
  const rec = recRe.exec(u.hash) || recRe.exec(u.search);
  return { host: u.host, spaceId: m[1] || null, appId: m[3], recordId: rec ? rec[1] : null };
}

/**
 * @param {{appId: string|number, recordId: string|number, spaceId?: string|number|null, platform?: 'desktop'|'mobile'}} p
 * @returns {string}
 */
export function buildRecordUrl({ appId, recordId, spaceId, platform = 'desktop' }) {
  const digits = /^\d+$/;
  if (!digits.test(String(appId)) || !digits.test(String(recordId))) {
    throw new Error('invalid appId or recordId');
  }
  const mobile = platform === 'mobile';
  const tail = mobile ? `m/${appId}/show?record=${recordId}` : `${appId}/show#record=${recordId}`;
  if (spaceId !== null && spaceId !== undefined && spaceId !== '') {
    if (!digits.test(String(spaceId))) throw new Error('invalid spaceId');
    return `/k/guest/${spaceId}/${tail}`;
  }
  return `/k/${tail}`;
}

/**
 * @param {string} pathname
 * @returns {string|null}
 */
export function getGuestSpaceIdFromPath(pathname) {
  const m = /^\/k\/(?:m\/)?guest\/(\d+)\//.exec(pathname || '');
  return m ? m[1] : null;
}

/**
 * kintone.api.url(path, true) の結果（パスまたは URL）からゲストスペース ID を取得する。
 * 例: '/k/guest/7/v1/app.json' -> '7'、'/k/v1/app.json' -> null
 * @param {string} apiUrl
 * @returns {string|null}
 */
export function getGuestSpaceIdFromApiUrl(apiUrl) {
  let pathname;
  try {
    pathname = new URL(String(apiUrl || ''), 'https://example.invalid').pathname;
  } catch {
    return null;
  }
  const m = /^\/k\/guest\/(\d+)\//.exec(pathname);
  return m ? m[1] : null;
}

/**
 * @param {string} path 例: '/k/v1/records.json'
 * @param {string|null} spaceId
 * @returns {string}
 */
export function buildApiPath(path, spaceId) {
  if (!spaceId) return path;
  return path.replace(/^\/k\//, `/k/guest/${spaceId}/`);
}
