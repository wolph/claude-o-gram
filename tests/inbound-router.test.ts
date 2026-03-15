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
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it('queues while a clear transition is in progress', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const queue = vi.fn().mockReturnValue({ status: 'queued', depth: 1 });

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

    expect(result).toEqual({ action: 'queued', depth: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalled();
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(queue.mock.invocationCallOrder[0]);
  });

  it('fails explicitly when queueing is not wired for a transitioning conversation', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const queue = vi.fn().mockReturnValue({
      status: 'failed',
      error: 'queueing not wired yet',
    });

    const router = new InboundRouter({ send, log, queue });
    const result = await router.handle({
      threadId: 42,
      telegramMessageId: 102,
      kind: 'text',
      rawText: 'continue',
      routedText: 'continue',
      state: 'transitioning',
      sessionId: 'sess-old',
      inputMethod: 'tmux',
    });

    expect(result).toEqual({
      action: 'failed',
      error: 'queueing not wired yet',
    });
    expect(send).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalled();
  });
});
