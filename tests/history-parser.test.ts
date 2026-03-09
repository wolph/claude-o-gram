import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHistoryUsage } from '../src/monitoring/history-parser.js';

describe('parseHistoryUsage', () => {
  let dir: string;
  let historyPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `history-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    historyPath = join(dir, 'history.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map for missing file', async () => {
    const result = await parseHistoryUsage(join(dir, 'missing.jsonl'));
    expect(result.size).toBe(0);
  });

  it('counts slash commands from display field', async () => {
    const lines = [
      JSON.stringify({ display: '/gsd:progress some args', timestamp: 1 }),
      JSON.stringify({ display: '/gsd:progress', timestamp: 2 }),
      JSON.stringify({ display: '/clear', timestamp: 3 }),
      JSON.stringify({ display: 'not a command', timestamp: 4 }),
    ].join('\n');
    writeFileSync(historyPath, lines);

    const result = await parseHistoryUsage(historyPath);
    expect(result.get('gsd:progress')).toBe(2);
    expect(result.get('clear')).toBe(1);
    expect(result.has('not a command')).toBe(false);
  });

  it('skips lines starting with //', async () => {
    const lines = [
      JSON.stringify({ display: '//not-a-command', timestamp: 1 }),
      JSON.stringify({ display: '/real', timestamp: 2 }),
    ].join('\n');
    writeFileSync(historyPath, lines);

    const result = await parseHistoryUsage(historyPath);
    expect(result.has('not-a-command')).toBe(false);
    expect(result.get('real')).toBe(1);
  });

  it('skips malformed JSON lines gracefully', async () => {
    const lines = [
      'not json',
      JSON.stringify({ display: '/good', timestamp: 1 }),
    ].join('\n');
    writeFileSync(historyPath, lines);

    const result = await parseHistoryUsage(historyPath);
    expect(result.get('good')).toBe(1);
  });
});
