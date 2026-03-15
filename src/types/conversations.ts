export type ConversationState = 'active' | 'transitioning';
export type ConversationInputMethod = 'tmux' | 'fifo' | 'sdk-resume';

export interface InboundMessage {
  telegramMessageId: number;
  kind: 'text' | 'command';
  rawText: string;
  routedText: string;
  receivedAt: string;
}

export interface ConversationInfo {
  threadId: number;
  cwd: string;
  topicName: string;
  statusMessageId: number;
  state: ConversationState;
  currentSessionId: string;
  currentTranscriptPath: string;
  currentInputMethod?: ConversationInputMethod;
  permissionMode?: string;
  queue: InboundMessage[];
}

export interface ActiveConversationBinding {
  threadId: number;
  cwd: string;
  topicName: string;
  sessionId: string;
  transcriptPath: string;
  inputMethod?: ConversationInputMethod;
  permissionMode?: string;
  statusMessageId: number;
}

export interface ReplacementConversationBinding {
  sessionId: string;
  transcriptPath: string;
  inputMethod: ConversationInputMethod;
  permissionMode?: string;
}
