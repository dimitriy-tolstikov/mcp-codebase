import { getStats } from '../utils/stats.js';

export async function handleToolStats(): Promise<string> {
  const stats = getStats();
  if (stats.size === 0) {
    return 'No tool calls recorded yet in this server process.';
  }
  const rows = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const nameWidth = Math.max(...rows.map(([name]) => name.length), 4);
  const lines = rows.map(
    ([name, s]) => `${name.padEnd(nameWidth)}  calls: ${s.calls}  errors: ${s.errors}`
  );
  return `Tool usage statistics (since server start; counts reset on restart):\n\n${lines.join('\n')}\n\nNote: errors counted here are thrown exceptions only; user errors returned as plain text are not counted.`;
}
