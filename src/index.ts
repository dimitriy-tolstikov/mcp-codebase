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
      "Find all usages/references of a symbol across the codebase. Searches in source files for occurrences of the symbol name.",
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
    switch (name) {
      case "search_symbols": {
        const parsed = SearchSymbolsSchema.parse(args);
        const text = await handleSearchSymbols(parsed);
        return { content: [{ type: "text", text }] };
      }
      case "get_symbol_details": {
        const parsed = SymbolDetailsSchema.parse(args);
        const text = await handleSymbolDetails(parsed);
        return { content: [{ type: "text", text }] };
      }
      case "explore_module": {
        const parsed = ExploreModuleSchema.parse(args);
        const text = await handleExploreModule(parsed);
        return { content: [{ type: "text", text }] };
      }
      case "find_usages": {
        const parsed = FindUsagesSchema.parse(args);
        const text = await handleFindUsages(parsed);
        return { content: [{ type: "text", text }] };
      }
      case "get_module_dependencies": {
        const parsed = ModuleDepsSchema.parse(args);
        const text = await handleModuleDeps(parsed);
        return { content: [{ type: "text", text }] };
      }
      case "reindex": {
        const parsed = ReindexSchema.parse(args);
        const text = await handleReindex(parsed);
        return { content: [{ type: "text", text }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
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
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  const { closePool } = await import("./db/connection.js");
  const { stopWatcher } = await import("./indexer/watcher.js");
  await stopWatcher();
  await closePool();
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
