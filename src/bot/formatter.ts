import { escapeHtml, truncateText, shortenCommand } from '../utils/text.js';
import type { PostToolUsePayload, PreToolUsePayload, NotificationPayload } from '../types/hooks.js';
import type { SessionInfo } from '../types/sessions.js';

// ---------------------------------------------------------------------------
// Compact tool result type
// ---------------------------------------------------------------------------

/**
 * Result of formatting a tool call in compact mode.
 * The compact string is a single-line HTML summary (max 250 chars).
 * expandContent holds the full output for the expand cache (null if not needed).
 */
export interface CompactToolResult {
  /** Single-line compact display, max 250 chars, HTML-escaped */
  compact: string;
  /** Full expanded content for LRU cache. null for tools that don't need expansion. */
  expandContent: string | null;
  /** Tool name for expand view headers */
  toolName: string;
}

// ---------------------------------------------------------------------------
// Session formatting (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Compact tool formatter
// ---------------------------------------------------------------------------

/**
 * Format a PostToolUse event into a compact single-line summary.
 *
 * Returns a CompactToolResult with:
 * - compact: single-line HTML (max 250 chars), e.g. `Read(src/bot/formatter.ts)`
 * - expandContent: full output for the expand cache (null if not applicable)
 * - toolName: for expand view headers
 */
