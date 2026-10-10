import { z } from 'zod';
import { getProjectOverview } from '../db/repositories.js';

export const ProjectOverviewSchema = z.object({
  path: z.string().optional().describe('Limit the overview to a subdirectory (relative to project root)'),
  max_symbols: z.number().int().min(1).max(100).optional().default(40).describe('Max key symbols to list'),
});

export async function handleProjectOverview(args: z.infer<typeof ProjectOverviewSchema>): Promise<string> {
  const dirPrefix = (args.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const overview = await getProjectOverview(dirPrefix ? `${dirPrefix}/` : '', args.max_symbols);

  let output = dirPrefix ? `Project overview (${dirPrefix}/)\n` : 'Project overview\n';

  const totalFiles = overview.languages.reduce((sum: number, l: any) => sum + l.file_count, 0);
  const langBreakdown = overview.languages.map((l: any) => `${l.file_count} ${l.language}`).join(', ');
  output += `Files: ${totalFiles} (${langBreakdown})\n`;
  output += `Symbols: ${overview.symbolCount}\n`;

  if (overview.topDirs.length) {
    output += `\nTop-level directories:\n`;
    for (const d of overview.topDirs) {
      output += `  ${d.dir}/  (${d.file_count} files)\n`;
    }
  }

  if (overview.keySymbols.length) {
    output += `\nKey exported symbols (by importer count):\n`;
    for (const s of overview.keySymbols) {
      const kind = s.kind ? ` (${s.kind})` : '';
      const loc = s.line_start ? `${s.path}:${s.line_start}` : s.path;
      output += `  ${s.name}${kind} — ${loc}, imported by ${s.imported_by} file(s)\n`;
    }
  }

  return output;
}
