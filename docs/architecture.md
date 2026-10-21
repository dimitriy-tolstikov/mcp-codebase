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
        src/indexer/watcher.ts (chokidar) ── reindex on add/change, delete on unlink
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
- `CallToolRequestSchema` looks the tool up in the `TOOL_HANDLERS` map (name → zod schema +
  handler), validates `arguments`, and calls the handler (`handle*` in `src/tools/<name>.ts`
  or `src/tools/refactor/<name>.ts`).
- Telemetry is centralized in the dispatcher (`src/utils/stats.ts`): on success
  `recordCall(name)` increments an in-memory counter; on a thrown error
  `recordError(name, err, args)` increments the error counter and appends a line
  (timestamp, tool, JSON args, message, stack) to the error log (`MCP_ERROR_LOG`, default
  `<PROJECT_ROOT>/.mcp-codebase-errors.log`). Logging failures never crash the server.
  The `get_tool_stats` tool exposes the counters as a plain-text table.
- Handlers return a plain-text string, wrapped as `{ content: [{ type: "text", text }] }`.
- Any thrown error (including zod validation failures) is caught and returned as
  `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }` — tool errors never
  crash the server.

## LSP layer

`src/lsp/` adds semantic, language-server-backed operations on top of (and independent of)
the AST indexing pipeline:

- `client.ts` — `LspClient`: spawns a language server over stdio and speaks JSON-RPC via
  `vscode-jsonrpc` (`createMessageConnection` with `StreamMessageReader/Writer`). Handles
  `initialize`/`initialized`, `didOpen`/`didChange` (always full-content sync from disk),
  stores `publishDiagnostics` per URI, applies `LSP_STARTUP_TIMEOUT_MS` /
  `LSP_REQUEST_TIMEOUT_MS`, and shuts the server down gracefully.
- `backend.ts` — `ILspBackend`: `languageId`, `extensions`, `capabilities`
  (a `Set` of `rename | move_file | organize_imports | fix_all | extract_method |
  diagnostics | references | definition`), `ensureStarted()`, `client`.
- `tsserver-backend.ts` — spawns `typescript-language-server --stdio` (resolved from this
  package's `node_modules/.bin`, overridable via `TSSERVER_CMD`).
- `csharp-backend.ts` — spawns `csharp-ls` (`CSHARPLS_CMD`); checks availability with
  `--version` first and throws a friendly install-the-.NET-SDK error if missing. The MCP
  server keeps running — the error surfaces as an `isError` tool response.
- `registry.ts` — `backendForFile(absPath)` returns the lazily-created singleton backend
  per extension; `getStartedBackends()` for project-wide diagnostics; `shutdownAll()` is
  called from the SIGINT/SIGTERM handlers.
- `edits.ts` — `applyWorkspaceEdit(edit, { dryRun })`: applies `TextEdit`s per file by
  reading the file, applying edits sorted from end-of-file backwards (offsets never shift),
  writing back; then syncs changed documents to the LSP server and reindexes each changed
  file via `indexSingleFile()`. Returns a human-readable per-file report (edit count +
  preview of first changed lines). `dryRun` computes the same report without writing.
- `positions.ts` — path ↔ `file://` URI conversion, 1-based tool line/column → 0-based LSP
  positions, and offset arithmetic for applying `TextEdit`s.

Backends are **lazy**: no language server starts at MCP server startup — only on the first
refactoring tool call for a file of that language. `LSP_ENABLED=false` disables the whole
layer (tools return a text error).

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
   - The batch's file paths are deleted first (`DELETE FROM files WHERE path = ANY(...)`),
     cascading to symbols/imports/exports — re-indexing a file never duplicates child rows.
   - `insertFilesBatch()` upserts file rows `ON CONFLICT (path) DO UPDATE` and returns a
     `path → id` map (`RETURNING id, path`).
   - Symbols/imports are inserted in sub-batches of 500 rows to stay under PostgreSQL's
     parameter limit (65535). Exports are inserted last, each linked to its symbol
     (`exports.symbol_id`) via a `file_id + name` lookup when it resolves.
5. **Full vs incremental.** `full: true` first runs `TRUNCATE files, symbols, imports,
   exports CASCADE`. `full: false` (incremental) loads the stored `path → mtime` map,
   skips files whose mtime is unchanged (`stats.skipped`), deletes rows for files that no
   longer exist on disk (`stats.removed`), and indexes only new or changed files.

### Single-file indexing

`indexSingleFile(absolutePath, rootDir)` — used by the watcher — runs one transaction:
`DELETE FROM files WHERE path = $1` (child rows cascade), then re-parse and re-insert
(including export → symbol linking). Files with no registered parser are re-inserted as
metadata-only rows. `removeFileFromIndex(absolutePath, rootDir)` performs the delete-only
half for files removed from disk.

## Watch mode

`startWatcher()` (`src/indexer/watcher.ts`) uses chokidar with:

- `ignored`: dotfiles, `node_modules`, `dist`, `build`, `*.min.js`, `*.map` — as regexes
  matching at any nesting depth (chokidar v4 has no glob support)
- `ignoreInitial: true`, `awaitWriteFinish: { stabilityThreshold: config.watchDebounceMs`
  (300 ms), `pollInterval: 100 }`

Handlers:

- `add` / `change` → `indexSingleFile()`, but only for extensions listed in
  `config.languageMap`. Successes and failures are logged to stderr.
- `unlink` → `removeFileFromIndex()` deletes the file row (children cascade), so deleted
  files disappear from the index immediately.
- `error` → logged to stderr; watcher errors (e.g. `ENOSPC` inotify limits) never crash
  the server.

The watcher is a singleton; a second `startWatcher()` call is a no-op.

## Shutdown

`SIGINT` and `SIGTERM` both run `stopWatcher()`, then `shutdownAll()` (graceful shutdown of
any started language servers), then `closePool()`, and exit 0.
