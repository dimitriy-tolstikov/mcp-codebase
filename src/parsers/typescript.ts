import ts from 'typescript';
import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, ExportInfo, SymbolKind } from './interface.js';

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.ts')) return ts.ScriptKind.TS;
  if (filePath.endsWith('.mts')) return ts.ScriptKind.TS;
  if (filePath.endsWith('.cts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function getModifiers(node: ts.Node): string[] {
  const mods: string[] = [];
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  if (flags & ts.ModifierFlags.Export) mods.push('export');
  if (flags & ts.ModifierFlags.Default) mods.push('default');
  if (flags & ts.ModifierFlags.Async) mods.push('async');
  if (flags & ts.ModifierFlags.Abstract) mods.push('abstract');
  if (flags & ts.ModifierFlags.Static) mods.push('static');
  if (flags & ts.ModifierFlags.Public) mods.push('public');
  if (flags & ts.ModifierFlags.Private) mods.push('private');
  if (flags & ts.ModifierFlags.Protected) mods.push('protected');
  if (flags & ts.ModifierFlags.Readonly) mods.push('readonly');
  if (flags & ts.ModifierFlags.Const) mods.push('const');
  return mods;
}

function getDocString(node: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(node);
  if (!docs.length) return undefined;
  return docs
    .map((d) => (typeof d.comment === 'string' ? d.comment : ''))
    .filter(Boolean)
    .join('\n') || undefined;
}

function buildSignature(node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration): string | undefined {
  try {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const file = ts.createSourceFile('tmp.ts', '', ts.ScriptTarget.Latest);
    return printer.printNode(ts.EmitHint.Unspecified, node, file).split('\n')[0].trim();
  } catch {
    return undefined;
  }
}

function getKind(node: ts.Node): SymbolKind | null {
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
      return 'function';
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return 'class';
    case ts.SyntaxKind.InterfaceDeclaration:
      return 'interface';
    case ts.SyntaxKind.TypeAliasDeclaration:
      return 'type_alias';
    case ts.SyntaxKind.EnumDeclaration:
      return 'enum';
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
      return 'method';
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
      return 'property';
    case ts.SyntaxKind.VariableDeclaration:
      return 'variable';
    case ts.SyntaxKind.ModuleDeclaration:
      return 'namespace';
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return 'property';
    case ts.SyntaxKind.Constructor:
      return 'constructor';
    default:
      return null;
  }
}

export class TypeScriptParser implements ILanguageParser {
  readonly supportedExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts'];
  readonly languageId = 'typescript';

  parse(filePath: string, content: string): ParseResult | null {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(filePath)
    );

    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];

    const visit = (node: ts.Node) => {
      const kind = getKind(node);
      if (kind) {
        const nameNode = (node as any).name;
        const name = nameNode && ts.isIdentifier(nameNode) ? nameNode.text : (kind === 'constructor' ? 'constructor' : undefined);
        if (name || kind === 'constructor') {
          const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
          const mods = getModifiers(node);

          let signature: string | undefined;
          if (
            ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isArrowFunction(node) ||
            ts.isFunctionExpression(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isGetAccessor(node) ||
            ts.isSetAccessor(node)
          ) {
            signature = buildSignature(node);
          }

          symbols.push({
            name: name || '<anonymous>',
            kind,
            lineStart: start.line + 1,
            lineEnd: end.line + 1,
            colStart: start.character,
            colEnd: end.character,
            signature,
            docstring: getDocString(node),
            modifiers: mods,
          });

          if (mods.includes('export')) {
            exports.push({
              name,
              symbolName: name,
              isDefault: mods.includes('default'),
            });
          }
        }
      }

      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const source = moduleSpecifier.text;
          const names: string[] = [];
          let isTypeOnly = false;
          if (node.importClause) {
            isTypeOnly = node.importClause.isTypeOnly;
            if (node.importClause.name) {
              names.push(node.importClause.name.text);
            }
            if (node.importClause.namedBindings) {
              if (ts.isNamedImports(node.importClause.namedBindings)) {
                for (const el of node.importClause.namedBindings.elements) {
                  names.push(el.name.text);
                }
              } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                names.push(`* as ${node.importClause.namedBindings.name.text}`);
              }
            }
          }
          imports.push({ source, names: names.length ? names : undefined, isTypeOnly });
        }
      }

      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.Identifier) {
        const expr = node.expression as ts.Identifier;
        if (expr.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
          imports.push({ source: node.arguments[0].text });
        }
      }

      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        imports.push({ source: node.moduleReference.expression.text, names: [node.name.text] });
      }

      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          // re-export
          const names: string[] = [];
          if (node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              names.push(el.name.text);
            }
          }
          exports.push({
            name: names.join(', ') || undefined,
            isReexport: true,
            source: node.moduleSpecifier.text,
          });
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            exports.push({
              name: el.name.text,
              symbolName: el.propertyName?.text || el.name.text,
            });
          }
        }
      }

      if (ts.isExportAssignment(node)) {
        exports.push({
          isDefault: !node.isExportEquals,
          name: node.expression.getText(sourceFile),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return { language: 'typescript', symbols, imports, exports };
  }
}
