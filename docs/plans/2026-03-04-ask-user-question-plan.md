# AskUserQuestion Telegram Forwarding — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect AskUserQuestion tool_use blocks in the Claude Code transcript JSONL and forward them to Telegram as interactive inline keyboard prompts.

**Architecture:** TranscriptWatcher already tails the transcript JSONL and filters for text blocks. We add detection for `tool_use` blocks with `name === 'AskUserQuestion'`, emit a callback with the parsed question data, and wire it to a Telegram message with inline keyboard buttons. Button clicks send number keystrokes via tmux.

**Tech Stack:** TypeScript, grammY (InlineKeyboard, callback queries), tmux keystroke injection via InputRouter

---

### Task 1: Add AskUserQuestionData type

**Files:**
- Modify: `src/types/monitoring.ts`

**Step 1: Add the type definition**

Add to the end of `src/types/monitoring.ts`:

```typescript
/** Parsed data from an AskUserQuestion tool_use block in the transcript */
export interface AskUserQuestionData {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{
      label: string;
      description?: string;
    }>;
    multiSelect: boolean;
  }>;
}
```

This mirrors the `input` shape of AskUserQuestion as seen in Claude Code transcripts. The `questions` array contains 1-4 questions, each with 2-4 options.

**Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/types/monitoring.ts
git commit -m "feat: add AskUserQuestionData type for transcript detection"
```

---

### Task 2: Add onAskUserQuestion callback to TranscriptWatcher

**Files:**
- Modify: `src/monitoring/transcript-watcher.ts`

**Step 1: Add the callback parameter and detection logic**

In the constructor signature (line 61-71), add a 5th optional parameter:

```typescript
constructor(
  filePath: string,
  onAssistantMessage: (text: string) => void,
  onUsageUpdate: (usage: TokenUsage) => void,
  onSidechainMessage?: (text: string) => void,
  onAskUserQuestion?: (data: AskUserQuestionData) => void,
)
```

Add the import at the top:

```typescript
import type { TokenUsage, TranscriptEntry, ContentBlock, AskUserQuestionData } from '../types/monitoring.js';
```

Store it as a private field:

```typescript
private onAskUserQuestion?: (data: AskUserQuestionData) => void;
```

And assign in constructor body:

```typescript
this.onAskUserQuestion = onAskUserQuestion;
```

**Step 2: Add AskUserQuestion detection in processEntry()**

In `processEntry()`, after text extraction (around line 255, after the text blocks loop) and before the usage update check, add detection for AskUserQuestion tool_use blocks. This must work for **both** main-chain and sidechain entries (the design says "All including subagents").

Add this code block in processEntry(), after the existing text/usage logic but applicable to both sidechain and main-chain paths. The cleanest approach: add a private helper method and call it from both paths.

Add a new private method:

```typescript
/**
 * Scan content blocks for AskUserQuestion tool_use and emit callback.
 * Called from both main-chain and sidechain processing paths.
 */
private detectAskUserQuestion(content: string | ContentBlock[]): void {
  if (!this.onAskUserQuestion) return;
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) return;

  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_use') continue;
    if (block.name !== 'AskUserQuestion') continue;

    const input = block.input as Record<string, unknown>;
    const questions = input.questions as Array<Record<string, unknown>> | undefined;
    if (!questions || !Array.isArray(questions)) continue;

    const parsed: AskUserQuestionData = {
      toolUseId: block.id,
      questions: questions.map((q) => ({
        question: (q.question as string) || '',
        header: (q.header as string) || undefined,
        options: ((q.options as Array<Record<string, unknown>>) || []).map((o) => ({
          label: (o.label as string) || '',
          description: (o.description as string) || undefined,
        })),
        multiSelect: (q.multiSelect as boolean) || false,
      })),
    };

    this.onAskUserQuestion(parsed);
  }
}
```

Then call `this.detectAskUserQuestion(content)` in two places:

1. In the sidechain path (around line 215-232), after text extraction, before the early return:
   ```typescript
   // Detect AskUserQuestion in sidechain entries too
   this.detectAskUserQuestion(content);
   ```

2. In the main-chain path (around line 255), after text extraction, before the usage check:
   ```typescript
   // Detect AskUserQuestion tool_use blocks
   this.detectAskUserQuestion(content);
   ```

**Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/monitoring/transcript-watcher.ts
git commit -m "feat: detect AskUserQuestion tool_use blocks in transcript watcher"
```

