import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from '../src/sessions/session-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import type { SessionInfo } from '../src/types/sessions.js';

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: randomBytes(8).toString('hex'),
    threadId: Math.floor(Math.random() * 100000),
    topicName: 'test-topic',
    cwd: '/tmp/test',
    model: 'claude-sonnet-4-20250514',
    status: 'active',
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    toolCallCount: 0,
    filesChanged: new Set<string>(),
    suppressedCounts: {},
    statusMessageId: 0,
    contextPercent: 0,
    transcriptPath: '/tmp/transcript.jsonl',
    ...overrides,
  };
}

describe('SessionStore', () => {
  let testDir: string;
  let filePath: string;
  let store: SessionStore;

  beforeEach(() => {
    testDir = join(tmpdir(), `session-store-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(testDir, { recursive: true });
    filePath = join(testDir, 'sessions.json');
    store = new SessionStore(filePath);
  });

  afterEach(() => {
    try { unlinkSync(filePath); } catch { /* ok */ }
    try { unlinkSync(filePath + '.tmp'); } catch { /* ok */ }
    try { rmdirSync(testDir); } catch { /* ok */ }
  });

  it('stores and retrieves sessions', () => {
    const session = makeSession({ sessionId: 'test-1' });
    store.set('test-1', session);
    expect(store.get('test-1')).toBeDefined();
    expect(store.get('test-1')!.sessionId).toBe('test-1');
  });

  it('returns undefined for missing sessions', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  describe('getByThreadId', () => {
    it('finds session by thread ID', () => {
      const session = makeSession({ sessionId: 'a', threadId: 42 });
      store.set('a', session);
      expect(store.getByThreadId(42)?.sessionId).toBe('a');
    });

    it('prefers active over closed sessions', () => {
      const closed = makeSession({ sessionId: 'old', threadId: 42, status: 'closed' });
      const active = makeSession({ sessionId: 'new', threadId: 42, status: 'active' });
      store.set('old', closed);
      store.set('new', active);
      expect(store.getByThreadId(42)?.sessionId).toBe('new');
    });

    it('falls back to closed if no active match', () => {
      const closed = makeSession({ sessionId: 'old', threadId: 42, status: 'closed' });
      store.set('old', closed);
      expect(store.getByThreadId(42)?.sessionId).toBe('old');
    });

    it('returns undefined when no match', () => {
      expect(store.getByThreadId(999)).toBeUndefined();
    });
  });

  describe('getActiveByCwd', () => {
    it('finds active session by cwd', () => {
      const session = makeSession({ sessionId: 'a', cwd: '/tmp/project' });
      store.set('a', session);
      expect(store.getActiveByCwd('/tmp/project')?.sessionId).toBe('a');
    });

    it('ignores closed sessions', () => {
      const session = makeSession({ sessionId: 'a', cwd: '/tmp/project', status: 'closed' });
      store.set('a', session);
      expect(store.getActiveByCwd('/tmp/project')).toBeUndefined();
    });
  });

  it('updates status', () => {
    const session = makeSession({ sessionId: 'a' });
    store.set('a', session);
    store.updateStatus('a', 'closed');
    expect(store.get('a')!.status).toBe('closed');
  });

  it('updates thread ID', () => {
    const session = makeSession({ sessionId: 'a', threadId: 1 });
    store.set('a', session);
    store.updateThreadId('a', 99);
    expect(store.get('a')!.threadId).toBe(99);
  });

  it('gets active sessions only', () => {
    store.set('a', makeSession({ sessionId: 'a', status: 'active' }));
    store.set('b', makeSession({ sessionId: 'b', status: 'closed' }));
    store.set('c', makeSession({ sessionId: 'c', status: 'active' }));
    expect(store.getActiveSessions()).toHaveLength(2);
  });

  it('increments tool count', () => {
    store.set('a', makeSession({ sessionId: 'a', toolCallCount: 5 }));
    store.incrementToolCount('a');
    expect(store.get('a')!.toolCallCount).toBe(6);
  });

  it('persists and reloads from disk', () => {
    const session = makeSession({ sessionId: 'persist-test', topicName: 'persisted' });
    store.set('persist-test', session);

    // Create a new store from the same file
    const store2 = new SessionStore(filePath);
    expect(store2.get('persist-test')).toBeDefined();
    expect(store2.get('persist-test')!.topicName).toBe('persisted');
  });

  it('deletes sessions', () => {
    store.set('a', makeSession({ sessionId: 'a' }));
    store.set('b', makeSession({ sessionId: 'b' }));
    store.deleteSessions(['a']);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
  });
});
