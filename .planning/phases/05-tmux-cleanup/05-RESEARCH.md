# Phase 5: tmux Cleanup - Research

**Researched:** 2026-03-01
**Domain:** Dead code removal / codebase cleanup (TypeScript)
**Confidence:** HIGH

## Summary

Phase 5 is a surgical code removal phase. Phase 4 already built the SDK input path as the primary mechanism and wired it with a tmux fallback. This phase removes all tmux-related code paths so the codebase has no dead code, no unused dependencies, and no orphaned fields. The scope is well-defined and bounded: 7 source files are affected, 1 file is deleted entirely, and 0 new dependencies are introduced.

The removal spans five layers: (1) the `capture-tmux-pane.sh` command hook and its installer code, (2) the entire `TextInputManager` class and its `child_process`/`execSync` tmux calls, (3) the `tmuxPane` field from the `SessionInfo` type and `SessionStore`, (4) the tmux fallback logic in `bot.ts`'s text handler, and (5) the `tryReadTmuxPane` helper and all tmux pane file I/O in `index.ts`. After removal, the SDK-only text handler becomes the sole input path with clean error handling (no fallback).

**Primary recommendation:** Remove all tmux code in dependency order (types first, then consumers), build after each logical group, and verify the final build compiles with zero errors and no remaining tmux references in `src/`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CLN-01 | tmux pane capture hook (`capture-tmux-pane.sh`) removed from hook installer | Remove script generation, file write, chmod, and command hook entry from `install-hooks.ts` lines 44-61 and line 71 |
| CLN-02 | TextInputManager tmux injection code removed | Delete entire `src/control/input-manager.ts` file; remove all imports, instantiation, parameter passing, and fallback usage in `bot.ts` and `index.ts` |
| CLN-03 | tmuxPane field removed from session types and store | Remove field from `SessionInfo` interface, `updateTmuxPane` method from `SessionStore`, tmuxPane initialization in `handlers.ts`, and tmuxPane serialization in `session-store.ts` load() |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.9.3 | Type checking catches dangling references after removal | Already in project; `npx tsc --noEmit` is the validation tool |

### Supporting
No new libraries needed. This phase only removes code.

### Removal Targets
| Item | Type | Reason for Removal |
|------|------|--------------------|
| `src/control/input-manager.ts` | Entire file | Contains `TextInputManager` with tmux `execSync` calls; replaced by `SdkInputManager` |
| `node:child_process` import | Import | Only used by `TextInputManager` for `execSync`; no other consumer in `src/` |
| `capture-tmux-pane.sh` generation | Code block | Hook installer generates this script; no longer needed with SDK input |
| `tmuxPane` field | Type field | Session type field only used by tmux code paths |

**No installation needed** -- this phase removes code, not adds it.

## Architecture Patterns

### Pattern 1: Dependency-Order Removal
**What:** Remove code in reverse dependency order: first remove the leaf consumers (bot.ts fallback, index.ts pane capture), then the intermediate layer (SessionStore.updateTmuxPane, SessionInfo.tmuxPane), then the source file (input-manager.ts).
**When to use:** Any dead code removal where types, interfaces, and implementations are interlinked.
**Why:** TypeScript compilation catches dangling references. If you remove the type field first, the compiler immediately flags every consumer. This makes it impossible to miss a reference.

### Pattern 2: SDK-Only Text Handler (Post-Cleanup)
**What:** After tmux removal, the text handler in `bot.ts` becomes SDK-only. On failure, it reports the error directly instead of falling back.
**Example:**
```typescript
// AFTER cleanup: SDK-only text handler (no fallback)
bot.on('message:text', async (ctx) => {
  const threadId = ctx.message.message_thread_id;
  if (!threadId) return;

  const session = sessionStore.getByThreadId(threadId);
  if (!session) return;
  if (session.status !== 'active') return;
  if (ctx.message.text.startsWith('/')) return;

  let text = ctx.message.text;
  const replied = ctx.message.reply_to_message;
  if (replied && 'text' in replied && replied.text) {
    text = `[Quoting: "${replied.text}"]\n\n${text}`;
  }

  const result = await sdkInputManager.send(
    session.sessionId,
    text,
    session.cwd,
  );

  if (result.status === 'sent') {
    try {
      await ctx.react('\u26A1');
    } catch {
      // Reaction not supported -- ignore
    }
  } else {
    await ctx.reply(
      `\u274C Failed to send input: ${result.error}`,
      { message_thread_id: threadId, reply_to_message_id: ctx.message.message_id },
    );
  }
});
```

