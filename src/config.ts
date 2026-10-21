export const config = {
  projectRoot: process.env.PROJECT_ROOT || process.cwd(),

  database: {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'codebase_index',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
  },

  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '.git/**',
    '*.min.js',
    '*.map',
    '**/bin/**',
    '**/obj/**',
    '**/.vs/**',
    '**/packages/**',
    '**/coverage/**',
    '**/.next/**',
  ],

  languageMap: {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
    '.mts': 'typescript',
    '.cs': 'csharp',
  } as Record<string, string>,

  batchSize: 1000,
  watchDebounceMs: 300,

  lsp: {
    enabled: process.env.LSP_ENABLED !== 'false',
    tsserverCmd: process.env.TSSERVER_CMD,
    csharpLsCmd: process.env.CSHARPLS_CMD || 'csharp-ls',
    startupTimeoutMs: parseInt(process.env.LSP_STARTUP_TIMEOUT_MS || '60000', 10),
    requestTimeoutMs: parseInt(process.env.LSP_REQUEST_TIMEOUT_MS || '30000', 10),
  },
};
