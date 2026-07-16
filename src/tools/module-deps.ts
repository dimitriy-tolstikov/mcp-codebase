import path from 'path';
import { z } from 'zod';
import { query } from '../db/connection.js';
import { getFileByPath, getImportsInFile, getExportsInFile } from '../db/repositories.js';

export const ModuleDepsSchema = z.object({
  path: z.string().describe('File path relative to project root'),
});

export async function handleModuleDeps(args: z.infer<typeof ModuleDepsSchema>): Promise<string> {
  const filePath = args.path.replace(/\\/g, '/');
  const file = await getFileByPath(filePath);

  if (!file) {
    return `File not found in index: ${filePath}`;
  }

  const imports = await getImportsInFile(file.id);
  const exports = await getExportsInFile(file.id);

  // Find files that import this module (heuristic)
  const usedByResult = await query(
    `SELECT DISTINCT f.path
     FROM imports i
     JOIN files f ON i.file_id = f.id
     WHERE i.source LIKE $1 AND f.path != $2
     LIMIT 50`,
    [`%${pathToModuleName(filePath)}%`, filePath]
  );

  let output = `File: ${filePath}\n`;

  if (imports.length) {
    const internal: string[] = [];
    const external: string[] = [];
    for (const imp of imports) {
      const src = imp.source as string;
      const names = imp.names ? JSON.parse(imp.names).join(', ') : '';
      const line = `  - ${src}${names ? ` (${names})` : ''}${imp.is_type_only ? ' [type-only]' : ''}`;
      if (src.startsWith('.') || src.startsWith('/')) {
        internal.push(line);
      } else {
        external.push(line);
      }
    }

    output += `\nImports (what this file depends on):\n`;
    if (internal.length) {
      output += `  Internal:\n${internal.join('\n')}\n`;
    }
    if (external.length) {
      output += `  External:\n${external.join('\n')}\n`;
    }
  }

  if (exports.length) {
    output += `\nExported symbols:\n`;
    for (const exp of exports) {
      let line = `  - ${exp.name || exp.symbol_name || '<unknown>'}`;
      if (exp.is_default) line += ' [default]';
      if (exp.is_reexport) line += ` [re-export from ${exp.source}]`;
      output += line + '\n';
    }
  }

  if (usedByResult.rows.length) {
    output += `\nUsed by (files that import this module):\n`;
    for (const row of usedByResult.rows) {
      output += `  - ${row.path}\n`;
    }
  }

  return output;
}

function pathToModuleName(filePath: string): string {
  // Simple heuristic: remove extension, return basename or last dir + basename
  const withoutExt = filePath.replace(/\.[^/.]+$/, '');
  return path.posix.basename(withoutExt);
}
