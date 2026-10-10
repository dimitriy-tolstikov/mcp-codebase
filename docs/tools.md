# MCP Tools Reference

Sixteen tools are registered in `src/index.ts` (`TOOLS` array + `TOOL_HANDLERS` dispatch
map). Each navigation tool lives in its own file under `src/tools/`; the LSP-backed
tools live under `src/tools/refactor/`. Every tool exports a zod schema plus a
`handle*` function returning `Promise<string>`.

Tool descriptions in `src/index.ts` follow a deliberate pattern — what the tool does,
when to use it, and when NOT to (with the alternative named). This guides the agent's
tool choice; keep the pattern when adding tools.

Common conventions:

- Arguments are validated with zod; failures surface as an `isError` MCP response.
- Handlers return **human-readable plain text** — never JSON.
- Paths are relative to `PROJECT_ROOT` unless noted; use forward slashes.
- "User errors" (e.g. symbol not found) are returned as normal text starting with `Error:`
  or a plain message; unexpected exceptions are caught by the dispatcher in `index.ts`.
- All write tools accept `dryRun` (default `false`): with `dryRun: true` they compute and
  report the edits without writing files or reindexing.

## `project_overview`

Cheap project map from the index — the recommended first call on an unfamiliar project.
File: `src/tools/project-overview.ts` → `getProjectOverview()` in `src/db/repositories.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | no | — | Limit the overview to a subdirectory |
| `max_symbols` | int 1–100 | no | 40 | Max key symbols to list |

```json
{ "max_symbols": 20 }
```

Output sections:

- `Files: N (X typescript, Y csharp)` — indexed file counts grouped by language.
- `Symbols: N` — total indexed symbols.
- `Top-level directories:` — up to 15 first path segments with file counts.
- `Key exported symbols (by importer count):` — exported symbols ranked by how many
  distinct files import their module (same `LIKE` heuristic as `get_module_dependencies`) —
  a relational analogue of Aider's PageRank repo map.

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
and usages via destructuring/aliasing are not distinguished. For precise semantic
references use `find_references`; for renames use `rename_symbol`.

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

## LSP-backed tools

The next eight tools talk to real language servers through the LSP layer (`src/lsp/`) —
see `docs/architecture.md` for how backends are started and `src/lsp/edits.ts` for how
`WorkspaceEdit`s are applied. They require `LSP_ENABLED` not set to `false` (otherwise
they return `Error: LSP support disabled (LSP_ENABLED=false)`), a file type with a
registered backend (`Error: no LSP backend for this file type`), and a backend that
declares the capability (`Error: operation '<op>' not supported by <backend> backend`).

All of them share the `dryRun` parameter (default `false`). After a real (non-dry-run)
write, changed files are synced back to the language server (didOpen/didChange) and
reindexed via `indexSingleFile()`.

## `rename_symbol`

Semantic rename of a function/class/method/variable across the whole project.
File: `src/tools/refactor/rename-symbol.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `file_path` | string | yes | — | File containing the symbol |
| `line` | int ≥ 1 | yes | — | Line of the symbol (1-based) |
| `column` | int ≥ 1 | yes | — | Column of the symbol (1-based) |
| `new_name` | string | yes | — | New name |
| `dryRun` | boolean | no | false | Report edits without writing |

The handler issues `textDocument/rename`. Because tsserver loads the project
asynchronously after the first `didOpen`, the rename request is retried (up to 5 times,
800 ms apart) until the returned edit set stabilizes — otherwise references in not yet
loaded files could be missed. `Error: rename not possible at ...` when the server refuses.

Output: the `applyWorkspaceEdit()` report — per changed file, edit count and a short
preview of the first changed lines:

```
Rename to 'hello':
Applied edits to 2 file(s) and reindexed them.
util.ts: 1 edit(s)
  line 1: "export function hello(name: string): string {"
main.ts: 2 edit(s)
  ...
```

## `find_references`

