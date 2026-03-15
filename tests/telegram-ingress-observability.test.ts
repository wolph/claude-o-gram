import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Update } from '@grammyjs/types';
import { describe, expect, it, vi } from 'vitest';
import { createBot } from '../src/bot/bot.js';
import { InboundRouter } from '../src/bot/inbound-router.js';
import { ApprovalManager } from '../src/control/approval-manager.js';
import { PermissionModeManager } from '../src/control/permission-modes.js';
import type { SendResult } from '../src/input/types.js';
import { ConversationStore } from '../src/sessions/conversation-store.js';
import { SessionStore } from '../src/sessions/session-store.js';
import type { ActiveConversationBinding, ConversationInputMethod } from '../src/types/conversations.js';
import type { SessionInfo } from '../src/types/sessions.js';

function createTempDir(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `telegram-ingress-observability-${randomBytes(4).toString('hex')}`);
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 'sess-old',
    threadId: 42,
    cwd: '/tmp/project',
    topicName: 'project',
    startedAt: '2026-03-15T00:00:00.000Z',
    status: 'active',
    transcriptPath: '/tmp/old.jsonl',
    toolCallCount: 0,
    filesChanged: [],
    verbosity: 'minimal',
    statusMessageId: 7,
    suppressedCounts: {},
    contextPercent: 0,
    lastActivityAt: '2026-03-15T00:00:00.000Z',
    permissionMode: 'default',
    inputMethod: 'tmux',
    ...overrides,
  } as unknown as SessionInfo;
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

async function createQueuedNoticeHarness() {
  const { dir, cleanup } = createTempDir();
  const sessionStore = new SessionStore(join(dir, 'sessions.json'));
  const conversationStore = new ConversationStore(join(dir, 'conversations.json'));
  const approvalManager = new ApprovalManager(join(dir, 'pending-approvals.json'));
  const permissionModeManager = new PermissionModeManager();
  const inputMethodBySession = new Map<string, ConversationInputMethod>();
  const send = vi.fn<(sessionId: string, text: string) => Promise<SendResult>>()
    .mockResolvedValue({ status: 'sent' });
  const sendMessageCalls: Array<{ text: string; message_thread_id?: number; reply_to_message_id?: number }> = [];

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

  bot.botInfo = {
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
      sendMessageCalls.push({
        text: String(payload.text ?? ''),
        message_thread_id: 'message_thread_id' in payload ? Number(payload.message_thread_id) : undefined,
        reply_to_message_id: 'reply_to_message_id' in payload ? Number(payload.reply_to_message_id) : undefined,
      });
      return {
        ok: true,
        result: {
          message_id: sendMessageCalls.length,
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

  inputMethodBySession.set('sess-old', 'tmux');
  sessionStore.set('sess-old', makeSession());
  conversationStore.upsertActive(makeActiveBinding());
  expect(conversationStore.startClearTransition(42)).toBe(true);

  async function receiveTelegramText(messageId: number, text: string): Promise<void> {
    const update: Update = {
      update_id: messageId,
      message: {
        message_id: messageId,
        date: 1_710_460_800,
        text,
        message_thread_id: 42,
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
    conversationStore,
    receiveTelegramText,
    send,
    sendMessageCalls,
  };
}

describe('telegram ingress observability', () => {
  it('logs receipt and route details for successful sends', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'sent' });
    const log = vi.fn();
    const queue = vi.fn();

    const router = new InboundRouter({ send, log, queue });
    await router.handle({
      threadId: 42,
      telegramMessageId: 100,
      kind: 'text',
      rawText: 'ping',
      routedText: 'ping',
      state: 'active',
      sessionId: 'sess-1',
      inputMethod: 'tmux',
      receivedAt: '2026-03-15T00:00:00.000Z',
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('RECV thread=42'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ROUTE thread=42'));
  });

  it('logs queue depth when buffering during a clear transition', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const queue = vi.fn().mockReturnValue({ status: 'queued', depth: 1 });

    const router = new InboundRouter({ send, log, queue });
    const result = await router.handle({
      threadId: 42,
      telegramMessageId: 101,
      kind: 'text',
      rawText: 'wait for clear',
      routedText: 'wait for clear',
      state: 'transitioning',
      sessionId: 'sess-old',
      inputMethod: 'tmux',
      receivedAt: '2026-03-15T00:00:00.000Z',
    });

    expect(result).toEqual({ action: 'queued', depth: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('QUEUE thread=42'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('depth=1'));
  });

  it('sends only one buffering notice to telegram while repeated messages queue during clear', async () => {
    const harness = await createQueuedNoticeHarness();

    try {
      await harness.receiveTelegramText(500, 'first while clearing');
      await harness.receiveTelegramText(501, 'second while clearing');

      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.conversationStore.getByThreadId(42)?.queue).toHaveLength(2);
      expect(harness.sendMessageCalls).toHaveLength(1);
      expect(harness.sendMessageCalls[0]).toMatchObject({
        text: 'Queued while context is clearing; will send automatically.',
        message_thread_id: 42,
        reply_to_message_id: 500,
      });
    } finally {
      harness.cleanup();
    }
  });
});
