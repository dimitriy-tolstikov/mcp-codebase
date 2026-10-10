import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { Position } from 'vscode-languageserver-protocol';
import { config } from '../config.js';

export function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(config.projectRoot, filePath);
}

export function fileToUri(absPath: string): string {
  return pathToFileURL(absPath).toString();
}

export function uriToFile(uri: string): string {
  return fileURLToPath(uri);
}

// Tool inputs are 1-based line / 1-based column; LSP positions are 0-based.
export function toLspPosition(line: number, character: number): Position {
  return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
}

// Byte/offset helpers for applying TextEdits to file contents.
export function offsetAt(content: string, position: Position): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + Math.min(position.character, (lines[position.line] ?? '').length);
}

export function applyTextEdits(content: string, edits: { range: { start: Position; end: Position }; newText: string }[]): string {
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });
  let result = content;
  for (const edit of sorted) {
    const start = offsetAt(result, edit.range.start);
    const end = offsetAt(result, edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}
