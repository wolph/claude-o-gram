import { escapeHtml, truncateText, splitForTelegram } from '../utils/text.js';
import type { PostToolUsePayload, PreToolUsePayload, NotificationPayload } from '../types/hooks.js';
import type { SessionInfo } from '../types/sessions.js';

/**
 * Format a session start notification message.
 */
export function formatSessionStart(session: SessionInfo, isResume: boolean): string {
  const cwd = escapeHtml(session.cwd);
  if (isResume) {
    return `\u{1F504} <b>Session resumed</b> in <code>${cwd}</code>`;
  }
  return `\u{1F7E2} <b>Session started</b> in <code>${cwd}</code>`;
}

/**
 * Format a session end notification message with summary statistics.
 */
export function formatSessionEnd(session: SessionInfo, reason: string): string {
  const escapedReason = escapeHtml(reason);

  // Calculate duration
  const startMs = new Date(session.startedAt).getTime();
  const endMs = Date.now();
  const durationMs = endMs - startMs;
  const durationStr = formatDuration(durationMs);

  // Gather files changed
  const files = session.filesChanged instanceof Set
    ? Array.from(session.filesChanged)
    : (session.filesChanged || []);

  let filesList = '';
  if (files.length > 0) {
    const displayFiles = files.slice(0, 10);
    filesList = displayFiles.map((f) => `  \u2022 <code>${escapeHtml(f)}</code>`).join('\n');
    if (files.length > 10) {
      filesList += `\n  <i>(+ ${files.length - 10} more)</i>`;
    }
  }

  const parts = [
    `\u2705 <b>Session ended</b> (${escapedReason})`,
    '',
    `\u{1F4CA} <b>Summary:</b>`,
    `\u2022 Duration: ${durationStr}`,
    `\u2022 Tool calls: ${session.toolCallCount}`,
    `\u2022 Files changed: ${files.length}`,
  ];

  if (filesList) {
    parts.push(filesList);
  }

  return parts.join('\n');
}

/**
 * Format a PostToolUse event into HTML text and optionally a file attachment.
 *
 * Tiered verbosity per user decisions:
 * - Compact one-liners for reads/searches
 * - Detailed blocks for edits/bash
 * - File attachments for long outputs
 */
export function formatToolUse(
  payload: PostToolUsePayload,
): { text: string; attachment?: { content: string; filename: string } } {
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};
  const response = payload.tool_response || {};

  switch (toolName) {
    case 'Read':
      return formatRead(input);

    case 'Glob':
      return formatGlob(input, response);

    case 'Grep':
      return formatGrep(input);

    case 'Write':
      return formatWrite(input);

    case 'Edit':
      return formatEdit(input);

    case 'MultiEdit':
      return formatMultiEdit(input);

    case 'Bash':
      return formatBash(input, response);

    default:
      return formatDefault(toolName, input);
  }
}

/**
 * Format a Notification hook event into HTML with urgency-based styling.
 * Permission prompts are visually distinct from regular tool calls.
 */
export function formatNotification(payload: NotificationPayload): string {
  const message = escapeHtml(payload.message);
  const title = payload.title ? escapeHtml(payload.title) : undefined;

  switch (payload.notification_type) {
    case 'permission_prompt':
      return [
        `\u26A0\uFE0F <b>Permission Required</b>`,
        title ? `<b>${title}</b>` : '',
        `<blockquote>${message}</blockquote>`,
      ].filter(Boolean).join('\n');

    case 'idle_prompt':
      return `\u{1F4A4} <b>Claude is idle</b>\n${message}`;

    case 'auth_success':
      return `\u2705 <b>Authentication successful</b>\n${message}`;

    case 'elicitation_dialog':
      return [
        `\u2753 <b>Input Needed</b>`,
        title ? `<b>${title}</b>` : '',
        message,
      ].filter(Boolean).join('\n');

    default:
      return `\u{1F514} <b>Notification</b>\n${message}`;
  }
}

// --- Phase 3: Approval formatting ---

/** Risk level for tool approval display */
type RiskLevel = 'safe' | 'caution' | 'danger';

/**
 * Classify a tool's risk level for the approval message.
 * Per user decision: show risk indicator (safe/caution/danger based on tool type).
 */
function classifyRisk(toolName: string): RiskLevel {
  // Danger: tools that execute arbitrary commands or delete things
  const dangerTools = new Set(['Bash', 'BashBackground']);
  if (dangerTools.has(toolName)) return 'danger';

  // Caution: tools that modify files
  const cautionTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  if (cautionTools.has(toolName)) return 'caution';

  // Safe: read-only tools
  return 'safe';
}

/** Emoji for each risk level */
const RISK_EMOJI: Record<RiskLevel, string> = {
  safe: '\u{1F7E2}',     // green circle
  caution: '\u{1F7E1}',  // yellow circle
  danger: '\u{1F534}',   // red circle
};

