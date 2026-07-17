# MCP Codebase Server

[Русская версия](README.ru.md)

MCP server for semantic codebase navigation. Builds an AST index of symbols, imports, and exports, providing high-level tools for an AI agent.

## Features

- **Symbol search** — finds functions, classes, interfaces, methods, etc. by name with wildcard (`*`, `?`) and OR (`|`) support
- **Symbol details** — shows source code, signature, documentation, and file imports
- **Module overview** — directory structure, key symbols, subdirectories, top imports
- **Usage search** — finds all references to a symbol in the project
- **Module dependencies** — imports, exports, and files that use the given module
- **Reindexing** — full or incremental (by mtime)
- **Watch mode** — automatic index updates when files change

## Supported Languages

| Language | Parser | Symbols | Imports | Exports |
|----------|--------|---------|---------|----------|
| TypeScript / JavaScript | TypeScript Compiler API | ✅ | ✅ | ✅ |
| C# | Regex-based (lightweight) | ✅ | ✅ (using) | ✅ (public) |

The architecture makes it easy to add new languages via the `ILanguageParser` interface.

## Requirements

- Node.js 18+
- PostgreSQL 14+

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
├── tools/
│   ├── search-symbols.ts
│   ├── symbol-details.ts
│   ├── explore-module.ts
│   ├── find-usages.ts
│   ├── module-deps.ts
│   └── reindex.ts
└── utils/
    ├── gitignore.ts
    └── paths.ts
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
