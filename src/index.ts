#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ensureDatabase, initSchema } from "./db/schema.js";
import { indexProject } from "./indexer/indexer.js";
import { startWatcher } from "./indexer/watcher.js";
import { config } from "./config.js";

import { SearchSymbolsSchema, handleSearchSymbols } from "./tools/search-symbols.js";
import { SymbolDetailsSchema, handleSymbolDetails } from "./tools/symbol-details.js";
import { ExploreModuleSchema, handleExploreModule } from "./tools/explore-module.js";
import { FindUsagesSchema, handleFindUsages } from "./tools/find-usages.js";
import { ModuleDepsSchema, handleModuleDeps } from "./tools/module-deps.js";
import { ReindexSchema, handleReindex } from "./tools/reindex.js";
import { RenameSymbolSchema, handleRenameSymbol } from "./tools/refactor/rename-symbol.js";
import { GetDiagnosticsSchema, handleGetDiagnostics } from "./tools/refactor/get-diagnostics.js";
import { MoveFileSchema, handleMoveFile } from "./tools/refactor/move-file.js";
import { OrganizeImportsSchema, handleOrganizeImports } from "./tools/refactor/organize-imports.js";
import { FixAllSchema, handleFixAll } from "./tools/refactor/fix-all.js";
import { ExtractMethodSchema, handleExtractMethod } from "./tools/refactor/extract-method.js";
import { FindReferencesSchema, handleFindReferences } from "./tools/refactor/find-references.js";
import { GoToDefinitionSchema, handleGoToDefinition } from "./tools/refactor/go-to-definition.js";
import { ProjectOverviewSchema, handleProjectOverview } from "./tools/project-overview.js";
import { handleToolStats } from "./tools/tool-stats.js";
import { recordCall, recordError } from "./utils/stats.js";
import { shutdownAll } from "./lsp/registry.js";

type ToolHandler = (args: never) => Promise<string>;

const TOOL_HANDLERS: Record<string, { schema: z.ZodTypeAny; handler: ToolHandler }> = {
  search_symbols: { schema: SearchSymbolsSchema, handler: handleSearchSymbols as ToolHandler },
  get_symbol_details: { schema: SymbolDetailsSchema, handler: handleSymbolDetails as ToolHandler },
  explore_module: { schema: ExploreModuleSchema, handler: handleExploreModule as ToolHandler },
  find_usages: { schema: FindUsagesSchema, handler: handleFindUsages as ToolHandler },
  get_module_dependencies: { schema: ModuleDepsSchema, handler: handleModuleDeps as ToolHandler },
  reindex: { schema: ReindexSchema, handler: handleReindex as ToolHandler },
  rename_symbol: { schema: RenameSymbolSchema, handler: handleRenameSymbol as ToolHandler },
  get_diagnostics: { schema: GetDiagnosticsSchema, handler: handleGetDiagnostics as ToolHandler },
  move_file: { schema: MoveFileSchema, handler: handleMoveFile as ToolHandler },
  organize_imports: { schema: OrganizeImportsSchema, handler: handleOrganizeImports as ToolHandler },
  fix_all: { schema: FixAllSchema, handler: handleFixAll as ToolHandler },
  extract_method: { schema: ExtractMethodSchema, handler: handleExtractMethod as ToolHandler },
  find_references: { schema: FindReferencesSchema, handler: handleFindReferences as ToolHandler },
  go_to_definition: { schema: GoToDefinitionSchema, handler: handleGoToDefinition as ToolHandler },
  project_overview: { schema: ProjectOverviewSchema, handler: handleProjectOverview as ToolHandler },
  get_tool_stats: { schema: z.object({}), handler: handleToolStats as ToolHandler },
};

