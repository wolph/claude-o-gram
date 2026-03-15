import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ActiveConversationBinding,
  ConversationInfo,
  InboundMessage,
  ReplacementConversationBinding,
} from '../types/conversations.js';

export class ConversationStore {
  private conversations = new Map<number, ConversationInfo>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  getByThreadId(threadId: number): ConversationInfo | undefined {
    return this.conversations.get(threadId);
  }

  upsertActive(binding: ActiveConversationBinding): void {
    const existing = this.conversations.get(binding.threadId);
    this.conversations.set(binding.threadId, this.buildActiveConversation(binding, existing?.queue ?? []));
    this.save();
  }

  syncActive(binding: ActiveConversationBinding): boolean {
    const existing = this.conversations.get(binding.threadId);
    if (!existing) {
      this.conversations.set(binding.threadId, this.buildActiveConversation(binding, []));
      this.save();
      return true;
    }

    if (existing.state !== 'active') {
      return false;
    }

    if (existing.currentSessionId !== binding.sessionId) {
      return false;
    }

    this.conversations.set(binding.threadId, this.buildActiveConversation(binding, existing.queue));
    this.save();
    return true;
  }

  startClearTransition(threadId: number): boolean {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return false;
    }

    conversation.state = 'transitioning';
    this.save();
    return true;
  }

  enqueue(threadId: number, message: InboundMessage): boolean {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return false;
    }

    conversation.queue.push(message);
    this.save();
    return true;
  }

  peekQueued(threadId: number): InboundMessage | undefined {
    return this.conversations.get(threadId)?.queue[0];
  }

  shiftQueue(threadId: number): InboundMessage | undefined {
    const shifted = this.conversations.get(threadId)?.queue.shift();
    if (shifted) {
      this.save();
    }
    return shifted;
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
    this.save();
    return true;
  }

  deleteByThreadId(threadId: number): boolean {
    const deleted = this.conversations.delete(threadId);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  private buildActiveConversation(
    binding: ActiveConversationBinding,
    queue: InboundMessage[],
  ): ConversationInfo {
    return {
      threadId: binding.threadId,
      cwd: binding.cwd,
      topicName: binding.topicName,
      statusMessageId: binding.statusMessageId,
      state: 'active',
      currentSessionId: binding.sessionId,
      currentTranscriptPath: binding.transcriptPath,
      currentInputMethod: binding.inputMethod,
      permissionMode: binding.permissionMode,
      queue,
    };
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const data = Object.fromEntries(this.conversations.entries());
    const json = JSON.stringify(data, null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, json, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, ConversationInfo>;

      for (const [threadId, conversation] of Object.entries(data)) {
        this.conversations.set(Number(threadId), conversation);
      }
    } catch (err) {
      console.warn(
        `Warning: Failed to load conversations from ${this.filePath}, using empty store.`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
