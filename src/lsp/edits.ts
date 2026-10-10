import fs from 'fs';
import path from 'path';
import type { WorkspaceEdit, TextEdit } from 'vscode-languageserver-protocol';
import { config } from '../config.js';
import { indexSingleFile } from '../indexer/indexer.js';
import { backendForFile } from './registry.js';
import { uriToFile, applyTextEdits } from './positions.js';

export interface ApplyEditOptions {
  dryRun?: boolean;
}

function editsByFile(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const byFile = new Map<string, TextEdit[]>();
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      byFile.set(uri, [...(byFile.get(uri) ?? []), ...edits]);
    }
  }
  // documentChanges (TextDocumentEdit form) is not expected — we declare
  // documentChanges: false in capabilities — but tolerate it if it shows up.
  const docChanges = (edit as { documentChanges?: unknown }).documentChanges;
  if (Array.isArray(docChanges)) {
    for (const dc of docChanges) {
      const tde = dc as { textDocument?: { uri: string }; edits?: TextEdit[] };
      if (tde.textDocument?.uri && Array.isArray(tde.edits)) {
        byFile.set(tde.textDocument.uri, [...(byFile.get(tde.textDocument.uri) ?? []), ...tde.edits]);
      }
    }
  }
  return byFile;
}

function previewDiff(oldContent: string, newContent: string, maxLines = 3): string[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const previews: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max && previews.length < maxLines; i++) {
    if (oldLines[i] !== newLines[i]) {
      previews.push(`  line ${i + 1}: ${JSON.stringify((newLines[i] ?? '').trim().slice(0, 120))}`);
    }
  }
  return previews;
}

export async function applyWorkspaceEdit(edit: WorkspaceEdit | null | undefined, opts: ApplyEditOptions = {}): Promise<string> {
  if (!edit) {
    return 'No edits returned by the language server.';
  }
  const byFile = editsByFile(edit);
  if (byFile.size === 0) {
    return 'No changes required (language server returned an empty edit).';
  }

  const lines: string[] = [];
  const changedFiles: string[] = [];

  for (const [uri, edits] of byFile) {
    const absPath = uriToFile(uri);
    const relPath = path.relative(config.projectRoot, absPath).replace(/\\/g, '/');
    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      lines.push(`${relPath}: skipped (file not readable)`);
      continue;
    }
    const newContent = applyTextEdits(content, edits);
    if (newContent === content) {
      lines.push(`${relPath}: no effective change`);
      continue;
    }
    lines.push(`${relPath}: ${edits.length} edit(s)`);
    lines.push(...previewDiff(content, newContent));
    if (!opts.dryRun) {
      fs.writeFileSync(absPath, newContent, 'utf-8');
      changedFiles.push(absPath);
    }
  }

  if (!opts.dryRun) {
    for (const absPath of changedFiles) {
      // Sync the new content back to the language server (didChange/didOpen)
      // so follow-up operations do not work on a stale view.
      try {
        const backend = backendForFile(absPath);
        if (backend) {
          try {
            await backend.client.openDocument(absPath);
          } catch {
            // backend not started — nothing to sync
          }
        }
      } catch (err) {
        console.error(`LSP sync after edit failed for ${absPath}: ${(err as Error).message}`);
      }
      try {
        await indexSingleFile(absPath, config.projectRoot);
      } catch (err) {
        console.error(`Reindex after edit failed for ${absPath}: ${(err as Error).message}`);
      }
    }
  }

  const header = opts.dryRun
    ? 'Dry run — no files were modified.'
    : `Applied edits to ${changedFiles.length} file(s) and reindexed them.`;
  return `${header}\n${lines.join('\n')}`;
}
