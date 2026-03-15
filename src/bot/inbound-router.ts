import type { SendResult } from '../input/types.js';
import type {
  ConversationInputMethod,
  ConversationState,
  InboundMessage,
} from '../types/conversations.js';

export interface RoutedInboundMessage extends InboundMessage {
  threadId: number;
  state: ConversationState;
  sessionId: string;
  inputMethod?: ConversationInputMethod;
}

export type QueueInboundResult =
  | { status: 'queued'; depth: number }
  | { status: 'failed'; error: string };

interface InboundRouterCallbacks {
  send: (sessionId: string, text: string) => Promise<SendResult>;
  log: (message: string) => void;
  queue: (input: RoutedInboundMessage) => QueueInboundResult | Promise<QueueInboundResult>;
}

export type InboundRouterResult =
  | { action: 'queued'; depth: number }
  | { action: 'sent' }
  | { action: 'failed'; error: string };

export class InboundRouter {
  constructor(private readonly callbacks: InboundRouterCallbacks) {}

  async handle(input: RoutedInboundMessage): Promise<InboundRouterResult> {
    this.callbacks.log(
      `RECV thread=${input.threadId} msg=${input.telegramMessageId} kind=${input.kind}`,
    );

    if (input.state === 'transitioning') {
      const queueResult = await this.callbacks.queue(input);
      if (queueResult.status === 'failed') {
        this.callbacks.log(
          `FAIL thread=${input.threadId} reason=${queueResult.error}`,
        );
        return { action: 'failed', error: queueResult.error };
      }
      this.callbacks.log(`QUEUE thread=${input.threadId} reason=clear-transition depth=${queueResult.depth}`);
      return { action: 'queued', depth: queueResult.depth };
    }

    this.callbacks.log(
      `ROUTE thread=${input.threadId} state=active session=${input.sessionId} via=${input.inputMethod ?? 'unknown'}`,
    );
    const delivery = await this.callbacks.send(input.sessionId, input.routedText);
    if (delivery.status === 'failed') {
      this.callbacks.log(`FAIL thread=${input.threadId} reason=${delivery.error}`);
      return { action: 'failed', error: delivery.error };
    }
    return { action: 'sent' };
  }
}
