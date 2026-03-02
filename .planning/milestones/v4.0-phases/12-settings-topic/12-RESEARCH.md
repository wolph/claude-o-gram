# Phase 12: Settings Topic - Research

**Researched:** 2026-03-02
**Domain:** Telegram bot inline keyboard settings UI with persistent state
**Confidence:** HIGH

## Summary

Phase 12 builds a dedicated Settings topic in Telegram with inline keyboard buttons for toggling sub-agent visibility and selecting the default permission mode. The implementation requires three new modules: a BotStateStore for persistent bot-level state, a RuntimeSettings mutable config layer, and a SettingsTopic manager for topic lifecycle and keyboard rendering.

The codebase already has all the foundational patterns needed: SessionStore demonstrates atomic JSON persistence (write-tmp-rename), bot.ts has 8 existing callbackQuery handlers with regex matching, InlineKeyboard is well-exercised for approval and expand/collapse buttons, and TopicManager handles topic creation/reopen lifecycle. No new dependencies are needed.

**Primary recommendation:** Follow the existing SessionStore atomic persistence pattern for BotStateStore, wire RuntimeSettings as a thin mutable wrapper read by index.ts hook callbacks, and register settings callback handlers in createBot() alongside existing approval/mode/expand handlers.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Single pinned message in the Settings topic showing all settings with inline keyboard buttons below
- Message is edited in-place when any toggle is tapped -- no new messages per change
- Format: each setting on its own line with current value, keyboard buttons below
- After toggle: message updates immediately showing new state
- Tap confirmation via `answerCallbackQuery()` (dismiss spinner)
- Sub-agent visibility toggle available in settings (maps to config.subagentOutput)
- Default permission mode: select one of Manual / Safe Only / Accept All / Until Done
  - Sets the default mode for NEW sessions -- does not change active sessions
  - Active sessions keep their current per-session mode from the approval flow
  - "Same Tool" is not available as a default (requires a tool name context)
- Settings topic created at bot startup if it doesn't already exist
- `settingsTopicId` persisted in `data/bot-state.json` (separate from sessions.json)
- On startup: check if `settingsTopicId` exists in bot-state; reopen and reuse; if not, create new
- Topic name: "Settings" (no status color prefix -- not a session topic)
- Settings message is pinned in the topic
- If the topic was deleted by a user, detect the error on reopen and re-create
- New `RuntimeSettings` object separate from immutable `AppConfig`
- Initialized from `AppConfig` defaults at startup (env values are the initial state)
- Mutated by settings topic button handlers
- Read by hook callbacks in `index.ts` instead of `config.subagentOutput` directly
- Persisted to `data/bot-state.json` on every change (atomic write)
- Loaded from `bot-state.json` on startup (overrides env defaults if file exists)
- New optional env var: `BOT_OWNER_ID` (Telegram user ID number)
- If set: only this user's callback taps are accepted; others get answerCallbackQuery error alert
- If not set: any group member can change settings (single-user system)
- Settings topic threadId checked BEFORE session lookup in the text handler
- Text messages in settings topic are ignored (no session to route to)
- Only callback queries from settings keyboard buttons are processed
- Settings callback handlers registered with distinct prefixes (e.g., `set_sa:`, `set_pm:`)
- Separate file from sessions.json -- different concern
- Contains: `settingsTopicId`, `settingsMessageId`, `subagentOutput`, `defaultPermissionMode`
- Same atomic write pattern as SessionStore (write .tmp, rename)
- New `BotStateStore` class following `SessionStore` pattern

### Claude's Discretion
- Exact callback data prefix naming convention
- Whether to use emoji indicators or text (ON/OFF) for toggle states
- Error recovery when settings topic or message is deleted
- Whether RuntimeSettings is a class or a plain object + functions
- Whether BotStateStore and SettingsStore are one class or two

