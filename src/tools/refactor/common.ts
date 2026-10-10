import { config } from '../../config.js';
import { backendForFile } from '../../lsp/registry.js';
import type { ILspBackend, RefactorOp } from '../../lsp/backend.js';
import { resolvePath } from '../../lsp/positions.js';

export async function requireBackend(filePath: string, op: RefactorOp): Promise<{ absPath: string; backend: ILspBackend }> {
  if (!config.lsp.enabled) {
    throw new Error('LSP support disabled (LSP_ENABLED=false)');
  }
  const absPath = resolvePath(filePath);
  const backend = backendForFile(absPath);
  if (!backend) {
    throw new Error(`no LSP backend for this file type: ${filePath}`);
  }
  if (!backend.capabilities.has(op)) {
    throw new Error(`operation '${op}' not supported by ${backend.languageId} backend`);
  }
  await backend.ensureStarted();
  return { absPath, backend };
}
