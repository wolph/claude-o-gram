import { classifyRisk } from '../bot/formatter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Available permission modes for auto-approval */
export type PermissionMode = 'manual' | 'accept-all' | 'same-tool' | 'safe-only' | 'until-done';

/** Per-session mode state */
export interface ModeState {
  mode: PermissionMode;
  /** Tool name locked for 'same-tool' mode */
  lockedToolName?: string;
  /** Count of auto-approved tool calls in the current mode */
  autoApprovedCount: number;
}

// ---------------------------------------------------------------------------
// Dangerous command detection
// ---------------------------------------------------------------------------

/**
 * Narrow blocklist of obviously destructive command patterns.
 * Per CONTEXT.md locked decision: only rm -rf /, sudo, curl|bash, git push --force.
 * Fixed/hardcoded -- no user customization.
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+).*\//,  // rm -rf /
  /\bsudo\b/,                                               // sudo anything
  /\bcurl\b.*\|\s*\bbash\b/,                                // curl | bash
  /\bwget\b.*\|\s*\bbash\b/,                                // wget | bash
  /\bgit\s+push\b.*--force\b/,                              // git push --force
  /\bgit\s+push\b.*\s-f\b/,                                 // git push -f
];

/**
 * Check if a tool call involves a dangerous command that should never be
 * auto-approved regardless of the active permission mode.
 *
 * Only Bash/BashBackground commands are checked -- other tools (Read, Write, etc.)
 * are never dangerous by this definition.
 */
export function isDangerous(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== 'Bash' && toolName !== 'BashBackground') return false;
  const command = (toolInput.command as string) || '';
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}

// ---------------------------------------------------------------------------
// PermissionModeManager
// ---------------------------------------------------------------------------

/**
 * Per-session permission mode state machine.
 *
 * Tracks the active auto-approval mode for each Claude Code session and
 * answers shouldAutoApprove queries. Modes are ephemeral (in-memory only)
 * and default to 'manual' when no entry exists.
 *
 * Lifecycle:
 * - Modes reset on /clear (new session ID, old entry cleaned up)
 * - 'until-done' expires when Stop hook fires (caller resets via resetToManual)
 * - Other modes persist until user explicitly stops or session ends
 */
export class PermissionModeManager {
  private modes = new Map<string, ModeState>();

  /** Get the current mode state for a session. Returns manual default if not set. */
  getMode(sessionId: string): ModeState {
    return this.modes.get(sessionId) ?? { mode: 'manual', autoApprovedCount: 0 };
  }

  /**
   * Set the permission mode for a session.
   * For 'same-tool', pass the toolName to lock auto-approval to that tool.
   * Resets autoApprovedCount to 0.
   */
  setMode(sessionId: string, mode: PermissionMode, toolName?: string): void {
    this.modes.set(sessionId, {
      mode,
      lockedToolName: mode === 'same-tool' ? toolName : undefined,
      autoApprovedCount: 0,
    });
  }

  /** Reset a session to manual mode (deletes entry; default is manual). */
  resetToManual(sessionId: string): void {
    this.modes.delete(sessionId);
  }

  /**
   * Determine whether a tool call should be auto-approved based on the
   * current mode. Always returns false for dangerous commands regardless
   * of mode.
   */
  shouldAutoApprove(sessionId: string, toolName: string, toolInput: Record<string, unknown>): boolean {
    // Dangerous commands are never auto-approved
    if (isDangerous(toolName, toolInput)) return false;

    const state = this.getMode(sessionId);
    switch (state.mode) {
      case 'manual':
        return false;
      case 'accept-all':
        return true;
      case 'same-tool':
        return toolName === state.lockedToolName;
      case 'safe-only':
        return classifyRisk(toolName) === 'safe';
      case 'until-done':
        return true;
    }
  }

  /** Increment the auto-approved count for a session's current mode. */
  incrementAutoApproved(sessionId: string): void {
    const state = this.modes.get(sessionId);
    if (state) state.autoApprovedCount++;
  }

  /** Clean up mode state for a session (e.g., on session end or /clear). */
  cleanup(sessionId: string): void {
    this.modes.delete(sessionId);
  }
}
