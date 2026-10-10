import { z } from 'zod';
import { requireBackend } from './common.js';
import { fileToUri } from '../../lsp/positions.js';
import { applyWorkspaceEdit } from '../../lsp/edits.js';
import type { CodeAction, WorkspaceEdit } from 'vscode-languageserver-protocol';

export const FixAllSchema = z.object({
  file_path: z.string().describe('File to fix'),
  dryRun: z.boolean().optional().default(false).describe('If true, only report the edits without writing the file'),
});

interface MaybeCommand {
  title?: string;
  command?: string | { command: string; arguments?: unknown[] };
  edit?: WorkspaceEdit;
  kind?: string;
}

export async function handleFixAll(args: z.infer<typeof FixAllSchema>): Promise<string> {
  const { absPath, backend } = await requireBackend(args.file_path, 'fix_all');
  await backend.client.openDocument(absPath);
  const uri = fileToUri(absPath);

  // Wait briefly for diagnostics so source.fixAll has something to work on.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (backend.client.getDiagnostics(uri).has(uri)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const diagnostics = backend.client.getDiagnostics(uri).get(uri) ?? [];

  const actions = await backend.client.request<(CodeAction | MaybeCommand)[] | null>('textDocument/codeAction', {
    textDocument: { uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: Number.MAX_SAFE_INTEGER, character: 0 },
    },
    context: { diagnostics, only: ['source.fixAll'] },
  });

  const action = (actions ?? [])[0];

  let edit: WorkspaceEdit | null | undefined = action?.edit;
  if (!edit && action?.command) {
    const cmd = typeof action.command === 'string' ? action.command : action.command.command;
    const cmdArgs = typeof action.command === 'object' ? action.command.arguments : undefined;
    edit = await backend.client.request<WorkspaceEdit | null>('workspace/executeCommand', {
      command: cmd,
      arguments: cmdArgs,
    }).catch(() => null);
  }

  if (!edit) {
    if (diagnostics.length === 0) {
      return 'Nothing to fix: no diagnostics reported for this file.';
    }
    throw new Error(`fix all not supported by ${backend.languageId} backend for this file (no source.fixAll code action offered)`);
  }
  const report = await applyWorkspaceEdit(edit, { dryRun: args.dryRun });
  return `Fix all auto-fixable diagnostics:\n${report}`;
}