---

### Task 3: Add formatAskUserQuestion to formatter

**Files:**
- Modify: `src/bot/formatter.ts`

**Step 1: Add the import**

Add `AskUserQuestionData` to the monitoring types import. Since formatter.ts doesn't currently import from monitoring types, add a new import:

```typescript
import type { AskUserQuestionData } from '../types/monitoring.js';
```

**Step 2: Add the formatting function**

Add at the end of the file (before the final closing comments or after the bypass batch section):

```typescript
// ---------------------------------------------------------------------------
// AskUserQuestion formatting
// ---------------------------------------------------------------------------

/**
 * Format an AskUserQuestion for Telegram display.
 * Shows the question text with header, suitable for pairing with
 * an InlineKeyboard of option buttons.
 *
 * Only formats the first question (Claude Code sends 1-4 but typically 1).
 */
export function formatAskUserQuestion(data: AskUserQuestionData): string {
  const q = data.questions[0];
  if (!q) return '❓ <b>Input Needed</b>';

  const parts: string[] = [];

  // Header line
  const header = q.header ? escapeHtml(q.header) : 'Question';
  parts.push(`❓ <b>Input Needed</b> — ${header}`);

  // Question text
  parts.push('');
  parts.push(escapeHtml(q.question));

  return parts.join('\n');
}
```

**Step 3: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/bot/formatter.ts
git commit -m "feat: add formatAskUserQuestion formatter for Telegram display"
```

---

### Task 4: Add `ask:` callback query handler to bot.ts

**Files:**
- Modify: `src/bot/bot.ts`

This task adds:
1. An inline keyboard builder for AskUserQuestion options
2. A callback query handler for `ask:` button clicks

**Step 1: Add the InlineKeyboard builder function**

Add a new exported function at the bottom of `src/bot/bot.ts` (after `makeApprovalKeyboard`):

```typescript
/**
 * Create an InlineKeyboard for AskUserQuestion options.
 * Each predefined option becomes a button. An "Other →" button is appended.
 * Callback data format: `ask:<toolUseId_first8>:<option_index>`
 *
 * The 64-byte Telegram callback_data limit is respected:
 * "ask:" (4) + 8-char ID (8) + ":" (1) + index (1-2) = 14-15 bytes max.
 */
export function makeAskKeyboard(
  toolUseId: string,
  options: Array<{ label: string }>,
): InlineKeyboard {
  const idPrefix = toolUseId.slice(0, 8);
  const kb = new InlineKeyboard();

  for (let i = 0; i < options.length; i++) {
    const label = options[i].label.slice(0, 30); // Truncate long labels
    kb.text(label, `ask:${idPrefix}:${i}`);
    // Two buttons per row
    if (i % 2 === 1 && i < options.length - 1) {
      kb.row();
    }
  }

  // "Other →" button on its own row
  kb.row();
  kb.text('Other →', `ask:${idPrefix}:other`);

  return kb;
}
```

**Step 2: Add the callback query handler**

In `createBot()`, after the existing settings callback query handlers (around line 328, after the `set_rm:inactive` handler), add:

```typescript
// --- AskUserQuestion callback query handlers ---
// Buttons send number keystrokes (1-4) via tmux to select an option.

