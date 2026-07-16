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

  // List subdirectories
  try {
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length) {
      output += `\nSubdirectories:\n`;
      for (const d of dirs) {
        const subPath = path.join(absoluteDir, d.name);
        let fileCount = 0;
        try {
          const subEntries = fs.readdirSync(subPath, { recursive: true }) as string[];
          fileCount = subEntries.filter((e) => {
            try {
              return fs.statSync(path.join(subPath, e)).isFile();
            } catch {
              return false;
            }
          }).length;
        } catch {
          // ignore
        }
        output += `  - ${d.name}/  (${fileCount} files)\n`;
      }
    }
  } catch {
    // ignore
  }

  if (stats.topImports.length) {
    output += `\nTop external/internal imports:\n`;
    for (const imp of stats.topImports.slice(0, 10)) {
      output += `  - ${imp.source} (${imp.file_count} files)\n`;
    }
  }

  return output;
}
