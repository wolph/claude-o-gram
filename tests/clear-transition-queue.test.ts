import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from '@grammyjs/types';
import { describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { ApprovalManager } from '../src/control/approval-manager.js';
import { PermissionModeManager } from '../src/control/permission-modes.js';
import { SessionStore } from '../src/sessions/session-store.js';
import { ConversationStore } from '../src/sessions/conversation-store.js';
import type { SendResult } from '../src/input/types.js';
import type {
  ActiveConversationBinding,
  ConversationInputMethod,
  ReplacementConversationBinding,
} from '../src/types/conversations.js';
import type { SessionInfo } from '../src/types/sessions.js';

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `clear-transition-queue-${randomBytes(4).toString('hex')}`);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSession(
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    sessionId: 'sess-old',
    threadId: 42,
    cwd: '/tmp/project',
    topicName: 'project',
    startedAt: '2026-03-15T00:00:00.000Z',
    status: 'active',
    transcriptPath: '/tmp/old.jsonl',
    toolCallCount: 0,
    filesChanged: new Set<string>(),
    verbosity: 'minimal',
    statusMessageId: 7,
    suppressedCounts: {},
    contextPercent: 0,
    lastActivityAt: '2026-03-15T00:00:00.000Z',
    permissionMode: 'default',
    inputMethod: 'tmux',
    ...overrides,
  };
}

function makeActiveBinding(
  overrides: Partial<ActiveConversationBinding> = {},
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
  overrides: Partial<ReplacementConversationBinding> = {},
): ReplacementConversationBinding {
  return {
    sessionId: 'sess-new',
    transcriptPath: '/tmp/new.jsonl',
    inputMethod: 'fifo',
    permissionMode: 'default',
    ...overrides,
  };
}

async function drainQueuedMessages(
  store: ConversationStore,
  threadId: number,
  send: (sessionId: string, text: string) => Promise<SendResult>,
): Promise<void> {
  for (;;) {
    const conversation = store.getByThreadId(threadId);
    if (!conversation) {
      return;
    }

    const next = store.peekQueued(threadId);
    if (!next) {
      return;
    }

    const result = await send(conversation.currentSessionId, next.routedText);
    if (result.status !== 'sent') {
      return;
    }

    store.shiftQueue(threadId);
  }
}

function syncActiveBinding(
  store: ConversationStore,
  binding: ActiveConversationBinding,
): boolean {
  return (store as unknown as {
    syncActive: (nextBinding: ActiveConversationBinding) => boolean;
  }).syncActive(binding);
}

