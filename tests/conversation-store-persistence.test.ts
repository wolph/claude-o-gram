import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { ConversationStore } from '../src/sessions/conversation-store.js';

describe('ConversationStore persistence', () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `conversation-store-persistence-${randomBytes(4).toString('hex')}`);
    mkdirSync(testDir, { recursive: true });
    filePath = join(testDir, 'conversations.json');
  });

  afterEach(() => {
    try { unlinkSync(filePath); } catch { /* ok */ }
    try { unlinkSync(`${filePath}.tmp`); } catch { /* ok */ }
    try { rmdirSync(testDir); } catch { /* ok */ }
  });

  it('restores queued messages and transition state after reload', () => {
    const first = new ConversationStore(filePath);
    first.upsertActive({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      sessionId: 'sess-old',
      transcriptPath: '/tmp/old.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
      statusMessageId: 7,
    });
    expect(first.startClearTransition(42)).toBe(true);
    expect(first.enqueue(42, {
      telegramMessageId: 100,
      kind: 'text',
      rawText: 'resume me',
      routedText: 'resume me',
      receivedAt: '2026-03-15T00:00:00.000Z',
    })).toBe(true);

    const second = new ConversationStore(filePath);
    expect(second.getByThreadId(42)).toEqual({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      statusMessageId: 7,
      state: 'transitioning',
      currentSessionId: 'sess-old',
      currentTranscriptPath: '/tmp/old.jsonl',
      currentInputMethod: 'tmux',
      permissionMode: 'default',
      queue: [{
        telegramMessageId: 100,
        kind: 'text',
        rawText: 'resume me',
        routedText: 'resume me',
        receivedAt: '2026-03-15T00:00:00.000Z',
      }],
    });
  });

  it('reactivates a persisted clear transition when the replacement session registers after restart', () => {
    const first = new ConversationStore(filePath);
    first.upsertActive({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      sessionId: 'sess-old',
      transcriptPath: '/tmp/old.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
      statusMessageId: 7,
    });
    expect(first.startClearTransition(42)).toBe(true);
    expect(first.enqueue(42, {
      telegramMessageId: 101,
      kind: 'text',
      rawText: 'recover me',
      routedText: 'recover me',
      receivedAt: '2026-03-15T00:00:00.000Z',
    })).toBe(true);

    const second = new ConversationStore(filePath);
    expect(
      second.activateRegisteredBinding({
        threadId: 42,
        cwd: '/tmp/project',
        topicName: 'project',
        sessionId: 'sess-new',
        transcriptPath: '/tmp/new.jsonl',
        inputMethod: 'fifo',
        permissionMode: 'default',
        statusMessageId: 7,
      })
    ).toBe('replacement');

    expect(second.getByThreadId(42)).toEqual({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      statusMessageId: 7,
      state: 'active',
      currentSessionId: 'sess-new',
      currentTranscriptPath: '/tmp/new.jsonl',
      currentInputMethod: 'fifo',
      permissionMode: 'default',
      queue: [{
        telegramMessageId: 101,
        kind: 'text',
        rawText: 'recover me',
        routedText: 'recover me',
        receivedAt: '2026-03-15T00:00:00.000Z',
      }],
    });
  });
});
