import { parseRecordUrl } from './url.js';

/** fields.json に lookup が無くても、リンクと type からルックアップ扱いにしてよい項目の type */
export const LOOKUP_DOM_TYPES = new Set(['SINGLE_LINE_TEXT', 'NUMBER']);

/**
 * セル1つがルックアップかを判定する（純粋関数）。
 * @param {{
 *   prop?: {type?: string, lookup?: any}|null,
 *   recordType?: string|null,
 *   href: string|null,
 *   host: string,
 *   currentAppId: string|number,
 * }} p
 * @returns {{isLookup: boolean, source: 'form'|'dom'|null, parsed: ReturnType<typeof parseRecordUrl>|null}}
 */
export function detectLookupCell({ prop, recordType, href, host, currentAppId }) {
  const parsed = href ? parseRecordUrl(href, host) : null;
  if (prop?.lookup) return { isLookup: true, source: 'form', parsed };
  const type = prop?.type ?? recordType;
  if (!LOOKUP_DOM_TYPES.has(type)) return { isLookup: false, source: null, parsed };
  if (!parsed || !parsed.recordId || parsed.appId === String(currentAppId)) {
    return { isLookup: false, source: null, parsed };
  }
  return { isLookup: true, source: 'dom', parsed };
}
