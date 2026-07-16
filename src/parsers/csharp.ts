import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, ExportInfo, SymbolKind } from './interface.js';

// Lightweight regex-based parser for C#.
// Good enough for indexing: classes, interfaces, methods, properties, fields, enums, structs, using directives.

const USING_REGEX = /^\s*using\s+(static\s+)?([^;]+);/gm;

const XML_DOC_REGEX = /\/\/\/\s*<summary>\s*([^<]+)/;

const MODIFIERS = ['public', 'private', 'protected', 'internal', 'static', 'abstract', 'virtual', 'override', 'async', 'sealed', 'partial', 'readonly', 'const'];

function extractModifiers(line: string): string[] {
  const mods: string[] = [];
  for (const m of MODIFIERS) {
    const regex = new RegExp(`\\b${m}\\b`);
    if (regex.test(line)) mods.push(m);
  }
  return mods;
}

function extractDocstring(lines: string[], startLine: number): string | undefined {
  for (let i = startLine - 1; i >= Math.max(0, startLine - 10); i--) {
    const m = lines[i].match(XML_DOC_REGEX);
    if (m) return m[1].trim();
    if (!lines[i].trim().startsWith('///')) break;
  }
  return undefined;
}

function buildSignature(modifiers: string[], returnType: string | null, name: string, params: string | null): string {
  const mods = modifiers.filter(m => m !== 'public' && m !== 'private' && m !== 'protected' && m !== 'internal').join(' ');
  let sig = '';
  if (mods) sig += mods + ' ';
  if (returnType) sig += returnType + ' ';
  sig += name;
  if (params) sig += '(' + params + ')';
  else sig += '()';
  return sig.trim();
}

export class CSharpParser implements ILanguageParser {
  readonly supportedExtensions = ['.cs'];
  readonly languageId = 'csharp';

  parse(filePath: string, content: string): ParseResult | null {
    const lines = content.split(/\r?\n/);
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];

    // Extract usings
    let m: RegExpExecArray | null;
    while ((m = USING_REGEX.exec(content)) !== null) {
      const isStatic = !!m[1];
      const source = m[2].trim();
      imports.push({ source: isStatic ? `static ${source}` : source });
    }

    const lineRegex = /^(\s*)(?:([\w\s<>\[\],?]+)\s+)?(\w+)\s*(?:<(\w+)>\s*)?\(([^)]*)\)\s*{|^(\s*)(?:([\w\s<>\[\],?]+)\s+)?(class|interface|struct|enum|record)\s+(\w+)|^(\s*)(?:([\w\s<>\[\],?]+)\s+)?(\w+)\s*\{\s*get;\s*set;\s*\}|^(\s*)(?:([\w\s<>\[\],?]+)\s+)?(\w+)\s*;\s*$/gm;

    // Simple line-by-line extraction for better accuracy on standard C# patterns
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comments and usings
      if (trimmed.startsWith('//') || trimmed.startsWith('using ') || trimmed.startsWith('[')) continue;

      // Class / Interface / Struct / Enum / Record
      const typeMatch = trimmed.match(/^(?:(public|internal|private|protected|abstract|sealed|partial|static)\s+)*\b(class|interface|struct|enum|record)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?/);
      if (typeMatch) {
        const mods = extractModifiers(trimmed);
        const kind = typeMatch[2] as SymbolKind;
        const name = typeMatch[3];
        symbols.push({
          name,
          kind,
          lineStart: i + 1,
          lineEnd: i + 1,
          colStart: 0,
          colEnd: line.length,
          signature: trimmed,
          docstring: extractDocstring(lines, i),
          modifiers: mods,
        });
        if (mods.includes('public')) {
          exports.push({ name, symbolName: name });
        }
        continue;
      }

      // Method (including constructors)
      const methodMatch = trimmed.match(/^(?:(public|internal|private|protected|static|abstract|virtual|override|async|sealed)\s+)*([\w<>,\[\]\s?]+)\s+(\w+)\s*\(([^)]*)\)\s*\{/);
      if (methodMatch) {
        const mods = extractModifiers(trimmed);
        const returnType = methodMatch[2].trim();
        const name = methodMatch[3];
        const params = methodMatch[4].trim();
        const kind: SymbolKind = name === symbols[symbols.length - 1]?.name ? 'constructor' : 'method';
        symbols.push({
          name,
          kind,
          lineStart: i + 1,
          lineEnd: i + 1,
          colStart: 0,
          colEnd: line.length,
          signature: buildSignature(mods, returnType, name, params),
          docstring: extractDocstring(lines, i),
          modifiers: mods,
        });
        if (mods.includes('public')) {
          exports.push({ name, symbolName: name });
        }
        continue;
      }

      // Property (auto-property)
      const propMatch = trimmed.match(/^(?:(public|internal|private|protected|static|abstract|virtual|override|sealed)\s+)*([\w<>,\[\]\s?]+)\s+(\w+)\s*\{\s*(get|set)\b/);
      if (propMatch) {
        const mods = extractModifiers(trimmed);
        const name = propMatch[3];
        symbols.push({
          name,
          kind: 'property',
          lineStart: i + 1,
          lineEnd: i + 1,
          colStart: 0,
          colEnd: line.length,
          signature: trimmed,
          docstring: extractDocstring(lines, i),
          modifiers: mods,
        });
        if (mods.includes('public')) {
          exports.push({ name, symbolName: name });
        }
        continue;
      }

      // Field
      const fieldMatch = trimmed.match(/^(?:(public|internal|private|protected|static|readonly|const)\s+)*([\w<>,\[\]\s?]+)\s+(\w+)\s*(?:=\s*[^;]+)?;\s*$/);
      if (fieldMatch) {
        const mods = extractModifiers(trimmed);
        const name = fieldMatch[3];
        // Avoid matching local variables by requiring a type indicator or being inside a class context
        // Heuristic: skip if previous non-empty line ends with ')' or '}' — likely method body
        // For MVP we accept some false positives
        symbols.push({
          name,
          kind: 'field',
          lineStart: i + 1,
          lineEnd: i + 1,
          colStart: 0,
          colEnd: line.length,
          signature: trimmed,
          docstring: extractDocstring(lines, i),
          modifiers: mods,
        });
        if (mods.includes('public')) {
          exports.push({ name, symbolName: name });
        }
        continue;
      }

      // Event
      const eventMatch = trimmed.match(/^(?:(public|internal|private|protected|static|virtual|override)\s+)*event\s+([\w<>,\[\]\s?]+)\s+(\w+)(?:\s*;|\s*\{)/);
      if (eventMatch) {
        const mods = extractModifiers(trimmed);
        const name = eventMatch[3];
        symbols.push({
          name,
          kind: 'event',
          lineStart: i + 1,
          lineEnd: i + 1,
          colStart: 0,
          colEnd: line.length,
          signature: trimmed,
          docstring: extractDocstring(lines, i),
          modifiers: mods,
        });
        if (mods.includes('public')) {
          exports.push({ name, symbolName: name });
        }
      }
    }

    return { language: 'csharp', symbols, imports, exports };
  }
}
