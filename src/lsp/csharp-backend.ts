import { execFile } from 'child_process';
import { pathToFileURL } from 'url';
import { LspClient } from './client.js';
import type { ILspBackend, RefactorOp } from './backend.js';
import { config } from '../config.js';

function checkAvailable(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, ['--version'], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        reject(
          new Error(
            `C# language server not available: '${cmd}' could not be executed (${err.message}). ` +
              `Install the .NET SDK and the csharp-ls dotnet tool, or set CSHARPLS_CMD to its path. ` +
              `C# refactoring tools are unavailable; the rest of the server keeps working.`
          )
        );
        return;
      }
      void stdout;
      resolve();
    });
  });
}

export class CSharpBackend implements ILspBackend {
  readonly languageId = 'csharp';
  readonly extensions = ['.cs'];
  readonly capabilities: Set<RefactorOp> = new Set([
    'rename',
    'move_file',
    'diagnostics',
    'organize_imports',
    'fix_all',
    'extract_method',
  ]);

  private lspClient: LspClient | null = null;

  get client(): LspClient {
    if (!this.lspClient) throw new Error('C# LSP backend not started');
    return this.lspClient;
  }

  async ensureStarted(): Promise<void> {
    if (this.lspClient) return;
    await checkAvailable(config.lsp.csharpLsCmd);
    const client = new LspClient({
      command: config.lsp.csharpLsCmd,
      args: [],
      languageId: 'csharp',
    });
    await client.initialize(pathToFileURL(config.projectRoot).toString());
    this.lspClient = client;
  }
}
