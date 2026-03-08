import { describe, it, expect } from 'vitest';
import {
  parseOpenSessionTranscripts,
  resolveProjectPathForSession,
  type SessionsIndexEntry,
} from '../src/sessions/live-session-discovery.js';

describe('live session discovery', () => {
  it('parses open transcript files from lsof output', () => {
    const output = [
      'p1234',
      'cnode',
      'n/home/cryptobot/.claude/projects/-home-cryptobot-workspace-jesse/7354ad46-4feb-4749-9cc1-3b1d8d98cc1d.jsonl',
      'n/home/cryptobot/.claude/projects/-home-cryptobot-workspace-jesse/sessions-index.json',
      'p5678',
      'cpython',
      'n/home/cryptobot/.claude/projects/-home-cryptobot-workspace-foo/not-a-session.txt',
      'n/home/cryptobot/.claude/projects/-home-cryptobot-workspace-foo/857e9cc7-7fa7-43e4-8e8f-b7f0d63fbcd9.jsonl',
    ].join('\n');

    const found = parseOpenSessionTranscripts(output, '/home/cryptobot/.claude/projects');

    expect(found.map((v) => v.sessionId)).toEqual([
      '7354ad46-4feb-4749-9cc1-3b1d8d98cc1d',
      '857e9cc7-7fa7-43e4-8e8f-b7f0d63fbcd9',
    ]);
    expect(found[0].transcriptPath).toContain('7354ad46-4feb-4749-9cc1-3b1d8d98cc1d.jsonl');
  });

  it('resolves cwd from sessions-index entries by session id or path', () => {
    const entries: SessionsIndexEntry[] = [
      {
        sessionId: '7354ad46-4feb-4749-9cc1-3b1d8d98cc1d',
        fullPath: '/home/cryptobot/.claude/projects/-home-cryptobot-workspace-jesse/7354ad46-4feb-4749-9cc1-3b1d8d98cc1d.jsonl',
        projectPath: '/home/cryptobot/workspace/jesse',
      },
      {
        sessionId: 'other-id',
        fullPath: '/home/cryptobot/.claude/projects/-home-cryptobot-workspace-foo/857e9cc7-7fa7-43e4-8e8f-b7f0d63fbcd9.jsonl',
        projectPath: '/home/cryptobot/workspace/foo',
      },
    ];

    const direct = resolveProjectPathForSession(
      '7354ad46-4feb-4749-9cc1-3b1d8d98cc1d',
      '/home/cryptobot/.claude/projects/-home-cryptobot-workspace-jesse/7354ad46-4feb-4749-9cc1-3b1d8d98cc1d.jsonl',
      entries,
    );
    expect(direct).toBe('/home/cryptobot/workspace/jesse');

    const byPath = resolveProjectPathForSession(
      '857e9cc7-7fa7-43e4-8e8f-b7f0d63fbcd9',
      '/home/cryptobot/.claude/projects/-home-cryptobot-workspace-foo/857e9cc7-7fa7-43e4-8e8f-b7f0d63fbcd9.jsonl',
      entries,
    );
    expect(byPath).toBe('/home/cryptobot/workspace/foo');
  });
});
