# 一覧画面クリック遷移制御（kintone プラグイン）

kintone の一覧画面（表形式）で、次を制御するプラグインです。

- 行のどこをクリックしてもレコード詳細へ遷移（PC のみ）
- ルックアップのリンクを「標準 / 無効（テキスト表示）/ 自レコードへ遷移」から選択（全体設定＋フィールド個別）
- 遷移先レコードの閲覧権限がないとき、リンクを無効化（ルックアップ／kintone のレコード URL を持つ「リンク」フィールド）

## 設定項目

設定は `schemaVersion` 付きの JSON 1キーで保存されます。

| キー | 値 | 既定 |
|---|---|---|
| rowClick | `default` / `row` | `default` |
| openMode | `same` / `new` | `same` |
| lookup.mode | `standard` / `text` / `self` | `standard` |
| lookup.fields | `{フィールドコード: inherit/standard/text/self}` | `{}` |
| views.mode / views.ids | `all` / `selected`、一覧 ID の配列 | `all`, `[]` |
| hover | boolean | `true` |
| permission.enabled | boolean | `false` |
| permission.targets.lookup / recordLink | boolean | `true` / `false` |
| permission.onError | `standard` / `disable` | `standard` |
| permission.cacheTtlSec | 0〜3600 | `300` |

行クリックでは、リンク・ボタン・入力欄の上、詳細/編集アイコンの列、テキスト選択中、インライン編集中、右クリックは遷移しません。Ctrl / Cmd / Shift クリックと中クリックは常に新しいタブで開きます。モバイルではルックアップ制御と権限判定のみ動作します（行クリックとホバーなし）。

## 権限判定の仕組みと注意

- 二段階確認で判定します。
  1. 遷移先アプリごとに `/k/v1/records.json` を `$id in (...)`（href からレコード ID が取れない場合は、ルックアップのキーフィールドの値）で問い合わせ、返ってきたレコードを「閲覧可」にします。
  2. 返らなかった ID 型の値は `/k/v1/record.json` GET で個別に再確認します。成功なら「閲覧可」、`CB_NO02` なら「閲覧不可」、`GAIA_RE01` なら「レコードが見つからない（削除済みなど）」、その他は通信エラー扱い（`onError` に従う）です。
  - 再確認は 1 回の判定につき最大 10 件です。超過分は個別確認せず「閲覧不可」として扱いますが、キャッシュしないので次の判定時に再確認します。
  - キー値（ルックアップのキーフィールド）で判定する場合は個別取得できないので、返らなければ「閲覧不可」です。
- **この判定は表示上の補助です。** 実際の閲覧可否は kintone のサーバー側の権限設定で保証されます。権限のないレコードへ遷移しても kintone が閲覧権限エラーを表示するだけです。
- アプリ全体に権限がない場合（`CB_NO02` など）は、そのアプリの全リンクを無効にし、以後そのアプリは問い合わせません。
- 通信エラー・タイムアウト（5 秒）時は、既定で標準のリンクに戻します（`onError: standard`）。厳格にしたい場合は `disable` を選ぶと無効表示にします。エラーは保存せず、連続失敗時は指数バックオフ（最大 60 秒）で再試行します。
- 呼び出し回数の目安: 100 行 × ルックアップ 3 フィールド・遷移先 2 アプリで、初回 2〜3 回。TTL 内の再表示は 0 回です。1 回の問い合わせは 100 件までで、並列度は最大 3 です。個別再確認は 1 回の判定につき最大 10 回で、上限を超えた分は非キャッシュのため、再表示のたびに再問い合わせされます。
- キャッシュ: メモリ上に TTL 付きで保持します。sessionStorage（キー `klc-acl-v2`）には ID ベースの「閲覧可」とアプリ単位の「閲覧不可」のみを保存し、キー値（顧客名など）は保存しません。レコード単位の「閲覧不可」「見つからない」はメモリ（TTL 付き）のみで保存しません。旧キー `klc-acl-v1` は読まず、起動時に削除します。ログにも値を出しません。
- 無効化したリンク（権限なし、見つからない、確認中、エラー、テキスト表示）をクリックしても、リンクは開きません。行クリックが有効（`rowClick: row`）ならその行のレコード詳細へ遷移し、`default` では何も起きません。

## 誤判定時の切り分け手順

1. ブラウザの開発者ツール > Application > Session Storage で `klc-acl-v2` を確認します。`entries` に該当 ID が `allow` 以外で残っていないことを見ます。疑わしければキーを削除して再読み込みします。
2. 同じ ID を record.json で GET して確認します（コンソールで `kintone.api(kintone.api.url('/k/v1/record.json', true), 'GET', {app: 27, id: 17})`）。成功なら閲覧可のはずで、`CB_NO02` は権限なし、`GAIA_RE01` は削除済みまたは ID 違いです。
3. 無効リンクの `title` を確認します（「閲覧権限がありません」か「レコードが見つかりません」か）。
4. `permission.enabled` を off にすると判定が無効になります。

## 開発・ビルド

Node.js 22.2 以上と npm が必要です（アイコン生成で `zlib.crc32` を使用）。

