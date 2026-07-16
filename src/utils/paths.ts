import path from 'path';

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function getExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext;
}

export function relativePath(from: string, to: string): string {
  return normalizePath(path.relative(from, to));
}
