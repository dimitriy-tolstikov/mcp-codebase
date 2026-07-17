import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from '../config.js';
import { getSymbolById, getSymbolByNameAndPath } from '../db/repositories.js';

// Extensions to scan — driven by config.languageMap
const SOURCE_EXTENSIONS = new Set(Object.keys(config.languageMap));

export const FindUsagesSchema = z.object({
  name: z.string().describe('Symbol name to search for'),
  file_path: z.string().optional().describe('File path where symbol is defined (for narrowing)'),
  symbol_id: z.number().int().optional().describe('Symbol database ID'),
});

export async function handleFindUsages(args: z.infer<typeof FindUsagesSchema>): Promise<string> {
  let symbol: any;
  if (args.symbol_id) {
    symbol = await getSymbolById(args.symbol_id);
  } else if (args.name && args.file_path) {
    symbol = await getSymbolByNameAndPath(args.name, args.file_path);
  }

  const targetName = symbol?.name || args.name;
  const targetPath = symbol?.file_path || args.file_path;

  if (!targetName) {
    return 'Error: provide symbol_id, or both name and file_path';
  }

  // Grep-like search across the project
  const regex = new RegExp(`\\b${targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const results: { file: string; line: number; text: string }[] = [];

  function searchDir(dir: string, relPrefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = path.posix.join(relPrefix, entry.name);
      const absPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        )
          continue;
        searchDir(absPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        let content: string;
        try {
          content = fs.readFileSync(absPath, 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip own definition line if we know the file
          if (relPath === targetPath && i + 1 >= (symbol?.line_start || 0) && i + 1 <= (symbol?.line_end || 0)) {
            continue;
          }
          if (regex.test(line)) {
            results.push({ file: relPath, line: i + 1, text: line.trim() });
          }
          regex.lastIndex = 0;
        }
      }
    }
  }

  searchDir(config.projectRoot, '');

  if (results.length === 0) {
    return `No usages found for "${targetName}"`;
  }

  let output = `References to ${targetName} (found ${results.length}):\n`;
  for (const r of results.slice(0, 50)) {
    output += `\n  ${r.file}:${r.line}\n     ${r.text}\n`;
  }
  if (results.length > 50) {
    output += `\n  ... and ${results.length - 50} more references\n`;
  }

  return output;
}
