import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { requireBackend } from './common.js';
import { fileToUri, toLspPosition, uriToFile } from '../../lsp/positions.js';
import { config } from '../../config.js';
import type { Location, LocationLink } from 'vscode-languageserver-protocol';

export const FindReferencesSchema = z.object({
  file_path: z.string().describe('File containing the symbol (relative to project root or absolute)'),
  line: z.number().int().min(1).describe('Line number of the symbol (1-based)'),
  column: z.number().int().min(1).describe('Column number of the symbol (1-based)'),
  include_declaration: z.boolean().optional().default(false).describe('Include the declaration itself in the results'),
  limit: z.number().int().min(1).max(500).optional().default(100).describe('Max results'),
});

type RefLocation = { uri: string; line: number; character: number };

function normalizeLocations(result: Location[] | LocationLink[] | null): RefLocation[] {
  if (!result) return [];
  return result.map((loc) => {
    if ('targetUri' in loc) {
      return { uri: loc.targetUri, line: loc.targetRange.start.line, character: loc.targetRange.start.character };
    }
    return { uri: loc.uri, line: loc.range.start.line, character: loc.range.start.character };
  });
}

export async function handleFindReferences(args: z.infer<typeof FindReferencesSchema>): Promise<string> {
  const { absPath, backend } = await requireBackend(args.file_path, 'references');
  await backend.client.openDocument(absPath);

  const params = {
    textDocument: { uri: fileToUri(absPath) },
    position: toLspPosition(args.line, args.column),
    context: { includeDeclaration: args.include_declaration },
  };

  // tsserver loads the project asynchronously after didOpen, so early requests
  // miss references in files that are not loaded yet. Run at least 3 attempts
  // before accepting a stable result set.
  let refs = normalizeLocations(
    await backend.client.request<Location[] | LocationLink[] | null>('textDocument/references', params)
  );
  for (let i = 1; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const next = normalizeLocations(
      await backend.client.request<Location[] | LocationLink[] | null>('textDocument/references', params)
    );
    const stable = JSON.stringify(next) === JSON.stringify(refs);
    refs = next;
    if (stable && i >= 3) break;
  }

  if (refs.length === 0) {
    return `No references found at ${args.file_path}:${args.line}:${args.column}`;
  }

  const fileCache = new Map<string, string[]>();
  const readLine = (abs: string, line0: number): string => {
    let lines = fileCache.get(abs);
    if (!lines) {
      try {
        lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/);
      } catch {
        lines = [];
      }
      fileCache.set(abs, lines);
    }
    return (lines[line0] ?? '').trim();
  };

  let output = `References (found ${refs.length}):\n`;
  for (const ref of refs.slice(0, args.limit)) {
    const abs = uriToFile(ref.uri);
    const rel = path.relative(config.projectRoot, abs).replace(/\\/g, '/');
    output += `\n  ${rel}:${ref.line + 1}:${ref.character + 1}\n     ${readLine(abs, ref.line)}\n`;
  }
  if (refs.length > args.limit) {
    output += `\n  ... and ${refs.length - args.limit} more references\n`;
  }

  return output;
}