bot.callbackQuery(/^ask:([a-f0-9]+):(\w+)$/, async (ctx) => {
  const idPrefix = ctx.match[1];
  const optionStr = ctx.match[2];

  // "Other →" button: show toast, no keystroke
  if (optionStr === 'other') {
    await ctx.answerCallbackQuery({
      text: 'Type your answer in the terminal.',
      show_alert: true,
    });
    return;
  }

  const optionIndex = parseInt(optionStr, 10);
  if (isNaN(optionIndex)) {
    await ctx.answerCallbackQuery({ text: 'Invalid option.', show_alert: true });
    return;
  }

  // Find the session from the thread
  const threadId = ctx.callbackQuery.message?.message_thread_id;
  if (!threadId) {
    await ctx.answerCallbackQuery({ text: 'No session found.', show_alert: true });
    return;
  }

  const session = sessionStore.getByThreadId(threadId);
  if (!session || session.status !== 'active') {
    await ctx.answerCallbackQuery({ text: 'Session not active.', show_alert: true });
    // Remove buttons from stale message
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch { /* best-effort */ }
    return;
  }

  // Check tmux availability
  const method = inputRouter.getMethod(session.sessionId);
  if (method !== 'tmux') {
    await ctx.answerCallbackQuery({
      text: 'No tmux pane — answer from your terminal',
      show_alert: true,
    });
    return;
  }

  // Send the option number key (1-indexed: option 0 → key "1", option 1 → key "2", etc.)
  const keystroke = String(optionIndex + 1);
  const result = await inputRouter.send(session.sessionId, keystroke);
  if (result.status !== 'sent') {
    await ctx.answerCallbackQuery({ text: `Failed: ${result.error}`, show_alert: true });
    return;
  }

  // Success: dismiss loading spinner
  await ctx.answerCallbackQuery();

  // Edit message: remove buttons, append selection indicator
  const who = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || 'User';
  try {
    // Get the button text that was selected from the inline keyboard
    const buttons = ctx.callbackQuery.message?.reply_markup?.inline_keyboard?.flat() || [];
    const selectedButton = buttons.find(b => b.callback_data === ctx.callbackQuery.data);
    const selectedLabel = selectedButton?.text || `Option ${optionIndex + 1}`;

    const originalText = ctx.callbackQuery.message?.text || '';
    // Use HTML from the original message if available
    const originalHtml = (ctx.callbackQuery.message as Record<string, unknown> | undefined)?.html_text as string | undefined;
    const baseText = originalHtml || escapeHtml(originalText);
    const updatedText = `${baseText}\n\n✅ <b>${escapeHtml(selectedLabel)}</b> — selected by ${escapeHtml(who)}`;
    await ctx.editMessageText(updatedText, { parse_mode: 'HTML', reply_markup: undefined });
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('message is not modified'))) {
      console.warn('Failed to edit ask message:', err instanceof Error ? err.message : err);
    }
  }
});
```

**Step 3: Add the `escapeHtml` import**

Add `escapeHtml` to the imports at the top of bot.ts:

```typescript
import { escapeHtml } from '../utils/text.js';
```

Note: `escapeHtml` is already imported indirectly via `formatApprovalResult`, but we need the direct import for the ask handler. Check if it's already imported — if `escapeHtml` is not in the existing imports from `../utils/text.js`, add it.

**Step 4: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/bot/bot.ts
git commit -m "feat: add AskUserQuestion inline keyboard and callback handler"
```

---

### Task 5: Wire onAskUserQuestion callback in initMonitoring

**Files:**
- Modify: `src/index.ts`

This task:
1. Adds a `Set<string>` per session to track seen `tool_use_id`s (dedup)
2. Passes the `onAskUserQuestion` callback to TranscriptWatcher
3. Sends the formatted message with inline keyboard to Telegram
4. Cleans up the seen set on session end

**Step 1: Add the seen-IDs tracking**

Add a per-session dedup set. Add this near the `monitors` map (around line 224):

```typescript
// Per-session dedup for AskUserQuestion tool_use_ids
const seenAskIds = new Map<string, Set<string>>();
```

**Step 2: Add imports**

