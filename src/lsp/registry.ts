import path from 'path';
import type { ILspBackend } from './backend.js';
import { TsserverBackend } from './tsserver-backend.js';
import { CSharpBackend } from './csharp-backend.js';

let tsBackend: TsserverBackend | null = null;
let csBackend: CSharpBackend | null = null;

export function backendForFile(absPath: string): ILspBackend | undefined {
  const ext = path.extname(absPath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'].includes(ext)) {
    if (!tsBackend) tsBackend = new TsserverBackend();
    return tsBackend;
  }
  if (ext === '.cs') {
    if (!csBackend) csBackend = new CSharpBackend();
    return csBackend;
  }
  return undefined;
}

function allBackends(): ILspBackend[] {
  const result: ILspBackend[] = [];
  if (tsBackend) result.push(tsBackend);
  if (csBackend) result.push(csBackend);
  return result;
}

// Backends that have actually been started (client initialized) — for
// project-wide diagnostics collection without spinning up new servers.
export function getStartedBackends(): ILspBackend[] {
  return allBackends().filter((b) => {
    try {
      b.client;
      return true;
    } catch {
      return false;
    }
  });
}

export async function shutdownAll(): Promise<void> {
  await Promise.all(
    allBackends().map(async (b) => {
      try {
        await b.client.shutdown();
      } catch {
        // backend was never started or already dead
      }
    })
  );
  tsBackend = null;
  csBackend = null;
}
