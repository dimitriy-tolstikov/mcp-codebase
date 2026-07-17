# Architecture

## Overview

```
        MCP host (AI agent)
               │  JSON-RPC over stdio
               ▼
        src/index.ts  ── Server (@modelcontextprotocol/sdk)
               │        TOOLS registry + zod validation
               ▼
        src/tools/*   ── one handler per tool, returns plain text
               │
               ▼
        src/db/repositories.ts ── SQL (parameterized)
               ▼
          PostgreSQL  (files / symbols / imports / exports)
               ▲
               │  batch upserts in transactions
        src/indexer/indexer.ts ── indexProject() / indexSingleFile()
               │
        src/indexer/file-crawler.ts  +  src/parsers/* (per-language AST/regex parsing)
               ▲
        src/indexer/watcher.ts (chokidar) ── reindex on file add/change
```

Two data paths exist:

1. **Indexing path**: crawl files under `PROJECT_ROOT` → parse → batch-insert into
   PostgreSQL. Runs on startup (when the DB is empty), on demand (`reindex` tool), and
   continuously (watcher).
2. **Query path**: MCP tool call → zod-validated args → SQL queries → plain-text response.

## Startup sequence

`main()` in `src/index.ts`:

1. `ensureDatabase()` (`src/db/schema.ts`) connects to the `postgres` system database and
   creates the target database (`PGDATABASE`, default `codebase_index`) if it does not exist.
2. `initSchema()` creates the `pg_trgm` extension, four tables, and their indexes — all with
   `IF NOT EXISTS`, so startup is idempotent.
3. If the `files` table is empty, a full initial index runs automatically
   (`indexProject({ full: true })`), with progress printed to stderr.
4. `startWatcher(config.projectRoot)` begins watching the target project.
5. The MCP server connects over `StdioServerTransport`.

Fatal startup errors are logged to stderr and exit with code 1. **Nothing may be written to
stdout** — the MCP protocol owns that channel; all logging uses `console.error`.

## Tool dispatch

- `ListToolsRequestSchema` returns the static `TOOLS` array (name, description, JSON Schema).
- `CallToolRequestSchema` switches on the tool name, validates `arguments` with the tool's
  zod schema, and calls the handler (`handle*` in `src/tools/<name>.ts`).
- Handlers return a plain-text string, wrapped as `{ content: [{ type: "text", text }] }`.
- Any thrown error (including zod validation failures) is caught and returned as
  `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }` — tool errors never
  crash the server.

## Indexing pipeline

`indexProject()` in `src/indexer/indexer.ts`:

1. **Ignore rules.** `loadGitignore(rootDir)` loads the target project's `.gitignore` (via the
   `ignore` package); `config.ignorePatterns` are added on top.
2. **Crawl.** `crawlFiles()` (`src/indexer/file-crawler.ts`) is a generator that walks the
   tree iteratively (explicit stack), skipping ignored paths, and yields `FileEntry`
   (`absolutePath`, `relativePath` with forward slashes, `extension`, `size`, `mtime`).
   Unreadable directories/files are skipped silently.
3. **Parse.** For each file, `getParserForExtension()` selects a parser from the
   `extToParser` registry. Files without a parser are still recorded in `files` (with zero
   symbols). Parse errors skip the file's symbols but not the file row.
4. **Batch flush.** Every `config.batchSize` (1000) files, `flushBatch()` writes one
   transaction:
   - `insertFilesBatch()` upserts file rows `ON CONFLICT (path) DO UPDATE` and returns a
     `path → id` map (`RETURNING id, path`).
   - Symbols/imports/exports are inserted in sub-batches of 500 rows to stay under
     PostgreSQL's parameter limit (65535).
5. **Full vs incremental.** `full: true` first runs `TRUNCATE files, symbols, imports,
   exports CASCADE`. `full: false` skips the truncate but still re-scans and re-upserts
   **every** file — `mtime` is recorded but never compared (see
   [Known limitations](development.md#known-limitations)).

### Single-file indexing

`indexSingleFile(absolutePath, rootDir)` — used by the watcher — runs one transaction:
`DELETE FROM files WHERE path = $1` (child rows cascade), then re-parse and re-insert.
Files with no registered parser are re-inserted as metadata-only rows.

## Watch mode

`startWatcher()` (`src/indexer/watcher.ts`) uses chokidar with:

- `ignored`: dotfiles, `node_modules`, `dist`, `build`, `*.min.js`, `*.map`
- `ignoreInitial: true`, `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }`

Handlers:

- `add` / `change` → `indexSingleFile()`, but only for the hardcoded extension allowlist
  `.ts .tsx .js .jsx .cs .mjs .cjs`. Successes and failures are logged to stderr.
- `unlink` → **only logs**. Deleted files stay in the index until a full reindex.

The watcher is a singleton; a second `startWatcher()` call is a no-op.

## Shutdown

`SIGINT` and `SIGTERM` both run `stopWatcher()` then `closePool()` and exit 0.
