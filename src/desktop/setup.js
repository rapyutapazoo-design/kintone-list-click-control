import { loadConfig } from '../core/config.js';
import { getGuestSpaceIdFromPath } from '../core/url.js';
import { createAclChecker, createKintoneFetcher } from '../core/acl.js';
import { createListController } from './dom.js';

/**
 * 共有のエントリ初期化（desktop / mobile 共通）。kintone オブジェクトは引数で受け取る。
 * @param {{platform: 'desktop'|'mobile', eventName: string, kintone: any, getAppId: () => any, getFieldElements: (code: string) => any}} p
 */
export function setupEntry({ platform, eventName, kintone, getAppId, getFieldElements }) {
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const config = loadConfig(kintone.plugin.app.getConfig(PLUGIN_ID));

  const noLookupControl =
    config.lookup.mode === 'standard' && Object.values(config.lookup.fields).every((m) => m === 'standard' || m === 'inherit');
  const rowOff = platform !== 'desktop' || config.rowClick === 'default';
  if (rowOff && noLookupControl && !config.permission.enabled) return;

  const currentSpaceId = getGuestSpaceIdFromPath(location.pathname);

  let fieldsPromise = null;
  const fetchFormFields = () => {
    if (!fieldsPromise) {
      fieldsPromise = kintone
        .api(kintone.api.url('/k/v1/app/form/fields.json', !!currentSpaceId), 'GET', { app: getAppId() })
        .then((r) => r.properties || {})
        .catch((e) => {
          console.warn('[klc] フォーム情報の取得に失敗しました', e);
          return {};
        });
    }
    return fieldsPromise;
  };

  const aclChecker = config.permission.enabled
    ? createAclChecker({
        fetcher: createKintoneFetcher(kintone),
        host: location.host,
        ttlSec: config.permission.cacheTtlSec,
        storage: safeSessionStorage(),
      })
    : null;

  const controller = createListController({
    platform,
    config,
    getAppId: () => String(getAppId()),
    getFieldElements,
    fetchFormFields,
    aclChecker,
    host: location.host,
    currentSpaceId,
    navigate: (url, mode) => {
      if (mode === 'new') window.open(url, '_blank', 'noopener');
      else location.href = url;
    },
    root: window,
    getSelection: () => window.getSelection(),
  });

  kintone.events.on(eventName, (event) => {
    try {
      controller.onIndexShow(event);
    } catch (e) {
      console.warn('[klc]', e);
    }
    return event;
  });
}

function safeSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

