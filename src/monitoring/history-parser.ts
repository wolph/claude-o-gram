import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Parse ~/.claude/history.jsonl to count command usage.
 *
 * Each line is a JSON object with a `display` field. Lines where
 * `display` starts with `/` (but not `//`) are commands. The first
 * whitespace-delimited token is the command name (strip leading `/`).
 *
 * @returns Map of claudeName → invocation count
 */
export async function parseHistoryUsage(historyPath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (!existsSync(historyPath)) return counts;

  const rl = createInterface({
    input: createReadStream(historyPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { display?: string };
      const display = entry.display ?? '';
      if (!display.startsWith('/') || display.startsWith('//')) continue;
      const raw = display.split(/\s+/)[0].slice(1).replace(/_/g, ':'); // strip leading /, normalize _ → :
      if (!raw) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    } catch {
      // skip malformed lines
    }
  }

  return counts;
}
