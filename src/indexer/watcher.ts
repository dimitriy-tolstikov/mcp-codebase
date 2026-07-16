import { FSWatcher, watch } from 'chokidar';
import path from 'path';
import { config } from '../config.js';
import { indexSingleFile } from './indexer.js';

let watcher: FSWatcher | null = null;

export function startWatcher(rootDir: string): void {
  if (watcher) return;

  watcher = watch(rootDir, {
    ignored: [
      /(^|[\/\\])\../, // dotfiles
      'node_modules',
      'dist',
      'build',
      '*.min.js',
      '*.map',
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  const handleChange = async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.cs', '.mjs', '.cjs'].includes(ext)) return;

    try {
      await indexSingleFile(filePath, rootDir);
      console.error(`[watch] Indexed: ${path.relative(rootDir, filePath)}`);
    } catch (err) {
      console.error(`[watch] Failed to index ${filePath}:`, (err as Error).message);
    }
  };

  const handleUnlink = async (filePath: string) => {
    // File deletion handled by indexer transaction
    console.error(`[watch] Removed: ${path.relative(rootDir, filePath)}`);
  };

  watcher.on('add', handleChange);
  watcher.on('change', handleChange);
  watcher.on('unlink', handleUnlink);

  console.error(`[watch] Watching ${rootDir}`);
}

export async function stopWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}
