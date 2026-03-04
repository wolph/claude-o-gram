import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { InputSender, SendResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Send input to a Claude Code session running in a tmux pane.
 *
 * Uses `tmux send-keys -t <paneId> -l <text>` followed by Enter.
 * The -l flag sends literal text (no special key interpretation).
 */
export class TmuxInputSender implements InputSender {
  readonly method = 'tmux' as const;

  constructor(private paneId: string) {}

  async send(text: string): Promise<SendResult> {
    try {
      // Send literal text (no key interpretation)
      await execFileAsync('tmux', ['send-keys', '-t', this.paneId, '-l', text]);
      // Small delay to let tmux process the pasted text before submitting
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Send Enter separately to submit
      await execFileAsync('tmux', ['send-keys', '-t', this.paneId, 'Enter']);
      return { status: 'sent' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: `tmux send-keys failed: ${msg}` };
    }
  }

  cleanup(): void {
    // Nothing to clean up — tmux pane is managed by the user
  }
}

/**
 * Detect a tmux pane running `claude` in the given working directory.
 * Returns the pane ID (e.g. "%53") or null if not found.
 */
export async function detectTmuxPane(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      'list-panes', '-a', '-F',
      '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}',
    ]);

    const lines = stdout.trim().split('\n').filter(Boolean);
    // Deduplicate (tmux can return duplicates across windows)
    const seen = new Set<string>();
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      const [paneId, command, path] = line.split('\t');
      if (!paneId || !command || !path) continue;
      // Match: command is "claude" (or contains it) AND path matches cwd
      if (command.includes('claude') && path === cwd) {
        return paneId;
      }
    }
    return null;
  } catch {
    // tmux not running or not available
    return null;
  }
}
