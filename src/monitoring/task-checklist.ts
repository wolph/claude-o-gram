import { escapeHtml } from '../utils/text.js';

/** Tracked task entry */
interface TaskEntry {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
}

/** Callbacks for sending/editing Telegram messages */
export interface TaskChecklistCallbacks {
  send(threadId: number, html: string): Promise<number>;
  edit(messageId: number, html: string): Promise<void>;
}

/**
 * Maintains a live-updating task checklist message per session.
 *
 * Intercepts TaskCreate and TaskUpdate PostToolUse events,
 * tracks task state, and renders a single Telegram message
 * that is edited in-place as tasks progress.
 */
export class TaskChecklist {
  private sessions = new Map<string, {
    threadId: number;
    tasks: TaskEntry[];
    messageId: number;
  }>();
  private callbacks: TaskChecklistCallbacks;
  private updateTimer = new Map<string, ReturnType<typeof setTimeout>>();
  private static DEBOUNCE_MS = 500;

  constructor(callbacks: TaskChecklistCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Handle a PostToolUse event. Returns true if the event was consumed
   * (i.e., it was a TaskCreate or TaskUpdate that the checklist handled).
   */
  handleToolUse(
    sessionId: string,
    threadId: number,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResponse: Record<string, unknown>,
  ): boolean {
    if (toolName === 'TaskCreate') {
      const subject = (toolInput.subject as string) || 'Untitled task';
      // Extract task ID from response — format: "Task #N created successfully: ..."
      const responseStr = typeof toolResponse === 'string'
        ? toolResponse
        : (toolResponse.content as string) || (toolResponse.result as string) || JSON.stringify(toolResponse);
      const idMatch = responseStr.match(/#(\d+)/);
      const id = idMatch ? idMatch[1] : String(Date.now());

      let session = this.sessions.get(sessionId);
      if (!session) {
        session = { threadId, tasks: [], messageId: 0 };
        this.sessions.set(sessionId, session);
      }
      session.tasks.push({ id, subject, status: 'pending' });
      this.scheduleUpdate(sessionId);
      return true;
    }

    if (toolName === 'TaskUpdate') {
      const taskId = String(toolInput.taskId || '');
      const newStatus = toolInput.status as string | undefined;
      const session = this.sessions.get(sessionId);
      if (!session || !taskId) return true; // Consumed but nothing to do

      const task = session.tasks.find(t => t.id === taskId);
      if (task && newStatus) {
        if (newStatus === 'deleted') {
          session.tasks = session.tasks.filter(t => t.id !== taskId);
        } else {
          task.status = newStatus as TaskEntry['status'];
        }
        // Also update subject if provided
        if (toolInput.subject) {
          task.subject = toolInput.subject as string;
        }
        this.scheduleUpdate(sessionId);
      }
      return true;
    }

    // TaskList, TaskGet — ignore but consume
    if (toolName === 'TaskList' || toolName === 'TaskGet') {
      return true;
    }

    return false; // Not a task tool
  }

  /** Clean up a session's checklist state */
  cleanup(sessionId: string): void {
    const timer = this.updateTimer.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.updateTimer.delete(sessionId);
    }
    this.sessions.delete(sessionId);
  }

  /** Shut down all sessions */
  shutdown(): void {
    for (const sessionId of this.sessions.keys()) {
      this.cleanup(sessionId);
    }
  }

  private scheduleUpdate(sessionId: string): void {
    const existing = this.updateTimer.get(sessionId);
    if (existing) clearTimeout(existing);

    this.updateTimer.set(sessionId, setTimeout(() => {
      this.updateTimer.delete(sessionId);
      void this.render(sessionId);
    }, TaskChecklist.DEBOUNCE_MS));
  }

  private async render(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.tasks.length === 0) return;

    const html = this.formatChecklist(session.tasks);

    try {
      if (session.messageId === 0) {
        session.messageId = await this.callbacks.send(session.threadId, html);
      } else {
        await this.callbacks.edit(session.messageId, html);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('message is not modified')) {
        return; // Content unchanged — fine
      }
      console.warn('[CHECKLIST] Failed to update:', err instanceof Error ? err.message : err);
    }
  }

  private formatChecklist(tasks: TaskEntry[]): string {
    const lines: string[] = ['✢ <b>Task progress</b>', ''];

    for (const task of tasks) {
      const escaped = escapeHtml(task.subject);
      switch (task.status) {
        case 'completed':
          lines.push(`  ✔ <s>${escaped}</s>`);
          break;
        case 'in_progress':
          lines.push(`  ◼ <b>${escaped}</b>`);
          break;
        case 'pending':
        default:
          lines.push(`  ◻ ${escaped}`);
          break;
      }
    }

    return lines.join('\n');
  }
}
