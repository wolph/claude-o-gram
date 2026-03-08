# CLI Runtime Observability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add colorful, structured command-line logs and a live runtime status dashboard so the running bot process clearly shows what it is doing.

**Architecture:** Introduce a dedicated runtime observability layer with three parts: state tracking, log formatting, and a terminal dashboard renderer. Wire this layer into startup/shutdown, hook ingress/auth, session lifecycle, permission prompts, and subagent lifecycle events. Keep Telegram and Claude payload formatting unchanged.

**Tech Stack:** TypeScript, Node.js stdout/TTY ANSI control sequences, Vitest.

---

### Task 1: Add runtime observability modules

**Files:**
- Create: `src/runtime/runtime-status.ts`
- Create: `src/runtime/cli-format.ts`
- Create: `src/runtime/cli-output.ts`
- Test: `tests/cli-output.test.ts`

**Step 1: Write failing tests**
- Add tests for colored structured log formatting in `cli-format.ts`.
- Add tests for dashboard rendering text blocks in `cli-format.ts`.
- Add tests for runtime counters in `runtime-status.ts`.

**Step 2: Run tests to verify failure**
Run: `npm test tests/cli-output.test.ts`
Expected: FAIL with missing module/function errors.

**Step 3: Write minimal implementation**
- Implement `RuntimeStatus` with counters: hooks by type, auth failures, subagent active/completed, warnings/errors.
- Implement `formatCliLine(...)` with ANSI color support and fallback plain output.
- Implement `renderDashboard(...)` with compact multi-line process summary.
- Implement `CliOutput` to emit logs and optionally refresh a live dashboard.

**Step 4: Run tests to verify pass**
Run: `npm test tests/cli-output.test.ts`
Expected: PASS

### Task 2: Wire observability into runtime flow

**Files:**
- Modify: `src/index.ts`
- Modify: `src/hooks/server.ts`
- Modify: `src/types/config.ts` (if needed for options)
- Test: `tests/hook-server-auth.test.ts`

**Step 1: Write/extend failing tests**
- Add/extend tests to assert hook auth failure callback/counter hooks can be invoked.

**Step 2: Run tests to verify failure**
Run: `npm test tests/hook-server-auth.test.ts tests/cli-output.test.ts`
Expected: FAIL for new hook instrumentation expectations.

**Step 3: Write minimal implementation**
- Instantiate `RuntimeStatus` and `CliOutput` in `main()`.
- Replace key `console.log/warn/error` calls with structured logger usage.
- Update `createHookServer` signature with optional instrumentation callbacks:
  - `onHookReceived(eventName)`
  - `onAuthFailure(route)`
- Call status updates in hook endpoints and auth rejection path.
- Update lifecycle callbacks for session start/end, pre-tool approval prompts, subagent start/stop.

**Step 4: Run tests to verify pass**
Run: `npm test tests/hook-server-auth.test.ts tests/cli-output.test.ts`
Expected: PASS

### Task 3: Document and verify full system

**Files:**
- Modify: `README.md`

**Step 1: Update docs**
- Add section describing CLI observability features and env controls:
  - `CLI_COLOR=auto|on|off`
  - `CLI_DASHBOARD=auto|on|off`
  - `CLI_LOG_LEVEL=debug|info|warn|error`

**Step 2: Verify full project**
Run: `npm test`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

**Step 3: Commit**
```bash
git add src/runtime/*.ts src/index.ts src/hooks/server.ts tests/cli-output.test.ts README.md docs/plans/2026-03-05-cli-runtime-observability-plan.md
git commit -m "feat: add colorful cli logs and live runtime status dashboard"
```
