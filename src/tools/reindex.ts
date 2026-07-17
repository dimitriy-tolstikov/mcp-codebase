import { z } from 'zod';
import { indexProject } from '../indexer/indexer.js';

export const ReindexSchema = z.object({
  full: z.boolean().optional().default(false).describe('If true, performs a full reindex instead of incremental'),
});

export async function handleReindex(args: z.infer<typeof ReindexSchema>): Promise<string> {
  const stats = await indexProject({ full: args.full });
  return `Reindex complete.\nScanned: ${stats.scanned} files\nSkipped (unchanged): ${stats.skipped}\nRemoved (deleted from disk): ${stats.removed}\nParsed: ${stats.parsed} files\nSymbols: ${stats.symbols}\nImports: ${stats.imports}\nExports: ${stats.exports}\nDuration: ${(stats.durationMs / 1000).toFixed(1)}s`;
}
