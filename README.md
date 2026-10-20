# 一覧画面クリック遷移制御（kintone プラグイン）

kintone の一覧画面（表形式）で、次を制御するプラグインです。

- 行のどこをクリックしてもレコード詳細へ遷移（PC のみ）
- ルックアップのリンクを「標準 / 無効（テキスト表示）/ 自レコードへ遷移」から選択（全体設定＋フィールド個別）
- リンクのクリック時に遷移先の閲覧権限を確認し、閲覧できなければクリックした行のレコード詳細を開く（設定で無効化も可。ルックアップ／kintone のレコード URL を持つ「リンク」フィールド）

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
| permission.onDeny | `self` / `disable` | `self` |
| permission.onError | `standard` / `self` / `disable` | `self` |
| permission.cacheTtlSec | 0〜3600 | `300` |

行クリックでは、リンク・ボタン・入力欄の上、詳細/編集アイコンの列、テキスト選択中、インライン編集中、右クリックは遷移しません。Ctrl / Cmd / Shift クリックと中クリックは常に新しいタブで開きます。モバイルではルックアップ制御と権限判定のみ動作します（行クリックとホバーなし）。

## v1.2 の変更点

- 表示時にリンクを灰色にしたり無効にしたりするのをやめました。一覧の見た目は変わりません。
- 権限は**クリックしたときに判定**します。判定結果のキャッシュがあれば即時に遷移し、なければ最大 1.5 秒待ちます（待つ間はカーソルとリンクが「確認中」の表示になります）。表示時の判定は、キャッシュを温めるために裏で実行するだけで、画面には反映しません。
- `rowClick` の設定（default / row）に関係なく、クリックすれば必ず反応します。閲覧できる場合はルックアップ先、閲覧できない・リンク先がない場合は自レコードの詳細（`onDeny: self`）を開きます。`onDeny: disable` では開かずに理由をトースト表示します。
- 権限を確認できなかったとき（通信エラー・1.5 秒のタイムアウト）の動作は `onError` で選びます。新しい既定値は `self`（自レコードを開く）です。
- 設定スキーマが v2 になりました（`permission.onDeny` を追加、`onError` に `self` を追加）。v1 の設定は自動で移行され、`onError` は保存済みの値のまま残ります。
- **v1.1 から更新した既存の設定では、権限がないときの挙動が「リンクを無効化」から「自レコードへ遷移」に変わります。** 元の「開かない」挙動に近づけるには `onDeny` を `disable` にしてください。
- `permission.enabled` が `false` のときは v1.1 と同じで、kintone 標準のリンクのままです。

## 権限判定の仕組みと注意

- 二段階確認で判定します。
  1. 遷移先アプリごとに `/k/v1/records.json` を `$id in (...)`（href からレコード ID が取れない場合は、ルックアップのキーフィールドの値）で問い合わせ、返ってきたレコードを「閲覧可」にします。
  2. 返らなかった ID 型の値は `/k/v1/record.json` GET で個別に再確認します。成功なら「閲覧可」、`CB_NO02` なら「閲覧不可」、`GAIA_RE01` なら「レコードが見つからない（削除済みなど）」、その他は通信エラー扱い（`onError` に従う）です。
  - 再確認は 1 回の判定につき最大 10 件です。超過分は個別確認せず「閲覧不可」として扱いますが、キャッシュしないので次の判定時に再確認します。
  - キー値（ルックアップのキーフィールド）で判定する場合は個別取得できないので、返らなければ「閲覧不可」です。
