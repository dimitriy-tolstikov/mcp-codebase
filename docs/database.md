# Database

PostgreSQL 14+ is the only store. Requires the `pg_trgm` extension (created automatically
by `initSchema()`) for fuzzy symbol search.

Code: `src/db/connection.ts` (pool + helpers), `src/db/schema.ts` (DDL),
`src/db/repositories.ts` (all queries).

## Connection helpers (`connection.ts`)

- `getPool()` — lazily creates the singleton `pg.Pool` (see
  [configuration.md](configuration.md#connection-pool) for pool settings).
- `query(sql, params?)` — one-off query on the pool.
- `withClient(fn)` — checked-out client, always released.
- `withTransaction(fn)` — `BEGIN` / `COMMIT` / `ROLLBACK` wrapper. All index writes go
  through this.
- `closePool()` — used on shutdown.

All SQL is parameterized (`$1`, `$2`, ...). Never interpolate values into query strings.
The single exception is `CREATE DATABASE "<name>"` in `ensureDatabase()`, where the name
comes from env — there is no parameter support for identifiers.

## Schema (`schema.ts`)

`initSchema()` uses `IF NOT EXISTS` everywhere — additive only, no migration framework.

### `files` — one row per crawled file (including unparseable ones)

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | |
| `path` | `TEXT UNIQUE NOT NULL` | Path relative to `PROJECT_ROOT`, forward slashes |
| `extension` | `TEXT` | Lowercase, with dot (`.ts`) |
| `language` | `TEXT` | From parser result, or extension without dot |
| `size` | `INTEGER` | Bytes |
| `line_count` | `INTEGER` | 0 for unparsed files |
| `mtime` | `BIGINT` | `mtimeMs`, floored. Recorded but never compared |
| `indexed_at` | `TIMESTAMP DEFAULT NOW()` | Refreshed on every upsert |

Indexes: `idx_files_ext` (extension), `idx_files_lang` (language),
`idx_files_path` (**hash** on path).

### `symbols` — one row per parsed symbol

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | Used by `get_symbol_details` / `find_usages` |
| `file_id` | `INTEGER → files(id) ON DELETE CASCADE` | |
| `name` | `TEXT NOT NULL` | |
| `kind` | `TEXT NOT NULL` | One of the `SymbolKind` values (see [parsers.md](parsers.md)) |
| `line_start`, `line_end` | `INTEGER` | 1-based lines |
| `col_start`, `col_end` | `INTEGER` | 0-based columns |
| `signature` | `TEXT`, nullable | First line of the declaration |
| `docstring` | `TEXT`, nullable | JSDoc / XML-doc summary |
| `modifiers` | `TEXT`, nullable | JSON array string, e.g. `["export","async"]` |

Indexes: `idx_symbols_name` (btree), `idx_symbols_kind`, `idx_symbols_file`,
`idx_symbols_name_trgm` — **GIN** on `name gin_trgm_ops`, powers `similarity()`.

### `imports`

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | |
| `file_id` | `INTEGER → files(id) ON DELETE CASCADE` | |
| `source` | `TEXT NOT NULL` | Module specifier as written (`./foo.js`, `react`, C# namespace) |
| `names` | `TEXT`, nullable | JSON array of imported names; `* as ns` for namespace imports |
| `is_type_only` | `BOOLEAN DEFAULT FALSE` | `import type ...` |

Indexes: `idx_imports_source`, `idx_imports_file`.

### `exports`

| Column | Type | Notes |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | |
| `file_id` | `INTEGER → files(id) ON DELETE CASCADE` | |
| `symbol_id` | `INTEGER → symbols(id) ON DELETE SET NULL` | Nullable; currently never set by the indexer |
| `name` | `TEXT`, nullable | |
| `is_default` | `BOOLEAN DEFAULT FALSE` | |
| `is_reexport` | `BOOLEAN DEFAULT FALSE` | |
| `source` | `TEXT`, nullable | Module specifier for re-exports |

Indexes: `idx_exports_file`.

## Write path (`repositories.ts`)

- `insertFilesBatch(client, files)` — multi-row `INSERT ... ON CONFLICT (path) DO UPDATE`,
  returns `Map<path, id>` via `RETURNING`. Also refreshes `indexed_at`.
- `deleteFileByPath(client, path)` — cascades to symbols/imports/exports.
- `insertSymbolsBatch` / `insertImportsBatch` / `insertExportsBatch` — plain multi-row
  inserts; `modifiers` / `names` are `JSON.stringify`-ed. Callers sub-batch at 500 rows
  (PostgreSQL parameter limit).

Symbols/imports/exports have **no upsert** — correctness relies on the caller deleting or
truncating first (`indexSingleFile` deletes; full reindex truncates). A bare incremental
`indexProject({ full: false })` re-inserts file rows via upsert but appends child rows,
which can duplicate symbols — see [Known limitations](development.md#known-limitations).

## Read path

- `searchSymbols(opts)` — powers the `search_symbols` tool:
  - Query split on `|` → OR of `name ILIKE` patterns. `*` → `%`, `?` → `_`.
  - Single pattern without wildcards → `name = $q OR name ILIKE '$q%' OR
    similarity(name, $q) > 0.3`.
  - Optional filters: `kind IN (...)` (split on `|`), `f.language = ...`,
    `f.path ILIKE '%...%'`.
  - Ranking: exact match of the raw query first, then `similarity(name, query)` DESC,
    then name. `LIMIT`/`OFFSET` pagination.
- `getSymbolById(id)`, `getSymbolByNameAndPath(name, path)` — symbol + file path/language.
- `getSymbolsInFile(fileId)` — ordered by `line_start`.
- `getImportsInFile(fileId)`, `getExportsInFile(fileId)` — exports join `symbols` for
  `symbol_name`.
- `getModuleStats(dirPath)` — `explore_module` data: file counts by extension, first 50
  symbols, top 10 import sources by distinct-file count. All match `path LIKE '<dir>%'`.
- `getFileByPath(path)` — id lookup used by `get_module_dependencies`.

## Lifecycle notes

- **Startup**: `ensureDatabase()` creates the DB if missing; `initSchema()` creates
  extension/tables/indexes; an empty `files` table triggers a full initial index.
- **Full reindex**: `TRUNCATE files, symbols, imports, exports CASCADE`, then re-crawl.
- **Watcher updates**: delete file row (cascade) + re-insert, in one transaction.
- **Deleted files** are never removed (watcher `unlink` only logs) — they persist until a
  full reindex.
