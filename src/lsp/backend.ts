import type { LspClient } from './client.js';

export type RefactorOp =
  | 'rename'
  | 'move_file'
  | 'organize_imports'
  | 'fix_all'
  | 'extract_method'
  | 'diagnostics'
  | 'references'
  | 'definition';

export interface ILspBackend {
  readonly languageId: string;
  readonly extensions: string[];
  readonly capabilities: Set<RefactorOp>;
  ensureStarted(): Promise<void>;
  readonly client: LspClient;
}
