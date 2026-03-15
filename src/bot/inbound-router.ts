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

interface InboundRouterCallbacks {
  send: (sessionId: string, text: string) => Promise<SendResult>;
  log: (message: string) => void;
  queue: (input: RoutedInboundMessage) => void;
}

export type InboundRouterResult =
  | { action: 'queued' }
  | { action: 'sent'; delivery: SendResult };

export class InboundRouter {
  constructor(private readonly callbacks: InboundRouterCallbacks) {}

  async handle(input: RoutedInboundMessage): Promise<InboundRouterResult> {
    this.callbacks.log(
      `RECV thread=${input.threadId} msg=${input.telegramMessageId} kind=${input.kind}`,
    );

    if (input.state === 'transitioning') {
      this.callbacks.queue(input);
      this.callbacks.log(`QUEUE thread=${input.threadId} reason=clear-transition`);
      return { action: 'queued' };
    }

    this.callbacks.log(
      `ROUTE thread=${input.threadId} state=active session=${input.sessionId} via=${input.inputMethod ?? 'unknown'}`,
    );
    const delivery = await this.callbacks.send(input.sessionId, input.routedText);
    return { action: 'sent', delivery };
  }
}