- **この判定は遷移先を切り替えるための補助です。** 実際の閲覧可否は kintone のサーバー側の権限設定で保証されます。権限のないレコードへ遷移しても kintone が閲覧権限エラーを表示するだけです。
- アプリ全体に権限がない場合（`CB_NO02` など）は、そのアプリの全リンクを無効にし、以後そのアプリは問い合わせません。
- 通信エラー・タイムアウト時は `onError` に従います（既定は `self`＝自レコードを開く。`standard` は標準のリンク先、`disable` は開かずにトースト表示）。タイムアウトは 2 種類あり、判定そのもの（acl）のタイムアウトは 5 秒、クリック時に判定を待つ時間は 1.5 秒です。1.5 秒を過ぎても判定は裏で続き、結果はキャッシュされるので、次のクリックでは正しい遷移先に行けます。エラーは保存せず、連続失敗時は指数バックオフ（最大 60 秒）で再試行します。
- 呼び出し回数の目安: 100 行 × ルックアップ 3 フィールド・遷移先 2 アプリで、初回 2〜3 回。TTL 内の再表示は 0 回です。1 回の問い合わせは 100 件までで、並列度は最大 3 です。個別再確認は 1 回の判定につき最大 10 回で、上限を超えた分は非キャッシュのため、再表示のたびに再問い合わせされます。
- キャッシュ: メモリ上に TTL 付きで保持します。sessionStorage（キー `klc-acl-v2`）には ID ベースの「閲覧可」とアプリ単位の「閲覧不可」のみを保存し、キー値（顧客名など）は保存しません。レコード単位の「閲覧不可」「見つからない」はメモリ（TTL 付き）のみで保存しません。旧キー `klc-acl-v1` は読まず、起動時に削除します。ログにも値を出しません。
- 判定対象のリンクをクリックすると、`rowClick` の設定に関係なく、閲覧可ならルックアップ先、閲覧不可・リンク先なしなら自レコード（`onDeny: self`）へ遷移します。href がないリンクは API を呼ばずに「リンク先なし」として扱います。`http(s)` 以外の href（`javascript:` など）には介入しません。新しいタブで開く操作（Ctrl / Cmd / Shift クリック、中クリック、`openMode: new`）では、ポップアップブロックを避けるためクリックの時点で空タブを開き、判定後にそのタブを遷移させます（開けないときは再クリックを促すトーストを表示します）。
- `lookup.mode` が `text`（テキスト表示）のリンクは v1.1 のままで、無効表示になり行クリックに回ります。`self` は常に自レコードへ遷移します。

## 誤判定時の切り分け手順

1. ブラウザの開発者ツール > Application > Session Storage で `klc-acl-v2` を確認します。`entries` に該当 ID が `allow` 以外で残っていないことを見ます。疑わしければキーを削除して再読み込みします。
2. 同じ ID を record.json で GET して確認します（コンソールで `kintone.api(kintone.api.url('/k/v1/record.json', true), 'GET', {app: 27, id: 17})`）。成功なら閲覧可のはずで、`CB_NO02` は権限なし、`GAIA_RE01` は削除済みまたは ID 違いです。
3. クリックしたときに表示されるトーストの文言を確認します（`onDeny: disable` のとき。「閲覧権限がないため開けません」か「レコードが見つかりません」か）。
4. `permission.enabled` を off にすると判定が無効になります。

## 開発・ビルド

Node.js 22.2 以上と npm が必要です（アイコン生成で `zlib.crc32` を使用）。

```sh
npm install
npm test            # vitest（core の単体テストと jsdom 結合テスト）
npm run build       # plugin/js/{desktop,mobile,config}.js と plugin/image/icon.png を生成
npm run dev         # watch ビルド
npm run package     # build のあと dist/plugin.zip と dist/releases/plugin-<version>.zip を生成
```

- ソースは素の JavaScript（ESM）＋ JSDoc です。esbuild で IIFE（es2019）にバンドルします。
- 設定画面のみ kintone-ui-component v1 を同梱します（desktop / mobile は依存なし）。依存はすべて exact pin です。
- `src/core/` は DOM・kintone に依存しない純粋関数、`src/desktop/dom.js` は DOM 制御とエントリ初期化 `setupEntry`（desktop / mobile 共用。イベント登録は各 `index.js` が自分の platform 分だけ行う）です。

## 秘密鍵（ppk）の管理

`npm run package` は、鍵がなければ**停止します**（自動では生成しません）。**同じ ppk でパッケージしないとプラグイン ID が変わり、更新インストールできません。**

- 鍵のパスは、環境変数 `KLC_PPK_PATH` > `.env` の `KLC_PPK_PATH` > `./private.ppk` の順で決まります（`~/` は展開されます）。
- 推奨の置き場所は `~/.config/kintone-plugins/kintone-list-click/private.ppk`（`chmod 600`）です。リポジトリ内に置く場合は `.ppk` の拡張子で、`.gitignore` に `*.ppk` が必要です（なければ停止します）。
- 移す手順:
  1. 鍵を推奨の場所へ移動する（`mkdir -p` のあと `mv`）。
  2. `.env` に `KLC_PPK_PATH=~/.config/kintone-plugins/kintone-list-click/private.ppk` を書く（`.env*` は git に含めません）。
  3. `npm run package` を実行し、出力の `plugin id:` が `package.json` の `kintone.pluginId` と一致することを確認する。
  4. 暗号化した外部媒体やパスワードマネージャーにバックアップする。
- パッケージ時に、生成されたプラグイン ID を `package.json` の `kintone.pluginId` と照合します。違う場合は何も書き込まずに停止します（誤った鍵や鍵の作り直しの防止）。
- `--init-key` は、鍵のファイルがなく、かつ `kintone.pluginId` が未記録のときだけ使えます（新しい鍵を 0600 で保存し、ID を表示します）。記録済みの場合は拒否されます。
- `*.ppk`・`dist/`・`plugin/js/` は `.gitignore` 済みで、git には含めません。

