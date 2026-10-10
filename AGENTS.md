# AGENTS.md

Guidance for AI coding agents working in this repository. Assumes no prior knowledge of the project.

## Documentation workflow (required)

Detailed project documentation lives in `docs/` as Markdown files (start from `docs/README.md`).

**Docs before code — a hard sequencing rule, not a suggestion.** When you receive a task,
your FIRST tool calls must read the task-relevant files under `docs/` — before reading any
source file, searching the codebase, or running commands. Reading only `docs/README.md`
(the index) is not enough; read the specific documents for your task type in full:

- Tool behavior (`src/tools/`, SQL queries) → `docs/tools.md` + `docs/database.md`
- Indexing, watcher, startup, configuration → `docs/architecture.md` + `docs/configuration.md`
- Parsers, adding a language → `docs/parsers.md`
- Adding an MCP tool → `docs/tools.md` + `docs/development.md`
- Cross-cutting features → every document the feature touches; when in doubt, read all
  seven files in `docs/` — the folder is small.

In your first reply to the user, name the documents you read (one short line) so compliance
is verifiable. Only then proceed:

1. **Docs must match the code.** If you find a discrepancy between the documentation and the
   actual code, update the documentation to reflect the code.
2. **Keep docs current.** After any code change, update the affected documentation in `docs/`
   as part of the same change — a task is not done until the documentation is updated.
3. **Commit and push.** When the task is complete (code + docs), commit with a clear message
   and push to the remote repository.

## Project overview

`mcp-codebase` is an **MCP (Model Context Protocol) server** that gives an AI agent semantic
navigation over a codebase. It crawls a target project, parses source files into symbols,
imports, and exports, stores them in **PostgreSQL**, and exposes sixteen high-level MCP tools
over **stdio**:

- `project_overview` — cheap project map from the index: counts, top directories, key
  exported symbols ranked by importer count.
- `search_symbols` — find symbols by name with wildcards (`*`, `?`), OR (`|`), and fuzzy
  trigram matching; filter by kind, language, file path.
