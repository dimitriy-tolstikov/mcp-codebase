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
  get_tool_stats: { schema: z.object({}), handler: handleToolStats as ToolHandler },
};

const TOOLS: Tool[] = [
  {
    name: "search_symbols",
    description:
      "Search for symbols (functions, classes, interfaces, methods, etc.) across the codebase. Supports wildcards (*, ?) and OR operator (|). Filters by kind, language, and file path.",
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
      "Get full details about a symbol: source code, signature, docstring, imports in the file, and other symbols in the same file.",
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
      "Explore a directory/module: list files, key symbols, subdirectories, and top imports. Useful for understanding project structure.",
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
      "Find all usages/references of a symbol across the codebase. Searches in source files for occurrences of the symbol name. Note: this is plain text search, not semantic reference resolution; for precise rename/references use the rename_symbol/get_diagnostics LSP tools.",
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
    name: "get_module_dependencies",
    description:
      "Show dependencies of a file: what it imports, what it exports, and which files import it.",
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
      "Trigger a reindex of the codebase. Use full=true for complete reindex, or full=false for incremental (checks file mtimes).",
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
      "Semantically rename a symbol (function, class, method, variable) across the project via the language server. Do NOT use for a quick text replacement in one file you can edit yourself; do NOT use when LSP support is disabled (LSP_ENABLED=false).",
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
      "Get compiler/linter diagnostics (errors, warnings) from the language server for a file, or all stored diagnostics when file_path is omitted. Do NOT use to search for symbols — use search_symbols.",
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
      "Move/rename a file and update imports referencing it (TS/JS: full import rewrite via tsserver; C#: file move only, namespace updates not guaranteed). Do NOT use for renaming a symbol inside a file — use rename_symbol.",
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
      "Remove unused imports and sort the remaining ones in a file via the language server. Do NOT use to add missing imports.",
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
      "Apply all auto-fixable diagnostics (source.fixAll) in a file via the language server. Do NOT use for errors that need a design decision — the server only applies mechanical fixes.",
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
      "Extract a line range into a new method/function via the language server. Availability depends on the selected code; returns an honest error when no refactoring is offered. Do NOT use for ranges that span declarations (extract works on statements inside a body).",
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
