import { setupEntry } from './dom.js';

setupEntry({
  platform: 'desktop',
  eventName: 'app.record.index.show',
  kintone,
  getAppId: () => kintone.app.getId(),
  getFieldElements: (code) => kintone.app.getFieldElements(code),
});
