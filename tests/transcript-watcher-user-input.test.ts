import { describe, it, expect, vi } from 'vitest';
import { TranscriptWatcher } from '../src/monitoring/transcript-watcher.js';
import type { TranscriptEntry } from '../src/types/monitoring.js';

function makeEntry(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    type: 'user',
    uuid: 'uuid-1',
    parentUuid: null,
    timestamp: '2026-03-06T00:00:00.000Z',
    sessionId: 'session-1',
    version: '1',
    cwd: '/tmp/project',
    isSidechain: false,
    message: {
      role: 'user',
      content: '',
    },
    ...overrides,
  };
}

describe('TranscriptWatcher user input mirroring', () => {
  it('emits user text content from user entries', () => {
    const onAssistant = vi.fn();
    const onUsage = vi.fn();
    const onUserMessage = vi.fn();
    const watcher = new TranscriptWatcher(
      '/tmp/unused.jsonl',
      onAssistant,
      onUsage,
      undefined,
      undefined,
      undefined,
      onUserMessage,
    );

    const entry = makeEntry({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Investigate why hooks skipped this session' }],
      },
    });

    (watcher as unknown as { processEntry: (e: TranscriptEntry) => void }).processEntry(entry);

    expect(onUserMessage).toHaveBeenCalledTimes(1);
    expect(onUserMessage).toHaveBeenCalledWith('Investigate why hooks skipped this session');
    expect(onAssistant).not.toHaveBeenCalled();
  });

  it('does not emit user text for AskUserQuestion tool_result-only entries', () => {
    const onAssistant = vi.fn();
    const onUsage = vi.fn();
    const onAskUserQuestionResult = vi.fn();
    const onUserMessage = vi.fn();
    const watcher = new TranscriptWatcher(
      '/tmp/unused.jsonl',
      onAssistant,
      onUsage,
      undefined,
      undefined,
      onAskUserQuestionResult,
      onUserMessage,
    );

    const entry = makeEntry({
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'ask_123',
            content: '{"answers":{"cleanup":"Yes"}}',
          },
        ],
      },
    });

    (watcher as unknown as { processEntry: (e: TranscriptEntry) => void }).processEntry(entry);

    expect(onAskUserQuestionResult).toHaveBeenCalledTimes(1);
    expect(onUserMessage).not.toHaveBeenCalled();
  });
});
