import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { ConversationStore } from '../src/sessions/conversation-store.js';

describe('ConversationStore', () => {
  let testDir: string;
  let filePath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `conversation-store-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(testDir, { recursive: true });
    filePath = join(testDir, 'conversations.json');
  });

  afterEach(() => {
    try { unlinkSync(filePath); } catch { /* ok */ }
    try { unlinkSync(filePath + '.tmp'); } catch { /* ok */ }
    try { rmdirSync(testDir); } catch { /* ok */ }
  });

  it('keeps one durable conversation while rotating the Claude session binding', () => {
    const store = new ConversationStore(filePath);

    store.upsertActive({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      sessionId: 'sess-old',
      transcriptPath: '/tmp/old.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
      statusMessageId: 7,
    });

    store.startClearTransition(42);
    store.enqueue(42, {
      telegramMessageId: 10,
      kind: 'text',
      rawText: 'continue',
      routedText: 'continue',
      receivedAt: '2026-03-15T00:00:00.000Z',
    });

    store.attachReplacementBinding(42, {
      sessionId: 'sess-new',
      transcriptPath: '/tmp/new.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
    });

    const conversation = store.getByThreadId(42);
    expect(conversation?.state).toBe('active');
    expect(conversation?.currentSessionId).toBe('sess-new');
    expect(conversation?.queue).toHaveLength(1);
  });
});
