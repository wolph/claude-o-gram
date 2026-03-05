import { query } from '@anthropic-ai/claude-agent-sdk';
import type { InputSender, SendResult } from './types.js';

/**
 * Send input to a Claude Code session via SDK `query({ resume })`.
 *
 * Only works for IDLE sessions (where the CLI process has exited).
 * Fails or hangs for sessions still running in a terminal.
 *
 * Used as a fallback when tmux/FIFO are not available.
 */
export class SdkResumeInputSender implements InputSender {
  readonly method = 'sdk-resume' as const;
  private activeQuery: Promise<void> | null = null;

  constructor(
    private sessionId: string,
    private cwd: string,
    private permissionMode?: string,
  ) {}

  async send(text: string): Promise<SendResult> {
    // Serialize: wait for any active query to finish
    if (this.activeQuery) {
      try { await this.activeQuery; } catch { /* proceed */ }
    }

    const promise = this.executeQuery(text);
    this.activeQuery = promise;

    try {
      await promise;
      return { status: 'sent' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`SDK resume failed for ${this.sessionId}:`, msg);
      return { status: 'failed', error: msg };
    } finally {
      if (this.activeQuery === promise) this.activeQuery = null;
    }
  }

  private async executeQuery(text: string): Promise<void> {
    const abortController = new AbortController();
    // Shorter timeout (30s) since this is a fallback — if the session is locked
    // by a running process, it'll hang. Better to fail fast.
    const timeout = setTimeout(() => abortController.abort(), 30_000);

    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const options: Record<string, unknown> = {
        resume: this.sessionId,
        cwd: this.cwd,
        abortController,
        env,
        settingSources: [],
      };

      if (this.permissionMode === 'bypassPermissions') {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (this.permissionMode) {
        options.permissionMode = this.permissionMode;
      }

      const q = query({ prompt: text, options });
      try {
        for await (const message of q) {
          if (message.type === 'result') break;
        }
      } finally {
        q.close();
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  cleanup(): void {
    this.activeQuery = null;
  }
}