## バージョン更新手順

正のバージョンは `package.json` の `version` です。`plugin/manifest.json` の `version` は `npm run package` 時に package.json の値で上書きされます。版は `X.Y.Z` 形式のみ（先頭ゼロ・プレリリース接尾辞は不可）です。

- kintone に読み込むファイルは常に `dist/plugin.zip` です。版ごとの控えは `dist/releases/plugin-<版>.zip` に残ります（旧形式の `dist/plugin-1.1.0.zip` はそのまま残ります）。
- リリース手順: `npm run release:patch`（または `release:minor` / `release:major`）を実行します。版を上げ、パッケージし、manifest の版を同期し、コミットとタグ `v<版>` を作ります（パッケージに失敗した場合はコミットもタグも作られません）。push は手動で `git push --follow-tags` を実行します。
- 今回の 1.2.0 は `npm version 1.2.0 --no-git-tag-version` で上げたため、タグは後で付けます（例: `git tag v1.2.0`）。
- 前回パッケージした版は `dist/.last-packaged-version` に記録されます。同じ版、または低い版で再度 `npm run package` すると exit 1 で止まります。
- 意図的に作り直す場合は `npm run package -- --force`（`--` の後ろの引数が package.mjs に渡ります）。`--force` は検証用で、同一版を再作成しても kintone は更新として扱わない可能性が高いです。
- 変更が反映されないときの確認:
  1. ブラウザを強制再読込（Cmd+Shift+R）する。
  2. DevTools > Sources でページが読んでいる `desktop.js` を開き、`klc-acl-v2` や `GAIA_RE01` など最新の文字列が含まれるか検索する。
  3. kintone のプラグイン一覧に表示されるバージョンが上がっているか確認する。

## kintone へのインストール

1. kintone システム管理 > プラグイン > 「読み込む」から `dist/plugin.zip` を取り込む（同じ内容が `dist/releases/plugin-<version>.zip` にも残ります）。
2. 対象アプリのプラグイン設定で追加し、設定画面で各項目を設定して保存、アプリを更新する。

## 既知の制約

- kintone の DOM 構造が変わると動かなくなる可能性があります。`getFieldElements`・tr/td 構造・href パターンのみに依存し、取得できない場合は標準動作のままになります。
- 【要検証】ルックアップのリンクの href 形式（`/k/{app}/show#record={id}` を想定）は実機未確認です。ID が取れない場合はキー値で判定します。
- 【要検証】アプリ権限エラーのコード（`APP_DENY_CODES`）は実機未確認です。外れた場合は一般エラー扱い（`onError` に従う）になります。
- 【要検証】`CB_NO02`（record.json）がレコード単位の権限なしを指すか、`GAIA_RE01` が削除済みを指すかは実機未確認です。外れた場合は error 扱いになり標準動作に戻ります。
- 右クリックの「新しいタブで開く」「リンクをコピー」は、kintone 標準のリンク先のままです（href は書き換えません）。
- 【要検証】Firefox の中クリック（auxclick の `preventDefault` が効くか、ユーザー操作として扱われるか）は実機未確認です。効かない場合は kintone 標準のリンク先が開くだけです。
- 一覧の表示直後（フォーム情報を取得する前）のクリックは標準動作になります。`<a>` がないルックアップのセルは対象外です。
- 判定対象のリンクのクリックは `stopPropagation` するため、kintone 標準の行ハンドラには届きません。【要検証】実機未確認です。
- キー値での判定時、キーが数値フィールドなら表示値の桁区切りを除いて問い合わせますが、保存値と一致しない場合は「閲覧不可」と判定されます。
- 別スペース・別ホストのアプリへのリンクは、href を解析できたときは href のゲストスペース ID（なければ通常スペース）を使い、解析できないキー型の判定だけ現在のスペースを使います。判定できない場合は標準動作です。
- 【要検証】モバイルのレコード詳細 URL は `/k/m/{app}/show?record={id}`、ゲストは `/k/guest/{space}/m/{app}/show?record={id}` を想定しています（デスクトップ形式の href も解析できます）。モバイルの「自レコードへ遷移」はこの形式で遷移します。フォーム情報の取得は `kintone.api.url(path, true)` でゲスト判定を kintone に任せています。いずれも実機未確認です。
- URL・パラメータ不整合系のエラー（`GAIA_IL23`、`CB_IJ01`、`GAIA_NO01` など）はアプリ権限なしとは扱わず、一般エラー（`onError` に従い、結果は保存しない）にします。
- インライン編集の保存後などに kintone が行を再描画すると、このプラグインの状態は標準に戻ることがあります（安全側）。
- 関連レコード一覧は一覧画面に出ないため対象外です。外部 URL・ユーザー・添付ファイルのリンクは判定しません。