const TOOLS: Tool[] = [
  {
    name: "project_overview",
    description:
      "Cheap project map from the index: file/symbol counts, top-level directories, key exported symbols ranked by importer count. USE FIRST when entering an unfamiliar project or module — one call instead of reading many files. Do NOT use for finding a specific symbol — use search_symbols.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Limit to a subdirectory (relative to project root)" },
        max_symbols: { type: "number", description: "Max key symbols to list", default: 40 },
      },
    },
  },
  {
    name: "search_symbols",
    description:
      "Find symbols (functions, classes, interfaces, methods) by name across the indexed codebase. Supports wildcards (*, ?), OR (|), and fuzzy matching. USE when you know (part of) the symbol name — this is the cheapest way to locate a definition. If you get 0 results or >50, fall back to a plain-text search (find_usages or grep). Do NOT use to find call sites — use find_references.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name or pattern" },
        kind: { type: "string", description: "Filter by kind: class, function, interface, method, property, etc." },
        language: { type: "string", description: "Filter by language: typescript, csharp" },
        file_path: { type: "string", description: "Filter by file path substring" },
        limit: { type: "number", description: "Max results", default: 20 },
        offset: { type: "number", description: "Pagination offset", default: 0 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_symbol_details",
    description:
      "Get full details about one symbol: numbered source code, signature, docstring, imports in its file, sibling symbols. USE after search_symbols to read a symbol's implementation without opening the whole file. Do NOT use for a project overview — use project_overview or explore_module.",
    inputSchema: {
      type: "object",
      properties: {
        symbol_id: { type: "number", description: "Symbol database ID" },
        name: { type: "string", description: "Symbol name" },
        file_path: { type: "string", description: "File path where symbol is defined" },
      },
    },
  },
  {
    name: "explore_module",
    description:
      "Explore one directory: file counts, key symbols, subdirectories, top imports. USE to understand a specific module after project_overview. Do NOT use for the whole project root in one shot — start with project_overview instead.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to project root" },
        depth: { type: "number", description: "Directory listing depth", default: 1 },
      },
      required: ["path"],
    },
  },
  {
    name: "find_usages",
    description:
      "Plain-text (word-boundary) search for a symbol name across source files — fast, works without a language server, but matches same-named unrelated symbols. USE for a quick scan, for languages without an LSP backend, or when find_references is unavailable. For exact semantic references prefer find_references (needs file/line/column of the symbol).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Symbol name to search for" },
        file_path: { type: "string", description: "File path where symbol is defined" },
        symbol_id: { type: "number", description: "Symbol database ID" },
      },
      required: ["name"],
    },
  },
  {
    name: "find_references",
    description:
      "Semantic 'who calls/uses this' via the language server — precise references for the symbol at the given position. USE to answer impact questions ('is it safe to change X?', 'who calls X?'). Get the position from search_symbols or get_symbol_details first. Note: starts a language server on first call (slower); for a quick rough scan use find_usages instead.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File containing the symbol (relative to project root or absolute)" },
        line: { type: "number", description: "Line number of the symbol (1-based)" },
        column: { type: "number", description: "Column number of the symbol (1-based)" },
        include_declaration: { type: "boolean", description: "Include the declaration itself", default: false },
        limit: { type: "number", description: "Max results", default: 100 },
      },
      required: ["file_path", "line", "column"],
    },
  },
  {
    name: "go_to_definition",
    description:
      "Jump to the definition of the symbol at the given position, plus hover info (type, signature, docstring) from the language server. USE before reading a whole file: resolve where a name is defined, then read just that symbol with get_symbol_details. Do NOT use to find usages — use find_references.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File containing the symbol reference (relative to project root or absolute)" },
        line: { type: "number", description: "Line number of the symbol (1-based)" },
        column: { type: "number", description: "Column number of the symbol (1-based)" },
      },
      required: ["file_path", "line", "column"],
    },
  },
  {
    name: "get_module_dependencies",
    description:
      "Show dependencies of one file: what it imports, what it exports, and which files import it (heuristic match). USE to understand a file's place in the module graph before changing it. Do NOT use for symbol-level impact — use find_references.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
      },
      required: ["path"],
    },
  },
  {
    name: "reindex",
    description:
      "Trigger a reindex of the codebase (full=false: incremental by mtime; full=true: truncate and rebuild). USE when the index looks stale (search results don't match the files on disk). Usually unnecessary — the watcher keeps the index current automatically.",
    inputSchema: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "Perform full reindex", default: false },
      },
    },
  },
  {
    name: "rename_symbol",
    description:
      "Semantically rename a symbol (function, class, method, variable) across the whole project via the language server. USE for renames that span files or risk collisions. Do NOT use for a trivial rename in one file you are editing anyway. After renaming, verify with get_diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File containing the symbol (relative to project root or absolute)" },
        line: { type: "number", description: "Line number of the symbol (1-based)" },
        column: { type: "number", description: "Column number of the symbol (1-based)" },
        new_name: { type: "string", description: "New name for the symbol" },
        dryRun: { type: "boolean", description: "Report edits without writing files", default: false },
      },
      required: ["file_path", "line", "column", "new_name"],
    },
  },
  {
    name: "get_diagnostics",
    description:
      "Get compiler/linter diagnostics (errors, warnings) from the language server for a file, or all stored diagnostics when file_path is omitted. USE after every rename/move/fix to verify nothing broke, and before editing an unfamiliar file. Do NOT use to search for symbols — use search_symbols.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File to check (relative to project root or absolute). Omit for all stored diagnostics" },
        severity: { type: "string", enum: ["error", "warning", "info", "hint"], description: "Minimum severity to include" },
      },
    },
  },
  {
    name: "move_file",
    description:
      "Move/rename a file and update imports referencing it (TS/JS: full import rewrite via tsserver; C#: file move only, namespace updates not guaranteed). USE instead of manually moving a file + fixing imports. Do NOT use for renaming a symbol inside a file — use rename_symbol. Verify with get_diagnostics afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        old_path: { type: "string", description: "Current file path" },
        new_path: { type: "string", description: "Target file path" },
        dryRun: { type: "boolean", description: "Report import updates without moving", default: false },
      },
      required: ["old_path", "new_path"],
    },
  },
  {
    name: "organize_imports",
    description:
      "Remove unused imports and sort the remaining ones in a file via the language server. USE to clean up an import block mechanically. Do NOT use to add missing imports — the language server only removes/sorts here.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File whose imports should be organized" },
        dryRun: { type: "boolean", description: "Report edits without writing the file", default: false },
      },
      required: ["file_path"],
    },
  },
  {
    name: "fix_all",
    description:
      "Apply all auto-fixable diagnostics (source.fixAll) in a file via the language server. USE to clear mechanical warnings (unused vars, formatting rules) in one call. Do NOT use for errors that need a design decision — only mechanical fixes are applied.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File to fix" },
        dryRun: { type: "boolean", description: "Report edits without writing the file", default: false },
      },
      required: ["file_path"],
    },
  },
  {
    name: "extract_method",
    description:
      "Extract a line range into a new method/function via the language server. USE to split a long function without manual edit errors. Availability depends on the selected code (works on statements inside a body, not across declarations); returns an honest error when the server offers nothing.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File containing the code to extract" },
        start_line: { type: "number", description: "First line of the range (1-based)" },
        end_line: { type: "number", description: "Last line of the range (1-based)" },
        new_name: { type: "string", description: "Name for the extracted method/function" },
        dryRun: { type: "boolean", description: "Report edits without writing the file", default: false },
      },
      required: ["file_path", "start_line", "end_line", "new_name"],
    },
  },
  {
    name: "get_tool_stats",
    description:
      "Show per-tool call and error counters for this server process (telemetry for deciding what to fix or remove). Read-only, no parameters.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

const server = new Server(
  { name: "mcp-codebase", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const entry = TOOL_HANDLERS[name];
    if (!entry) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const parsed = entry.schema.parse(args);
    const text = await entry.handler(parsed as never);
    recordCall(name);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    recordError(name, err, args);
    const message = (err as Error).message;
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  await ensureDatabase();
  await initSchema();

  // Perform initial index if database is empty
  const { query } = await import("./db/connection.js");
  const countResult = await query("SELECT COUNT(*)::int as count FROM files");
  if (countResult.rows[0].count === 0) {
    console.error("Database empty, performing initial index...");
    const stats = await indexProject({ full: true });
    console.error(`Initial index complete: ${stats.scanned} files, ${stats.symbols} symbols`);
  }

  startWatcher(config.projectRoot);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Codebase server running on stdio");
}

process.on("SIGINT", async () => {
  const { closePool } = await import("./db/connection.js");
  const { stopWatcher } = await import("./indexer/watcher.js");
  await stopWatcher();
  await shutdownAll();
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  const { closePool } = await import("./db/connection.js");
  const { stopWatcher } = await import("./indexer/watcher.js");
  await stopWatcher();
  await shutdownAll();
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
