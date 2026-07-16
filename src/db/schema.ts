import { query, withClient } from './connection.js';

export async function ensureDatabase(): Promise<void> {
  // Connect to 'postgres' database to create our target DB if needed
  const pg = await import('pg');
  const tempPool = new pg.default.Pool({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: 'postgres',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    max: 1,
  });

  try {
    const dbName = process.env.PGDATABASE || 'codebase_index';
    const exists = await tempPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    if (exists.rowCount === 0) {
      await tempPool.query(`CREATE DATABASE "${dbName}"`);
      console.error(`Created database: ${dbName}`);
    }
  } finally {
    await tempPool.end();
  }
}

export async function initSchema(): Promise<void> {
  await query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  await query(`
    CREATE TABLE IF NOT EXISTS files (
      id SERIAL PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      extension TEXT,
      language TEXT,
      size INTEGER,
      line_count INTEGER,
      mtime BIGINT,
      indexed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_files_lang ON files(language)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_files_path ON files USING hash(path)`);

  await query(`
    CREATE TABLE IF NOT EXISTS symbols (
      id SERIAL PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      col_start INTEGER,
      col_end INTEGER,
      signature TEXT,
      docstring TEXT,
      modifiers TEXT
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_symbols_name_trgm ON symbols USING gin (name gin_trgm_ops)`);

  await query(`
    CREATE TABLE IF NOT EXISTS imports (
      id SERIAL PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      names TEXT,
      is_type_only BOOLEAN DEFAULT FALSE
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS exports (
      id SERIAL PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      name TEXT,
      is_default BOOLEAN DEFAULT FALSE,
      is_reexport BOOLEAN DEFAULT FALSE,
      source TEXT
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_exports_file ON exports(file_id)`);

  console.error('Schema initialized');
}
