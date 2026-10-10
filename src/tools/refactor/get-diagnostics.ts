import { z } from 'zod';
import path from 'path';
import { requireBackend } from './common.js';
import { config } from '../../config.js';
import { fileToUri, uriToFile } from '../../lsp/positions.js';
import { getStartedBackends } from '../../lsp/registry.js';
import type { Diagnostic } from 'vscode-languageserver-protocol';

const SEVERITY: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

export const GetDiagnosticsSchema = z.object({
  file_path: z.string().optional().describe('File to check (relative to project root or absolute). Omit for all diagnostics the server has published'),
  severity: z.enum(['error', 'warning', 'info', 'hint']).optional().describe('Minimum severity to include'),
});

const SEVERITY_ORDER: Record<string, number> = { error: 1, warning: 2, info: 3, hint: 4 };

function format(uri: string, d: Diagnostic): string {
  const rel = path.relative(config.projectRoot, uriToFile(uri)).replace(/\\/g, '/');
  const sev = SEVERITY[d.severity ?? 1] ?? 'error';
  const src = d.source ? ` (${d.source})` : '';
  return `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev} ${d.message}${src}`;
}

export async function handleGetDiagnostics(args: z.infer<typeof GetDiagnosticsSchema>): Promise<string> {
  const minSev = args.severity ? SEVERITY_ORDER[args.severity] : 4;
  const filter = (d: Diagnostic) => (d.severity ?? 1) <= minSev;

  if (args.file_path) {
    const { absPath, backend } = await requireBackend(args.file_path, 'diagnostics');
    await backend.client.openDocument(absPath);
    const uri = fileToUri(absPath);
    // Diagnostics arrive asynchronously via publishDiagnostics in several waves
    // (syntax first, semantic later) — wait the full window, then read the latest.
    await new Promise((r) => setTimeout(r, 2000));
    const diags = (backend.client.getDiagnostics(uri).get(uri) ?? []).filter(filter);
    if (diags.length === 0) return `No diagnostics for ${args.file_path}.`;
    return `Diagnostics for ${args.file_path} (${diags.length}):\n${diags.map((d) => format(uri, d)).join('\n')}`;
  }

  // Project-wide: report whatever the started servers have already published.
  if (!config.lsp.enabled) {
    throw new Error('LSP support disabled (LSP_ENABLED=false)');
  }
  const lines: string[] = [];
  for (const backend of getStartedBackends()) {
    for (const [uri, diags] of backend.client.getDiagnostics()) {
      for (const d of diags.filter(filter)) {
        lines.push(format(uri, d));
      }
    }
  }
  if (lines.length === 0) {
    return 'No stored diagnostics. Note: project-wide mode only reports diagnostics already published by running language servers; pass file_path to check a specific file.';
  }
  return `Stored diagnostics (${lines.length}):\n${lines.join('\n')}`;
}