/** Label for each risk level */
const RISK_LABEL: Record<RiskLevel, string> = {
  safe: 'Safe',
  caution: 'Caution',
  danger: 'Danger',
};

/**
 * Format a PreToolUse approval request message.
 * Per user decision: "Show tool name, what it wants to do (file path, command),
 * and a risk indicator (safe/caution/danger based on tool type). Include a compact
 * preview of tool input: bash command text, file path + first few lines of edit,
 * truncated to ~200 chars."
 *
 * Returns HTML text suitable for sending with an InlineKeyboard.
 */
export function formatApprovalRequest(payload: PreToolUsePayload): string {
  const risk = classifyRisk(payload.tool_name);
  const riskEmoji = RISK_EMOJI[risk];
  const riskLabel = RISK_LABEL[risk];
  const toolName = escapeHtml(payload.tool_name);

  const parts: string[] = [
    `${riskEmoji} <b>Approval Required</b> [${riskLabel}]`,
    `<b>Tool:</b> ${toolName}`,
  ];

  // Add compact preview of what the tool wants to do
  const preview = buildToolPreview(payload.tool_name, payload.tool_input);
  if (preview) {
    parts.push(preview);
  }

  return parts.join('\n');
}

/**
 * Build a compact preview of the tool input for the approval message.
 * Truncated to ~200 chars per user decision.
 */
function buildToolPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'BashBackground': {
      const cmd = (input.command as string) || '';
      const truncated = escapeHtml(truncateText(cmd, 200));
      return `<b>Command:</b>\n<pre>${truncated}</pre>`;
    }

    case 'Write': {
      const filePath = (input.file_path as string) || (input.path as string) || '';
      const content = (input.content as string) || '';
      const preview = escapeHtml(truncateText(content, 150));
      return `<b>File:</b> <code>${escapeHtml(filePath)}</code>\n<pre>${preview}</pre>`;
    }

    case 'Edit':
    case 'MultiEdit': {
      const filePath = (input.file_path as string) || (input.path as string) || '';
      const oldStr = (input.old_string as string) || '';
      const newStr = (input.new_string as string) || '';
      const combined = `- ${oldStr}\n+ ${newStr}`;
      const preview = escapeHtml(truncateText(combined, 200));
      return `<b>File:</b> <code>${escapeHtml(filePath)}</code>\n<pre>${preview}</pre>`;
    }

    case 'Read': {
      const filePath = (input.file_path as string) || (input.path as string) || '';
      return `<b>File:</b> <code>${escapeHtml(filePath)}</code>`;
    }

    case 'Glob': {
      const pattern = (input.pattern as string) || '';
      return `<b>Pattern:</b> <code>${escapeHtml(pattern)}</code>`;
    }

    case 'Grep': {
      const pattern = (input.pattern as string) || '';
      const path = (input.path as string) || '';
      return `<b>Pattern:</b> <code>${escapeHtml(pattern)}</code>` +
        (path ? ` in <code>${escapeHtml(path)}</code>` : '');
    }

    default: {
      // Generic: show JSON preview of input
      let inputStr = '';
      try {
        inputStr = JSON.stringify(input, null, 2);
      } catch {
        inputStr = String(input);
      }
      const preview = escapeHtml(truncateText(inputStr, 200));
      return `<pre>${preview}</pre>`;
    }
  }
}

/**
 * Format the result text appended to an approval message after the user acts.
 * Per user decision: "update message in place -- replace buttons with
 * 'Approved' or 'Denied' text + who acted + timestamp"
 *
 * @param decision 'allow' or 'deny'
 * @param who Username or first name of the person who acted
 * @param originalText The original approval request message text
 */
export function formatApprovalResult(
  decision: 'allow' | 'deny',
  who: string,
  originalText: string,
): string {
  const timestamp = new Date().toLocaleTimeString();
  const escapedWho = escapeHtml(who);

  if (decision === 'allow') {
    return `${originalText}\n\n\u2705 <b>Approved</b> by ${escapedWho} at ${timestamp}`;
  }
  return `${originalText}\n\n\u274C <b>Denied</b> by ${escapedWho} at ${timestamp}`;
}

/**
 * Format the expired text for an approval that timed out.
 * Per user decision: "On expiry: update message in place with
 * 'Expired -- auto-denied after 5m'"
 *
 * @param originalText The original approval request message text
 * @param timeoutMs The timeout duration in milliseconds
 */
export function formatApprovalExpired(
  originalText: string,
  timeoutMs: number,
): string {
  const minutes = Math.round(timeoutMs / 60000);
  return `${originalText}\n\n\u23F0 <b>Expired</b> \u2014 auto-denied after ${minutes}m`;
}

// --- Compact one-liners for reads/searches ---

function formatRead(
  input: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  return { text: `\u{1F441} Read <code>${escapeHtml(filePath)}</code>` };
}

