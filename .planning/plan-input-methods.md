# Plan: Dual Input Methods (tmux + FIFO)

## Problem

`query({ resume })` creates a new subprocess — it cannot inject input into a running Claude Code session. Sessions running in a terminal are locked by the CLI process. SDK resume only works for idle/exited sessions.

## Principles

- **CLI is leading, Telegram is backup** — never replace terminal interaction
- tmux send-keys: for interactive sessions (user keeps terminal)
- FIFO: for headless sessions (all input via Telegram)
- SDK resume: fallback for idle sessions (CLI exited)

## Architecture

### Input sender interface

```typescript
// src/input/types.ts
interface InputSender {
  send(text: string): Promise<{ status: 'sent' } | { status: 'failed'; error: string }>;
  cleanup(): void;
}
```

Three implementations: `TmuxInputSender`, `FifoInputSender`, `SdkResumeInputSender` (existing).

### Input router

```typescript
// src/input/input-router.ts
class InputRouter {
  private senders = new Map<string, InputSender>(); // sessionId → sender

  // Called on SessionStart — detects which method to use
  register(session: SessionInfo): void;

  // Called by bot text handler
  send(sessionId: string, text: string): Promise<...>;

  // Called on SessionEnd
  cleanup(sessionId: string): void;
}
```

Detection priority on SessionStart:
1. Check tmux: `tmux list-panes -a -F '#{pane_id} #{pane_current_command} #{pane_current_path}'` — find pane running `claude` in session's cwd → `TmuxInputSender`
2. Check FIFO: look for file at `~/.claude/telegram-bot/input/<session-id>.fifo` → `FifoInputSender`
3. Fallback: `SdkResumeInputSender` (works only when session goes idle)

### tmux implementation

```typescript
// src/input/tmux-input.ts
class TmuxInputSender implements InputSender {
  constructor(private paneId: string) {}

  async send(text: string): Promise<...> {
    // tmux send-keys -t <paneId> -l <text>
    // then: tmux send-keys -t <paneId> Enter
    // -l flag: literal text (no special key interpretation)
  }
}
```

Uses `child_process.execFile('tmux', ['send-keys', '-t', paneId, '-l', text])` then sends Enter separately. This is how the original v1.0 tmux code worked.

### FIFO implementation

```typescript
// src/input/fifo-input.ts
class FifoInputSender implements InputSender {
  constructor(private fifoPath: string) {}

  async send(text: string): Promise<...> {
    // Write text + newline to the FIFO
    // Use fs.open with O_WRONLY | O_NONBLOCK to avoid blocking if no reader
  }
}
```

FIFO setup (user responsibility):
```bash
mkfifo ~/.claude/telegram-bot/input/my-session.fifo
claude < ~/.claude/telegram-bot/input/my-session.fifo
```

Note: FIFO replaces stdin — no terminal keyboard input. For headless/automated use only.

### SDK resume (existing, fixed)

Already has the `CLAUDECODE` env fix. Keep as fallback — works when the CLI process has exited and the user sends a follow-up message in Telegram.

## Files to create

1. `src/input/types.ts` — InputSender interface
2. `src/input/tmux-input.ts` — tmux send-keys implementation
3. `src/input/fifo-input.ts` — FIFO write implementation
4. `src/input/input-router.ts` — detection + routing logic

## Files to modify

1. `src/types/sessions.ts` — add `inputMethod` and `tmuxTarget` fields
2. `src/bot/bot.ts` — text handler uses InputRouter instead of SdkInputManager
3. `src/index.ts` — create InputRouter, wire it into bot and hook callbacks
4. `src/sdk/input-manager.ts` — refactor to implement InputSender interface

## Sequence

1. Create `src/input/types.ts` (interface)
2. Refactor `SdkInputManager` → implement `InputSender`
3. Create `TmuxInputSender`
4. Create `FifoInputSender`
5. Create `InputRouter` with detection logic
6. Update `SessionInfo` type
7. Wire into `bot.ts` and `index.ts`
8. Build + test

## Detection detail: tmux pane matching

```bash
tmux list-panes -a -F '#{pane_id} #{pane_current_command} #{pane_current_path}'
```

Output: `%53 claude /home/cryptobot/workspace/claude-o-gram`

Match: `pane_current_command` contains "claude" AND `pane_current_path` matches session cwd.

If multiple panes match, use the most recently active one.

Edge case: `pane_current_command` may show `node` instead of `claude` (if Claude is running via `npx` or similar). Mitigate by also checking for `claude` or `node.*claude` in the pane's process tree.
