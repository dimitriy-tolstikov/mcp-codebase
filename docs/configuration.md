# Configuration

All configuration lives in `src/config.ts`. There is **no config file and no dotenv
loading** — the MCP host supplies environment variables (see `kimi-mcp.json` for an example).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PROJECT_ROOT` | `process.cwd()` | Root of the codebase to index |
| `PGHOST` | `localhost` | PostgreSQL host |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGDATABASE` | `codebase_index` | Database name (auto-created on startup if missing) |
| `PGUSER` | `postgres` | PostgreSQL user |
| `PGPASSWORD` | `postgres` | PostgreSQL password |
| `LSP_ENABLED` | `true` | Set to `false` to disable the LSP layer (refactoring tools return a text error) |
| `TSSERVER_CMD` | bundled `typescript-language-server` from `node_modules/.bin` | Command used to spawn the TS/JS language server |
| `CSHARPLS_CMD` | `csharp-ls` | Command used to spawn the C# language server |
| `LSP_STARTUP_TIMEOUT_MS` | `60000` | Timeout for the LSP `initialize` handshake |
| `LSP_REQUEST_TIMEOUT_MS` | `30000` | Timeout for individual LSP requests |
| `MCP_ERROR_LOG` | `<PROJECT_ROOT>/.mcp-codebase-errors.log` | Append-only tool error log (telemetry) |

Example host configuration (`kimi-mcp.json`):

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["<path-to-mcp-codebase>/dist/index.js"],
      "env": {
        "PROJECT_ROOT": "<path-to-your-codebase>",
        "PGHOST": "localhost",
        "PGPORT": "5432",
        "PGDATABASE": "codebase_index",
        "PGUSER": "postgres",
        "PGPASSWORD": "your_password"
      }
    }
  }
}
```

## Hardcoded tuning in `src/config.ts`

| Key | Value | Purpose |
|---|---|---|
| `ignorePatterns` | see list below | Added on top of the target project's `.gitignore` during crawl |
| `languageMap` | ext → language | Fallback `language` for files without a parser result; also defines the extension allowlists used by the watcher and `find_usages` |
| `batchSize` | `1000` | Files per flush transaction in `indexProject()` |
| `watchDebounceMs` | `300` | Watcher `awaitWriteFinish` stability threshold (ms) |
| `lsp` | see env table above | LSP layer: enabled flag, backend commands, startup/request timeouts |

`ignorePatterns`:

```
**/node_modules/**  **/dist/**  **/build/**  .git/**  *.min.js  *.map
**/bin/**  **/obj/**  **/.vs/**  **/packages/**  **/coverage/**  **/.next/**
```

The `**/` prefix makes the directory patterns match at any nesting depth (e.g.
`browser-extension/node_modules/`), not only at the project root. The crawler
additionally applies these as per-directory basename filters
(`src/indexer/file-crawler.ts`), so ignored directories are never descended into.

`languageMap`:

```
.ts .tsx .js .jsx .mjs .cjs .mts → typescript
.cs                              → csharp
```

## Watcher ignore list

The chokidar watcher (`src/indexer/watcher.ts`) has its own, separate ignore list —
dotfiles (regex), `node_modules`, `dist`, `build`, `*.min.js`, `*.map` — and reindexes
only the extensions from `config.languageMap` on add/change. chokidar v4 has no glob
support, so these are regexes that match at any nesting depth. Watcher errors
(e.g. `ENOSPC` when the inotify watch limit is exhausted) are logged to stderr and no
longer crash the server. Changing `config.ignorePatterns` does **not** affect the
watcher; extending `config.languageMap` does.

## Connection pool

`src/db/connection.ts` creates a singleton `pg.Pool` with fixed settings:
`max: 10`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 5000`. These are not
configurable via env vars.

`ensureDatabase()` (`src/db/schema.ts`) opens a separate one-connection pool to the
`postgres` system database using the same env vars to create `PGDATABASE` if missing.

## Security notes

- Credentials come only from env vars; never commit real passwords. `kimi-mcp.json` in the
  repo contains placeholders only. `.env` is gitignored.
- Default credentials (`postgres`/`postgres`) are development-only.
- The server reads any file under `PROJECT_ROOT` (e.g. `find_usages`, `get_symbol_details`).
  Run it only against trusted codebases with least-privilege DB credentials.
