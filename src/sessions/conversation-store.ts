import type {
  ActiveConversationBinding,
  ConversationInfo,
  InboundMessage,
  ReplacementConversationBinding,
} from '../types/conversations.js';

export class ConversationStore {
  private conversations = new Map<number, ConversationInfo>();

  constructor(_filePath: string) {}

  getByThreadId(threadId: number): ConversationInfo | undefined {
    return this.conversations.get(threadId);
  }

  upsertActive(binding: ActiveConversationBinding): void {
    const existing = this.conversations.get(binding.threadId);

    this.conversations.set(binding.threadId, {
      threadId: binding.threadId,
      cwd: binding.cwd,
      topicName: binding.topicName,
      statusMessageId: binding.statusMessageId,
      state: 'active',
      currentSessionId: binding.sessionId,
      currentTranscriptPath: binding.transcriptPath,
      currentInputMethod: binding.inputMethod,
      permissionMode: binding.permissionMode,
      queue: existing?.queue ?? [],
    });
  }

  startClearTransition(threadId: number): boolean {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return false;
    }

    conversation.state = 'transitioning';
    return true;
  }

  enqueue(threadId: number, message: InboundMessage): boolean {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return false;
    }

    conversation.queue.push(message);
    return true;
  }

  attachReplacementBinding(threadId: number, binding: ReplacementConversationBinding): boolean {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return false;
    }

    if (!binding.inputMethod) {
      return false;
    }

    conversation.currentSessionId = binding.sessionId;
    conversation.currentTranscriptPath = binding.transcriptPath;
    conversation.currentInputMethod = binding.inputMethod;
    conversation.permissionMode = binding.permissionMode;
    conversation.state = 'active';
    return true;
  }
}
