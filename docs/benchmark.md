# Benchmarking

How to measure whether this server actually saves an AI agent tokens and time, and how to
compare it against alternatives (grep-only agent loops, Serena, Claude Context, etc.).

## Metrics

| Metric | How we measure it | Why |
|---|---|---|
| Context bytes | Sum of bytes returned by tool calls (proxy for tokens, ~4 chars/token) | Token spend is the primary cost driver |
| Tool calls | Count per task | Fewer round-trips = faster agent |
| Wall time | `performance.now()` around each call | Latency compounds in agent loops |
| Correctness | Expected substring / known-answer check per task | Speed without correctness is useless |

Bytes are used instead of tokens so the benchmark runs without any LLM in the loop; the
agent-level variant (Level B) measures real tokens via the model's API usage counters.

## Level A — micro-benchmark (`npm run benchmark`)

`benchmarks/run-micro.mjs` spawns the built server (`dist/index.js`) as an MCP stdio server
against `PROJECT_ROOT` (defaults to this repository) and replays the fixed task suite in
`benchmarks/tasks.json`. Each task names a tool, its arguments, an `expect` substring
(correctness check), and an optional `grep` pattern used to emulate the baseline.

The **grep-only baseline** emulates what an agent without this server does: run
`grep -rn` for the symbol, then read the matching files fully into context (capped at the
first 10 files). The reported "baseline bytes" are the grep output plus those file reads —
that is the context an agent would actually pull in.

Output: a Markdown table written to `benchmarks/results-<date>.md` with per-task latency,
tool bytes, baseline bytes, and the aggregate ratio.

```bash
npm run build
PROJECT_ROOT=/path/to/repo npm run benchmark
```

### Reference results (this repository, ~56 files / 744 symbols, 2026-10-10)

| Task | Tool | Latency | Bytes (tool) | Bytes (grep baseline) |
|---|---|---|---|---|
| project map | project_overview | 204 ms | 2 048 | — |
| find symbol by name | search_symbols | 81 ms | 818 | 18 981 |
| fuzzy symbol search | search_symbols | 70 ms | 315 | 20 379 |
| symbol details | get_symbol_details | 207 ms | 1 479 | 18 981 |
| module overview | explore_module | 18 ms | 1 579 | 5 869 |
| text usages | find_usages | 6 ms | 729 | 17 843 |
| semantic references | find_references | 3 706 ms | 256 | 18 981 |
| go to definition | go_to_definition | 14 ms | 284 | 18 981 |
| module dependencies | get_module_dependencies | 7 ms | 904 | 26 920 |

Total: **8.2 KB via tools vs 147 KB via the grep loop (~18x less context)**, with
single-digit millisecond latency for index-backed tools. LSP-backed tools are slower on a
cold language server (first `find_references` warms up tsserver) and fast afterwards.

### How to extend the suite

Add entries to `benchmarks/tasks.json`. Rules for a good task:

- a realistic agent question ("find definition of X", "who calls Y", "what does module Z export");
- `expect` — a substring a correct answer must contain;
- `grep` — the pattern an agent without the server would realistically search for.

Run the suite against at least three codebases before drawing conclusions:

- **small** (<50k LOC), **medium** (~200k LOC), **large** (>500k LOC).

The relative win of the index grows with repository size; on tiny repos grep latency is
already fine and only the byte savings remain.

## Level B — agent-level A/B

Micro-bytes are a proxy. The real question is end-to-end agent cost on real tasks.
Methodology (following the approach Augment Code published for their Context Engine):

1. **Task set**: 20–50 real issues/PRs from the target repository's history (bug fixes and
   small features where the "correct" diff exists). Prompt the agent with the issue text only.
2. **Arms**: the same agent, model, and prompt — once with the MCP server connected,
   once with shell grep/read only. Optionally a third arm with a competitor server
   (Serena, Claude Context) for cross-tool comparison.
3. **Fixed everything else**: same model + temperature, same system prompt, same task order;
   warm the index/language servers before timing (or report cold vs warm separately).
4. **n ≥ 3 runs per arm**; report medians, not best runs.
5. **Metrics**: total tokens (input+output from API usage), wall time, number of tool calls,
   and quality — does the produced patch pass the PR's tests / match the reference diff's
   behavior. Score quality blind if human-rated.

### Honesty rules

- Never copy competitor numbers without reproducing them under this protocol.
- Report the exact commit, model version, and server config (env vars) alongside numbers.
- If a tool loses on some task class (e.g. grep wins on tiny repos), publish that.

## Qualitative comparison (feature matrix, 2026-10)

| | mcp-codebase | Serena | Claude Context | grep-only agent |
|---|---|---|---|---|
| Persistent index | PostgreSQL (pg_trgm) | none (LSP on the fly) | vector DB (Milvus) | none |
| Symbol search | exact/wildcard/fuzzy trigram | LSP symbol search | embeddings + BM25 | grep |
| Semantic references/definition | yes (LSP) | yes (LSP) | no | no |
| Refactoring (rename/move/extract) | yes (LSP) | yes (LSP) | no | manual edits |
| Diagnostics | yes (LSP) | yes | no | build output only |
| Languages (index / LSP) | 2 / 2 | many via LSP | many via AST chunking | all |
| External services | PostgreSQL only | none | Milvus + embedding API | none |
| Cold start | instant (index in DB) | LSP warm-up per project | re-indexing | instant |

Deliberate scope boundaries: no embeddings/semantic search (a documented trade-off, not an
oversight), index parsers are TS/JS + C#-heuristic only.
