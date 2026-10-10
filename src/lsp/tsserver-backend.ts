import path from 'path';
import { fileURLToPath } from 'url';
import { LspClient } from './client.js';
import type { ILspBackend, RefactorOp } from './backend.js';
import { config } from '../config.js';
import { pathToFileURL } from 'url';

function defaultTsserverCmd(): string {
  if (config.lsp.tsserverCmd) return config.lsp.tsserverCmd;
  // Resolve the bundled typescript-language-server from this package's node_modules
  const here = path.dirname(fileURLToPath(import.meta.url));
  const localBin = path.resolve(here, '../../node_modules/.bin/typescript-language-server');
  return localBin;
}

export class TsserverBackend implements ILspBackend {
  readonly languageId = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];
  readonly capabilities: Set<RefactorOp> = new Set([
    'rename',
    'move_file',
    'organize_imports',
    'fix_all',
    'extract_method',
    'diagnostics',
  ]);

  private lspClient: LspClient | null = null;

  get client(): LspClient {
    if (!this.lspClient) throw new Error('TypeScript LSP backend not started');
    return this.lspClient;
  }

  async ensureStarted(): Promise<void> {
    if (this.lspClient) return;
    const client = new LspClient({
      command: defaultTsserverCmd(),
      args: ['--stdio'],
      languageId: 'typescript',
    });
    await client.initialize(pathToFileURL(config.projectRoot).toString());
    this.lspClient = client;
  }
}