async function createBotHarness({
  send,
}: {
  send: (sessionId: string, text: string) => Promise<SendResult>;
}) {
  const { dir, cleanup } = createTempDir();
  const sessionStore = new SessionStore(join(dir, 'sessions.json'));
  const conversationStore = new ConversationStore(join(dir, 'conversations.json'));
  const approvalManager = new ApprovalManager(join(dir, 'pending-approvals.json'));
  const permissionModeManager = new PermissionModeManager();
  const inputMethodBySession = new Map<string, ConversationInputMethod>();

  const bot = await createBot(
    {
      telegramBotToken: '123456:TEST_TOKEN',
      telegramChatId: -100123,
      hookServerPort: 3456,
      hookServerHost: '127.0.0.1',
      dataDir: dir,
      defaultVerbosity: 'minimal',
      idleTimeoutMs: 60_000,
      approvalTimeoutMs: 300_000,
      autoApprove: false,
      subagentOutput: false,
      botOwnerId: 999,
    },
    sessionStore,
    conversationStore,
    approvalManager,
    {
      send,
      getMethod: (sessionId: string) => inputMethodBySession.get(sessionId) ?? null,
    } as never,
    {
      getCommandsByNamespace: () => new Map<string, string[]>(),
      getEntries: () => [],
      isBotNative: () => false,
      toClaudeName: () => null,
      getByClaudeName: () => null,
    } as never,
    permissionModeManager,
    {
      settingsTopicId: 0,
      settingsMessageId: 0,
      subagentOutput: false,
      defaultPermissionMode: 'manual',
    } as never,
    {
      getCommandSetting: () => ({ visibility: 'submenu', usageCount: 0 }),
      recordUse: () => undefined,
      getDirectCutoff: () => 30,
    } as never,
  );
  (bot as typeof bot & {
    botInfo: {
      id: number;
      is_bot: true;
      first_name: string;
      username: string;
      can_join_groups: true;
      can_read_all_group_messages: false;
      supports_inline_queries: false;
    };
  }).botInfo = {
    id: 123456,
    is_bot: true,
    first_name: 'Test Bot',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: 999,
          date: 0,
          chat: {
            id: -100123,
            type: 'supergroup',
            title: 'Test Chat',
            is_forum: true,
          },
          text: String(payload.text ?? ''),
        },
      };
    }
    return prev(method, payload, signal);
  });

  function registerActiveSession({
    threadId,
    sessionId,
    inputMethod,
  }: {
    threadId: number;
    sessionId: string;
    inputMethod: ConversationInputMethod;
  }) {
    inputMethodBySession.set(sessionId, inputMethod);
    sessionStore.set(sessionId, makeSession({
      sessionId,
      threadId,
      inputMethod,
    }));
    conversationStore.upsertActive(makeActiveBinding({
      threadId,
      sessionId,
      inputMethod,
    }));
  }

  async function receiveTelegramText(
    threadId: number,
    telegramMessageId: number,
    text: string,
  ): Promise<void> {
    const update: Update = {
      update_id: telegramMessageId,
      message: {
        message_id: telegramMessageId,
        date: 1_710_460_800,
        text,
        message_thread_id: threadId,
        is_topic_message: true,
        chat: {
          id: -100123,
          type: 'supergroup',
          title: 'Test Chat',
          is_forum: true,
        },
        from: {
          id: 999,
          is_bot: false,
          first_name: 'Owner',
        },
      },
    };

    await bot.handleUpdate(update);
  }

  return {
    cleanup,
    sessionStore,
    conversationStore,
    registerActiveSession,
    queueDepth(threadId: number): number {
      return conversationStore.getByThreadId(threadId)?.queue.length ?? 0;
    },
    startClearTransition(threadId: number) {
      expect(conversationStore.startClearTransition(threadId)).toBe(true);
    },
    receiveTelegramText,
    async attachReplacementBinding(
      threadId: number,
      binding: Pick<ReplacementConversationBinding, 'sessionId' | 'inputMethod'>,
    ) {
      inputMethodBySession.set(binding.sessionId, binding.inputMethod);
      sessionStore.set(binding.sessionId, makeSession({
        sessionId: binding.sessionId,
        threadId,
        transcriptPath: '/tmp/new.jsonl',
        inputMethod: binding.inputMethod,
      }));

      expect(conversationStore.attachReplacementBinding(threadId, {
        sessionId: binding.sessionId,
        transcriptPath: '/tmp/new.jsonl',
        inputMethod: binding.inputMethod,
        permissionMode: 'default',
      })).toBe(true);

      await drainQueuedMessages(conversationStore, threadId, send);
    },
  };
}

describe('clear transition queueing', () => {
  it('queues telegram text through real bot ingress during clear transition and drains it to the replacement session in FIFO order', async () => {
    const send = vi.fn<(sessionId: string, text: string) => Promise<SendResult>>()
      .mockResolvedValue({ status: 'sent' });

    const harness = await createBotHarness({ send });
    try {
      harness.registerActiveSession({ threadId: 42, sessionId: 'sess-old', inputMethod: 'tmux' });

      harness.startClearTransition(42);
      await harness.receiveTelegramText(42, 500, 'first after clear');
      await harness.receiveTelegramText(42, 501, 'second after clear');

      expect(send).not.toHaveBeenCalled();
      expect(harness.queueDepth(42)).toBe(2);

      await harness.attachReplacementBinding(42, { sessionId: 'sess-new', inputMethod: 'tmux' });

      expect(send.mock.calls).toEqual([
        ['sess-new', 'first after clear'],
        ['sess-new', 'second after clear'],
      ]);
      expect(harness.queueDepth(42)).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it('ignores stale activation sync once the thread is transitioning or rebound', () => {
    const { dir, cleanup } = createTempDir();
    const store = new ConversationStore(join(dir, 'conversations.json'));

    try {
      store.upsertActive(makeActiveBinding());

      expect(syncActiveBinding(store, makeActiveBinding({
        statusMessageId: 9,
        inputMethod: 'fifo',
      }))).toBe(true);

      expect(store.startClearTransition(42)).toBe(true);
      expect(syncActiveBinding(store, makeActiveBinding({
        statusMessageId: 10,
        inputMethod: 'sdk-resume',
      }))).toBe(false);

      expect(store.attachReplacementBinding(42, makeReplacementBinding({
        inputMethod: 'tmux',
      }))).toBe(true);
      expect(syncActiveBinding(store, makeActiveBinding({
        statusMessageId: 11,
        inputMethod: 'sdk-resume',
      }))).toBe(false);

      expect(store.getByThreadId(42)).toEqual({
        threadId: 42,
        cwd: '/tmp/project',
        topicName: 'project',
        statusMessageId: 9,
        state: 'active',
        currentSessionId: 'sess-new',
        currentTranscriptPath: '/tmp/new.jsonl',
        currentInputMethod: 'tmux',
        permissionMode: 'default',
        queue: [],
      });
    } finally {
      cleanup();
    }
  });
});
