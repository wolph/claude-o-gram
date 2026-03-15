import { describe, expect, it, vi } from 'vitest';
import { InboundRouter } from '../src/bot/inbound-router.js';

describe('InboundRouter', () => {
  it('routes immediately when the conversation is active', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'sent' });
    const log = vi.fn();
    const queue = vi.fn();

    const router = new InboundRouter({ send, log, queue });
    const result = await router.handle({
      threadId: 42,
      telegramMessageId: 100,
      kind: 'text',
      rawText: 'status',
      routedText: 'status',
      state: 'active',
      sessionId: 'sess-1',
      inputMethod: 'tmux',
    });

    expect(result.action).toBe('sent');
    expect(send).toHaveBeenCalledWith('sess-1', 'status');
    expect(log).toHaveBeenCalled();
  });

  it('queues while a clear transition is in progress', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const queue = vi.fn();

    const router = new InboundRouter({ send, log, queue });
    const result = await router.handle({
      threadId: 42,
      telegramMessageId: 101,
      kind: 'command',
      rawText: '/status',
      routedText: '/status',
      state: 'transitioning',
      sessionId: 'sess-old',
      inputMethod: 'tmux',
    });

    expect(result.action).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalled();
  });
});
