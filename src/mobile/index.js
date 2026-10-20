import { setupEntry } from '../desktop/dom.js';

setupEntry({
  platform: 'mobile',
  eventName: 'mobile.app.record.index.show',
  kintone,
  getAppId: () => kintone.mobile.app.getId(),
  getFieldElements: (code) => kintone.mobile.app.getFieldElements(code),
});
