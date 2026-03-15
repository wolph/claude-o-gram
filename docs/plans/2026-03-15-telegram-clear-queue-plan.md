# Telegram Clear Queueing + Session Continuity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Telegram topics the durable visible session across `/clear`, queue inbound messages during the clear transition, and log every received/routed Telegram input immediately.

**Architecture:** Add a durable conversation store keyed by Telegram topic, with an ordered ingress queue and a replaceable Claude binding (`sessionId`, transcript, input method). Refactor Telegram ingress to resolve through that conversation, mark conversations `transitioning` on `/clear`, and drain queued inputs only after the replacement binding is fully routable.

**Tech Stack:** TypeScript, grammY, Vitest, Node.js fs persistence

---

### Task 1: Add durable conversation types and store

**Files:**
- Create: `src/types/conversations.ts`
- Create: `src/sessions/conversation-store.ts`
- Create: `tests/conversation-store.test.ts`

**Step 1: Write the failing test**

Create `tests/conversation-store.test.ts` with coverage for create, transition, queue, and activate:

```typescript
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/sessions/conversation-store.js';

describe('ConversationStore', () => {
  it('keeps one durable conversation while rotating the Claude session binding', () => {
    const store = new ConversationStore('/tmp/conversations.json');

    store.upsertActive({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      sessionId: 'sess-old',
      transcriptPath: '/tmp/old.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
      statusMessageId: 7,
    });

    store.startClearTransition(42);
    store.enqueue(42, {
      telegramMessageId: 10,
      kind: 'text',
      rawText: 'continue',
      routedText: 'continue',
      receivedAt: '2026-03-15T00:00:00.000Z',
    });

    store.attachReplacementBinding(42, {
      sessionId: 'sess-new',
      transcriptPath: '/tmp/new.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
    });

    const conversation = store.getByThreadId(42);
    expect(conversation?.state).toBe('active');
    expect(conversation?.currentSessionId).toBe('sess-new');
    expect(conversation?.queue).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/conversation-store.test.ts`
Expected: FAIL with module-not-found errors for `conversation-store` / `conversations` types.

**Step 3: Write minimal implementation**

Create the store and types with a minimal shape like:

```typescript
export interface InboundMessage {
  telegramMessageId: number;
  kind: 'text' | 'command';
  rawText: string;
  routedText: string;
  receivedAt: string;
}

export interface ConversationInfo {
  threadId: number;
  cwd: string;
  topicName: string;
  statusMessageId: number;
  state: 'active' | 'transitioning';
  currentSessionId: string;
  currentTranscriptPath: string;
  currentInputMethod?: 'tmux' | 'fifo' | 'sdk-resume';
  permissionMode?: string;
  queue: InboundMessage[];
}
```

Implement `upsertActive()`, `startClearTransition()`, `enqueue()`, and
`attachReplacementBinding()` in `src/sessions/conversation-store.ts`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/conversation-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types/conversations.ts src/sessions/conversation-store.ts tests/conversation-store.test.ts
git commit -m "feat: add durable conversation store for telegram topics"
```

---

### Task 2: Build a unified Telegram ingress router

**Files:**
- Create: `src/bot/inbound-router.ts`
- Create: `tests/inbound-router.test.ts`
- Modify: `src/bot/bot.ts`

**Step 1: Write the failing test**

Create `tests/inbound-router.test.ts` to prove active routing vs queued routing:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { InboundRouter } from '../src/bot/inbound-router.js';

describe('InboundRouter', () => {
  it('routes immediately when the conversation is active', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'sent' });
    const log = vi.fn();
    const queue = vi.fn();

    const router = new InboundRouter({ send, log, queue });
    const result = await router.handle({
      threadId: 42,
      telegramMessageId: 100,
      kind: 'text',
      rawText: 'status',
      routedText: 'status',
      state: 'active',
      sessionId: 'sess-1',
      inputMethod: 'tmux',
    });

    expect(result.action).toBe('sent');
    expect(send).toHaveBeenCalledWith('sess-1', 'status');
    expect(log).toHaveBeenCalled();
  });

  it('queues while a clear transition is in progress', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const queue = vi.fn();

    const router = new InboundRouter({ send, log, queue });
    const result = await router.handle({
      threadId: 42,
      telegramMessageId: 101,
      kind: 'command',
      rawText: '/status',
      routedText: '/status',
      state: 'transitioning',
      sessionId: 'sess-old',
      inputMethod: 'tmux',
    });

    expect(result.action).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/inbound-router.test.ts`
