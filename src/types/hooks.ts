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

/** Payload for PreToolUse hook event (blocking approval flow) */
export interface PreToolUsePayload extends HookPayload {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}

/** Payload for Notification hook event (permission prompts, idle alerts, etc.) */
export interface NotificationPayload extends HookPayload {
  hook_event_name: 'Notification';
  notification_type: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog';
  message: string;
  title?: string;
}

/** Payload for Stop hook event (fires when Claude finishes responding) */
export interface StopPayload extends HookPayload {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message: string;
}
