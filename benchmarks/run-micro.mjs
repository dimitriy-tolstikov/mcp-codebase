#!/usr/bin/env node
// Micro-benchmark: runs the fixed task suite (benchmarks/tasks.json) against the
// MCP server over stdio and against a grep-only baseline, measuring latency and
// response bytes (a proxy for token spend). Writes benchmarks/results-<date>.md.
//
// Usage: PROJECT_ROOT=<target repo> node benchmarks/run-micro.mjs [--no-baseline]
// Requires: npm run build, a reachable PostgreSQL (same env vars as the server).

import { spawn, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const projectRoot = process.env.PROJECT_ROOT || root;
const withBaseline = !process.argv.includes('--no-baseline');

const tasks = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf-8'));

function byteLen(s) {
  return Buffer.byteLength(s ?? '', 'utf-8');
}

async function runGrepBaseline(task) {
  // Emulates the agent's grep-then-read loop: search, then read matching files
  // fully (that is what the agent would pull into context).
  if (!task.grep) return null;
  const start = performance.now();
  const grepOut = await new Promise((resolve) => {
    execFile(
      'grep', ['-rnE', task.grep, projectRoot,
        '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.cs',
        '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.git'],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? '' : stdout)
    );
  });
  let bytes = byteLen(grepOut);
  const files = [...new Set(
    grepOut.split('\n').filter(Boolean).map((l) => l.split(':')[0])
  )].slice(0, 10);
  for (const f of files) {
    try {
      bytes += byteLen(fs.readFileSync(f, 'utf-8'));
    } catch { /* file gone */ }
  }
  return { ms: performance.now() - start, bytes, filesRead: files.length };
}

async function main() {
  const serverPath = path.join(root, 'dist', 'index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, PROJECT_ROOT: projectRoot },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'benchmark', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const results = [];
  for (const task of tasks) {
    const start = performance.now();
    let text = '';
    let ok = true;
    try {
      const res = await client.callTool({ name: task.tool, arguments: task.args });
      text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      if (res.isError) ok = false;
      if (task.expect && !text.includes(task.expect)) ok = false;
    } catch (err) {
      ok = false;
      text = String(err);
    }
    const ms = performance.now() - start;
    const baseline = withBaseline ? await runGrepBaseline(task) : null;
    results.push({ task, ms, bytes: byteLen(text), ok, baseline });
    console.error(`[${ok ? 'ok' : 'FAIL'}] ${task.name}: ${ms.toFixed(0)}ms, ${byteLen(text)}B`);
  }

  await client.close();

  const date = new Date().toISOString().slice(0, 10);
  let md = `# Micro-benchmark results — ${date}\n\n`;
  md += `PROJECT_ROOT: \`${projectRoot}\`\n\n`;
  md += `| Task | Tool | OK | Latency | Bytes (tool) | Bytes (grep baseline) | Baseline files read |\n`;
  md += `|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    md += `| ${r.task.name} | ${r.task.tool} | ${r.ok ? 'yes' : 'NO'} | ${r.ms.toFixed(0)} ms | ${r.bytes} | ${r.baseline ? r.baseline.bytes : '—'} | ${r.baseline ? r.baseline.filesRead : '—'} |\n`;
  }
  const totBytes = results.reduce((s, r) => s + r.bytes, 0);
  const totBaseline = results.reduce((s, r) => s + (r.baseline?.bytes ?? 0), 0);
  md += `\nTotal tool bytes: ${totBytes}; total grep-baseline bytes: ${totBaseline}`;
  if (totBaseline > 0) md += ` (${(totBaseline / Math.max(totBytes, 1)).toFixed(1)}x more)\n`;

  const outPath = path.join(here, `results-${date}.md`);
  fs.writeFileSync(outPath, md);
  console.log(md);
  console.error(`\nReport written to ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
