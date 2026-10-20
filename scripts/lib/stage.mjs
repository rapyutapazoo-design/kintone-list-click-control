import { basename } from 'node:path';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { applyVersionToManifest, isExcludedFromStage } from './version.mjs';

/**
 * plugin を stage に複製し、stage 側 manifest の version を書き換えて fn(stageManifestPath) を実行する。
 * 成功・失敗にかかわらず stage は削除する。元の srcDir は変更しない。
 * @template T
 * @param {{ srcDir: string, stageDir: string, version: string }} opts
 * @param {(manifestPath: string) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withVersionedStage({ srcDir, stageDir, version }, fn) {
  try {
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    cpSync(srcDir, stageDir, {
      recursive: true,
      filter: (src) => src === srcDir || !isExcludedFromStage(basename(src)),
    });
    const manifestPath = `${stageDir}/manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    writeFileSync(manifestPath, JSON.stringify(applyVersionToManifest(manifest, version), null, 2) + '\n');
    return await fn(manifestPath);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
