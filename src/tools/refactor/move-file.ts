import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { requireBackend } from './common.js';
import { config } from '../../config.js';
import { fileToUri, resolvePath } from '../../lsp/positions.js';
import { applyWorkspaceEdit } from '../../lsp/edits.js';
import { indexSingleFile, removeFileFromIndex } from '../../indexer/indexer.js';
import type { WorkspaceEdit } from 'vscode-languageserver-protocol';

export const MoveFileSchema = z.object({
  old_path: z.string().describe('Current file path (relative to project root or absolute)'),
  new_path: z.string().describe('Target file path (relative to project root or absolute)'),
  dryRun: z.boolean().optional().default(false).describe('If true, only report import updates without moving the file'),
});

export async function handleMoveFile(args: z.infer<typeof MoveFileSchema>): Promise<string> {
  const { absPath: oldAbs, backend } = await requireBackend(args.old_path, 'move_file');
  const newAbs = resolvePath(args.new_path);

  if (!fs.existsSync(oldAbs)) {
    throw new Error(`File not found: ${args.old_path}`);
  }
  if (fs.existsSync(newAbs)) {
    throw new Error(`Target already exists: ${args.new_path}`);
  }

  let report = '';

  if (backend.languageId === 'typescript') {
    // Ask tsserver (via typescript-language-server) for import updates caused by the rename.
    const edit = await backend.client.request<WorkspaceEdit | null>('workspace/executeCommand', {
      command: '_typescript.getEditsForFileRename',
      arguments: [
        {
          files: [{ oldUri: fileToUri(oldAbs), newUri: fileToUri(newAbs) }],
        },
      ],
    }).catch(() => null);
    if (edit) {
      report = await applyWorkspaceEdit(edit, { dryRun: args.dryRun });
    }
  } else {
    report =
      'Note: for C# files, namespace/using updates after a move are not guaranteed — ' +
      'only the file itself is moved. Verify with get_diagnostics afterwards.';
  }

  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(newAbs), { recursive: true });
    fs.renameSync(oldAbs, newAbs);
    try {
      await removeFileFromIndex(oldAbs, config.projectRoot);
      await indexSingleFile(newAbs, config.projectRoot);
    } catch (err) {
      console.error(`Reindex after move failed: ${(err as Error).message}`);
    }
  }

  const header = args.dryRun
    ? `Dry run — ${args.old_path} was NOT moved.`
    : `Moved ${args.old_path} → ${args.new_path} and updated the index.`;
  return report ? `${header}\n${report}` : header;
}
