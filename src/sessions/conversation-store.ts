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

  startClearTransition(threadId: number): void {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return;
    }

    conversation.state = 'transitioning';
  }

  enqueue(threadId: number, message: InboundMessage): void {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return;
    }

    conversation.queue.push(message);
  }

  attachReplacementBinding(threadId: number, binding: ReplacementConversationBinding): void {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return;
    }

    conversation.state = 'active';
    conversation.currentSessionId = binding.sessionId;
    conversation.currentTranscriptPath = binding.transcriptPath;
    conversation.currentInputMethod = binding.inputMethod;
    conversation.permissionMode = binding.permissionMode;
  }
}