### Pattern 3: Hook Installer Cleanup
**What:** The `SessionStart` hook config currently has two entries: an HTTP hook (keep) and a command hook for tmux capture (remove). After cleanup, only the HTTP hook remains.
**Example:**
```typescript
// AFTER cleanup: SessionStart with HTTP hook only
SessionStart: [
  {
    matcher: '',
    hooks: [
      { type: 'http', url: `${baseUrl}/hooks/session-start`, timeout: 10 },
    ],
  },
],
```

### Anti-Patterns to Avoid
- **Leaving dead imports:** After removing `TextInputManager`, ensure `import { TextInputManager }` and `import type { TextInputManager }` are removed from `bot.ts` and `index.ts`.
- **Leaving orphaned parameters:** `createBot()` currently accepts `inputManager: TextInputManager` -- this parameter must be removed from both the declaration and the call site.
- **Partial type cleanup:** If `tmuxPane` is removed from `SessionInfo` but the `tmuxPane ?? null` line remains in `session-store.ts` load(), TypeScript will error. Clean both sides.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Finding all tmux references | Manual text search | `grep -r tmux src/` | Automated search is exhaustive; manual review misses edge cases |
| Validating clean removal | Manual code review | `npx tsc --noEmit` | TypeScript compiler catches every dangling reference |
| Verifying no runtime impact | Custom test harness | `npm run build` + manual smoke test | Build proves compilation; smoke test proves runtime |

**Key insight:** TypeScript is the best tool for verifying dead code removal. Remove a type field, and the compiler immediately flags every file that references it. This makes tmux cleanup nearly mechanical.

## Common Pitfalls

### Pitfall 1: Incomplete Hook Config Cleanup
**What goes wrong:** Removing the `capture-tmux-pane.sh` script generation but forgetting to remove the `{ type: 'command', command: scriptPath, timeout: 5 }` entry from the `SessionStart` hooks array, or forgetting to remove the `scriptPath` variable and `hooksDir` setup (if only used for the tmux script).
**Why it happens:** The hook config is built as a nested object literal and the command entry is one line inside a larger structure.
**How to avoid:** Remove lines 44-61 (tmux script generation, hooksDir, scriptPath, writeFileSync, chmodSync) AND line 71 (command hook entry). The `hooksDir` mkdir and creation are ONLY used for the tmux script, so they can be removed entirely.
**Warning signs:** Build succeeds but `~/.claude/settings.json` references a non-existent script path at runtime.

### Pitfall 2: Orphaned `inputManager` Parameter Chain
**What goes wrong:** Removing the `TextInputManager` class but forgetting one link in the parameter chain: `index.ts` creates it -> passes to `createBot()` -> `bot.ts` receives it -> uses in handler.
**Why it happens:** The parameter flows through 3 files and 2 function signatures.
**How to avoid:** Follow the chain: (1) delete `src/control/input-manager.ts`, (2) remove import + instantiation + parameter in `index.ts`, (3) remove import + parameter + all usage in `bot.ts`. TypeScript will catch any missed step.
**Warning signs:** TypeScript errors about missing module or unused parameters.

