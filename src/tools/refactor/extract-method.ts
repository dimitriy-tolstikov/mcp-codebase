import { z } from 'zod';
import { requireBackend } from './common.js';
import { fileToUri, toLspPosition } from '../../lsp/positions.js';
import { applyWorkspaceEdit } from '../../lsp/edits.js';
import type { CodeAction, WorkspaceEdit } from 'vscode-languageserver-protocol';

export const ExtractMethodSchema = z.object({
  file_path: z.string().describe('File containing the code to extract'),
  start_line: z.number().int().min(1).describe('First line of the range to extract (1-based)'),
  end_line: z.number().int().min(1).describe('Last line of the range to extract (1-based)'),
  new_name: z.string().min(1).describe('Name for the extracted method/function'),
  dryRun: z.boolean().optional().default(false).describe('If true, only report the edits without writing the file'),
});

interface MaybeCommand {
  title?: string;
  command?: string | { command: string; arguments?: unknown[] };
  edit?: WorkspaceEdit;
  kind?: string;
}

export async function handleExtractMethod(args: z.infer<typeof ExtractMethodSchema>): Promise<string> {
  const { absPath, backend } = await requireBackend(args.file_path, 'extract_method');
  await backend.client.openDocument(absPath);
  const uri = fileToUri(absPath);

  const range = {
    start: toLspPosition(args.start_line, 1),
    end: toLspPosition(args.end_line, Number.MAX_SAFE_INTEGER),
  };

  const actions = await backend.client.request<(CodeAction | MaybeCommand)[] | null>('textDocument/codeAction', {
    textDocument: { uri },
    range,
    context: { diagnostics: [], only: ['refactor.extract'] },
  });

  const candidates = (actions ?? []).filter((a) => (a?.kind ?? '').startsWith('refactor.extract'));
  if (candidates.length === 0) {
    throw new Error(`refactoring not available at this position (${args.file_path}:${args.start_line}-${args.end_line})`);
  }

  // Prefer a function/method extraction action.
  const action =
    candidates.find((a) => /function|method/i.test(a.title ?? '')) ?? candidates[0];

  let edit: WorkspaceEdit | null | undefined = action.edit;
  if (!edit && action.command) {
    const cmdObj = typeof action.command === 'string'
      ? { command: action.command, arguments: undefined as unknown[] | undefined }
      : action.command;
    // typescript-language-server's _typescript.applyRefactoring is interactive about
    // the new name; pass it when the argument shape allows it.
    const cmdArgs = (cmdObj.arguments ?? []).map((a: unknown) => {
      if (a && typeof a === 'object' && 'interactiveRefactorArguments' in (a as Record<string, unknown>)) {
        return { ...(a as Record<string, unknown>), interactiveRefactorArguments: { newName: args.new_name } };
      }
      return a;
    });
    edit = await backend.client.request<WorkspaceEdit | null>('workspace/executeCommand', {
      command: cmdObj.command,
      arguments: cmdArgs,
    }).catch(() => null);
  }

  if (!edit) {
    throw new Error(
      `extract refactoring requires an interactive name prompt the language server cannot fulfill non-interactively; ` +
        `rename the extracted symbol '${args.new_name}' manually afterwards, or use rename_symbol after applying`
    );
  }
  const report = await applyWorkspaceEdit(edit, { dryRun: args.dryRun });
  return `Extract '${args.new_name}' (action: ${action.title ?? 'refactor.extract'}):\n${report}`;
}
