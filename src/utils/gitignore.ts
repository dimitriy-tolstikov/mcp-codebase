import fs from 'fs';
import path from 'path';
import ignoreLib from 'ignore';

export function loadGitignore(rootDir: string): ignoreLib.Ignore {
  const ig = ignoreLib.default();
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    ig.add(content);
  }
  return ig;
}
