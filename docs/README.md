# mcp-codebase Documentation

`mcp-codebase` is an **MCP (Model Context Protocol) server** that gives an AI agent semantic
navigation over a codebase. It crawls a target project, parses source files into symbols,
imports, and exports, stores them in **PostgreSQL**, and exposes six high-level MCP tools
over **stdio**.

> The server indexes an *external* codebase pointed at by `PROJECT_ROOT` — not its own source.

For installation and a quick feature overview see the top-level [README.md](../README.md).
This folder contains the detailed, code-level documentation.

## Contents

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Runtime architecture: startup sequence, tool dispatch, indexing pipeline, watch mode, shutdown |
| [configuration.md](configuration.md) | Environment variables, hardcoded tuning in `src/config.ts`, connection pool settings |
| [database.md](database.md) | PostgreSQL schema (tables, indexes), repository functions, symbol search semantics |
| [tools.md](tools.md) | Reference for the six MCP tools: parameters, behavior, output format, examples |
| [parsers.md](parsers.md) | `ILanguageParser` contract, the TypeScript and C# parsers, how to add a language |
| [development.md](development.md) | Build/run, code style, adding tools, schema changes, testing, security, known limitations |

## Reading guide

- **Working on a tool's behavior** → [tools.md](tools.md) + [database.md](database.md)
- **Working on indexing or the watcher** → [architecture.md](architecture.md) + [parsers.md](parsers.md)
- **Adding a language** → [parsers.md](parsers.md)
- **Adding an MCP tool** → [tools.md](tools.md) + [development.md](development.md)
- **Changing configuration or deployment** → [configuration.md](configuration.md)
- **Anything else** → start with [development.md](development.md)

## Source layout at a glance

```
src/
├── index.ts        # MCP server entry point, tool registry, startup sequence
├── config.ts       # All configuration (env vars + hardcoded tuning)
├── db/             # PostgreSQL: connection pool, schema DDL, queries
├── indexer/        # File crawler, indexing orchestration, chokidar watcher
├── parsers/        # ILanguageParser contract + TypeScript and C# parsers
├── tools/          # One file per MCP tool (zod schema + handler)
└── utils/          # .gitignore loading, path helpers
```

## Keeping these docs current

These documents describe the **actual code**, not intentions. If you find a discrepancy,
the code wins — update the document. Any code change should come with an update to the
affected document in the same commit (this workflow is also stated in `AGENTS.md`).
