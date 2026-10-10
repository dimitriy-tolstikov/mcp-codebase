# MCP Codebase Server

[Русская версия](README.ru.md)

MCP server for semantic codebase navigation. Builds an AST index of symbols, imports, and exports, providing high-level tools for an AI agent.

## Features

- **Project overview** — a cheap "repo map" from the index: counts, top directories, key exported symbols ranked by importer count
- **Symbol search** — finds functions, classes, interfaces, methods, etc. by name with wildcard (`*`, `?`) and OR (`|`) support
- **Symbol details** — shows source code, signature, documentation, and file imports
- **Module overview** — directory structure, key symbols, subdirectories, top imports
- **Usage search** — finds all references to a symbol in the project (plain text)
- **Semantic navigation** (LSP-backed): `find_references` (precise "who calls this") and `go_to_definition` (definition jump + hover info)
- **Module dependencies** — imports, exports, and files that use the given module
- **Reindexing** — full or incremental (by mtime)
- **Watch mode** — automatic index updates when files change
- **Semantic refactoring** (LSP-backed, via real language servers): `rename_symbol`,
  `get_diagnostics`, `move_file`, `organize_imports`, `fix_all`, `extract_method` — all
  with `dryRun` support and automatic reindex of changed files
- **Tool telemetry** — `get_tool_stats` shows per-tool call/error counters for the running
  server process

16 MCP tools in total: 7 navigation, 8 LSP-backed, 1 telemetry. See `docs/benchmark.md`
for the measured context savings vs a grep-only agent loop (~18x fewer bytes on this repo).

## Supported Languages

| Language | Parser | Symbols | Imports | Exports |
|----------|--------|---------|---------|----------|
| TypeScript / JavaScript | TypeScript Compiler API | ✅ | ✅ | ✅ |
| C# | Regex-based (lightweight) | ✅ | ✅ (using) | ✅ (public) |

The architecture makes it easy to add new languages via the `ILanguageParser` interface.

## Requirements

- Node.js 18+
- PostgreSQL 14+
- For C# refactoring tools: .NET SDK + the `csharp-ls` dotnet tool (TS/JS refactoring works out of the box via the bundled `typescript-language-server`)

## Installation

```bash
npm install
npm run build
```

## Configuration

Environment variables:

| Variable | Description | Default |
|------------|----------|--------------|
| `PROJECT_ROOT` | Project root directory | `process.cwd()` |
| `PGHOST` | PostgreSQL host | `localhost` |
| `PGPORT` | PostgreSQL port | `5432` |
| `PGDATABASE` | Database name | `codebase_index` |
| `PGUSER` | PostgreSQL user | `postgres` |
| `PGPASSWORD` | PostgreSQL password | `postgres` |

## Integration with Kimi CLI

Add to `kimi-mcp.json`:

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

## MCP Tools

### `project_overview`
Cheap project map — call first on an unfamiliar project.

```json
{ "max_symbols": 20 }
```

### `search_symbols`
Search symbols by name with filtering.

```json
{
  "query": "UserService|useAuth|*Controller",
  "kind": "class|function",
  "language": "typescript",
  "file_path": "src/services",
  "limit": 20
}
```

### `get_symbol_details`
Full information about a symbol.

```json
{ "symbol_id": 123 }
// or
{ "name": "UserService", "file_path": "src/services/UserService.ts" }
```

### `explore_module`
Directory overview.

```json
{ "path": "src/services", "depth": 1 }
```

### `find_usages`
Find symbol usages.

```json
{ "name": "UserService", "file_path": "src/services/UserService.ts" }
```

### `get_module_dependencies`
File dependency graph.

```json
{ "path": "src/services/UserService.ts" }
```

### `reindex`
Force reindexing.

```json
{ "full": false }
```

### Refactoring tools (LSP-backed)

Require a language server for the file type (TS/JS out of the box; C# needs `csharp-ls`).
All write tools accept `dryRun: true` to preview edits without writing.

- `find_references` — `{ "file_path": "src/util.ts", "line": 12, "column": 17 }` (semantic references)
- `go_to_definition` — `{ "file_path": "src/main.ts", "line": 5, "column": 10 }` (definition + hover)
- `rename_symbol` — `{ "file_path": "src/util.ts", "line": 12, "column": 17, "new_name": "hello" }`
- `get_diagnostics` — `{ "file_path": "src/util.ts", "severity": "error" }` (omit `file_path` for all stored diagnostics)
- `move_file` — `{ "old_path": "src/a.ts", "new_path": "src/lib/a.ts" }`
- `organize_imports` — `{ "file_path": "src/a.ts" }`
- `fix_all` — `{ "file_path": "src/a.ts" }`
- `extract_method` — `{ "file_path": "src/a.ts", "start_line": 10, "end_line": 20, "new_name": "helper" }`
- `get_tool_stats` — `{}` (per-tool call/error counters)

LSP env vars: `LSP_ENABLED`, `TSSERVER_CMD`, `CSHARPLS_CMD`, `LSP_STARTUP_TIMEOUT_MS`,
`LSP_REQUEST_TIMEOUT_MS`, `MCP_ERROR_LOG` — see `docs/configuration.md`.

## Architecture

```
src/
├── index.ts                 # MCP server
├── config.ts                # Configuration
├── db/
│   ├── connection.ts        # PostgreSQL pool
│   ├── schema.ts            # DDL and migrations
│   └── repositories.ts      # Database queries
├── indexer/
│   ├── file-crawler.ts      # File traversal
│   ├── indexer.ts           # Indexing orchestration
│   └── watcher.ts           # Watch mode (chokidar)
├── parsers/
│   ├── interface.ts         # ILanguageParser
│   ├── typescript.ts        # TS/JS parser
│   └── csharp.ts            # C# parser
├── lsp/
│   ├── client.ts            # LSP client over stdio
│   ├── backend.ts           # ILspBackend contract
│   ├── tsserver-backend.ts  # typescript-language-server
│   ├── csharp-backend.ts    # csharp-ls (needs .NET SDK)
│   ├── registry.ts          # backend lifecycle
│   ├── edits.ts             # WorkspaceEdit application
│   └── positions.ts         # path↔URI, positions
├── tools/
│   ├── search-symbols.ts
│   ├── symbol-details.ts
│   ├── explore-module.ts
│   ├── find-usages.ts
│   ├── module-deps.ts
│   ├── reindex.ts
│   ├── project-overview.ts
│   ├── tool-stats.ts
│   └── refactor/            # find-references, go-to-definition, rename-symbol,
│                            # get-diagnostics, move-file, organize-imports,
│                            # fix-all, extract-method
└── utils/
    ├── gitignore.ts
    ├── paths.ts
    └── stats.ts             # tool telemetry
benchmarks/                  # micro-benchmark suite (see docs/benchmark.md)
```

## Performance

On the `lowcodeplatform` project (~71K files, ~730 source files excluding node_modules/dist):
- Full indexing: ~1.3 sec
- Symbols in the index: ~5000
- Symbol search: < 50 ms

## Extending to Other Languages

1. Create a class implementing `ILanguageParser`
2. Register it in `src/indexer/indexer.ts`
3. Add the extension to `config.languageMap`

Example:
```typescript
export class PythonParser implements ILanguageParser {
  readonly supportedExtensions = ['.py'];
  readonly languageId = 'python';
  parse(filePath: string, content: string): ParseResult | null { ... }
}
```