Add `formatAskUserQuestion` to the formatter imports:

```typescript
import {
  formatSessionStart,
  formatSessionEnd,
  formatToolCompact,
  formatNotification,
  formatApprovalRequest,
  formatApprovalResult,
  formatSubagentSpawn,
  formatSubagentDone,
  formatBypassBatch,
  formatAskUserQuestion,
} from './bot/formatter.js';
```

Add `makeAskKeyboard` to the bot imports:

```typescript
import { createBot, makeApprovalKeyboard, makeAskKeyboard } from './bot/bot.js';
```

Add `AskUserQuestionData` to the monitoring types import:

```typescript
import type { StatusData, AskUserQuestionData } from './types/monitoring.js';
```

**Step 3: Wire the callback in initMonitoring**

In the `initMonitoring` function, the `TranscriptWatcher` constructor call (lines 385-451) currently takes 4 arguments. Add the 5th argument `onAskUserQuestion`:

After the existing `onSidechainMessage` callback (the 4th argument, ending around line 451), add the 5th argument:

```typescript
// onAskUserQuestion: forward to Telegram as interactive prompt
(data: AskUserQuestionData) => {
  // Dedup: skip if we've already seen this tool_use_id
  let seen = seenAskIds.get(session.sessionId);
  if (!seen) {
    seen = new Set();
    seenAskIds.set(session.sessionId, seen);
  }
  if (seen.has(data.toolUseId)) return;
  seen.add(data.toolUseId);

  // Format the question message
  const html = formatAskUserQuestion(data);

  // Build inline keyboard from the first question's options
  const q = data.questions[0];
  if (!q || q.options.length === 0) {
    // No options — just show as text
    batcher.enqueue(session.threadId, html);
    return;
  }

  const keyboard = makeAskKeyboard(data.toolUseId, q.options);

  // Send immediately (not batched) — this needs user interaction
  void bot.api.sendMessage(config.telegramChatId, html, {
    message_thread_id: session.threadId,
    parse_mode: 'HTML',
    reply_markup: keyboard,
  }).catch((err) => {
    console.warn(
      'Failed to send AskUserQuestion message:',
      err instanceof Error ? err.message : err,
    );
  });
},
```

**Step 4: Clean up seenAskIds on session end**

In the `onSessionEnd` callback (around line 666), add cleanup alongside the other session cleanup calls. Add after the existing `bypassBatcher.cleanupSession()` calls (there are two — one in the `reason === 'clear'` path and one in the normal path):

In the `reason === 'clear'` path (around line 685):
```typescript
seenAskIds.delete(session.sessionId);
```

In the normal session end path (around line 721):
```typescript
seenAskIds.delete(session.sessionId);
```

Also clean up in the `handleClearDetected` function (around line 337-343, where old session cleanup happens):
```typescript
seenAskIds.delete(oldSession.sessionId);
```

And in the `source === 'clear'` path of `onSessionStart` (around line 550-556):
```typescript
seenAskIds.delete(oldSessionId);
```

**Step 5: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Manual integration test**

1. Start the bot: `npm start`
2. In a Claude Code session, trigger an AskUserQuestion (e.g., ask Claude to make a decision that uses AskUserQuestion)
3. Verify:
   - The question appears in Telegram with inline keyboard buttons
   - Tapping an option sends the correct keystroke and updates the message
   - "Other →" shows a toast without sending a keystroke
   - The same question is not posted twice

**Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire AskUserQuestion transcript detection to Telegram"
```

---

### Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add `AskUserQuestionData` type | `src/types/monitoring.ts` |
| 2 | Detect AskUserQuestion in TranscriptWatcher | `src/monitoring/transcript-watcher.ts` |
| 3 | Format AskUserQuestion for Telegram | `src/bot/formatter.ts` |
| 4 | Add inline keyboard builder + callback handler | `src/bot/bot.ts` |
| 5 | Wire everything in initMonitoring + dedup + cleanup | `src/index.ts` |
