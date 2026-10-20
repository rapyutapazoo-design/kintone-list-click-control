import { RadioButton } from 'kintone-ui-component/lib/radio-button';
import { Dropdown } from 'kintone-ui-component/lib/dropdown';
import { MultiChoice } from 'kintone-ui-component/lib/multichoice';
import { Checkbox } from 'kintone-ui-component/lib/checkbox';
import { Text } from 'kintone-ui-component/lib/text';
import { Button } from 'kintone-ui-component/lib/button';
import { Notification } from 'kintone-ui-component/lib/notification';
import { Spinner } from 'kintone-ui-component/lib/spinner';
import { loadConfig, serializeConfig, sanitizeForSave, buildConfigFromForm } from '../core/config.js';
import { getGuestSpaceIdFromPath } from '../core/url.js';

(async () => {
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const cfg = loadConfig(kintone.plugin.app.getConfig(PLUGIN_ID));
  const spaceId = getGuestSpaceIdFromPath(location.pathname);
  const appId = kintone.app.getId();
  const mount = document.getElementById('klc-config');
  if (!mount) return;

  const notify = (text, type = 'danger') => {
    const n = new Notification({ text, type, duration: 5000 });
    n.open();
  };
  const el = (tag, className, text) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const section = (title) => {
    const s = el('div', 'klc-section');
    s.appendChild(el('h3', '', title));
    mount.appendChild(s);
    return s;
  };
  const note = (parent, text) => parent.appendChild(el('p', 'klc-note', text));

  const spinner = new Spinner({ text: '読み込み中…' });
  spinner.open();

  let properties = {};
  let views = {};
  let loadFailed = false;
  try {
    const url = (p) => kintone.api.url(p, !!spaceId);
    const [f, v] = await Promise.all([
      kintone.api(url('/k/v1/app/form/fields.json'), 'GET', { app: appId }),
      kintone.api(url('/k/v1/app/views.json'), 'GET', { app: appId }),
    ]);
    properties = f.properties || {};
    views = v.views || {};
  } catch (e) {
    loadFailed = true;
    console.warn('[klc]', e);
    notify('アプリの情報を取得できませんでした。保存はできません。');
  } finally {
    spinner.close();
  }

  const lookupFields = Object.values(properties).filter((p) => p && p.lookup);
  const listViews = Object.values(views).filter((x) => x && x.type === 'LIST');

  // ① 行クリック
  let s = section('行クリックで詳細へ遷移（PC のみ）');
  const rowClick = new RadioButton({
    items: [
      { label: '標準（行クリックでは遷移しない）', value: 'default' },
      { label: '行のどこをクリックしても詳細へ遷移', value: 'row' },
    ],
    value: cfg.rowClick,
  });
  s.appendChild(rowClick);
  const hover = new Checkbox({ items: [{ label: '行にカーソルを合わせたとき、ポインターと背景色で示す', value: 'hover' }], value: cfg.hover ? ['hover'] : [] });
  s.appendChild(hover);

  // ② 開き方
  s = section('詳細の開き方');
  const openMode = new RadioButton({
    items: [
      { label: '同じタブで開く', value: 'same' },
      { label: '新しいタブで開く', value: 'new' },
    ],
    value: cfg.openMode,
  });
  s.appendChild(openMode);
  note(s, 'Ctrl / Cmd / Shift を押しながらのクリックと、マウスの中ボタンのクリックは常に新しいタブで開きます。');

  // ③ ルックアップ
  s = section('ルックアップのリンク');
  const lookupMode = new RadioButton({
    items: [
      { label: '標準（参照先レコードへ遷移）', value: 'standard' },
      { label: '無効（テキスト表示にする）', value: 'text' },
      { label: '自レコードの詳細へ遷移', value: 'self' },
    ],
    value: cfg.lookup.mode,
  });
  s.appendChild(lookupMode);
  /** @type {Record<string, Dropdown>} */
  const fieldDropdowns = {};
  if (lookupFields.length > 0) {
    note(s, 'フィールドごとの設定（「全体設定に従う」を選ぶと上の設定を使います）');
    for (const p of lookupFields) {
      const row = el('div', 'klc-field-row');
      const dd = new Dropdown({
        label: `${p.label}（${p.code}）参照先アプリ: ${p.lookup.relatedApp?.app ?? '-'}`,
        items: [
          { label: '全体設定に従う', value: 'inherit' },
          { label: '標準', value: 'standard' },
          { label: '無効（テキスト表示）', value: 'text' },
          { label: '自レコードへ遷移', value: 'self' },
        ],
        value: cfg.lookup.fields[p.code] || 'inherit',
      });
      fieldDropdowns[p.code] = dd;
      row.appendChild(dd);
      s.appendChild(row);
    }
  } else {
    note(s, 'このアプリにはルックアップフィールドがありません。');
  }

  // ④ 対象一覧
  s = section('対象の一覧');
  const viewsMode = new RadioButton({
    items: [
      { label: 'すべての一覧', value: 'all' },
      { label: '選択した一覧のみ', value: 'selected' },
    ],
    value: cfg.views.mode,
  });
  const viewIds = new MultiChoice({
    items: listViews.map((x) => ({ label: x.name, value: String(x.id) })),
    value: cfg.views.ids.filter((id) => listViews.some((x) => String(x.id) === id)),
    visible: cfg.views.mode === 'selected',
  });
  viewsMode.addEventListener('change', () => {
    viewIds.visible = viewsMode.value === 'selected';
  });
  s.appendChild(viewsMode);
  s.appendChild(viewIds);
  note(s, 'カレンダー表示・カスタマイズビューは対象外です（表形式の一覧のみ）。');

  // ⑤ 権限判定
  s = section('遷移先の閲覧権限による制御');
  const permValue = [];
  if (cfg.permission.enabled) permValue.push('enabled');
  if (cfg.permission.targets.lookup) permValue.push('lookup');
  if (cfg.permission.targets.recordLink) permValue.push('recordLink');
  const perm = new Checkbox({
    items: [
      { label: '遷移先の閲覧権限がないリンクを無効にする', value: 'enabled' },
      { label: '対象: ルックアップのリンク', value: 'lookup' },
      { label: '対象: kintone のレコード URL を持つ「リンク」フィールド', value: 'recordLink' },
    ],
    value: permValue,
    itemLayout: 'vertical',
  });
  s.appendChild(perm);
  note(s, 'この判定は表示上の補助です。実際の閲覧可否は kintone の権限設定で保証されます。');
  const onError = new RadioButton({
    label: '権限を確認できなかったとき（通信エラー・タイムアウトなど）',
    items: [
      { label: '標準のリンクに戻す（業務を止めない）', value: 'standard' },
      { label: 'リンクを無効にする（厳格）', value: 'disable' },
    ],
    value: cfg.permission.onError,
  });
  s.appendChild(onError);
  const ttl = new Text({ label: '判定結果のキャッシュ時間（秒、0〜3600。0でキャッシュしない）', value: String(cfg.permission.cacheTtlSec) });
  s.appendChild(ttl);
  note(s, '表示のたびに API を呼ばないよう、結果を一定時間記憶します。参照先レコードの名前などの値は保存せず、レコード ID ベースの結果のみブラウザのセッションに保存します。');

  // 保存・キャンセル
  const actions = el('div', 'klc-actions');
  const save = new Button({ text: '保存', type: 'submit', disabled: loadFailed });
  const cancel = new Button({ text: 'キャンセル' });
  actions.appendChild(save);
  actions.appendChild(cancel);
  mount.appendChild(actions);

  save.addEventListener('click', () => {
    const ttlText = String(ttl.value).trim();
    if (!/^\d+$/.test(ttlText)) {
      notify('キャッシュ時間は 0 以上の整数で入力してください。');
      return;
    }
    const lookupFieldValues = {};
    for (const [code, dd] of Object.entries(fieldDropdowns)) lookupFieldValues[code] = dd.value;
    const formCfg = buildConfigFromForm({
      rowClick: rowClick.value,
      openMode: openMode.value,
      lookupMode: lookupMode.value,
      lookupFields: lookupFieldValues,
      viewsMode: viewsMode.value,
      viewIds: viewIds.value || [],
      hover: hover.value.includes('hover'),
      permEnabled: perm.value.includes('enabled'),
      permLookup: perm.value.includes('lookup'),
      permRecordLink: perm.value.includes('recordLink'),
      onError: onError.value,
      cacheTtlSec: ttlText,
    });
    const finalCfg = sanitizeForSave(formCfg, {
      fieldCodes: lookupFields.map((p) => p.code),
      viewIds: listViews.map((x) => String(x.id)),
    });
    kintone.plugin.app.setConfig(serializeConfig(finalCfg), () => {
      location.href = '../../flow?app=' + appId;
    });
  });
  cancel.addEventListener('click', () => history.back());
})();