export function formatToolCompact(payload: PostToolUsePayload): CompactToolResult {
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};
  const response = payload.tool_response || {};

  switch (toolName) {
    case 'Read':
      return compactRead(toolName, input);

    case 'Glob':
      return compactGlob(toolName, input);

    case 'Grep':
      return compactGrep(toolName, input);

    case 'Edit':
      return compactEdit(toolName, input);

    case 'MultiEdit':
      return compactMultiEdit(toolName, input);

    case 'Write':
      return compactWrite(toolName, input);

    case 'Bash':
      return compactBash(toolName, input, response);

    default: {
      // Agent/Task tools
      if (toolName.includes('Agent') || toolName.includes('Task')) {
        return compactAgent(toolName, input);
      }
      return compactDefault(toolName, input);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-tool compact formatters
// ---------------------------------------------------------------------------

function compactRead(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  const compact = truncCompact(`Read(${smartPath(filePath)})`);
  return { compact, expandContent: null, toolName };
}

function compactGlob(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const pattern = (input.pattern as string) || '*';
  const compact = truncCompact(`Glob("${pattern}")`);
  return { compact, expandContent: null, toolName };
}

function compactGrep(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const pattern = (input.pattern as string) || '';
  const path = (input.path as string) || '';
  const pathPart = path ? `, ${smartPath(path)}` : '';
  const compact = truncCompact(`Grep("${pattern}"${pathPart})`);
  return { compact, expandContent: null, toolName };
}

function compactEdit(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  const oldStr = (input.old_string as string) || '';
  const newStr = (input.new_string as string) || '';
  const stats = diffStats(oldStr, newStr);
  const compact = truncCompact(`Edit(${smartPath(filePath)}) ${stats}`);

  // Build simplified diff for expand content
  const diffLines: string[] = [];
  for (const line of oldStr.split('\n')) {
    diffLines.push(`- ${line}`);
  }
  for (const line of newStr.split('\n')) {
    diffLines.push(`+ ${line}`);
  }
  const expandContent = diffLines.join('\n').slice(0, 3900);

  return { compact, expandContent, toolName };
}

function compactMultiEdit(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  const edits = (input.edits as Array<Record<string, unknown>>) || [];
  const editCount = edits.length;

  // Aggregate diff stats across all edits
  let totalAdded = 0;
  let totalRemoved = 0;
  const diffSections: string[] = [];

  for (let i = 0; i < edits.length; i++) {
    const oldStr = (edits[i].old_string as string) || '';
    const newStr = (edits[i].new_string as string) || '';
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    totalRemoved += oldLines.length;
    totalAdded += newLines.length;

    const section: string[] = [`--- edit ${i + 1} ---`];
    for (const line of oldLines) {
      section.push(`- ${line}`);
    }
    for (const line of newLines) {
      section.push(`+ ${line}`);
    }
    diffSections.push(section.join('\n'));
  }

  const stats = `+${totalAdded} -${totalRemoved}`;
  const compact = truncCompact(`Edit(${smartPath(filePath)}) ${stats} (${editCount} edits)`);
  const expandContent = diffSections.join('\n\n').slice(0, 3900);

  return { compact, expandContent, toolName };
}

function compactWrite(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const filePath = (input.file_path as string) || (input.path as string) || 'unknown';
  const content = (input.content as string) || '';
  const lineCount = content.split('\n').length;
  const compact = truncCompact(`Write(${smartPath(filePath)}) ${lineCount} lines`);
  const expandContent = content.slice(0, 3900);

  return { compact, expandContent, toolName };
}

function compactBash(toolName: string, input: Record<string, unknown>, response: Record<string, unknown>): CompactToolResult {
  const command = shortenCommand((input.command as string) || '');
  // Determine exit status
  const exitCode = response.exit_code;
  const output = extractBashOutput(response);
  let indicator = '';

  if (typeof exitCode === 'number') {
    indicator = exitCode === 0 ? ' \u2713' : ' \u2717';
  } else if (output !== undefined) {
    // Heuristic: if there's stderr content with "error" or "Error", mark as failure
    const stderr = (typeof response.stderr === 'string') ? response.stderr : '';
    if (stderr && /error/i.test(stderr)) {
      indicator = ' \u2717';
    }
  }

  // Preview: first meaningful line of command, truncated
  const commandPreview = command.split('\n')[0].slice(0, 200);
  const compact = truncCompact(`Bash(${commandPreview})${indicator}`);

  // Expand content: full stdout/stderr
  const expandContent = output ? output.slice(0, 3900) : null;

  return { compact, expandContent, toolName };
}

function compactAgent(toolName: string, input: Record<string, unknown>): CompactToolResult {
  const description = (input.description as string) || (input.prompt as string) || '';
  const preview = description.slice(0, 80);
  const compact = truncCompact(`Agent(${toolName}) spawned -- "${preview}"`);
  return { compact, expandContent: null, toolName };
}

function compactDefault(toolName: string, input: Record<string, unknown>): CompactToolResult {
  let argsPreview = '';
  try {
    argsPreview = JSON.stringify(input);
  } catch {
    argsPreview = String(input);
  }
  if (argsPreview.length > 150) {
    argsPreview = argsPreview.slice(0, 150) + '\u2026';
  }
  const compact = truncCompact(`${toolName}(${argsPreview})`);

  // Expand content: full JSON of input
  let expandContent: string | null = null;
  try {
    expandContent = JSON.stringify(input, null, 2);
    if (expandContent && expandContent.length > 3900) {
      expandContent = expandContent.slice(0, 3900);
    }
  } catch {
    // ignore
  }

  return { compact, expandContent, toolName };
}

// ---------------------------------------------------------------------------
// Notification formatting (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Approval formatting (unchanged)
// ---------------------------------------------------------------------------

/** Risk level for tool approval display */
type RiskLevel = 'safe' | 'caution' | 'danger';

/**
 * Classify a tool's risk level for the approval message.
 * Per user decision: show risk indicator (safe/caution/danger based on tool type).
 * Exported for PermissionModeManager safe-only mode check.
 */
export function classifyRisk(toolName: string): RiskLevel {
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
 * Exported for formatDangerousPrompt reuse.
 */
export function buildToolPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'BashBackground': {
      const cmd = shortenCommand((input.command as string) || '');
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

// ---------------------------------------------------------------------------
// Auto-approval formatting
// ---------------------------------------------------------------------------

/**
 * Format a compact one-liner for an auto-approved tool call.
 * Lightning prefix indicates the tool was auto-approved by the active permission mode.
 * Format: "\u26A1 Bash(npm test)" or "\u26A1 Read(src/index.ts)"
 * Max 250 chars total.
 */
export function formatAutoApproved(toolName: string, toolInput: Record<string, unknown>): string {
  let preview: string;

  switch (toolName) {
    case 'Bash':
    case 'BashBackground': {
      const command = shortenCommand((toolInput.command as string) || '');
      const commandPreview = command.split('\n')[0].slice(0, 200);
      preview = `${toolName}(${commandPreview})`;
      break;
    }
    case 'Read': {
      const filePath = (toolInput.file_path as string) || (toolInput.path as string) || 'unknown';
      preview = `Read(${smartPath(filePath)})`;
      break;
    }
    case 'Glob': {
      const pattern = (toolInput.pattern as string) || '*';
      preview = `Glob("${pattern}")`;
      break;
    }
    case 'Grep': {
      const pattern = (toolInput.pattern as string) || '';
      const path = (toolInput.path as string) || '';
      const pathPart = path ? `, ${smartPath(path)}` : '';
      preview = `Grep("${pattern}"${pathPart})`;
      break;
    }
    case 'Write': {
      const filePath = (toolInput.file_path as string) || (toolInput.path as string) || 'unknown';
      preview = `Write(${smartPath(filePath)})`;
      break;
    }
    case 'Edit':
    case 'MultiEdit': {
      const filePath = (toolInput.file_path as string) || (toolInput.path as string) || 'unknown';
      preview = `Edit(${smartPath(filePath)})`;
      break;
    }
    default: {
      let argsPreview = '';
      try {
        argsPreview = JSON.stringify(toolInput);
      } catch {
        argsPreview = String(toolInput);
      }
      if (argsPreview.length > 150) {
        argsPreview = argsPreview.slice(0, 150) + '\u2026';
      }
      preview = `${toolName}(${argsPreview})`;
      break;
    }
  }

  return truncCompact(`\u26A1 ${preview}`);
}

/**
 * Format a warning-styled approval prompt for dangerous commands.
 * Visually distinct from normal prompts per CONTEXT.md locked decision.
 * Uses bold warning prefix and the existing buildToolPreview for command detail.
 */
export function formatDangerousPrompt(payload: PreToolUsePayload): string {
  const parts: string[] = [
    `\u26A0\uFE0F <b>DANGEROUS COMMAND</b>`,
  ];

  const preview = buildToolPreview(payload.tool_name, payload.tool_input);
  if (preview) {
    parts.push(preview);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Shorten a file path for compact display.
 * - Replace $HOME with ~/
 * - If <= 60 chars, return as-is
 * - Otherwise: first segment + ... + last 2 segments
 */
function smartPath(filePath: string): string {
  let p = filePath;
  const home = process.env.HOME;
  if (home && p.startsWith(home + '/')) {
    p = '~/' + p.slice(home.length + 1);
  }
  if (p.length <= 60) return p;

  const segments = p.split('/');
  if (segments.length <= 3) return p;

  const first = segments[0];
  const lastTwo = segments.slice(-2).join('/');
  return `${first}/.../${lastTwo}`;
}

/**
 * Count lines added/removed between old and new strings.
 * Returns a "+N -M" stats string.
 */
function diffStats(oldStr: string, newStr: string): string {
  const oldLines = oldStr ? oldStr.split('\n').length : 0;
  const newLines = newStr ? newStr.split('\n').length : 0;
  return `+${newLines} -${oldLines}`;
}

/**
 * Truncate a compact line to 250 chars max, HTML-escaping dynamic content.
 * Uses Unicode ellipsis for truncation.
 */
function truncCompact(raw: string): string {
  const escaped = escapeHtml(raw);
  if (escaped.length <= 250) return escaped;
  return escaped.slice(0, 247) + '\u2026';
}

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