### Pitfall 3: Session Store Load Compatibility
**What goes wrong:** Existing `sessions.json` files on disk still contain `tmuxPane` fields. After removing the field from `SessionInfo`, loading old data could cause issues.
**Why it happens:** The `load()` method uses `JSON.parse(raw) as Record<string, SessionInfo>` which doesn't validate fields. Extra fields in JSON are silently ignored when spread into an object, but the explicit `tmuxPane: session.tmuxPane ?? null` line on line 231 of session-store.ts will cause a TypeScript error if the field is removed from the type.
**How to avoid:** Remove the `tmuxPane: session.tmuxPane ?? null` line from `load()`. TypeScript's structural typing means extra JSON fields are harmlessly ignored by the spread operator. The `save()` method uses `...session` spread which automatically excludes removed fields since the in-memory objects won't have them.
**Warning signs:** TypeScript error in session-store.ts load() method.

### Pitfall 4: Forgetting the `/tmp/` File Cleanup
**What goes wrong:** The `onSessionEnd` callback in `index.ts` (line 300) has `unlinkSync(`/tmp/claude-tmux-pane-${session.sessionId}.txt`)` -- this is tmux cleanup code that should be removed.
**Why it happens:** It's a one-liner buried in the session-end handler, easy to overlook since it doesn't reference `tmux` as an import.
**How to avoid:** Search for ALL occurrences of `tmux` in `src/` after removal and verify zero matches.
**Warning signs:** Harmless at runtime (try/catch ignores errors) but leaves dead code.

### Pitfall 5: Forgetting `tryReadTmuxPane` Function and Its Two Call Sites
**What goes wrong:** The `tryReadTmuxPane` helper function (index.ts lines 62-77) has TWO call sites: one in `onSessionStart` (line 268) and one in `onPreToolUse` (line 347). Missing either leaves dead code or a TypeScript error.
**Why it happens:** The function is called in two different callback locations that are far apart in the file.
**How to avoid:** Remove the function definition AND both call sites. Also remove the `readFileSync, unlinkSync, existsSync` imports from index.ts if they become unused (check: `existsSync` is not used elsewhere in index.ts, but verify).
**Warning signs:** TypeScript errors about unused variables or missing functions.

## Code Examples

### Complete File Removal Manifest

Every tmux reference in `src/` and exactly what to do:

```
src/control/input-manager.ts        DELETE ENTIRE FILE
  - TextInputManager class
  - shellQuote helper
  - execSync import

src/types/sessions.ts                EDIT
  - Line 43-44: Remove tmuxPane field and JSDoc comment

src/sessions/session-store.ts        EDIT
  - Lines 171-178: Remove updateTmuxPane() method
  - Line 231: Remove `tmuxPane: session.tmuxPane ?? null` from load()

src/hooks/handlers.ts                EDIT
  - Line 74: Remove `tmuxPane: null` from ensureSession()
  - Line 253: Remove `tmuxPane: null` from handleSessionStart()

src/utils/install-hooks.ts           EDIT
  - Lines 44-61: Remove tmux script generation block (tmuxScript, hooksDir, scriptPath, writeFileSync, chmodSync)
  - Line 71: Remove command hook entry from SessionStart hooks array
  - Remove chmodSync from import if unused after removal

src/bot/bot.ts                       EDIT
  - Line 8: Remove TextInputManager import
  - Line 32: Remove inputManager parameter from createBot()
  - Lines 177-248: Rewrite text handler to SDK-only (remove tmux fallback)

src/index.ts                         EDIT
  - Line 2: Remove unlinkSync, existsSync from import (if unused after removal)
  - Line 24: Remove TextInputManager import
  - Lines 62-77: Remove tryReadTmuxPane() function
  - Line 105: Remove TextInputManager instantiation
  - Line 109: Remove inputManager from createBot() call
  - Lines 267-272: Remove tmux pane capture block in onSessionStart
  - Line 297: Remove inputManager.cleanup() call
  - Lines 299-300: Remove tmux pane file cleanup in onSessionEnd
  - Lines 345-352: Remove lazy tmux pane capture block in onPreToolUse
```

### Verifying Clean Removal
```bash
# After all edits, verify:
# 1. TypeScript compiles
npx tsc --noEmit

# 2. No tmux references remain in source
grep -r "tmux" src/
# Expected: zero matches

# 3. Build succeeds
npm run build

# 4. No orphaned imports of deleted file
grep -r "input-manager" src/
# Expected: only sdk/input-manager.ts references remain
```