- `get_symbol_details` — source code, signature, docstring, file imports, sibling symbols.
- `explore_module` — directory overview: file counts, key symbols, subdirectories, top imports.
- `find_usages` — grep-style reference search for a symbol name across the project.
- `get_module_dependencies` — what a file imports, what it exports, which files import it.
- `reindex` — full or incremental reindex of the target project.
- `find_references` — semantic "who calls/uses this" via LSP (`textDocument/references`).
- `go_to_definition` — definition jump + hover info via LSP.
- `rename_symbol` — LSP-backed semantic rename across the project.
- `get_diagnostics` — compiler/linter diagnostics from the language server (file or stored project-wide).
- `move_file` — move/rename a file with import updates (TS/JS full; C# move-only).
- `organize_imports` — remove unused + sort imports via the language server.
- `fix_all` — apply all auto-fixable diagnostics in a file.
- `extract_method` — extract a line range into a new method/function.
- `get_tool_stats` — per-tool call/error telemetry counters (read-only).

Note: this server indexes an *external* codebase (pointed at by `PROJECT_ROOT`), not itself.

## Tech stack and requirements

- **Node.js 18+**, **TypeScript** (ES2022 target, `NodeNext` modules, strict mode), pure **ESM**
  (`"type": "module"` in package.json).
- **PostgreSQL 14+** with the `pg_trgm` extension (created automatically) for fuzzy symbol search.
- Key dependencies: `@modelcontextprotocol/sdk` (stdio transport), `pg` (connection pool),
  `typescript` (TS/JS parsing via the Compiler API), `chokidar` (watch mode), `ignore`
  (.gitignore handling), `zod` (tool input validation), `vscode-jsonrpc` +
  `vscode-languageserver-protocol` + `typescript-language-server` (LSP refactoring layer).

## Build and run commands

```bash
npm install        # installs deps; `prepare` script also runs the build
npm run build      # tsc: src/ -> dist/ (with declarations and source maps)
npm run dev        # tsc --watch
npm start          # node dist/index.js  (runs the MCP server on stdio)
npm run benchmark  # micro-benchmark suite (benchmarks/), see docs/benchmark.md
```

There is no test script, linter, or formatter configured — see "Testing and verification".

## Project structure

```
src/
├── index.ts                 # Entry point: MCP server, tool registry, startup sequence
├── config.ts                # All configuration (env vars, ignore patterns, language map, tuning)
├── db/
│   ├── connection.ts        # pg Pool singleton; query/withClient/withTransaction helpers
│   ├── schema.ts            # ensureDatabase() (creates the DB) + initSchema() (DDL)
│   └── repositories.ts      # All SQL: batch inserts (upserts), search queries
├── indexer/
│   ├── file-crawler.ts      # Generator-based recursive file walk honoring .gitignore + ignore patterns
│   ├── indexer.ts           # Parser registry + indexProject() + indexSingleFile() + removeFileFromIndex()
│   └── watcher.ts           # chokidar watch mode: reindex on add/change, delete row on unlink
├── lsp/
│   ├── client.ts            # LspClient: stdio JSON-RPC (vscode-jsonrpc), didOpen/didChange, diagnostics store
│   ├── backend.ts           # ILspBackend: languageId, extensions, capabilities, ensureStarted()
│   ├── tsserver-backend.ts  # typescript-language-server --stdio (TS/JS)
│   ├── csharp-backend.ts    # csharp-ls (C#; friendly error when .NET/csharp-ls missing)
│   ├── registry.ts          # backendForFile() singletons, lazy start, getStartedBackends(), shutdownAll()
│   ├── edits.ts             # applyWorkspaceEdit(): TextEdits end-of-file backwards, dryRun report, reindex hook
│   └── positions.ts         # path↔file:// URI, 1-based tool positions → 0-based LSP, offset math
├── parsers/
│   ├── interface.ts         # ILanguageParser contract + SymbolInfo/ImportInfo/ExportInfo/ParseResult
│   ├── typescript.ts        # TS/JS parser built on the TypeScript Compiler API
│   └── csharp.ts            # Lightweight regex-based C# parser (approximate by design)
├── tools/                   # One file per MCP tool: zod schema + async handler returning text
│   ├── search-symbols.ts
│   ├── symbol-details.ts
│   ├── explore-module.ts
│   ├── find-usages.ts
│   ├── module-deps.ts
│   ├── reindex.ts
│   ├── project-overview.ts   # project_overview repo-map tool
│   ├── tool-stats.ts        # get_tool_stats telemetry tool
│   └── refactor/            # LSP-backed tools: common.ts helper + find-references,
│                            # go-to-definition, rename-symbol, get-diagnostics,
│                            # move-file, organize-imports, fix-all, extract-method
└── utils/
    ├── gitignore.ts         # loadGitignore()
    ├── paths.ts             # Path normalization helpers
    └── stats.ts             # Tool telemetry: in-memory call/error counters + append-only error log
```

`kimi-mcp.json` is an example MCP host configuration showing how to launch the server with
environment variables. `dist/` is build output (gitignored). Documentation: `README.md`
(English, canonical), `README.ru.md` (Russian translation), and `docs/` — detailed
code-level guides in English (`docs/README.md` is the index; see "Documentation workflow"
above).

## Runtime architecture

Startup sequence in `src/index.ts` (`main()`):

1. `ensureDatabase()` connects to the `postgres` system DB and creates the target database
   if missing; `initSchema()` creates tables and indexes.
2. If the `files` table is empty, a full initial index runs automatically.
3. The chokidar watcher starts on `PROJECT_ROOT`: reindexes individual files on add/change,
   removes them from the index on unlink.
4. The MCP server connects over stdio and dispatches tool calls via the `TOOL_HANDLERS` map.
   Each tool's args are validated with its zod schema, the handler returns a plain-text result,
   and any thrown error is returned as `{ isError: true, content: [{ type: "text", text }] }`.
   The dispatcher also records telemetry (`src/utils/stats.ts`): `recordCall` on success,
   `recordError` (which also appends to the error log file) on exceptions. Language servers
   (`src/lsp/`) are NOT started here — backends spin up lazily on the first refactoring tool
   call; `shutdownAll()` runs in the SIGINT/SIGTERM handlers.

Indexing pipeline (`src/indexer/indexer.ts`):

- Parsers are registered in two maps (`parsers` by language id, `extToParser` by extension).
  `TypeScriptParser` and `CSharpParser` are registered at module load.
- `crawlFiles()` walks the tree, applying `.gitignore` plus `config.ignorePatterns`.
- Files are parsed and flushed in batches (`config.batchSize` = 1000 files; symbol/import/export
  inserts are sub-batched at 500 rows to stay under PostgreSQL's parameter limit).
- Each batch is written in one transaction: the batch's file rows are deleted first
  (cascading to symbols/imports/exports, so re-indexing never duplicates), then file rows
  upsert `ON CONFLICT (path)`; exports are linked to symbols (`exports.symbol_id`).
- Full reindex truncates all four tables first. Incremental reindex skips files with
  unchanged `mtime`, prunes rows for files deleted from disk, and re-indexes only
  new/changed files.

Database schema (all in `src/db/schema.ts`): `files` (path unique, extension, language, size,
line_count, mtime), `symbols` (FK to files, name, kind, position, signature, docstring,
modifiers as JSON text), `imports` (source, names as JSON text, is_type_only), `exports`
(name, is_default, is_reexport, source, symbol_id FK). Symbol search ranks by exact match,
then `similarity()` via the `pg_trgm` GIN index.

## Configuration

Everything is configured through environment variables (see `src/config.ts`). There is no
config file and no dotenv loading — the MCP host supplies env (as in `kimi-mcp.json`).

| Variable | Default | Purpose |
|---|---|---|
| `PROJECT_ROOT` | `process.cwd()` | Root of the codebase to index |
| `PGHOST` / `PGPORT` | `localhost` / `5432` | PostgreSQL connection |
| `PGDATABASE` | `codebase_index` | Database name (auto-created) |
| `PGUSER` / `PGPASSWORD` | `postgres` / `postgres` | PostgreSQL credentials |
| `LSP_ENABLED` | `true` | Global switch for the LSP refactoring layer |
| `TSSERVER_CMD` | bundled `node_modules/.bin/typescript-language-server` | TS/JS language server command |
| `CSHARPLS_CMD` | `csharp-ls` | C# language server command |
| `LSP_STARTUP_TIMEOUT_MS` / `LSP_REQUEST_TIMEOUT_MS` | `60000` / `30000` | LSP timeouts |
| `MCP_ERROR_LOG` | `<PROJECT_ROOT>/.mcp-codebase-errors.log` | Append-only tool error log |

`config.ts` also holds hardcoded tuning: `ignorePatterns` (node_modules, dist, build, .git,
bin, obj, .vs, packages, coverage, .next, `*.min.js`, `*.map`), `languageMap`
(extension → language; also drives the watcher and `find_usages` extension allowlists),
`batchSize`, `watchDebounceMs` (watcher `awaitWriteFinish` threshold).

## Code style and conventions

- **ESM imports with explicit `.js` extension** on relative paths (`./db/connection.js`),
  required by `module: NodeNext`. Type-only imports use `import type`.
- Strict TypeScript, 2-space indentation, semicolons. Mixed single/double quotes exist;
  match the style of the file you are editing. No ESLint/Prettier — keep formatting manual
  and consistent with neighbors.
- **Never write to stdout.** The MCP protocol runs on stdio, so all logging goes to
  `console.error`. Adding a `console.log` will break the protocol.
- Tool handlers return human-readable **plain-text strings** (no JSON responses to the agent).
  User-facing errors are returned as text; unexpected exceptions bubble up to the dispatcher
  in `index.ts`.
- All SQL is parameterized (`$1`, `$2`, ...) — keep it that way; never interpolate values
  into query strings.
- `any` is used pragmatically for DB row shapes; new code may follow suit but typed rows
  are welcome.
- Comments and documentation are in English (`README.ru.md` is a translation of the English
  README — update both when user-facing docs change).

## Extending the project

**Add a language** (as documented in the README):

1. Create a class implementing `ILanguageParser` (`supportedExtensions`, `languageId`, `parse()`)
   in `src/parsers/`.
2. Register it in `src/indexer/indexer.ts` next to the existing `registerParser(...)` calls.
3. Add the extension to `config.languageMap` in `src/config.ts` — it automatically drives
   the extension allowlists in the watcher (`src/indexer/watcher.ts`) and `find_usages`
   (`src/tools/find-usages.ts`).

**Add an MCP tool:**

1. Create `src/tools/<name>.ts` (or `src/tools/refactor/<name>.ts` for LSP-backed tools)
   exporting a zod schema and a `handle*` function returning `Promise<string>`.
2. Register the tool definition in the `TOOLS` array in `src/index.ts` and add an entry to
   the `TOOL_HANDLERS` map (telemetry wrapping is automatic).

**Schema changes:** DDL lives in `src/db/schema.ts` (`initSchema` uses `IF NOT EXISTS`, so new
tables/indexes are additive-only; there is no migration framework). Batch insert/query helpers
go in `src/db/repositories.ts`.

## Testing and verification

- There are **no automated tests** and no test framework installed. `npm run build` (tsc with
  `strict: true`) is the only static check — it must pass before a change is considered done.
- Runtime verification requires a local PostgreSQL: start the server with
  `PROJECT_ROOT=<some project> npm start` and invoke tools over stdio, or register it in an
  MCP host via `kimi-mcp.json` and exercise the tools there.
- On startup, progress and errors are printed to stderr — watch that output when testing.

## Security considerations

- Database credentials come from environment variables; the committed `kimi-mcp.json` contains
  only placeholders. Do not commit real passwords. `.env` is gitignored.
- Default credentials (`postgres`/`postgres`) are development-only — document/override in
  production deployments.
- The server reads any file under `PROJECT_ROOT` (`find_usages`, `get_symbol_details`,
  `explore_module` join stored relative paths against `PROJECT_ROOT`). It should only be run
  against codebases the operator trusts, with least-privilege DB credentials.
- Keep all SQL parameterized (see conventions); the one exception is `CREATE DATABASE` in
  `ensureDatabase`, which quotes a name sourced from env.

## Known limitations (be careful not to "fix" these silently)

- **The C# parser is heuristic** (regex-based, line-oriented): it can produce false positives
  (e.g. local variables indexed as fields) and misses non-trivial syntax.
- `find_usages` is plain text search (word-boundary regex), not semantic reference resolution.
- `get_module_dependencies` finds "used by" files via a `LIKE` match on import sources —
  a heuristic, not a resolved module graph.
- **C# refactoring tools need the .NET SDK + `csharp-ls`** installed; without them the C#
  LSP backend fails with a friendly error while the server keeps running.
- `extract_method` is server-driven: availability depends on what the language server
  offers for the exact selection; some actions need an interactive name prompt that cannot
  be fulfilled non-interactively (apply, then use `rename_symbol`). No regex emulation.
- `move_file` for C# is partial: the file is moved and reindexed, but namespace/using
  updates are not guaranteed — verify with `get_diagnostics`.
- `rename_symbol` retries the rename request until the edit set stabilizes because tsserver
  loads the project asynchronously after the first `didOpen`. `find_references` does the
  same with a minimum of 3 attempts — an early "stable" result can still be incomplete.
- `get_diagnostics` without `file_path` only reports diagnostics already published by
  running language servers — it opens nothing and starts no backends.