Expected: FAIL with module-not-found errors for `inbound-router`.

**Step 3: Write minimal implementation**

Create `src/bot/inbound-router.ts` with a single entry point that logs first, then sends
or enqueues:

```typescript
export class InboundRouter {
  async handle(input: RoutedInboundMessage): Promise<{ action: 'sent' | 'queued' }> {
    this.callbacks.log(`RECV thread=${input.threadId} msg=${input.telegramMessageId} kind=${input.kind}`);

    if (input.state === 'transitioning') {
      this.callbacks.queue(input);
      this.callbacks.log(`QUEUE thread=${input.threadId} reason=clear-transition`);
      return { action: 'queued' };
    }

    this.callbacks.log(
      `ROUTE thread=${input.threadId} state=active session=${input.sessionId} via=${input.inputMethod ?? 'unknown'}`,
    );
    await this.callbacks.send(input.sessionId, input.routedText);
    return { action: 'sent' };
  }
}
```

Then refactor `src/bot/bot.ts` so both message handlers normalize their input and call
this router instead of directly calling `inputRouter.send(...)`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/inbound-router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bot/inbound-router.ts src/bot/bot.ts tests/inbound-router.test.ts
git commit -m "feat: unify telegram ingress routing and queueing"
```

---

### Task 3: Rebind conversations on `/clear` and drain queued messages

**Files:**
- Modify: `src/index.ts`
- Modify: `src/hooks/handlers.ts`
- Create: `tests/clear-transition-queue.test.ts`

**Step 1: Write the failing test**

Create `tests/clear-transition-queue.test.ts` covering the current race:

```typescript
import { describe, expect, it, vi } from 'vitest';

