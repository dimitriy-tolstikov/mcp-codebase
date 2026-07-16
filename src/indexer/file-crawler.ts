import fs from 'fs';
import path from 'path';
import type ignoreLib from 'ignore';
import { normalizePath } from '../utils/paths.js';

export interface FileEntry {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
  mtime: number;
  lineCount?: number;
}

export function* crawlFiles(
  rootDir: string,
  ig: ignoreLib.Ignore,
  extraIgnorePatterns: string[]
): Generator<FileEntry> {
  const stack: string[] = [''];
  const extraIg = new Set(extraIgnorePatterns.map((p) => p.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\/$/, '')));

  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = path.join(rootDir, relDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relPath = normalizePath(path.join(relDir, entry.name));
      const absPath = path.join(rootDir, relPath);

      // Check ignore patterns
      const checkPath = relPath.replace(/\\/g, '/');
      if (ig.ignores(checkPath)) continue;

      // Check extra patterns (simple basename matching)
      if (extraIg.has(entry.name)) continue;

      if (entry.isDirectory()) {
        stack.push(relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absPath);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }
        yield {
          absolutePath: absPath,
          relativePath: relPath,
          extension: path.extname(entry.name).toLowerCase(),
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      }
    }
  }
}
