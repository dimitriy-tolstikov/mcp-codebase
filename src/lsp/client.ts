import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  MessageConnection,
} from 'vscode-jsonrpc/node';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { config } from '../config.js';
import { fileToUri } from './positions.js';

export interface LspClientOptions {
  command: string;
  args: string[];
  languageId: string;
}

interface OpenDoc {
  version: number;
  content: string;
}

export class LspClient {
  private proc: ChildProcess | null = null;
  private connection: MessageConnection | null = null;
  private openDocs = new Map<string, OpenDoc>();
  private diagnosticsStore = new Map<string, Diagnostic[]>();
  private rootUri = '';

  constructor(private options: LspClientOptions) {}

  get languageId(): string {
    return this.options.languageId;
  }

  async initialize(rootUri: string): Promise<void> {
    if (this.connection) return;
    this.rootUri = rootUri;

    this.proc = spawn(this.options.command, this.options.args, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc.on('error', (err) => {
      console.error(`LSP process error (${this.options.command}): ${err.message}`);
    });

    this.connection = createMessageConnection(
      new StreamMessageReader(this.proc.stdout!),
      new StreamMessageWriter(this.proc.stdin!)
    );

    this.connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: { uri: string; diagnostics: Diagnostic[] }) => {
        this.diagnosticsStore.set(params.uri, params.diagnostics);
      }
    );

    this.connection.onClose(() => {
      this.connection = null;
      this.proc = null;
    });

    this.connection.listen();

    const initPromise = this.connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, willSave: false },
          rename: { prepareSupport: false },
          publishDiagnostics: { relatedInformation: true },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: [
                  'source.organizeImports',
                  'source.fixAll',
                  'refactor.extract',
                  'quickfix',
                ],
              },
            },
          },
        },
        workspace: {
          applyEdit: false,
          workspaceEdit: { documentChanges: false },
        },
      },
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
    });

    let rejectTimeout: (e: Error) => void = () => {};
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(
      () => rejectTimeout(new Error(`LSP initialize timed out after ${config.lsp.startupTimeoutMs}ms`)),
      config.lsp.startupTimeoutMs
    );
    try {
      await Promise.race([initPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
    await this.connection.sendNotification('initialized', {});
  }

  // Opens the document or syncs its content with disk. Always re-reads from disk
  // and sends didOpen (first time) or didChange with the full new content when it changed.
  async openDocument(absPath: string): Promise<void> {
    const uri = fileToUri(absPath);
    const content = fs.readFileSync(absPath, 'utf-8');
    const existing = this.openDocs.get(uri);

    if (!existing) {
      this.openDocs.set(uri, { version: 1, content });
      await this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.options.languageId, version: 1, text: content },
      });
      return;
    }
    if (existing.content !== content) {
      existing.version++;
      existing.content = content;
      await this.notify('textDocument/didChange', {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text: content }],
      });
    }
  }

  getDiagnostics(uri?: string): Map<string, Diagnostic[]> {
    if (uri !== undefined) {
      return new Map([[uri, this.diagnosticsStore.get(uri) ?? []]]);
    }
    return this.diagnosticsStore;
  }

  async request<R>(method: string, params: unknown): Promise<R> {
    if (!this.connection) throw new Error('LSP client is not initialized');
    const result = this.connection.sendRequest(method, params);
    let rejectTimeout: (e: Error) => void = () => {};
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(
      () => rejectTimeout(new Error(`LSP request '${method}' timed out after ${config.lsp.requestTimeoutMs}ms`)),
      config.lsp.requestTimeoutMs
    );
    try {
      return await Promise.race([result, timeout]) as R;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.connection) throw new Error('LSP client is not initialized');
    await this.connection.sendNotification(method, params);
  }

  getRootUri(): string {
    return this.rootUri;
  }

  async shutdown(): Promise<void> {
    if (!this.connection) return;
    const conn = this.connection;
    this.connection = null;
    try {
      await Promise.race([
        (async () => {
          await conn.sendRequest('shutdown');
          await conn.sendNotification('exit');
        })(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // ignore shutdown errors
    }
    try {
      conn.dispose();
    } catch {
      // ignore
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = null;
    this.openDocs.clear();
    this.diagnosticsStore.clear();
  }
}
