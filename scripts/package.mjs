import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { packPluginFromManifest } from '@kintone/plugin-packer/from-manifest';

const PPK = 'private.ppk';
const OUT = 'dist/plugin.zip';

for (const name of ['desktop', 'mobile', 'config']) {
  if (!existsSync(`plugin/js/${name}.js`)) {
    console.error(`plugin/js/${name}.js がありません。先に npm run build を実行してください。`);
    process.exit(1);
  }
}

const hadKey = existsSync(PPK);
const { plugin, privateKey, id } = await packPluginFromManifest(
  'plugin/manifest.json',
  hadKey ? readFileSync(PPK, 'utf-8') : undefined,
);
mkdirSync('dist', { recursive: true });
writeFileSync(OUT, plugin);
if (!hadKey) {
  writeFileSync(PPK, privateKey, { mode: 0o600 });
  console.log('private.ppk を新規生成しました。');
  console.log('同じ ppk でないとプラグインIDが変わります。安全な場所にバックアップしてください（git には含めません）。');
}
console.log(`wrote ${OUT}`);
console.log(`plugin id: ${id}`);
