import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PreToolUseStash, type StashedPreToolUse } from '../src/control/pretooluse-stash.js';
import type { PreToolUsePayload } from '../src/types/hooks.js';

function makePayload(toolUseId: string, sessionId = 'sess-1'): PreToolUsePayload {
  return {
    session_id: sessionId,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    permission_mode: 'plan',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: toolUseId,
  };
}

describe('PreToolUseStash', () => {
  let stash: PreToolUseStash;
  let flushed: Array<{ sessionId: string; threadId: number; payload: PreToolUsePayload }>;

  beforeEach(() => {
    vi.useFakeTimers();
    flushed = [];
    stash = new PreToolUseStash(2000, (sessionId, threadId, payload) => {
      flushed.push({ sessionId, threadId, payload });
    });
  });

  afterEach(() => {
    stash.shutdown();
    vi.useRealTimers();
  });

  it('stashes a PreToolUse entry and pops it by session (FIFO)', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.push('sess-1', 42, makePayload('tool-b'), null);

    const popped = stash.popOldest('sess-1');
    expect(popped).toBeDefined();
    expect(popped!.toolUseId).toBe('tool-a');

    const popped2 = stash.popOldest('sess-1');
    expect(popped2).toBeDefined();
    expect(popped2!.toolUseId).toBe('tool-b');

    expect(stash.popOldest('sess-1')).toBeUndefined();
  });

  it('removes a specific entry by toolUseId', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.push('sess-1', 42, makePayload('tool-b'), null);

    const removed = stash.removeByToolUseId('sess-1', 'tool-a');
    expect(removed).toBeDefined();
    expect(removed!.toolUseId).toBe('tool-a');

    // tool-b still there
    expect(stash.popOldest('sess-1')?.toolUseId).toBe('tool-b');
  });

  it('returns undefined when removing a non-existent entry', () => {
    expect(stash.removeByToolUseId('sess-1', 'nope')).toBeUndefined();
  });

  it('flushes to bypassBatcher callback on timer expiry', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);

    vi.advanceTimersByTime(2000);

    expect(flushed).toHaveLength(1);
    expect(flushed[0].payload.tool_use_id).toBe('tool-a');
    // Entry removed from stash
    expect(stash.popOldest('sess-1')).toBeUndefined();
  });

  it('does not flush if entry was popped before timer fires', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.popOldest('sess-1'); // consumed by Notification

    vi.advanceTimersByTime(2000);

    expect(flushed).toHaveLength(0);
  });

  it('does not flush if entry was removed by toolUseId before timer fires', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.removeByToolUseId('sess-1', 'tool-a'); // consumed by PostToolUse

    vi.advanceTimersByTime(2000);

    expect(flushed).toHaveLength(0);
  });

  it('cleanupSession clears all entries and cancels timers', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), null);
    stash.push('sess-1', 42, makePayload('tool-b'), null);

    stash.cleanupSession('sess-1');

    expect(stash.popOldest('sess-1')).toBeUndefined();
    // Timers should not fire after cleanup
    vi.advanceTimersByTime(5000);
    expect(flushed).toHaveLength(0);
  });

  it('isolates sessions from each other', () => {
    stash.push('sess-1', 42, makePayload('tool-a', 'sess-1'), null);
    stash.push('sess-2', 99, makePayload('tool-b', 'sess-2'), null);

    expect(stash.popOldest('sess-1')?.toolUseId).toBe('tool-a');
    expect(stash.popOldest('sess-2')?.toolUseId).toBe('tool-b');
  });

  it('stores agentPrefix for later use', () => {
    stash.push('sess-1', 42, makePayload('tool-a'), '<b>[Explorer]</b> ');
    const popped = stash.popOldest('sess-1');
    expect(popped?.agentPrefix).toBe('<b>[Explorer]</b> ');
  });
});
