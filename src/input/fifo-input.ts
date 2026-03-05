import { open, constants } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import type { InputSender, SendResult } from './types.js';

/**
 * Send input to a Claude Code session reading from a named pipe (FIFO).
 *
 * The user starts Claude with stdin redirected from the FIFO:
 *   mkfifo ~/.claude/telegram-bot/input/my-session.fifo
 *   claude < ~/.claude/telegram-bot/input/my-session.fifo
 *
 * Note: FIFO replaces terminal stdin — for headless/automated sessions only.
 */
export class FifoInputSender implements InputSender {
  readonly method = 'fifo' as const;

  constructor(private fifoPath: string) {}

  async send(text: string): Promise<SendResult> {
    let fd: import('node:fs/promises').FileHandle | undefined;
    try {
      // O_WRONLY | O_NONBLOCK: don't block if no reader is connected
      fd = await open(this.fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
      await fd.write(text + '\n');
      return { status: 'sent' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENXIO')) {
        return { status: 'failed', error: 'No reader on FIFO — is Claude running with this pipe?' };
      }
      return { status: 'failed', error: `FIFO write failed: ${msg}` };
    } finally {
      await fd?.close();
    }
  }

  cleanup(): void {
    // Don't remove the FIFO — user manages it
  }
}

/**
 * Check if a FIFO exists at the conventional path for a session.
 * Convention: ~/.claude/telegram-bot/input/<session-id>.fifo
 */
export function detectFifo(fifoDir: string, sessionId: string): string | null {
  const fifoPath = `${fifoDir}/${sessionId}.fifo`;
  try {
    if (existsSync(fifoPath) && statSync(fifoPath).isFIFO()) {
      return fifoPath;
    }
  } catch {
    // Not found or stat failed
  }
  return null;
}
