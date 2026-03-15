import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { ConversationStore } from '../src/sessions/conversation-store.js';
import type {
  ActiveConversationBinding,
  InboundMessage,
  ReplacementConversationBinding,
} from '../src/types/conversations.js';

function makeActiveBinding(
  overrides: Partial<ActiveConversationBinding> = {}
): ActiveConversationBinding {
  return {
    threadId: 42,
    cwd: '/tmp/project',
    topicName: 'project',
    sessionId: 'sess-old',
    transcriptPath: '/tmp/old.jsonl',
    inputMethod: 'tmux',
    permissionMode: 'default',
    statusMessageId: 7,
    ...overrides,
  };
}

function makeReplacementBinding(
  overrides: Partial<ReplacementConversationBinding> = {}
): ReplacementConversationBinding {
  return {
    sessionId: 'sess-new',
    transcriptPath: '/tmp/new.jsonl',
    inputMethod: 'fifo',
    permissionMode: 'bypassPermissions',
    ...overrides,
  };
}

function makeInboundMessage(
  overrides: Partial<InboundMessage> = {}
): InboundMessage {
  return {
    telegramMessageId: 10,
    kind: 'text',
    rawText: 'continue',
    routedText: 'continue',
    receivedAt: '2026-03-15T00:00:00.000Z',
    ...overrides,
  };
}

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
    const queuedMessage = makeInboundMessage();

    store.upsertActive(makeActiveBinding());

    expect(store.startClearTransition(42)).toBe(true);
    expect(store.enqueue(42, queuedMessage)).toBe(true);

    expect(store.attachReplacementBinding(42, makeReplacementBinding())).toBe(true);

    const conversation = store.getByThreadId(42);
    expect(conversation).toEqual({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      statusMessageId: 7,
      state: 'active',
      currentSessionId: 'sess-new',
      currentTranscriptPath: '/tmp/new.jsonl',
      currentInputMethod: 'fifo',
      permissionMode: 'bypassPermissions',
      queue: [queuedMessage],
    });
  });

  it('keeps conversations in memory only for task 1', () => {
    const firstStore = new ConversationStore(filePath);

    firstStore.upsertActive(makeActiveBinding());

    const secondStore = new ConversationStore(filePath);
    expect(secondStore.getByThreadId(42)).toBeUndefined();
  });

  it('reports missing-thread operations explicitly', () => {
    const store = new ConversationStore(filePath);

    expect(store.startClearTransition(999)).toBe(false);
    expect(store.enqueue(999, makeInboundMessage())).toBe(false);
    expect(store.attachReplacementBinding(999, makeReplacementBinding())).toBe(false);
  });

  it('does not reactivate a conversation without a routable replacement binding', () => {
    const store = new ConversationStore(filePath);

    store.upsertActive(makeActiveBinding());
    expect(store.startClearTransition(42)).toBe(true);

    expect(
      store.attachReplacementBinding(
        42,
        {
          sessionId: 'sess-new',
          transcriptPath: '/tmp/new.jsonl',
          permissionMode: 'bypassPermissions',
        } as unknown as ReplacementConversationBinding
      )
    ).toBe(false);

    expect(store.getByThreadId(42)).toEqual({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      statusMessageId: 7,
      state: 'transitioning',
      currentSessionId: 'sess-old',
      currentTranscriptPath: '/tmp/old.jsonl',
      currentInputMethod: 'tmux',
      permissionMode: 'default',
      queue: [],
    });
  });

  it('preserves queued messages when upserting an existing conversation record', () => {
    const store = new ConversationStore(filePath);
    const queuedMessage = makeInboundMessage();

    store.upsertActive(makeActiveBinding());
    expect(store.startClearTransition(42)).toBe(true);
    expect(store.enqueue(42, queuedMessage)).toBe(true);

    store.upsertActive(
      makeActiveBinding({
        sessionId: 'sess-replacement',
        transcriptPath: '/tmp/replacement.jsonl',
        inputMethod: 'sdk-resume',
        permissionMode: 'bypassPermissions',
      })
    );

    expect(store.getByThreadId(42)).toEqual({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      statusMessageId: 7,
      state: 'active',
      currentSessionId: 'sess-replacement',
      currentTranscriptPath: '/tmp/replacement.jsonl',
      currentInputMethod: 'sdk-resume',
      permissionMode: 'bypassPermissions',
      queue: [queuedMessage],
    });
  });
});
