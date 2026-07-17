import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from '../config.js';
import { getModuleStats } from '../db/repositories.js';

export const ExploreModuleSchema = z.object({
  path: z.string().describe('Directory path relative to project root or absolute within project'),
  depth: z.number().int().min(0).max(3).optional().default(1),
});

export async function handleExploreModule(args: z.infer<typeof ExploreModuleSchema>): Promise<string> {
  const dirPath = args.path.replace(/\\/g, '/');
  const absoluteDir = path.join(config.projectRoot, dirPath);

  if (!fs.existsSync(absoluteDir)) {
    return `Directory not found: ${dirPath}`;
  }

  const stats = await getModuleStats(dirPath);

  let output = `Module: ${dirPath}\n`;

  const totalFiles = stats.files.reduce((sum: number, f: any) => sum + parseInt(f.count), 0);
  const extBreakdown = stats.files.map((f: any) => `${f.count} ${f.extension || 'no-ext'}`).join(', ');
  output += `Files: ${totalFiles} total (${extBreakdown})\n`;

  if (stats.symbols.length) {
    output += `\nKey symbols:\n`;
    for (const s of stats.symbols.slice(0, 20)) {
      const fileName = path.basename(s.path);
      output += `  ${s.name.padEnd(25)} (${s.kind.padEnd(12)}) — ${fileName}:${s.line_start}\n`;
    }
    if (stats.symbols.length > 20) {
      output += `  ... and ${stats.symbols.length - 20} more\n`;
    }
  }

  // List subdirectories up to `depth` levels (depth 0 hides this section)
  if (args.depth > 0) {
    const dirLines: string[] = [];
    listSubdirectories(absoluteDir, args.depth, '  ', dirLines);
    if (dirLines.length) {
      output += `\nSubdirectories:\n${dirLines.join('\n')}\n`;
    }
  }

  if (stats.topImports.length) {
    output += `\nTop external/internal imports:\n`;
    for (const imp of stats.topImports.slice(0, 10)) {
      output += `  - ${imp.source} (${imp.file_count} files)\n`;
    }
  }

  return output;
}

// Directories that are never descended into when listing or counting
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

function countFilesRecursive(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        count += countFilesRecursive(path.join(dir, entry.name));
      }
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

function listSubdirectories(dir: string, depth: number, indent: string, lines: string[]): void {
  if (depth <= 0) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const subDir = path.join(dir, entry.name);
    lines.push(`${indent}- ${entry.name}/  (${countFilesRecursive(subDir)} files)`);
    listSubdirectories(subDir, depth - 1, indent + '  ', lines);
  }
}