### Deferred Ideas (OUT OF SCOPE)
- Per-session sub-agent visibility override (`/agents` command in session topics) -- v5+
- Summary interval configuration in settings -- v5+
- Output verbosity control in settings -- v5+
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SETT-01 | Bot creates a dedicated "Settings" topic in the Telegram group | TopicManager.createTopic() pattern, startup init sequence in main() |
| SETT-02 | Settings topic displays inline keyboard with toggle buttons for each setting | InlineKeyboard builder pattern from makeApprovalKeyboard(), ctx.editMessageText() |
| SETT-03 | Sub-agent visibility toggle available in settings | RuntimeSettings.subagentOutput field, callback handler wired to toggle |
| SETT-04 | Permission mode selection available in settings | RuntimeSettings.defaultPermissionMode field, 4 mode buttons |
| SETT-05 | Settings changes take effect immediately without bot restart | RuntimeSettings object referenced by hook callbacks; mutated in-place |
| SETT-06 | Settings persist to disk and survive bot restarts | BotStateStore with atomic write pattern, startup load |
| SETT-07 | Only bot owner can modify settings (auth guard on callbacks) | BOT_OWNER_ID env var, ctx.from.id check in callback handlers |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| grammy | ^1.40.1 | Telegram Bot API framework | Already in use; InlineKeyboard, callbackQuery, editMessageText |
| node:fs | built-in | Atomic file persistence | writeFileSync + renameSync pattern from SessionStore |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| dotenv | ^17.3.1 | Load BOT_OWNER_ID env var | Already in use in config.ts |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| File-based persistence | SQLite via better-sqlite3 | Overkill for 4 settings fields; file persistence is proven in this codebase |
| Separate BotStateStore class | Extend SessionStore | Violates separation of concerns; bot state != session state |

**Installation:** No new packages needed.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── settings/
│   ├── bot-state-store.ts    # Atomic JSON persistence for bot-level state
│   ├── runtime-settings.ts   # Mutable config layer read by hook callbacks
│   └── settings-topic.ts     # Topic lifecycle, keyboard builder, message formatter
├── bot/
│   └── bot.ts                # Add settings callback handlers
├── config.ts                 # Add BOT_OWNER_ID to AppConfig
├── types/
│   └── config.ts             # Add botOwnerId optional field
└── index.ts                  # Wire BotStateStore, RuntimeSettings, settings topic
```

### Pattern 1: Atomic JSON File Persistence (BotStateStore)
**What:** Write-to-tmp-then-rename pattern for crash-safe persistence
**When to use:** Any data that must survive process restarts
**Example (from SessionStore):**
```typescript
private save(): void {
  mkdirSync(dirname(this.filePath), { recursive: true });
  const json = JSON.stringify(data, null, 2);
  const tmpPath = this.filePath + '.tmp';
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, this.filePath);
}
```

### Pattern 2: Callback Query Handler with Regex Prefix (bot.ts)
**What:** Register bot.callbackQuery(/^prefix:(.+)$/) handlers with distinct prefixes
**When to use:** Each button type gets a unique prefix to prevent collision
**Example (existing approval handlers):**
```typescript
bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery(); // dismiss spinner
  await ctx.editMessageText(updatedText, { reply_markup: undefined });
});
```
**For settings:** Use prefixes like `set_sa:` (sub-agent toggle) and `set_pm:` (permission mode).

### Pattern 3: In-Place Message Edit for State Toggle
**What:** Edit existing message text + keyboard when user taps a button
**When to use:** When showing updated state after a toggle/selection
**Key detail:** The settings message is NEVER deleted and recreated; always edited in-place via `ctx.editMessageText()`.

### Pattern 4: Startup Topic Initialization
**What:** Create-or-reopen topic at bot startup, persist topic ID
**When to use:** Settings topic must exist before bot starts accepting callbacks
**Flow:**
1. Load `bot-state.json` -- get `settingsTopicId`
2. If exists: try to reopen topic (catch error if deleted)
3. If not exists or reopen failed: create new topic, persist ID
4. Send or edit settings message, pin it, persist `settingsMessageId`

### Anti-Patterns to Avoid
- **Sending new messages on each toggle:** Use editMessageText, never sendMessage for state changes
- **Reading config.subagentOutput directly:** Always go through RuntimeSettings for mutable values
- **Registering settings callbacks outside createBot():** Keep all callback handlers co-located in bot.ts

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Inline keyboard layout | Custom button grid logic | grammY InlineKeyboard chainable API | .text().row().text() handles layout perfectly |
| Callback query matching | Manual string parsing | bot.callbackQuery(/regex/) | grammY handles routing, match groups, answerCallbackQuery |
| Topic creation/reopen | Raw API calls | TopicManager class methods | Already handles error cases, naming conventions |
| Atomic file writes | Custom persistence layer | SessionStore pattern (write-tmp-rename) | Proven crash-safe in this codebase |

**Key insight:** Every component needed for Phase 12 already exists as a pattern in the codebase. The work is composition, not invention.

## Common Pitfalls

### Pitfall 1: "message is not modified" Error on Settings Toggle
**What goes wrong:** Telegram API throws 400 if editMessageText is called with identical content
**Why it happens:** User double-taps a button, or state didn't actually change
**How to avoid:** Catch and ignore "message is not modified" errors (already done in 6+ places in bot.ts)
**Warning signs:** Uncaught error crashes callback handler

### Pitfall 2: Settings Topic Deleted by User
**What goes wrong:** Bot tries to send/edit in a topic that was manually deleted
**Why it happens:** User deletes the Settings topic from Telegram
**How to avoid:** Catch errors on reopenTopic/sendMessage, detect "topic closed" or "message thread not found" errors, re-create topic and message
**Warning signs:** "Bad Request: message thread not found" error

### Pitfall 3: Race Between Startup Topic Creation and First Callback
**What goes wrong:** Bot receives a callback query before the settings message is posted
**Why it happens:** Bot starts polling before async settings topic initialization completes
**How to avoid:** Complete settings topic initialization (create topic, send message, pin) BEFORE calling bot.start()
**Warning signs:** "Message to edit not found" errors on first button tap

### Pitfall 4: BOT_OWNER_ID Type Mismatch
**What goes wrong:** Auth check fails because ctx.from.id is a number but env var is a string
**Why it happens:** process.env values are always strings; Telegram user IDs are numbers
**How to avoid:** Parse BOT_OWNER_ID with parseInt() in loadConfig(), store as `number | undefined`
**Warning signs:** Owner's taps rejected, or non-owner taps allowed

### Pitfall 5: Settings Topic Gets Session-Style Text Handling
**What goes wrong:** Text messages in settings topic trigger session lookup, error logs
**Why it happens:** Text handler doesn't know about the settings topic
**How to avoid:** Check threadId against settingsTopicId BEFORE session lookup in the text handler; early return if match
**Warning signs:** "Not a managed session topic" for settings topic messages

### Pitfall 6: Default Permission Mode vs Per-Session Mode Confusion
**What goes wrong:** Changing default mode in settings changes active sessions' modes
**Why it happens:** Reading the same mutable value for both defaults and active sessions
**How to avoid:** RuntimeSettings.defaultPermissionMode only affects NEW sessions (passed to PermissionModeManager.setMode on session start). Active sessions read from PermissionModeManager, not RuntimeSettings.
**Warning signs:** Active session behavior changes when settings are toggled

## Code Examples

### Settings Keyboard Builder
```typescript
import { InlineKeyboard } from 'grammy';