function formatGlob(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const pattern = (input.pattern as string) || 'unknown';
  // Try to extract match count from response
  const content = response.content as string | undefined;
  let countStr = '';
  if (content) {
    const lines = content.trim().split('\n').filter(Boolean);
    countStr = ` (${lines.length} matches)`;
  }
  return { text: `\u{1F50D} Glob <code>${escapeHtml(pattern)}</code>${countStr}` };
}

function formatGrep(
  input: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const pattern = (input.pattern as string) || 'unknown';
  const path = (input.path as string) || '';
  const pathPart = path ? ` in <code>${escapeHtml(path)}</code>` : '';
  return { text: `\u{1F50D} Grep <code>${escapeHtml(pattern)}</code>${pathPart}` };
}

// --- Detailed blocks for edits/bash ---

function formatWrite(
  input: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  const content = (input.content as string) || '';
  const preview = escapeHtml(truncateText(content, 500));
  return {
    text: `\u{1F4DD} <b>Write</b> <code>${escapeHtml(filePath)}</code>\n<pre>${preview}</pre>`,
  };
}

function formatEdit(
  input: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  let oldStr = (input.old_string as string) || '';
  let newStr = (input.new_string as string) || '';

  // Truncate if combined length is too long
  if (oldStr.length + newStr.length > 1000) {
    oldStr = truncateText(oldStr, 500);
    newStr = truncateText(newStr, 500);
  }

  return {
    text: [
      `\u{1F4DD} <b>Edit</b> <code>${escapeHtml(filePath)}</code>`,
      `<pre>- ${escapeHtml(oldStr)}`,
      `+ ${escapeHtml(newStr)}</pre>`,
    ].join('\n'),
  };
}

function formatMultiEdit(
  input: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  const edits = input.edits as Array<Record<string, unknown>> | undefined;
  const editCount = edits ? edits.length : 0;

  // Show first edit as sample if available
  if (edits && edits.length > 0) {
    let oldStr = (edits[0].old_string as string) || '';
    let newStr = (edits[0].new_string as string) || '';

    if (oldStr.length + newStr.length > 1000) {
      oldStr = truncateText(oldStr, 500);
      newStr = truncateText(newStr, 500);
    }

    return {
      text: [
        `\u{1F4DD} <b>Edit</b> <code>${escapeHtml(filePath)}</code> (${editCount} edits)`,
        `<pre>- ${escapeHtml(oldStr)}`,
        `+ ${escapeHtml(newStr)}</pre>`,
      ].join('\n'),
    };
  }

  return {
    text: `\u{1F4DD} <b>Edit</b> <code>${escapeHtml(filePath)}</code> (${editCount} edits)`,
  };
}

function formatBash(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): { text: string; attachment?: { content: string; filename: string } } {
  const command = (input.command as string) || '';
  const output = extractBashOutput(response);

  const parts: string[] = [
    `\u{1F4BB} <b>Bash</b>`,
    `<pre><code>${escapeHtml(command)}</code></pre>`,
  ];

  let attachment: { content: string; filename: string } | undefined;

  if (output) {
    const split = splitForTelegram(output);
    if (split.inline) {
      if (output.length <= 400) {
        // Short output: use blockquote
        parts.push(`<blockquote>${escapeHtml(output)}</blockquote>`);
      } else {
        // Medium output: use pre block
        parts.push(`<pre>${escapeHtml(output)}</pre>`);
      }
    } else {
      // Long output: send as file attachment
      attachment = { content: output, filename: 'bash-output.txt' };
      parts.push(`<i>(output sent as file attachment)</i>`);
    }
  }

  return { text: parts.join('\n'), attachment };
}

// --- Default for unknown tools ---

function formatDefault(
  toolName: string,
  input: Record<string, unknown>,
): { text: string; attachment?: undefined } {
  const escapedName = escapeHtml(toolName);
  let inputStr = '';
  try {
    inputStr = JSON.stringify(input, null, 2);
  } catch {
    inputStr = String(input);
  }
  const truncated = escapeHtml(truncateText(inputStr, 500));
  return {
    text: `\u{1F527} <b>${escapedName}</b>\n<pre>${truncated}</pre>`,
  };
}

// --- Helpers ---

/**
 * Extract bash output from response payload.
 * The response structure may vary; try common field names.
 */
function extractBashOutput(response: Record<string, unknown>): string {
  if (typeof response.content === 'string') {
    return response.content;
  }
  if (typeof response.stdout === 'string') {
    return response.stdout;
  }
  if (typeof response.output === 'string') {
    return response.output;
  }
  return '';
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours} hour${hours !== 1 ? 's' : ''} ${minutes} minute${minutes !== 1 ? 's' : ''}`;
    }
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
  return `${totalSeconds} second${totalSeconds !== 1 ? 's' : ''}`;
}
