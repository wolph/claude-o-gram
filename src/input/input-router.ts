import { join } from 'node:path';
import { homedir } from 'node:os';
import type { InputSender, SendResult } from './types.js';
import { TmuxInputSender, detectTmuxPane } from './tmux-input.js';
import { FifoInputSender, detectFifo } from './fifo-input.js';
import { SdkResumeInputSender } from './sdk-resume-input.js';

const FIFO_DIR = join(homedir(), '.claude', 'telegram-bot', 'input');

/**
 * Routes input to the appropriate sender for each session.
 *
 * Detection priority on session registration:
 * 1. tmux: find a pane running `claude` in the session's cwd
 * 2. FIFO: check for a named pipe at the conventional path
 * 3. SDK resume: fallback (only works for idle sessions)
 */
export class InputRouter {
  private senders = new Map<string, InputSender>();

  /**
   * Detect the best input method for a session and register a sender.
   * Called on SessionStart.
   */
  async register(sessionId: string, cwd: string, permissionMode?: string): Promise<void> {
    // 1. Check tmux
    const tmuxPane = await detectTmuxPane(cwd);
    if (tmuxPane) {
      this.senders.set(sessionId, new TmuxInputSender(tmuxPane));
      console.log(`Input[${sessionId.slice(0, 8)}]: tmux pane ${tmuxPane}`);
      return;
    }

    // 2. Check FIFO
    const fifoPath = detectFifo(FIFO_DIR, sessionId);
    if (fifoPath) {
      this.senders.set(sessionId, new FifoInputSender(fifoPath));
      console.log(`Input[${sessionId.slice(0, 8)}]: FIFO ${fifoPath}`);
      return;
    }

    // 3. Fallback to SDK resume
    this.senders.set(sessionId, new SdkResumeInputSender(sessionId, cwd, permissionMode));
    console.log(`Input[${sessionId.slice(0, 8)}]: sdk-resume (fallback)`);
  }

  /**
   * Send text to a session using its registered input method.
   */
  async send(sessionId: string, text: string): Promise<SendResult> {
    const sender = this.senders.get(sessionId);
    if (!sender) {
      return { status: 'failed', error: 'No input method registered for this session' };
    }
    return sender.send(text);
  }

  /** Get the input method name for a session (for status display) */
  getMethod(sessionId: string): 'tmux' | 'fifo' | 'sdk-resume' | null {
    return this.senders.get(sessionId)?.method ?? null;
  }

  /** Clean up a session's input sender */
  cleanup(sessionId: string): void {
    const sender = this.senders.get(sessionId);
    if (sender) {
      sender.cleanup();
      this.senders.delete(sessionId);
    }
  }
}
