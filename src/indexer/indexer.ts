import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { loadGitignore } from '../utils/gitignore.js';
import { crawlFiles, type FileEntry } from './file-crawler.js';
import { TypeScriptParser } from '../parsers/typescript.js';
import { CSharpParser } from '../parsers/csharp.js';
import type { ILanguageParser, ParseResult } from '../parsers/interface.js';
import { withTransaction } from '../db/connection.js';
import {
  insertFilesBatch,
  insertSymbolsBatch,
  insertImportsBatch,
  insertExportsBatch,
  deleteFileByPath,
} from '../db/repositories.js';

const parsers: Map<string, ILanguageParser> = new Map();
const extToParser: Map<string, ILanguageParser> = new Map();

function registerParser(parser: ILanguageParser) {
  parsers.set(parser.languageId, parser);
  for (const ext of parser.supportedExtensions) {
    extToParser.set(ext, parser);
  }
}

registerParser(new TypeScriptParser());
registerParser(new CSharpParser());

export function getParserForExtension(ext: string): ILanguageParser | undefined {
  return extToParser.get(ext);
}

export interface IndexStats {
  scanned: number;
  parsed: number;
  symbols: number;
  imports: number;
  exports: number;
  durationMs: number;
}

export async function indexProject(options?: { full?: boolean; rootDir?: string }): Promise<IndexStats> {
  const rootDir = options?.rootDir || config.projectRoot;
  const full = options?.full ?? true;
  const start = Date.now();

  const ig = loadGitignore(rootDir);
  for (const p of config.ignorePatterns) {
    ig.add(p);
  }

  const stats: IndexStats = {
    scanned: 0,
    parsed: 0,
    symbols: 0,
    imports: 0,
    exports: 0,
    durationMs: 0,
  };

  const files: FileEntry[] = [];
  for (const entry of crawlFiles(rootDir, ig, config.ignorePatterns)) {
    files.push(entry);
  }
  stats.scanned = files.length;

  if (full) {
    // Truncate all tables for full reindex
    await withTransaction(async (client) => {
      await client.query('TRUNCATE files, symbols, imports, exports CASCADE');
    });
  }

  // Process in batches
  const batchSize = config.batchSize;
  let batch: { entry: FileEntry; result: ParseResult | null }[] = [];

  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const parser = getParserForExtension(entry.extension);
    let result: ParseResult | null = null;

    if (parser) {
      try {
        const content = fs.readFileSync(entry.absolutePath, 'utf-8');
        const lineCount = content.split(/\r?\n/).length;
        result = parser.parse(entry.absolutePath, content);
        if (result) {
          stats.parsed++;
          stats.symbols += result.symbols.length;
          stats.imports += result.imports.length;
          stats.exports += result.exports.length;
        }
        batch.push({ entry: { ...entry, lineCount }, result });
      } catch {
        // Skip unreadable files
        batch.push({ entry: { ...entry, lineCount: 0 }, result: null });
      }
    } else {
      batch.push({ entry, result: null });
    }

    if (batch.length >= batchSize || i === files.length - 1) {
      await flushBatch(rootDir, batch);
      batch = [];
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

async function flushBatch(
  rootDir: string,
  batch: { entry: FileEntry & { lineCount?: number }; result: ParseResult | null }[]
): Promise<void> {
  await withTransaction(async (client) => {
    const fileRecords = batch.map((b) => ({
      path: b.entry.relativePath,
      extension: b.entry.extension,
      language: b.result?.language || b.entry.extension.replace('.', ''),
      size: b.entry.size,
      line_count: b.entry.lineCount || 0,
      mtime: Math.floor(b.entry.mtime),
    }));

    const fileMap = await insertFilesBatch(client, fileRecords);

    const allSymbols: { fileId: number; info: any }[] = [];
    const allImports: { fileId: number; info: any }[] = [];
    const allExports: { fileId: number; info: any }[] = [];

    for (const item of batch) {
      const fileId = fileMap.get(item.entry.relativePath);
      if (!fileId || !item.result) continue;

      for (const sym of item.result.symbols) {
        allSymbols.push({ fileId, info: sym });
      }
      for (const imp of item.result.imports) {
        allImports.push({ fileId, info: imp });
      }
      for (const exp of item.result.exports) {
        allExports.push({ fileId, info: exp });
      }
    }

    // Insert in smaller sub-batches to avoid parameter limit
    const subBatch = 500;
    for (let i = 0; i < allSymbols.length; i += subBatch) {
      await insertSymbolsBatch(client, allSymbols.slice(i, i + subBatch));
    }
    for (let i = 0; i < allImports.length; i += subBatch) {
      await insertImportsBatch(client, allImports.slice(i, i + subBatch));
    }
    for (let i = 0; i < allExports.length; i += subBatch) {
      await insertExportsBatch(client, allExports.slice(i, i + subBatch));
    }
  });
}

export async function indexSingleFile(absolutePath: string, rootDir: string): Promise<void> {
  const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, '/');
  const ext = path.extname(absolutePath).toLowerCase();
  const parser = getParserForExtension(ext);

  await withTransaction(async (client) => {
    await deleteFileByPath(client, relativePath);

    if (!parser) {
      // Still insert as unindexed file
      const stat = fs.statSync(absolutePath);
      await insertFilesBatch(client, [{
        path: relativePath,
        extension: ext,
        language: ext.replace('.', ''),
        size: stat.size,
        line_count: 0,
        mtime: Math.floor(stat.mtimeMs),
      }]);
      return;
    }

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const lineCount = content.split(/\r?\n/).length;
    const result = parser.parse(absolutePath, content);

    const fileMap = await insertFilesBatch(client, [{
      path: relativePath,
      extension: ext,
      language: result?.language || ext.replace('.', ''),
      size: fs.statSync(absolutePath).size,
      line_count: lineCount,
      mtime: Math.floor(fs.statSync(absolutePath).mtimeMs),
    }]);

    const fileId = fileMap.get(relativePath);
    if (!fileId || !result) return;

    await insertSymbolsBatch(client, result.symbols.map((s) => ({ fileId, info: s })));
    await insertImportsBatch(client, result.imports.map((i) => ({ fileId, info: i })));
    await insertExportsBatch(client, result.exports.map((e) => ({ fileId, info: e })));
  });
}
