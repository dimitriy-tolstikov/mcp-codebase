import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { config } from '../config.js';
import { getSymbolById, getSymbolByNameAndPath, getSymbolsInFile, getImportsInFile } from '../db/repositories.js';

export const SymbolDetailsSchema = z.object({
  symbol_id: z.number().int().optional().describe('Symbol database ID'),
  name: z.string().optional().describe('Symbol name'),
  file_path: z.string().optional().describe('File path where symbol is defined'),
});

export async function handleSymbolDetails(args: z.infer<typeof SymbolDetailsSchema>): Promise<string> {
  let symbol: any;

  if (args.symbol_id) {
    symbol = await getSymbolById(args.symbol_id);
  } else if (args.name && args.file_path) {
    symbol = await getSymbolByNameAndPath(args.name, args.file_path);
  } else {
    return 'Error: provide either symbol_id or both name and file_path';
  }

  if (!symbol) {
    return 'Symbol not found';
  }

  const absolutePath = path.join(config.projectRoot, symbol.file_path);
  let sourceCode = '';
  try {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, symbol.line_start - 1);
    const end = Math.min(lines.length, symbol.line_end);
    const slice = lines.slice(start, end);
    const maxNumWidth = String(end).length;
    sourceCode = slice
      .map((line, idx) => {
        const num = String(start + idx + 1).padStart(maxNumWidth, ' ');
        return `${num} | ${line}`;
      })
      .join('\n');
  } catch {
    sourceCode = '[Could not read file]';
  }

  const mods = symbol.modifiers ? JSON.parse(symbol.modifiers) : [];

  const otherSymbols = await getSymbolsInFile(symbol.file_id);
  const imports = await getImportsInFile(symbol.file_id);

  let output = `Symbol: ${symbol.name}\n`;
  output += `Kind: ${symbol.kind}\n`;
  output += `File: ${symbol.file_path}:${symbol.line_start}${symbol.line_end > symbol.line_start ? '-' + symbol.line_end : ''}\n`;
  output += `Language: ${symbol.language}\n`;
  if (mods.length) output += `Modifiers: [${mods.join(', ')}]\n`;
  if (symbol.signature) output += `\nSignature:\n  ${symbol.signature}\n`;
  if (symbol.docstring) output += `\nDocstring:\n  ${symbol.docstring}\n`;

  output += `\nSource code:\n${sourceCode}\n`;

  if (imports.length) {
    output += `\nImports in file:\n`;
    for (const imp of imports) {
      const names = imp.names ? JSON.parse(imp.names).join(', ') : '';
      output += `  - ${imp.source}${names ? ` (${names})` : ''}${imp.is_type_only ? ' [type-only]' : ''}\n`;
    }
  }

  if (otherSymbols.length > 1) {
    output += `\nOther symbols in file:\n`;
    for (const s of otherSymbols) {
      if (s.id === symbol.id) continue;
      output += `  - ${s.name} (${s.kind}) — line ${s.line_start}\n`;
    }
  }

  return output;
}
