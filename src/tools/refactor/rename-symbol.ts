import { z } from 'zod';
import { requireBackend } from './common.js';
import { fileToUri, toLspPosition } from '../../lsp/positions.js';
import { applyWorkspaceEdit } from '../../lsp/edits.js';
import type { WorkspaceEdit } from 'vscode-languageserver-protocol';

export const RenameSymbolSchema = z.object({
  file_path: z.string().describe('File containing the symbol (relative to project root or absolute)'),
  line: z.number().int().min(1).describe('Line number of the symbol (1-based)'),
  column: z.number().int().min(1).describe('Column number of the symbol (1-based)'),
  new_name: z.string().min(1).describe('New name for the symbol'),
  dryRun: z.boolean().optional().default(false).describe('If true, only report the edits without writing files'),
});

export async function handleRenameSymbol(args: z.infer<typeof RenameSymbolSchema>): Promise<string> {
  const { absPath, backend } = await requireBackend(args.file_path, 'rename');
  await backend.client.openDocument(absPath);

  // tsserver loads the project asynchronously after didOpen, so the first rename
  // can miss references in files that are not loaded yet. Retry until the edit
  // set stabilizes (rename is a read-only request).
  let edit = await requestRename(backend, absPath, args);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const next = await requestRename(backend, absPath, args);
    if (JSON.stringify(next) === JSON.stringify(edit)) break;
    edit = next;
  }

  if (!edit) {
    throw new Error(`rename not possible at ${args.file_path}:${args.line}:${args.column} (no symbol or rename refused by the server)`);
  }
  const report = await applyWorkspaceEdit(edit, { dryRun: args.dryRun });
  return `Rename to '${args.new_name}':\n${report}`;
}

async function requestRename(
  backend: { client: { request<R>(m: string, p: unknown): Promise<R> } },
  absPath: string,
  args: z.infer<typeof RenameSymbolSchema>
): Promise<WorkspaceEdit | null> {
  return backend.client.request<WorkspaceEdit | null>('textDocument/rename', {
    textDocument: { uri: fileToUri(absPath) },
    position: toLspPosition(args.line, args.column),
    newName: args.new_name,
  });
}
