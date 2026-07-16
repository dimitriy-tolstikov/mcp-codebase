import type { PoolClient } from 'pg';
import { query, withTransaction } from './connection.js';
import type { SymbolInfo, ImportInfo, ExportInfo } from '../parsers/interface.js';

export interface FileRecord {
  id?: number;
  path: string;
  extension: string;
  language: string;
  size: number;
  line_count: number;
  mtime: number;
}

export async function insertFilesBatch(client: PoolClient, files: FileRecord[]): Promise<Map<string, number>> {
  if (files.length === 0) return new Map();

  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const f of files) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
    values.push(f.path, f.extension, f.language, f.size, f.line_count, f.mtime);
    idx += 6;
  }

  const sql = `
    INSERT INTO files (path, extension, language, size, line_count, mtime)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (path) DO UPDATE SET
      extension = EXCLUDED.extension,
      language = EXCLUDED.language,
      size = EXCLUDED.size,
      line_count = EXCLUDED.line_count,
      mtime = EXCLUDED.mtime,
      indexed_at = NOW()
    RETURNING id, path
  `;

  const result = await client.query(sql, values);
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.path, row.id);
  }
  return map;
}

export async function deleteFileByPath(client: PoolClient, filePath: string): Promise<void> {
  await client.query('DELETE FROM files WHERE path = $1', [filePath]);
}

export async function insertSymbolsBatch(client: PoolClient, symbols: { fileId: number; info: SymbolInfo }[]): Promise<void> {
  if (symbols.length === 0) return;

  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const s of symbols) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8}, $${idx + 9})`);
    values.push(
      s.fileId,
      s.info.name,
      s.info.kind,
      s.info.lineStart,
      s.info.lineEnd,
      s.info.colStart,
      s.info.colEnd,
      s.info.signature || null,
      s.info.docstring || null,
      s.info.modifiers ? JSON.stringify(s.info.modifiers) : null
    );
    idx += 10;
  }

  await client.query(
    `INSERT INTO symbols (file_id, name, kind, line_start, line_end, col_start, col_end, signature, docstring, modifiers)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

export async function insertImportsBatch(client: PoolClient, imports: { fileId: number; info: ImportInfo }[]): Promise<void> {
  if (imports.length === 0) return;

  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const imp of imports) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3})`);
    values.push(
      imp.fileId,
      imp.info.source,
      imp.info.names ? JSON.stringify(imp.info.names) : null,
      imp.info.isTypeOnly || false
    );
    idx += 4;
  }

  await client.query(
    `INSERT INTO imports (file_id, source, names, is_type_only)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

export async function insertExportsBatch(client: PoolClient, exports: { fileId: number; info: ExportInfo }[]): Promise<void> {
  if (exports.length === 0) return;

  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const exp of exports) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
    values.push(
      exp.fileId,
      exp.info.name || null,
      exp.info.isDefault || false,
      exp.info.isReexport || false,
      exp.info.source || null
    );
    idx += 5;
  }

  await client.query(
    `INSERT INTO exports (file_id, name, is_default, is_reexport, source)
     VALUES ${placeholders.join(', ')}`,
    values
  );
}

export async function getFileByPath(path: string): Promise<{ id: number } | null> {
  const result = await query('SELECT id FROM files WHERE path = $1', [path]);
  return result.rows[0] || null;
}

export async function searchSymbols(
  opts: {
    query: string;
    kind?: string;
    language?: string;
    filePath?: string;
    limit: number;
    offset: number;
  }
): Promise<any[]> {
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  // Parse query for wildcards and pipes
  const parts = opts.query.split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const orConds = parts.map(() => {
      const v = `$${idx++}`;
      return `name ILIKE ${v}`;
    });
    conditions.push(`(${orConds.join(' OR ')})`);
    values.push(...parts.map(p => p.replace(/\*/g, '%').replace(/\?/g, '_')));
  } else {
    const q = parts[0];
    if (q.includes('*') || q.includes('?')) {
      conditions.push(`name ILIKE $${idx++}`);
      values.push(q.replace(/\*/g, '%').replace(/\?/g, '_'));
    } else {
      // Try exact, then prefix, then fuzzy
      conditions.push(`(name = $${idx} OR name ILIKE $${idx + 1} OR similarity(name, $${idx}) > 0.3)`);
      values.push(q, `${q}%`);
      idx += 2;
    }
  }

  if (opts.kind) {
    const kinds = opts.kind.split('|');
    conditions.push(`kind IN (${kinds.map(() => `$${idx++}`).join(',')})`);
    values.push(...kinds);
  }

  if (opts.language) {
    conditions.push(`f.language = $${idx++}`);
    values.push(opts.language);
  }

  if (opts.filePath) {
    conditions.push(`f.path ILIKE $${idx++}`);
    values.push(`%${opts.filePath}%`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT s.id, s.name, s.kind, s.line_start, s.line_end, s.signature, s.docstring, s.modifiers, f.path as file_path, f.language
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    ${whereClause}
    ORDER BY
      CASE WHEN s.name = $1 THEN 0 ELSE 1 END,
      similarity(s.name, $1) DESC,
      s.name
    LIMIT $${idx++} OFFSET $${idx++}
  `;
  values.push(opts.limit, opts.offset);

  const result = await query(sql, values);
  return result.rows;
}

export async function getSymbolById(id: number): Promise<any | null> {
  const result = await query(
    `SELECT s.*, f.path as file_path, f.language
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE s.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function getSymbolByNameAndPath(name: string, filePath: string): Promise<any | null> {
  const result = await query(
    `SELECT s.*, f.path as file_path, f.language
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE s.name = $1 AND f.path = $2
     LIMIT 1`,
    [name, filePath]
  );
  return result.rows[0] || null;
}

export async function getSymbolsInFile(fileId: number): Promise<any[]> {
  const result = await query(
    'SELECT * FROM symbols WHERE file_id = $1 ORDER BY line_start',
    [fileId]
  );
  return result.rows;
}

export async function getImportsInFile(fileId: number): Promise<any[]> {
  const result = await query(
    'SELECT * FROM imports WHERE file_id = $1',
    [fileId]
  );
  return result.rows;
}

export async function getExportsInFile(fileId: number): Promise<any[]> {
  const result = await query(
    'SELECT e.*, s.name as symbol_name FROM exports e LEFT JOIN symbols s ON e.symbol_id = s.id WHERE e.file_id = $1',
    [fileId]
  );
  return result.rows;
}

export async function getModuleStats(dirPath: string): Promise<any> {
  const fileResult = await query(
    `SELECT extension, COUNT(*) as count FROM files WHERE path LIKE $1 GROUP BY extension`,
    [`${dirPath}%`]
  );

  const symbolResult = await query(
    `SELECT s.name, s.kind, s.line_start, f.path
     FROM symbols s
     JOIN files f ON s.file_id = f.id
     WHERE f.path LIKE $1
     ORDER BY f.path, s.line_start
     LIMIT 50`,
    [`${dirPath}%`]
  );

  const importResult = await query(
    `SELECT i.source, COUNT(DISTINCT i.file_id) as file_count
     FROM imports i
     JOIN files f ON i.file_id = f.id
     WHERE f.path LIKE $1
     GROUP BY i.source
     ORDER BY file_count DESC
     LIMIT 10`,
    [`${dirPath}%`]
  );

  return {
    files: fileResult.rows,
    symbols: symbolResult.rows,
    topImports: importResult.rows,
  };
}
