import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

interface ToolStat {
  calls: number;
  errors: number;
}

const stats = new Map<string, ToolStat>();

function ensure(name: string): ToolStat {
  let s = stats.get(name);
  if (!s) {
    s = { calls: 0, errors: 0 };
    stats.set(name, s);
  }
  return s;
}

export function recordCall(name: string): void {
  ensure(name).calls++;
}

export function recordError(name: string, err: unknown, args: unknown): void {
  ensure(name).errors++;
  const e = err as Error;
  try {
    const logPath = process.env.MCP_ERROR_LOG || path.join(config.projectRoot, '.mcp-codebase-errors.log');
    const line = [
      new Date().toISOString(),
      name,
      safeJson(args),
      e?.message ?? String(err),
      (e?.stack ?? '').replace(/\n/g, ' | '),
    ].join('\t');
    fs.appendFileSync(logPath, line + '\n', 'utf-8');
  } catch {
    // never crash the server over logging
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '<unserializable>';
  }
}

export function getStats(): Map<string, ToolStat> {
  return stats;
}