```sh
npm install
npm test            # vitest（core の単体テストと jsdom 結合テスト）
npm run build       # plugin/js/{desktop,mobile,config}.js と plugin/image/icon.png を生成
npm run dev         # watch ビルド
npm run package     # build のあと dist/plugin-<version>.zip（と互換コピー dist/plugin.zip）を生成
```

- ソースは素の JavaScript（ESM）＋ JSDoc です。esbuild で IIFE（es2019）にバンドルします。
- 設定画面のみ kintone-ui-component v1 を同梱します（desktop / mobile は依存なし）。依存はすべて exact pin です。
- `src/core/` は DOM・kintone に依存しない純粋関数、`src/desktop/dom.js` は DOM 制御とエントリ初期化 `setupEntry`（desktop / mobile 共用。イベント登録は各 `index.js` が自分の platform 分だけ行う）です。

## 秘密鍵（ppk）の管理

`npm run package` で `private.ppk` がなければ新規に生成します。**同じ ppk でパッケージしないとプラグイン ID が変わり、更新インストールできません。** 安全な場所にバックアップしてください。`*.ppk`・`dist/`・`plugin/js/` は `.gitignore` 済みで、git には含めません。

## バージョン更新手順

正のバージョンは `package.json` の `version` です。`plugin/manifest.json` の `version` は `npm run package` 時に package.json の値で上書きされます（リポジトリ上の値も同じにしてあります）。版は `X.Y.Z` 形式のみ（先頭ゼロ・プレリリース接尾辞は不可）です。

1. `npm version minor --no-git-tag-version`（patch / major も可）で package.json の版を上げる。git のコミット・タグは作りません。
2. `npm run package` を実行する（manifest の版は自動同期されます）。
3. kintone システム管理 > プラグインで `dist/plugin-<version>.zip` を「読み込む」。同じ ppk なのでプラグイン ID は変わらず、更新扱いになります（版を上げても ppk が同じなら ID は不変です）。

- 前回パッケージした版は `dist/.last-packaged-version` に記録されます。同じ版、または低い版で再度 `npm run package` すると exit 1 で止まります。
- 意図的に作り直す場合は `npm run package -- --force`（`--` の後ろの引数が package.mjs に渡ります）。`--force` は検証用で、同一版を再作成しても kintone は更新として扱わない可能性が高いです。
- 変更が反映されないときの確認:
  1. ブラウザを強制再読込（Cmd+Shift+R）する。
  2. DevTools > Sources でページが読んでいる `desktop.js` を開き、`klc-acl-v2` や `GAIA_RE01` など最新の文字列が含まれるか検索する。
  3. kintone のプラグイン一覧に表示されるバージョンが上がっているか確認する。

## kintone へのインストール

1. kintone システム管理 > プラグイン > 「読み込む」から `dist/plugin-<version>.zip`（互換コピーの `dist/plugin.zip` も同内容）を取り込む。
2. 対象アプリのプラグイン設定で追加し、設定画面で各項目を設定して保存、アプリを更新する。

## 既知の制約

- kintone の DOM 構造が変わると動かなくなる可能性があります。`getFieldElements`・tr/td 構造・href パターンのみに依存し、取得できない場合は標準動作のままになります。
- 【要検証】ルックアップのリンクの href 形式（`/k/{app}/show#record={id}` を想定）は実機未確認です。ID が取れない場合はキー値で判定します。
- 【要検証】アプリ権限エラーのコード（`APP_DENY_CODES`）は実機未確認です。外れた場合は一般エラー扱い（`onError` に従う）になります。
- 【要検証】`CB_NO02`（record.json）がレコード単位の権限なしを指すか、`GAIA_RE01` が削除済みを指すかは実機未確認です。外れた場合は error 扱いになり標準動作に戻ります。
- 【要検証】無効リンクのクリックで `stopPropagation` をしなくなったため、kintone 標準の行ハンドラにクリックが届きます（pending 中の無効リンクは href を保持したままですが、`preventDefault` でブラウザ標準の遷移は止めています）。実機未確認です。
- キー値での判定時、キーが数値フィールドなら表示値の桁区切りを除いて問い合わせますが、保存値と一致しない場合は「閲覧不可」と判定されます。
- 別スペース・別ホストのアプリへのリンクは、href を解析できたときは href のゲストスペース ID（なければ通常スペース）を使い、解析できないキー型の判定だけ現在のスペースを使います。判定できない場合は標準動作です。
- 【要検証】モバイルのレコード詳細 URL は `/k/m/{app}/show?record={id}`、ゲストは `/k/guest/{space}/m/{app}/show?record={id}` を想定しています（デスクトップ形式の href も解析できます）。モバイルの「自レコードへ遷移」はこの形式で遷移します。フォーム情報の取得は `kintone.api.url(path, true)` でゲスト判定を kintone に任せています。いずれも実機未確認です。
- URL・パラメータ不整合系のエラー（`GAIA_IL23`、`CB_IJ01`、`GAIA_NO01` など）はアプリ権限なしとは扱わず、一般エラー（`onError` に従い、結果は保存しない）にします。
- インライン編集の保存後などに kintone が行を再描画すると、このプラグインの状態は標準に戻ることがあります（安全側）。
- 関連レコード一覧は一覧画面に出ないため対象外です。外部 URL・ユーザー・添付ファイルのリンクは判定しません。