function buildSettingsKeyboard(subagentVisible: boolean, defaultMode: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Sub-agent visibility toggle
  kb.text(
    subagentVisible ? '🟢 Sub-agents: Visible' : '🔴 Sub-agents: Hidden',
    'set_sa:toggle',
  );
  kb.row();
  // Permission mode buttons -- highlight the active one
  const modes = [
    { label: 'Manual', data: 'set_pm:manual' },
    { label: 'Safe Only', data: 'set_pm:safe-only' },
    { label: 'Accept All', data: 'set_pm:accept-all' },
    { label: 'Until Done', data: 'set_pm:until-done' },
  ];
  for (const m of modes) {
    const prefix = m.data.split(':')[1] === defaultMode ? '> ' : '';
    kb.text(prefix + m.label, m.data);
  }
  return kb;
}
```

### Settings Message Formatter
```typescript
function formatSettingsMessage(subagentVisible: boolean, defaultMode: string): string {
  const saStatus = subagentVisible ? '🟢 Visible' : '🔴 Hidden';
  const modeLabel: Record<string, string> = {
    'manual': 'Manual',
    'safe-only': 'Safe Only',
    'accept-all': 'Accept All',
    'until-done': 'Until Done',
  };
  return [
    '<b>Settings</b>',
    '',
    `Sub-agents: ${saStatus}`,
    `Default permission mode: ${modeLabel[defaultMode] || 'Manual'}`,
  ].join('\n');
}
```

### BotStateStore (Simplified)
```typescript
interface BotState {
  settingsTopicId: number;
  settingsMessageId: number;
  subagentOutput: boolean;
  defaultPermissionMode: string;
}

class BotStateStore {
  private state: BotState;
  private filePath: string;

  constructor(filePath: string, defaults: BotState) {
    this.filePath = filePath;
    this.state = defaults;
    this.load();
  }

  get(): BotState { return this.state; }