describe('clear transition queueing', () => {
  it('delivers a telegram message sent between clear teardown and replacement session attach', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'sent' });

    const harness = createClearHarness({ send });
    harness.startActiveConversation({ threadId: 42, sessionId: 'sess-old', inputMethod: 'tmux' });

    harness.startClearTransition(42);
    await harness.receiveTelegramText(42, 500, 'continue after clear');

    expect(harness.queueDepth(42)).toBe(1);

    await harness.attachReplacementBinding(42, { sessionId: 'sess-new', inputMethod: 'tmux' });

    expect(send).toHaveBeenCalledWith('sess-new', 'continue after clear');
    expect(harness.queueDepth(42)).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/clear-transition-queue.test.ts`
Expected: FAIL because the harness or rebinding/drain logic does not exist yet.

**Step 3: Write minimal implementation**

In `src/index.ts` and `src/hooks/handlers.ts`:

- mark the conversation `transitioning` as soon as `/clear` is recognized
- move old-session teardown behind the conversation transition state
- attach the replacement binding to the same conversation
- re-detect input method for the new binding
- drain queued messages only after binding + transport are ready

Representative drain shape:

```typescript
for (const item of conversation.queue) {
  const result = await inputRouter.send(conversation.currentSessionId, item.routedText);
  if (result.status !== 'sent') break;
  conversation.shiftQueue();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/clear-transition-queue.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/index.ts src/hooks/handlers.ts tests/clear-transition-queue.test.ts
git commit -m "fix: queue telegram input across clear transitions"
```

---

### Task 4: Persist transitioning conversations and queued input across restart

**Files:**
- Modify: `src/sessions/conversation-store.ts`
- Modify: `src/index.ts`
- Create: `tests/conversation-store-persistence.test.ts`

**Step 1: Write the failing test**

Create `tests/conversation-store-persistence.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/sessions/conversation-store.js';

describe('ConversationStore persistence', () => {
  it('restores queued messages and transition state after reload', () => {
    const filePath = '/tmp/conversations-persistence.json';

    const first = new ConversationStore(filePath);
    first.upsertActive({
      threadId: 42,
      cwd: '/tmp/project',
      topicName: 'project',
      sessionId: 'sess-old',
      transcriptPath: '/tmp/old.jsonl',
      inputMethod: 'tmux',
      permissionMode: 'default',
      statusMessageId: 7,
    });
    first.startClearTransition(42);
    first.enqueue(42, {
      telegramMessageId: 100,
      kind: 'text',
      rawText: 'resume me',
      routedText: 'resume me',
      receivedAt: '2026-03-15T00:00:00.000Z',
    });

    const second = new ConversationStore(filePath);
    const restored = second.getByThreadId(42);
    expect(restored?.state).toBe('transitioning');
    expect(restored?.queue).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/conversation-store-persistence.test.ts`
Expected: FAIL because queue/state persistence is not implemented yet.

**Step 3: Write minimal implementation**

Extend `ConversationStore` load/save so it persists queue contents and state, and on
startup `src/index.ts` reconnects active or transitioning conversations before resuming
watchers/drain attempts.

Use atomic writes, matching the existing store style:

```typescript
writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
renameSync(tmpPath, filePath);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/conversation-store-persistence.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sessions/conversation-store.ts src/index.ts tests/conversation-store-persistence.test.ts
git commit -m "feat: persist queued telegram input across restart"
```

---

### Task 5: Add observability logs and user-visible buffering notices

**Files:**
- Modify: `src/bot/bot.ts`
- Modify: `src/index.ts`
- Create: `tests/telegram-ingress-observability.test.ts`

**Step 1: Write the failing test**

Create `tests/telegram-ingress-observability.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { InboundRouter } from '../src/bot/inbound-router.js';

describe('telegram ingress observability', () => {
  it('logs receipt and route details for successful sends', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'sent' });
    const log = vi.fn();
    const queue = vi.fn();

    const router = new InboundRouter({ send, log, queue });
    await router.handle({
      threadId: 42,
      telegramMessageId: 100,
      kind: 'text',
      rawText: 'ping',
      routedText: 'ping',
      state: 'active',
      sessionId: 'sess-1',
      inputMethod: 'tmux',
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('RECV thread=42'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ROUTE thread=42'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram-ingress-observability.test.ts`
Expected: FAIL until the router emits the required logs and the bot uses it consistently.

**Step 3: Write minimal implementation**

Make the live handlers emit the same messages the tests assert:

```typescript
cli.info('TELEGRAM', `RECV thread=${threadId} msg=${messageId} kind=${kind}`, { preview });
cli.info('TELEGRAM', `ROUTE thread=${threadId} state=${state} session=${sessionId} via=${method}`, { target });
cli.info('TELEGRAM', `QUEUE thread=${threadId} reason=clear-transition depth=${depth}`);
```

When the conversation is transitioning, send one Telegram notice only when the queue
becomes non-empty:

```typescript
await ctx.reply('Queued while context is clearing; will send automatically.', {
  message_thread_id: threadId,
  reply_to_message_id: ctx.message.message_id,
});
```

**Step 4: Run targeted tests plus static verification**

Run: `npx vitest run tests/inbound-router.test.ts tests/clear-transition-queue.test.ts tests/telegram-ingress-observability.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/bot/bot.ts src/index.ts tests/telegram-ingress-observability.test.ts
git commit -m "feat: log telegram ingress receipt and routing decisions"
```

---

### Task 6: Run full verification and document behavior

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-03-15-telegram-clear-queue-design.md` (only if implementation changed the design)

**Step 1: Update user-facing docs**

Add or adjust a short README note in the text-input/session section covering:

```markdown
- Telegram messages received during `/clear` are queued and replayed automatically.
- The forum topic remains the same visible session across `/clear`.
- The local bot console logs receipt, queue, route, drain, and failure for Telegram ingress.
```

**Step 2: Run the full quality gate**

Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

Run: `npx lefthook run quality`
Expected: PASS

**Step 3: Commit**

```bash
git add README.md docs/plans/2026-03-15-telegram-clear-queue-design.md
git commit -m "docs: describe clear queueing and telegram ingress logging"
```