Semantic "who calls/uses this" via the language server (`textDocument/references`).
File: `src/tools/refactor/find-references.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `file_path` | string | yes | — | File containing the symbol |
| `line` | int ≥ 1 | yes | — | Line of the symbol (1-based) |
| `column` | int ≥ 1 | yes | — | Column of the symbol (1-based) |
| `include_declaration` | boolean | no | false | Include the declaration itself |
| `limit` | int 1–500 | no | 100 | Max results |

Like `rename_symbol`, the request is retried until the result set stabilizes (tsserver
loads the project asynchronously) — with a minimum of 3 attempts, because an early
"stable" answer can still be incomplete. Output: `References (found N):` then per hit
`file:line:column` plus the trimmed source line, truncated at `limit`.

This is the precise counterpart of `find_usages` (which is plain text search).

## `go_to_definition`

Jump to the definition of the symbol at a position, plus hover info (type, signature,
docstring). File: `src/tools/refactor/go-to-definition.ts`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | File containing the symbol reference |
| `line` | int ≥ 1 | yes | Line of the symbol (1-based) |
| `column` | int ≥ 1 | yes | Column of the symbol (1-based) |

Issues `textDocument/definition` and `textDocument/hover` in parallel. Output: a `Hover:`
block (when the server provides it) followed by `Definition(s):` as `file:line:column`
with the first source line. `No definition found at ...` when the server resolves nothing.

## `get_diagnostics`

Compiler/linter diagnostics from the language server.
File: `src/tools/refactor/get-diagnostics.ts`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | no | File to check. Omit for all diagnostics already published by running servers |
| `severity` | `error\|warning\|info\|hint` | no | Minimum severity to include |

With `file_path`, the document is opened/synced and the handler waits ~2 s for
`publishDiagnostics` (they arrive in waves: syntax first, semantic later), then reports
the latest set. Without `file_path`, only diagnostics already stored by running backends
are reported — nothing is opened or started.

Output lines: `file:line:col severity message (source)`, e.g.
`main.ts:3:7 error Type 'string' is not assignable to type 'number'. (typescript)`.

## `move_file`

Move/rename a file, updating imports that reference it. File: `src/tools/refactor/move-file.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `old_path` | string | yes | — | Current file path |
| `new_path` | string | yes | — | Target path (must not exist) |
| `dryRun` | boolean | no | false | Report import updates without moving |

For TS/JS the handler first asks tsserver for import updates
(`workspace/executeCommand` → `_typescript.getEditsForFileRename`) and applies that edit,
then performs the `fs.rename`, removes the old path from the index
(`removeFileFromIndex`) and indexes the new one (`indexSingleFile`). For C# only the
file move + reindex is done — namespace/using updates are **not** guaranteed; the report
says so explicitly.

## `organize_imports`

Remove unused imports and sort the rest. File: `src/tools/refactor/organize-imports.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `file_path` | string | yes | — | File to organize |
| `dryRun` | boolean | no | false | Report edits without writing |

Requests a `textDocument/codeAction` with `only: ['source.organizeImports']`; if the
action carries a command instead of an edit, it is executed via `workspace/executeCommand`.
When the backend offers no such action: `Error: organize imports not supported by ...`.

## `fix_all`

Apply all auto-fixable diagnostics in a file. File: `src/tools/refactor/fix-all.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `file_path` | string | yes | — | File to fix |
| `dryRun` | boolean | no | false | Report edits without writing |

Waits briefly for diagnostics, then requests code actions with `only: ['source.fixAll']`
(and executes the returned command if needed). With no diagnostics it returns
`Nothing to fix: ...`; with diagnostics but no offered action:
`Error: fix all not supported by ...`.

## `extract_method`

Extract a line range into a new method/function. File: `src/tools/refactor/extract-method.ts`.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `file_path` | string | yes | — | File containing the code |
| `start_line` | int ≥ 1 | yes | — | First line of the range (1-based) |
| `end_line` | int ≥ 1 | yes | — | Last line of the range (1-based) |
| `new_name` | string | yes | — | Name for the extracted function |
| `dryRun` | boolean | no | false | Report edits without writing |

Requests code actions with `only: ['refactor.extract']` for the range and picks a
function/method extraction action. Availability depends on what the server offers for
that exact selection: `Error: refactoring not available at this position` when nothing is
offered, and an honest error when the offered action requires an interactive name prompt
the server cannot fulfill non-interactively (rename afterwards with `rename_symbol`).

## `get_tool_stats`

Read-only telemetry counters. File: `src/tools/tool-stats.ts` (data: `src/utils/stats.ts`).
No parameters.

Returns a plain-text table of `tool → calls → errors` since server start. Only thrown
exceptions count as errors — user errors returned as plain text do not. Thrown exceptions
are also appended to an error log (`MCP_ERROR_LOG`, default
`<PROJECT_ROOT>/.mcp-codebase-errors.log`; one line per error: ISO timestamp, tool name,
JSON args, message, stack).
