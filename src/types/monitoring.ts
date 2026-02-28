// Phase 2 monitoring types: verbosity, status tracking, transcript parsing

/** Verbosity tier controlling which tool calls are posted to Telegram */
export type VerbosityTier = 'minimal' | 'normal' | 'verbose';

/** Token usage from Claude API responses */
export interface TokenUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  service_tier?: string;
}

/** Content block in a transcript message */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | unknown[] };

/** A single entry in the JSONL transcript file */
export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'summary';
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  version: string;
  cwd: string;
  isSidechain: boolean;
  message: {
    id?: string;
    role: 'user' | 'assistant';
    model?: string;
    content: string | ContentBlock[];
    usage?: TokenUsage;
  };
}

/** Data for the pinned status message, refreshed periodically */
export interface StatusData {
  contextPercent: number;
  currentTool: string;
  sessionDuration: string;
  toolCallCount: number;
  filesChanged: number;
  status: 'active' | 'idle' | 'closed';
}