### Verifying `readFileSync` Import Usage After Cleanup
```typescript
// index.ts currently imports: readFileSync, unlinkSync, existsSync
// After removing tryReadTmuxPane and the /tmp/ cleanup:
// - readFileSync: check if used elsewhere in index.ts (NO -- only in tryReadTmuxPane)
// - unlinkSync: check if used elsewhere (line 300 tmux cleanup -- also being removed)
// - existsSync: check if used elsewhere (NO -- only in tryReadTmuxPane)
// CONCLUSION: Remove readFileSync, unlinkSync, existsSync from index.ts import
// Keep only: join from 'node:path'
```

### Verifying `install-hooks.ts` Import Usage After Cleanup
```typescript
// install-hooks.ts currently imports: readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync
// After removing tmux script generation:
// - chmodSync: only used for the tmux script -- REMOVE from import
// - writeFileSync: still used for settings.json write (line 132) -- KEEP
// - readFileSync: still used for settings.json read (line 28) -- KEEP
// - existsSync: still used for checking settings.json (line 26) -- KEEP
// - mkdirSync: still used for ~/.claude/ dir creation (line 21) -- KEEP
// CONCLUSION: Remove only chmodSync from import
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tmux `send-keys`/`paste-buffer` injection | SDK `query({ resume })` | Phase 4 (2026-03-01) | Cross-platform, no terminal dependency |
| tmux pane capture via command hook | Not needed (SDK uses session ID directly) | Phase 4 (2026-03-01) | Eliminates `/tmp/` file I/O and race conditions |
| `TextInputManager` with queue | `SdkInputManager` with per-session serialization | Phase 4 (2026-03-01) | Reliable delivery with proper error reporting |

**Deprecated/outdated:**
- `TextInputManager` class: Entirely replaced by `SdkInputManager` in Phase 4
- `capture-tmux-pane.sh` command hook: tmux pane ID is not needed by SDK input path
- `tmuxPane` session field: No consumer after tmux code paths are removed

## Open Questions

1. **Should `TextInputManager` queue functionality be preserved?**
   - What we know: `TextInputManager` has `queue()`, `dequeue()`, `queueSize()` methods. `SdkInputManager` has no queueing -- it reports failure directly.
   - What's unclear: Whether any other code path uses the queue (answer: NO -- only the tmux fallback in bot.ts uses it)
   - Recommendation: Remove entirely. The SDK path either succeeds or reports failure; queueing for later tmux delivery is meaningless without tmux. If SDK fails, the user sees the error and can retry.

2. **Should the `hooksDir` directory creation be kept?**
   - What we know: `mkdirSync(hooksDir, { recursive: true })` creates `~/.claude/hooks/` solely for the tmux capture script.
   - What's unclear: Whether other hooks or tools create files in `~/.claude/hooks/`
   - Recommendation: Remove the `hooksDir` creation. It was only used for our capture script. If Claude Code itself needs this directory, it creates it independently.

## Sources

### Primary (HIGH confidence)
- Direct source code analysis of all 7 affected files in `src/`
- Phase 4 summaries (04-01-SUMMARY.md, 04-02-SUMMARY.md) confirming SDK is wired and primary
- REQUIREMENTS.md confirming CLN-01, CLN-02, CLN-03 scope
- TypeScript compiler (`npx tsc --noEmit`) confirming current clean build state

### Secondary (MEDIUM confidence)
- ROADMAP.md and STATE.md confirming Phase 4 is complete and Phase 5 scope

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - No new libraries; this is pure removal verified by existing TypeScript toolchain
- Architecture: HIGH - All code to remove is directly inspected; every reference enumerated
- Pitfalls: HIGH - Derived from actual code inspection, not hypothetical scenarios

**Research date:** 2026-03-01
**Valid until:** 2026-03-31 (stable -- code is frozen from Phase 4, no external dependencies involved)
