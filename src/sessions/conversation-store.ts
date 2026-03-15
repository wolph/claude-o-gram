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

    this.save();
  }

  startClearTransition(threadId: number): void {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return;
    }

    conversation.state = 'transitioning';
    this.save();
  }

  enqueue(threadId: number, message: InboundMessage): void {
    const conversation = this.conversations.get(threadId);
    if (!conversation) {
      return;
    }

    conversation.queue.push(message);
    this.save();
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
    this.save();
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
        `Warning: Failed to load conversations from ${this.filePath}, starting with empty conversation map.`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
