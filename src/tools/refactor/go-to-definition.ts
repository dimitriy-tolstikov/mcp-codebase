import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { requireBackend } from './common.js';
import { fileToUri, toLspPosition, uriToFile } from '../../lsp/positions.js';
import { config } from '../../config.js';
import type { Hover, Location, LocationLink, MarkupContent, MarkedString } from 'vscode-languageserver-protocol';

export const GoToDefinitionSchema = z.object({
  file_path: z.string().describe('File containing the symbol reference (relative to project root or absolute)'),
  line: z.number().int().min(1).describe('Line number of the symbol (1-based)'),
  column: z.number().int().min(1).describe('Column number of the symbol (1-based)'),
});

function hoverText(hover: Hover | null): string {
  if (!hover) return '';
  const contents = hover.contents as MarkupContent | MarkedString | MarkedString[] | undefined;
  if (!contents) return '';
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
  }
  if (typeof contents === 'string') return contents;
  return contents.value ?? '';
}

export async function handleGoToDefinition(args: z.infer<typeof GoToDefinitionSchema>): Promise<string> {
  const { absPath, backend } = await requireBackend(args.file_path, 'definition');
  await backend.client.openDocument(absPath);

  const uri = fileToUri(absPath);
  const position = toLspPosition(args.line, args.column);

  const [defsResult, hoverResult] = await Promise.all([
    backend.client.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', {
      textDocument: { uri },
      position,
    }),
    backend.client.request<Hover | null>('textDocument/hover', {
      textDocument: { uri },
      position,
    }).catch(() => null),
  ]);

  const defs: { uri: string; line: number; character: number }[] = [];
  for (const loc of Array.isArray(defsResult) ? defsResult : defsResult ? [defsResult] : []) {
    if ('targetUri' in loc) {
      defs.push({ uri: loc.targetUri, line: loc.targetRange.start.line, character: loc.targetRange.start.character });
    } else {
      defs.push({ uri: loc.uri, line: loc.range.start.line, character: loc.range.start.character });
    }
  }

  const hover = hoverText(hoverResult);
  if (defs.length === 0 && !hover) {
    return `No definition found at ${args.file_path}:${args.line}:${args.column}`;
  }

  let output = '';
  if (hover) {
    output += `Hover:\n  ${hover.split('\n').join('\n  ')}\n`;
  }
  if (defs.length) {
    output += `${output ? '\n' : ''}Definition${defs.length > 1 ? 's' : ''}:\n`;
    for (const def of defs) {
      const abs = uriToFile(def.uri);
      const rel = path.relative(config.projectRoot, abs).replace(/\\/g, '/');
      let firstLine = '';
      try {
        firstLine = (fs.readFileSync(abs, 'utf-8').split(/\r?\n/)[def.line] ?? '').trim();
      } catch {
        firstLine = '[Could not read file]';
      }
      output += `  ${rel}:${def.line + 1}:${def.character + 1}\n     ${firstLine}\n`;
    }
  }

  return output;
}
