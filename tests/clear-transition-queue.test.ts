import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { InboundRouter } from '../src/bot/inbound-router.js';
import { ConversationStore } from '../src/sessions/conversation-store.js';
import type {
  ConversationInputMethod,
  ReplacementConversationBinding,
} from '../src/types/conversations.js';
import type { SendResult } from '../src/input/types.js';

function createTempStore(): { store: ConversationStore; cleanup: () => void } {
  const testDir = join(tmpdir(), `clear-transition-queue-${randomBytes(4).toString('hex')}`);
  const filePath = join(testDir, 'conversations.json');
  mkdirSync(testDir, { recursive: true });

  return {
    store: new ConversationStore(filePath),
    cleanup: () => {
      try { unlinkSync(filePath); } catch { /* ok */ }
      try { unlinkSync(`${filePath}.tmp`); } catch { /* ok */ }
      try { rmdirSync(testDir); } catch { /* ok */ }
    },
  };
}

async function drainQueuedMessages(
  store: ConversationStore,
  threadId: number,
  send: (sessionId: string, text: string) => Promise<SendResult>,
): Promise<void> {
  for (;;) {
    const conversation = store.getByThreadId(threadId);
    if (!conversation) return;

    const next = store.peekQueued(threadId);
    if (!next) return;

    const result = await send(conversation.currentSessionId, next.routedText);
    if (result.status !== 'sent') {
      return;
    }

    store.shiftQueue(threadId);
  }
}

function createClearHarness({
  send,
}: {
  send: (sessionId: string, text: string) => Promise<SendResult>;
}) {
  const { store, cleanup } = createTempStore();
  const router = new InboundRouter({
    send,
    log: () => undefined,
    queue: (input) => (
      store.enqueue(input.threadId, {
        telegramMessageId: input.telegramMessageId,
        kind: input.kind,
        rawText: input.rawText,
        routedText: input.routedText,
        receivedAt: input.receivedAt,
      })
        ? { status: 'queued' }
        : { status: 'failed', error: 'conversation missing' }
    ),
  });

  return {
    cleanup,
    startActiveConversation({
      threadId,
      sessionId,
      inputMethod,
    }: {
      threadId: number;
      sessionId: string;
      inputMethod: ConversationInputMethod;
    }) {
      store.upsertActive({
        threadId,
        cwd: '/tmp/project',
        topicName: 'project',
        sessionId,
        transcriptPath: '/tmp/old.jsonl',
        inputMethod,
        permissionMode: 'default',
        statusMessageId: 7,
      });
    },
    startClearTransition(threadId: number) {
      const started = store.startClearTransition(threadId);
      if (!started) {
        throw new Error(`missing conversation for thread ${threadId}`);
      }
    },
    queueDepth(threadId: number): number {
      return store.getByThreadId(threadId)?.queue.length ?? 0;
    },
    async receiveTelegramText(threadId: number, telegramMessageId: number, text: string) {
      const conversation = store.getByThreadId(threadId);
      if (!conversation) {
        throw new Error(`missing conversation for thread ${threadId}`);
      }

      return router.handle({
        threadId,
        telegramMessageId,
        kind: 'text',
        rawText: text,
        routedText: text,
        state: conversation.state,
        sessionId: conversation.currentSessionId,
        inputMethod: conversation.currentInputMethod,
        receivedAt: '2026-03-15T00:00:00.000Z',
      });
    },
    async attachReplacementBinding(
      threadId: number,
      binding: Pick<ReplacementConversationBinding, 'sessionId' | 'inputMethod'>,
    ) {
      const attached = store.attachReplacementBinding(threadId, {
        sessionId: binding.sessionId,
        transcriptPath: '/tmp/new.jsonl',
        inputMethod: binding.inputMethod,
        permissionMode: 'default',
      });
      if (!attached) {
        throw new Error(`failed to attach replacement binding for thread ${threadId}`);
      }

      await drainQueuedMessages(store, threadId, send);
    },
  };
}

describe('clear transition queueing', () => {
  it('delivers a telegram message sent between clear teardown and replacement session attach', async () => {
    const send = vi.fn<(sessionId: string, text: string) => Promise<SendResult>>()
      .mockResolvedValue({ status: 'sent' });

    const harness = createClearHarness({ send });
    try {
      harness.startActiveConversation({ threadId: 42, sessionId: 'sess-old', inputMethod: 'tmux' });

      harness.startClearTransition(42);
      await harness.receiveTelegramText(42, 500, 'continue after clear');

      expect(harness.queueDepth(42)).toBe(1);

      await harness.attachReplacementBinding(42, { sessionId: 'sess-new', inputMethod: 'tmux' });

      expect(send).toHaveBeenCalledWith('sess-new', 'continue after clear');
      expect(harness.queueDepth(42)).toBe(0);
    } finally {
      harness.cleanup();
    }
  });
});
