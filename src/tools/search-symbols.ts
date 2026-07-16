import { z } from 'zod';
import { searchSymbols } from '../db/repositories.js';

export const SearchSymbolsSchema = z.object({
  query: z.string().min(1).describe('Symbol name or pattern (supports * wildcard and | for OR)'),
  kind: z.string().optional().describe('Filter by kind: class, function, interface, method, property, etc. Use | for multiple'),
  language: z.string().optional().describe('Filter by language: typescript, csharp'),
  file_path: z.string().optional().describe('Filter by file path substring'),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export async function handleSearchSymbols(args: z.infer<typeof SearchSymbolsSchema>): Promise<string> {
  const rows = await searchSymbols({
    query: args.query,
    kind: args.kind,
    language: args.language,
    filePath: args.file_path,
    limit: args.limit,
    offset: args.offset,
  });

  if (rows.length === 0) {
    return `No symbols found for query: "${args.query}"`;
  }

  const lines = rows.map((r, i) => {
    const mods = r.modifiers ? JSON.parse(r.modifiers) : [];
    let text = `${i + 1}. ${r.name} (${r.kind}) — ${r.file_path}:${r.line_start}`;
    if (r.signature) {
      text += `\n   ${r.signature}`;
    }
    if (mods.length) {
      text += `\n   [${mods.join(', ')}]`;
    }
    return text;
  });

  return `Found ${rows.length} symbol(s):\n\n${lines.join('\n\n')}`;
}
