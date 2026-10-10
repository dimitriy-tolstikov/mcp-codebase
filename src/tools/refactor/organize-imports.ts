import { z } from 'zod';
import { requireBackend } from './common.js';
import { fileToUri } from '../../lsp/positions.js';
import { applyWorkspaceEdit } from '../../lsp/edits.js';
import type { CodeAction, WorkspaceEdit } from 'vscode-languageserver-protocol';

export const OrganizeImportsSchema = z.object({
  file_path: z.string().describe('File whose imports should be organized'),
  dryRun: z.boolean().optional().default(false).describe('If true, only report the edits without writing the file'),
});

interface MaybeCommand {
  title?: string;
  command?: string | { command: string; arguments?: unknown[] };
  edit?: WorkspaceEdit;
  kind?: string;
}

export async function handleOrganizeImports(args: z.infer<typeof OrganizeImportsSchema>): Promise<string> {
  const { absPath, backend } = await requireBackend(args.file_path, 'organize_imports');
  await backend.client.openDocument(absPath);
  const uri = fileToUri(absPath);

  const actions = await backend.client.request<(CodeAction | MaybeCommand)[] | null>('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [], only: ['source.organizeImports'] },
  });

  const action = (actions ?? []).find((a) =>
    a?.kind === 'source.organizeImports' || typeof a?.command === 'object' || typeof a?.command === 'string'
  );

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
    throw new Error(`organize imports not supported by ${backend.languageId} backend for this file (no source.organizeImports code action offered)`);
  }
  const report = await applyWorkspaceEdit(edit, { dryRun: args.dryRun });
  return `Organize imports:\n${report}`;
}
