import { build, context } from 'esbuild';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const forceIcon = args.includes('--force-icon');

const ICON_PATH = 'plugin/image/icon.png';

/** 外部素材なしで PNG（RGBA 8bit）を生成する。 */
function makePng(width = 56, height = 56) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  // 白い右向き矢印（シャフト + 三角形の矢じり）を単色背景に描く
  const inArrow = (x, y) => {
    const nx = x / width;
    const ny = y / height;
    const shaft = nx >= 0.2 && nx <= 0.55 && ny >= 0.42 && ny <= 0.58;
    // 矢じり: x が 0.5〜0.82 で、中心線からの距離が (0.82 - x) 以内
    const head = nx >= 0.5 && nx <= 0.82 && Math.abs(ny - 0.5) <= (0.82 - nx) * 0.85;
    return shaft || head;
  };
  for (let y = 0; y < height; y++) {
    const off = y * (width * 4 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = off + 1 + x * 4;
      const white = inArrow(x + 0.5, y + 0.5);
      raw[i] = white ? 255 : 0x34;
      raw[i + 1] = white ? 255 : 0x98;
      raw[i + 2] = white ? 255 : 0xdb;
      raw[i + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (!existsSync(ICON_PATH) || forceIcon) {
  mkdirSync(dirname(ICON_PATH), { recursive: true });
  writeFileSync(ICON_PATH, makePng(56, 56));
  console.log(`generated ${ICON_PATH}`);
}

const options = {
  entryPoints: {
    desktop: 'src/desktop/index.js',
    mobile: 'src/mobile/index.js',
    config: 'src/config/index.js',
  },
  outdir: 'plugin/js',
  bundle: true,
  format: 'iife',
  target: 'es2019',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching...');
} else {
  await build(options);
  for (const name of ['desktop', 'mobile', 'config']) {
    const p = `plugin/js/${name}.js`;
    if (!existsSync(p)) {
      console.error(`missing ${p}`);
      process.exit(1);
    }
    console.log(`${p}: ${(statSync(p).size / 1024).toFixed(1)} KB`);
  }
}
