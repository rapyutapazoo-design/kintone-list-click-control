import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { packPluginFromManifest } from '@kintone/plugin-packer/from-manifest';
import {
  assertValidVersion,
  checkVersionBump,
  maxVersion,
  parseArgs,
} from './lib/version.mjs';
import { withVersionedStage } from './lib/stage.mjs';

const PPK = 'private.ppk';
const STAGE = 'dist/.stage';
const LAST_FILE = 'dist/.last-packaged-version';

for (const name of ['desktop', 'mobile', 'config']) {
  if (!existsSync(`plugin/js/${name}.js`)) {
    console.error(`plugin/js/${name}.js がありません。先に npm run build を実行してください。`);
    process.exit(1);
  }
}

const { force } = parseArgs(process.argv.slice(2));

// 版検査（ppk 生成・ステージ作成より前。失敗時に副作用を残さない）
let version;
try {
  version = assertValidVersion(JSON.parse(readFileSync('package.json', 'utf-8')).version);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const last = existsSync(LAST_FILE) ? readFileSync(LAST_FILE, 'utf-8').trim() : null;
const check = checkVersionBump(version, last, { force });
if (!check.ok) {
  console.error(check.message);
  process.exit(1);
}
if (check.reason === 'forced') {
  console.log('--force で同一/下位版のパッケージを続行します。');
}

const OUT_VERSIONED = `dist/plugin-${version}.zip`;
const OUT_COMPAT = 'dist/plugin.zip';

const hadKey = existsSync(PPK);
let result;
try {
  mkdirSync('dist', { recursive: true });
  result = await withVersionedStage({ srcDir: 'plugin', stageDir: STAGE, version }, (manifestPath) =>
    packPluginFromManifest(manifestPath, hadKey ? readFileSync(PPK, 'utf-8') : undefined),
  );
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
}
if (!result) process.exit(1);

const { plugin, privateKey, id } = result;
// 新規鍵は最初に保存（以降の書き込みが失敗しても鍵を失わない）
if (!hadKey) {
  writeFileSync(PPK, privateKey, { mode: 0o600 });
  console.log('private.ppk を新規生成しました。');
  console.log('同じ ppk でないとプラグインIDが変わります。安全な場所にバックアップしてください（git には含めません）。');
}
writeFileSync(OUT_VERSIONED, plugin);
writeFileSync(OUT_COMPAT, plugin);
// 記録は全出力成功後の最後に、記録済みと今回の大きい方を保持
writeFileSync(LAST_FILE, maxVersion(version, last) + '\n');
console.log(`wrote ${OUT_VERSIONED}`);
console.log(`wrote ${OUT_COMPAT} (互換用コピー)`);
console.log(`version: ${version}`);
console.log(`plugin id: ${id}`);
