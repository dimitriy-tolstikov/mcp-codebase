# Development

## Requirements

- Node.js 18+
- PostgreSQL 14+ (with rights to create a database and the `pg_trgm` extension)
- TypeScript builds to pure ESM (`"type": "module"`, `module: NodeNext`, strict mode)

## Commands

```bash
npm install        # installs deps; the `prepare` script also builds
npm run build      # tsc: src/ -> dist/ (declarations + source maps)
npm run dev        # tsc --watch
npm start          # node dist/index.js — MCP server on stdio
```

## Project layout

```
src/
├── index.ts                 # Entry point: MCP server, tool registry, startup
├── config.ts                # Env vars + hardcoded tuning
├── db/
│   ├── connection.ts        # pg Pool singleton; query/withClient/withTransaction
│   ├── schema.ts            # ensureDatabase() + initSchema() (DDL)
│   └── repositories.ts      # All SQL: batch inserts (upserts), search queries
├── indexer/
│   ├── file-crawler.ts      # Generator-based file walk honoring ignore rules
│   ├── indexer.ts           # Parser registry + indexProject() + indexSingleFile()
│   └── watcher.ts           # chokidar watch mode
├── lsp/
│   ├── client.ts            # LspClient: stdio JSON-RPC to a language server
│   ├── backend.ts           # ILspBackend contract + capability set
│   ├── tsserver-backend.ts  # typescript-language-server backend (TS/JS)
│   ├── csharp-backend.ts    # csharp-ls backend (C#; needs .NET SDK)
│   ├── registry.ts          # backendForFile() + lazy lifecycle + shutdownAll()
│   ├── edits.ts             # applyWorkspaceEdit() + dryRun + reindex hook
│   └── positions.ts         # path↔URI, 1-based→0-based positions, edit offsets
├── parsers/
│   ├── interface.ts         # ILanguageParser + data types
│   ├── typescript.ts        # TS/JS parser (TypeScript Compiler API)
│   └── csharp.ts            # Regex-based C# parser
├── tools/                   # One file per MCP tool (zod schema + handler)
│   ├── refactor/            # LSP-backed refactoring tools (rename, move, ...)
│   └── tool-stats.ts        # get_tool_stats telemetry tool
└── utils/
    ├── gitignore.ts         # loadGitignore()
    ├── paths.ts             # Path normalization helpers
    └── stats.ts             # Tool telemetry: call/error counters + error log
```

`dist/` is build output (gitignored). `kimi-mcp.json` is an example MCP host config.

## Code style

- **ESM imports with explicit `.js` extension** on relative paths (`./db/connection.js`),
  required by `module: NodeNext`. Type-only imports use `import type`.
- Strict TypeScript, 2-space indentation, semicolons. Mixed single/double quotes exist —
  match the file you edit. No ESLint/Prettier configured.
- **Never write to stdout** — the MCP protocol runs on stdio. All logging goes to
  `console.error`. A single `console.log` breaks the protocol.
- Tool handlers return human-readable **plain-text strings** (no JSON to the agent).
- All SQL is parameterized (`$1`, `$2`, ...) — never interpolate values into query strings.
- `any` is used pragmatically for DB row shapes; typed rows are welcome in new code.
- Comments and documentation in English. `README.ru.md` mirrors `README.md` — update both
  when user-facing docs change, and update `docs/` per the workflow in `AGENTS.md`.

## Adding an MCP tool

1. Create `src/tools/<name>.ts` (or `src/tools/refactor/<name>.ts` for LSP-backed tools)
   exporting a zod schema and `handle<Name>(args): Promise<string>`.
2. Register the tool definition in the `TOOLS` array in `src/index.ts` (name, description,
   JSON Schema for inputs).
3. Add an entry to the `TOOL_HANDLERS` map in `src/index.ts` (schema + handler). The
   dispatcher validates args, wraps execution with telemetry (`recordCall` /
   `recordError` from `src/utils/stats.ts`), and returns
   `{ content: [{ type: "text", text }] }`.

Errors thrown by the handler are converted to `isError` responses by the dispatcher —
return user-facing problems (e.g. "not found") as plain text instead of throwing.

## Schema changes

DDL lives in `src/db/schema.ts`; `initSchema()` uses `IF NOT EXISTS`, so changes are
additive-only (new tables/columns need `ALTER ... IF NOT EXISTS`-style guards — there is no
migration framework). Batch insert/query helpers go in `src/db/repositories.ts`.

## Testing and verification

- There are **no automated tests** and no test framework. `npm run build` (tsc,
  `strict: true`) is the only static check — it must pass before a change is done.
- Runtime verification needs a local PostgreSQL: run
  `PROJECT_ROOT=<some project> npm start` and invoke tools over stdio, or register the
  server in an MCP host via `kimi-mcp.json` and exercise the tools there.
- Startup progress and errors go to stderr — watch that output when testing.

## Security considerations

- DB credentials come from env vars; the committed `kimi-mcp.json` holds placeholders.
  Do not commit real passwords; `.env` is gitignored.
- Defaults (`postgres`/`postgres`) are development-only.
- The server reads arbitrary files under `PROJECT_ROOT` (`find_usages`,
  `get_symbol_details`, `explore_module`). Run it only against trusted codebases with
  least-privilege DB credentials.
- Keep SQL parameterized. The one exception is `CREATE DATABASE` in `ensureDatabase()`,
  which quotes a name sourced from env.

## Known limitations

Deliberate or accepted gaps — do not "fix" silently; discuss first, and update docs if
behavior changes:

- **The C# parser is heuristic** (regex, line-oriented): false positives such as local
  variables indexed as fields, `lineEnd == lineStart`, missed multi-line constructs.
- **`find_usages` is text search** (word-boundary regex), not semantic reference
  resolution.
- **`get_module_dependencies` "used by" is a `LIKE` heuristic** on import sources, not a
  resolved module graph.
- **C# refactoring tools need the .NET SDK and the `csharp-ls` dotnet tool** installed on
  the machine; without them the C# LSP backend fails with a friendly error (the server
  itself keeps running).
- **`extract_method` availability is server-driven**: whether a range can be extracted
  depends on what the language server offers for that exact selection; some offered
  refactorings require an interactive name prompt that cannot be fulfilled
  non-interactively (apply the refactoring, then use `rename_symbol`). No regex-based
  emulation is done.
- **`move_file` for C# is partial**: the file is moved and reindexed, but namespace/using
  updates across the project are not guaranteed — verify with `get_diagnostics` after.
- **Cross-file rename may need a warm-up**: tsserver loads the project asynchronously
  after the first `didOpen`; `rename_symbol` retries the rename request until the edit
  set stabilizes to avoid missing not-yet-loaded files.
- **`get_diagnostics` project-wide mode** only reports diagnostics already published by
  running language servers — it neither opens files nor starts backends.
