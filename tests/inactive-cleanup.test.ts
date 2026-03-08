import { describe, it, expect } from 'vitest';
import { planInactiveCleanup } from '../src/sessions/inactive-cleanup.js';
import type { SessionInfo } from '../src/types/sessions.js';

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 'sess-1',
    threadId: 123,
    cwd: '/tmp/project',
    topicName: 'project',
    startedAt: '2026-03-01T00:00:00.000Z',
    status: 'active',
    transcriptPath: '/tmp/transcript.jsonl',
    toolCallCount: 0,
    filesChanged: [],
    verbosity: 'normal',
    statusMessageId: 0,
    suppressedCounts: {},
    contextPercent: 0,
    lastActivityAt: '2026-03-01T00:00:00.000Z',
    permissionMode: 'bypassPermissions',
    inputMethod: 'sdk-resume',
    ...overrides,
  };
}

describe('planInactiveCleanup', () => {
  it('includes closed sessions and stale active sessions in cleanup candidates', () => {
    const now = Date.parse('2026-03-06T00:00:00.000Z');
    const staleAfterMs = 6 * 60 * 60 * 1000;

    const sessions: SessionInfo[] = [
      makeSession({
        sessionId: 'closed-1',
        status: 'closed',
        lastActivityAt: '2026-03-05T12:00:00.000Z',
      }),
      makeSession({
        sessionId: 'stale-active-1',
        status: 'active',
        lastActivityAt: '2026-03-05T12:00:00.000Z',
      }),
      makeSession({
        sessionId: 'fresh-active-1',
        status: 'active',
        lastActivityAt: '2026-03-05T23:30:00.000Z',
      }),
    ];

    const plan = planInactiveCleanup(sessions, { nowMs: now, staleAfterMs });

    expect(plan.closed.map((s) => s.sessionId)).toEqual(['closed-1']);
    expect(plan.staleActive.map((s) => s.sessionId)).toEqual(['stale-active-1']);
    expect(plan.candidates.map((s) => s.sessionId)).toEqual(['closed-1', 'stale-active-1']);
    expect(plan.deletable.map((s) => s.sessionId)).toEqual(['closed-1', 'stale-active-1']);
    expect(plan.unmapped).toEqual([]);
  });

  it('treats invalid lastActivity timestamps as stale using startedAt fallback', () => {
    const now = Date.parse('2026-03-06T00:00:00.000Z');
    const staleAfterMs = 6 * 60 * 60 * 1000;

    const sessions: SessionInfo[] = [
      makeSession({
        sessionId: 'bad-last-activity',
        status: 'active',
        startedAt: '2026-03-05T00:00:00.000Z',
        lastActivityAt: 'not-a-date',
      }),
    ];

    const plan = planInactiveCleanup(sessions, { nowMs: now, staleAfterMs });
    expect(plan.staleActive.map((s) => s.sessionId)).toEqual(['bad-last-activity']);
  });

  it('separates inactive sessions with missing thread IDs as unmapped', () => {
    const now = Date.parse('2026-03-06T00:00:00.000Z');
    const staleAfterMs = 6 * 60 * 60 * 1000;

    const sessions: SessionInfo[] = [
      makeSession({
        sessionId: 'closed-unmapped',
        status: 'closed',
        threadId: 0,
        lastActivityAt: '2026-03-05T12:00:00.000Z',
      }),
      makeSession({
        sessionId: 'stale-active-unmapped',
        status: 'active',
        threadId: 0,
        lastActivityAt: '2026-03-05T12:00:00.000Z',
      }),
      makeSession({
        sessionId: 'closed-deletable',
        status: 'closed',
        threadId: 777,
        lastActivityAt: '2026-03-05T12:00:00.000Z',
      }),
    ];

    const plan = planInactiveCleanup(sessions, { nowMs: now, staleAfterMs });

    expect(plan.deletable.map((s) => s.sessionId)).toEqual(['closed-deletable']);
    expect(plan.unmapped.map((s) => s.sessionId)).toEqual(['closed-unmapped', 'stale-active-unmapped']);
  });
});
