/**
 * kintone レコード URL のユーティリティ（純粋関数）。
 */

const SHOW_PATH = /^\/k\/(?:guest\/(\d+)\/)?(\d+)\/show\/?$/;

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
  const rec = /(?:^#|&)record=(\d+)(?:&|$)/.exec(u.hash);
  return { host: u.host, spaceId: m[1] || null, appId: m[2], recordId: rec ? rec[1] : null };
}

/**
 * @param {{appId: string|number, recordId: string|number, spaceId?: string|number|null}} p
 * @returns {string}
 */
export function buildRecordUrl({ appId, recordId, spaceId }) {
  const digits = /^\d+$/;
  if (!digits.test(String(appId)) || !digits.test(String(recordId))) {
    throw new Error('invalid appId or recordId');
  }
  if (spaceId !== null && spaceId !== undefined && spaceId !== '') {
    if (!digits.test(String(spaceId))) throw new Error('invalid spaceId');
    return `/k/guest/${spaceId}/${appId}/show#record=${recordId}`;
  }
  return `/k/${appId}/show#record=${recordId}`;
}

/**
 * @param {string} pathname
 * @returns {string|null}
 */
export function getGuestSpaceIdFromPath(pathname) {
  const m = /^\/k\/guest\/(\d+)\//.exec(pathname || '');
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
