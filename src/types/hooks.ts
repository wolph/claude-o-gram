// TypeScript types for Claude Code hook payloads
// These types match the JSON schemas from the Claude Code hooks reference

/** Base payload present in all hook events */
export interface HookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
}

/** Payload for SessionStart hook event */
export interface SessionStartPayload extends HookPayload {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model: string;
}

/** Payload for SessionEnd hook event */
export interface SessionEndPayload extends HookPayload {
  hook_event_name: 'SessionEnd';
  reason: string;
}

/** Payload for PostToolUse hook event */
export interface PostToolUsePayload extends HookPayload {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}