  update(partial: Partial<BotState>): void {
    Object.assign(this.state, partial);
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this.state, null, 2);
    const tmpPath = this.filePath + '.tmp';
    writeFileSync(tmpPath, json, 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      Object.assign(this.state, data);
    } catch {
      // Start with defaults on corrupt file
    }
  }
}
```

### Auth Guard Pattern
```typescript
function isAuthorized(ctx: Context, botOwnerId: number | undefined): boolean {
  if (!botOwnerId) return true; // No owner configured -- allow all
  return ctx.from?.id === botOwnerId;
}

// In callback handler:
bot.callbackQuery(/^set_sa:(.+)$/, async (ctx) => {
  if (!isAuthorized(ctx, config.botOwnerId)) {
    await ctx.answerCallbackQuery({
      text: 'Only the bot owner can change settings',
      show_alert: true,
    });
    return;
  }
  // ... toggle logic
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| config.subagentOutput (immutable) | RuntimeSettings.subagentOutput (mutable) | Phase 12 | Hook callbacks read mutable state |
| No settings UI | Settings topic with inline keyboard | Phase 12 | Users toggle settings from Telegram |
| Manual .env editing for config | Settings topic + bot-state.json persistence | Phase 12 | No restart needed for config changes |

**Deprecated/outdated:**
- Direct `config.subagentOutput` reads in index.ts: replaced by RuntimeSettings reads

## Open Questions

1. **Settings message formatting: emoji or text for toggle state?**
   - What we know: CONTEXT.md leaves this as Claude's discretion
   - Recommendation: Use emoji indicators (green/red circles) for visual clarity -- matches the status emoji pattern used elsewhere in the codebase

2. **RuntimeSettings: class or plain object?**
   - What we know: CONTEXT.md leaves this as Claude's discretion
   - Recommendation: Plain object with getter/setter functions on BotStateStore. Avoids unnecessary class overhead. BotStateStore already manages persistence -- adding getter/setter methods that update the in-memory state and persist makes it the single source of truth.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None configured (no test files exist in the project) |
| Config file | None |
| Quick run command | N/A |
| Full suite command | N/A |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SETT-01 | Settings topic created at startup | manual-only | Visual: check topic exists in Telegram group | N/A |
| SETT-02 | Inline keyboard with toggle buttons | manual-only | Visual: check buttons in settings topic | N/A |
| SETT-03 | Sub-agent visibility toggle | manual-only | Tap toggle, verify subagent output changes | N/A |
| SETT-04 | Permission mode selection | manual-only | Tap mode button, verify default changes | N/A |
| SETT-05 | Changes take effect immediately | manual-only | Toggle setting, check active session behavior | N/A |
| SETT-06 | Settings persist across restarts | manual-only | Change setting, restart bot, verify setting retained | N/A |
| SETT-07 | Auth guard on callbacks | manual-only | Non-owner taps settings button, verify rejection | N/A |

**Justification for manual-only:** This project has no test framework configured. All prior phases (1-11) were validated via manual UAT. The Telegram Bot API interactions (topic creation, message editing, callback queries) require a live bot connection to test meaningfully. Mocking grammY at the unit level would test implementation details rather than behavior.

### Sampling Rate
- **Per task commit:** Manual verification against success criteria
- **Per wave merge:** End-to-end walkthrough of settings topic
- **Phase gate:** Full UAT per established pattern

### Wave 0 Gaps
None -- no test infrastructure to set up (project uses manual UAT exclusively).

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `src/bot/bot.ts` -- 8 existing callback query handlers, InlineKeyboard usage
- Codebase analysis: `src/sessions/session-store.ts` -- atomic write-tmp-rename pattern
- Codebase analysis: `src/index.ts` -- main() startup sequence, monitoring init, config.subagentOutput references
- Codebase analysis: `src/bot/topics.ts` -- TopicManager create/reopen/close lifecycle
- Codebase analysis: `src/control/permission-modes.ts` -- PermissionMode type, PermissionModeManager
- Codebase analysis: `src/config.ts` -- loadConfig() env var parsing pattern
- Codebase analysis: `src/monitoring/status-message.ts` -- pinned message init/edit/pin pattern

### Secondary (MEDIUM confidence)
- grammY documentation: InlineKeyboard API, callbackQuery handler registration, answerCallbackQuery

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, all patterns proven in codebase
- Architecture: HIGH - direct extension of established patterns (SessionStore, callback handlers)
- Pitfalls: HIGH - all pitfalls identified from existing error handling patterns in the codebase

**Research date:** 2026-03-02
**Valid until:** 2026-04-02 (stable domain -- Telegram Bot API changes slowly)
