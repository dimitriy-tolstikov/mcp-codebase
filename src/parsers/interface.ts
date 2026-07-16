export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'method'
  | 'property'
  | 'variable'
  | 'enum'
  | 'type_alias'
  | 'namespace'
  | 'struct'
  | 'field'
  | 'constructor'
  | 'delegate'
  | 'event';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  lineStart: number;
  lineEnd: number;
  colStart: number;
  colEnd: number;
  signature?: string;
  docstring?: string;
  modifiers?: string[];
}

export interface ImportInfo {
  source: string;
  names?: string[];
  isTypeOnly?: boolean;
}

export interface ExportInfo {
  name?: string;
  symbolName?: string;
  isDefault?: boolean;
  isReexport?: boolean;
  source?: string;
}

export interface ParseResult {
  language: string;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
}

export interface ILanguageParser {
  readonly supportedExtensions: string[];
  readonly languageId: string;
  parse(filePath: string, content: string): ParseResult | null;
}
