# MCP Tools Reference

Six tools are registered in `src/index.ts` (`TOOLS` array + dispatch switch). Each tool
lives in its own file under `src/tools/` and exports a zod schema plus a `handle*` function
returning `Promise<string>`.

Common conventions:

- Arguments are validated with zod; failures surface as an `isError` MCP response.
- Handlers return **human-readable plain text** — never JSON.
- Paths are relative to `PROJECT_ROOT` unless noted; use forward slashes.
- "User errors" (e.g. symbol not found) are returned as normal text starting with `Error:`
  or a plain message; unexpected exceptions are caught by the dispatcher in `index.ts`.

## `search_symbols`

Search for symbols (functions, classes, interfaces, methods, etc.) across the codebase.
File: `src/tools/search-symbols.ts` → `searchSymbols()` in `src/db/repositories.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes | — | Name or pattern. `*` any chars, `?` one char, `|` = OR |
| `kind` | string | no | — | Filter by kind; `|` for several, e.g. `class\|function` |
| `language` | string | no | — | `typescript` or `csharp` |
| `file_path` | string | no | — | Substring filter on the indexed path |
| `limit` | int 1–100 | no | 20 | Max results |
| `offset` | int ≥ 0 | no | 0 | Pagination offset |

Matching semantics: with wildcards → `ILIKE` pattern; without wildcards → exact OR prefix
OR trigram `similarity() > 0.3`. Results rank exact matches first, then similarity.

```json
{ "query": "UserService|*Controller", "kind": "class", "limit": 20 }
```

Output:

```
Found 2 symbol(s):

1. UserService (class) — src/services/UserService.ts:12
   export class UserService {
   [export]
```

## `get_symbol_details`

Full information about one symbol. File: `src/tools/symbol-details.ts`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol_id` | int | one of the two modes | Database id (from `search_symbols`) |
| `name` | string | with `file_path` | Symbol name |
| `file_path` | string | with `name` | File where the symbol is defined |

Provide **either** `symbol_id` **or** both `name` + `file_path`; anything else returns
`Error: provide either symbol_id or both name and file_path`.

The handler re-reads the source file from disk and prints the symbol's line range with
line numbers. If the file is unreadable, `[Could not read file]` is shown instead.

Output sections: header (name, kind, `file:line[-line]`, language, modifiers), signature,
docstring, numbered source code, imports in the file (with `[type-only]` marker), and other
symbols in the same file.

```json
{ "symbol_id": 123 }
```

## `explore_module`

Directory overview — a good first step to understand project structure.
File: `src/tools/explore-module.ts` → `getModuleStats()` in `src/db/repositories.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Directory relative to project root |
| `depth` | int 0–3 | no | 1 | Subdirectory listing depth; 0 hides the section |

```json
{ "path": "src/services", "depth": 2 }
```

Output sections:

- `Files: N total (X .ts, Y .cs, ...)` — from the index, grouped by extension.
- `Key symbols:` — up to 20 symbols (name, kind, file:line).
- `Subdirectories:` — read from disk, nested up to `depth` levels (indented), each with a
  recursive file count. `node_modules`, `.git`, `dist`, and `build` are never descended into.
- `Top external/internal imports:` — up to 10 import sources by distinct-file count.

Index lookups use `path LIKE '<dir>%'`, so pass the directory without a trailing slash
(e.g. `src/services`). A directory absent from disk returns `Directory not found: ...`.

## `find_usages`

Grep-style reference search for a symbol name. File: `src/tools/find-usages.ts`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Symbol name to search for |
| `file_path` | string | no | Definition file (used to skip the definition itself) |
| `symbol_id` | int | no | Alternative way to supply name + definition location |

The handler walks `PROJECT_ROOT` on disk (skipping `node_modules`, `.git`, `dist`,
`build`), scans files with the extensions listed in `config.languageMap`, and matches a
**word-boundary regex** on each line. When the definition is known (via `symbol_id` or
`name` + `file_path`), the definition's own line range is skipped.

This is plain text search, not semantic resolution: same-named unrelated symbols match,
and usages via destructuring/aliasing are not distinguished.

```json
{ "name": "UserService", "file_path": "src/services/UserService.ts" }
```

Output: `References to UserService (found N):` then up to 50 hits as
`file:line` + trimmed line text, with `... and M more references` if truncated.

## `get_module_dependencies`

Dependencies of one file: what it imports, what it exports, which files import it.
File: `src/tools/module-deps.ts`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | File path relative to project root (as stored in the index) |

```json
{ "path": "src/services/UserService.ts" }
```

Output sections:

- `Imports` — split into **Internal** (source starts with `.` or `/`) and **External**,
  with imported names and `[type-only]` markers.
- `Exported symbols` — with `[default]` and `[re-export from <source>]` markers.
- `Used by` — up to 50 files whose import sources `LIKE '%<basename-without-ext>%'`.
  This is a heuristic string match, not a resolved module graph: `foo/bar.ts` matches
  imports of any module whose specifier contains `bar`.

A file missing from the index returns `File not found in index: ...`.

## `reindex`

Trigger reindexing of the target project. File: `src/tools/reindex.ts` →
`indexProject()` in `src/indexer/indexer.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `full` | boolean | no | false | `true` = truncate all tables and rebuild |

```json
{ "full": false }
```

Output: counts of scanned, skipped, removed, and parsed files, symbols, imports, exports,
and duration:

```
Reindex complete.
Scanned: 730 files
Skipped (unchanged): 712
Removed (deleted from disk): 3
Parsed: 15 files
Symbols: 120
Imports: 45
Exports: 30
Duration: 0.4s
```

Notes:

- `full: false` (incremental) skips files whose `mtime` is unchanged, prunes rows for
  files deleted from disk, and re-indexes only new/changed files — old rows are deleted
  before re-insert, so symbols never duplicate.
- `full: true` truncates all tables first — queries against the index may return empty
  results until it finishes.
