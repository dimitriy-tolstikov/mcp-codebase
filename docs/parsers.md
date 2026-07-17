# Parsers

Parsers turn source files into symbols, imports, and exports. The contract lives in
`src/parsers/interface.ts`; implementations: `typescript.ts` (AST-based) and `csharp.ts`
(regex-based).

## The `ILanguageParser` contract

```typescript
interface ILanguageParser {
  readonly supportedExtensions: string[];   // e.g. ['.ts', '.tsx']
  readonly languageId: string;              // e.g. 'typescript'
  parse(filePath: string, content: string): ParseResult | null;
}

interface ParseResult {
  language: string;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}
```

`SymbolInfo`: `name`, `kind`, `lineStart`/`lineEnd` (1-based), `colStart`/`colEnd`
(0-based), optional `signature`, `docstring`, `modifiers` (string array).

`ImportInfo`: `source`, optional `names` (string array), `isTypeOnly`.

`ExportInfo`: optional `name`, `symbolName`, `isDefault`, `isReexport`, `source`.

`SymbolKind` is a closed union of 14 values:

```
function  class  interface  method  property  variable  enum
type_alias  namespace  struct  field  constructor  delegate  event
```

## Registration

`src/indexer/indexer.ts` keeps two maps filled at module load:

- `parsers`: `languageId → parser`
- `extToParser`: `extension → parser` (used by both `indexProject` and `indexSingleFile`)

```typescript
registerParser(new TypeScriptParser());
registerParser(new CSharpParser());
```

A file whose extension has no parser is still recorded in `files` (metadata only).

## TypeScriptParser (`src/parsers/typescript.ts`)

Built on the TypeScript Compiler API (`ts.createSourceFile`, full AST walk).
Extensions: `.ts .tsx .js .jsx .mjs .cjs .mts` (`ScriptKind` from extension; TSX/JSX-aware).

**Symbols** — AST node kinds mapped to `SymbolKind`:

- functions: function declarations, function expressions, arrow functions
- classes (declarations and expressions), interfaces, type aliases, enums, namespaces
- methods (incl. signatures), properties (incl. signatures, getters/setters), constructors
- variables (each `VariableDeclaration`)

Only named nodes are recorded (anonymous ones become `<anonymous>`; constructors are named
`constructor`). Per symbol it also extracts:

- **modifiers** via `ts.getCombinedModifierFlags` (`export`, `default`, `async`,
  `abstract`, `static`, `public`, `private`, `protected`, `readonly`, `const`)
- **docstring** from JSDoc comments
- **signature** for function-like nodes: the first line of the node re-printed by
  `ts.createPrinter`

**Imports** — ES `import` declarations (default, named, `* as ns`, with `isTypeOnly`
flag), CommonJS `require("...")` calls, and `import x = require("...")`.

**Exports** — symbols with the `export` modifier (with `default` flag), named
`export { a, b }`, re-exports `export ... from "..."` (with `source`), and
`export default <expr>` / `export = <expr>`.

## CSharpParser (`src/parsers/csharp.ts`)

A lightweight, **line-oriented regex parser** — approximate by design. Extensions: `.cs`.

Extracts:

- **usings** → imports (`using static X;` is stored with a `static ` prefix)
- **types** — `class`, `interface`, `struct`, `enum`, `record` (with modifiers,
  base-type list ignored, line-level signature)
- **methods** — `modifiers ReturnType Name(params) {`; a method whose name equals the
  previously found symbol is reclassified as a `constructor`
- **auto-properties** — `Type Name { get; set; }`
- **fields** — `Type Name;` or with initializer
- **events** — `event Type Name`
- **docstrings** — `/// <summary>` text, searched up to 10 lines above the declaration

Any `public` symbol also produces an export record.

Known accuracy limits (do not "fix" silently — see
[Known limitations](development.md#known-limitations)):

- Local variables can be indexed as `field` (accepted false positive).
- Multi-line signatures, generic constraints, expression-bodied members, and nested
  contexts are approximated or missed.
- `lineEnd` always equals `lineStart` (declarations are matched per line).

## Adding a new language

1. **Create the parser**: `src/parsers/<lang>.ts` with a class implementing
   `ILanguageParser` (return `null` from `parse()` for files that should be skipped).
2. **Register it** in `src/indexer/indexer.ts` next to the existing `registerParser(...)`
   calls.
3. **Update the two hardcoded extension allowlists** so the file is picked up at runtime:
   - watcher: `src/indexer/watcher.ts` (`handleChange`)
   - usage search: `src/tools/find-usages.ts` (`searchDir`)
4. **Declare the mapping** in `config.languageMap` (`src/config.ts`) — currently
   informational (not read by code), but kept as the canonical extension → language list.

Then run `npm run build` and reindex (`reindex` tool with `full: true`).
