import { FSWatcher, watch } from 'chokidar';
import path from 'path';
import { config } from '../config.js';
import { indexSingleFile, removeFileFromIndex } from './indexer.js';

let watcher: FSWatcher | null = null;

// Extensions that get (re)indexed on add/change — driven by config.languageMap
const watchedExtensions = new Set(Object.keys(config.languageMap));

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
      stabilityThreshold: config.watchDebounceMs,
      pollInterval: 100,
    },
  });

  const handleChange = async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!watchedExtensions.has(ext)) return;

    try {
      await indexSingleFile(filePath, rootDir);
      console.error(`[watch] Indexed: ${path.relative(rootDir, filePath)}`);
    } catch (err) {
      console.error(`[watch] Failed to index ${filePath}:`, (err as Error).message);
    }
  };

  const handleUnlink = async (filePath: string) => {
    try {
      await removeFileFromIndex(filePath, rootDir);
      console.error(`[watch] Removed from index: ${path.relative(rootDir, filePath)}`);
    } catch (err) {
      console.error(`[watch] Failed to remove ${filePath}:`, (err as Error).message);
    }
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
