import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';
import { packPluginFromManifest } from '@kintone/plugin-packer/from-manifest';
import {
  applyVersionToManifest,
  assertKeyPathSafe,
  assertValidVersion,
  checkPluginId,
  checkVersionBump,
  decideKeyMode,
  isKeyFilePermissive,
  maxVersion,
  parseArgs,
  releaseZipPath,
  resolveKeyPath,
} from './lib/version.mjs';
import { withVersionedStage } from './lib/stage.mjs';

const STAGE = 'dist/.stage';
const LAST_FILE = 'dist/.last-packaged-version';
const OUT_COMPAT = 'dist/plugin.zip';
const MANIFEST = 'plugin/manifest.json';

for (const name of ['desktop', 'mobile', 'config']) {
  if (!existsSync(`plugin/js/${name}.js`)) {
    console.error(`plugin/js/${name}.js がありません。先に npm run build を実行してください。`);
    process.exit(1);
  }
}

const { force, initKey, syncManifest } = parseArgs(process.argv.slice(2));

// 検査フェーズ（ここまでは書き込みなし）
let version;
let expectedId;
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  version = assertValidVersion(pkg.version);
  expectedId = pkg.kintone?.pluginId ?? null;
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

// 鍵のパス: 環境変数 > .env > ./private.ppk
let dotenv = {};
try {
  if (existsSync('.env')) dotenv = parseEnv(readFileSync('.env', 'utf-8'));
} catch (e) {
  console.error(`.env を読み込めませんでした（権限や形式を確認してください）: ${e.message ?? e}`);
  process.exit(1);
}
const keyPath = resolveKeyPath({ env: process.env, dotenv, cwd: process.cwd(), homedir: homedir() });
try {
  assertKeyPathSafe({
    keyPath,
    repoRoot: process.cwd(),
    gitignoreText: existsSync('.gitignore') ? readFileSync('.gitignore', 'utf-8') : '',
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const km = decideKeyMode({ keyExists: existsSync(keyPath), initKey, expectedId });
if (!km.ok) {
  console.error(km.message);
  process.exit(1);
}
if (km.mode === 'use' && isKeyFilePermissive(statSync(keyPath).mode)) {
  console.warn(`警告: 鍵ファイルの権限が緩すぎます。chmod 600 を実行してください: ${keyPath}`);
}

let result;
try {
  mkdirSync('dist', { recursive: true });
  result = await withVersionedStage({ srcDir: 'plugin', stageDir: STAGE, version }, (manifestPath) =>
    packPluginFromManifest(manifestPath, km.mode === 'use' ? readFileSync(keyPath, 'utf-8') : undefined),
  );
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
}
if (!result) process.exit(1);

const { plugin, privateKey, id } = result;

if (km.mode === 'use') {
  const idc = checkPluginId(expectedId, id);
  if (!idc.ok) {
    console.error(idc.message);
    process.exit(1); // 成果物・記録は一切書かない
  }
  if (idc.reason === 'unrecorded') console.warn(idc.message);
}

// 書き込みフェーズ
if (km.mode === 'init') {
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKey, { mode: 0o600, flag: 'wx' });
  console.log(`新しい鍵を保存しました: ${keyPath}`);
  console.log(`plugin id: ${id}`);
  console.log('package.json の kintone.pluginId に記録し、鍵をバックアップしてください（git には含めません）。');
}
const releasePath = releaseZipPath(version);
mkdirSync('dist/releases', { recursive: true });
writeFileSync(releasePath, plugin);
writeFileSync(OUT_COMPAT, plugin);
if (syncManifest) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  writeFileSync(MANIFEST, JSON.stringify(applyVersionToManifest(manifest, version), null, 2) + '\n');
}
// 記録は全出力成功後の最後に、記録済みと今回の大きい方を保持
writeFileSync(LAST_FILE, maxVersion(version, last) + '\n');
console.log(`wrote ${releasePath}`);
console.log(`wrote ${OUT_COMPAT}（kintone に読み込むファイル）`);
console.log(`version: ${version}`);
console.log(`plugin id: ${id}`);
console.log(`key: ${keyPath}`);
