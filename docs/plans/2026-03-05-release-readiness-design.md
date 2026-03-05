# Release Readiness Design

**Date:** 2026-03-05
**Goal:** Make the project fully documented, CI tested, and ready for public open-source use.

## 1. README Overhaul

Rewrite README.md to reflect the current state:
- `BOT_OWNER_ID` required (security: single-user lockdown)
- Hook server auth with auto-generated Bearer tokens
- Input router with tmux/FIFO/SDK-resume methods
- Non-blocking PreToolUse (informational only)
- Topic reuse for same-cwd sessions
- Skills and command scanning
- Updated architecture diagram matching actual `src/` tree
- Remove references to deleted files (`summary-timer.ts`, `input-manager.ts`)
- Add security section documenting auth layers

## 2. Project Files

- **LICENSE** — BSD 3-Clause
- **CLAUDE.md** — contributor dev guide (build commands, architecture, conventions)
- **.gitignore** — add `.planning/`, `.claude/` (internal dev artifacts)
- **.env.example** — already updated

## 3. CI Pipeline (GitHub Actions)

Single workflow `ci.yml`, three jobs:
- **build** — `npm ci` + `tsc --noEmit`
- **lint** — ESLint with `@typescript-eslint`
- **test** — Vitest unit + integration tests

Triggers: push to `main`/`master`, pull requests.

## 4. Test Suite (Vitest)

**Unit tests** for pure/isolated modules:
- `src/utils/text.ts` — escapeHtml, truncateMessage, markdownToHtml
- `src/utils/hook-secret.ts` — secret gen, idempotency, file permissions
- `src/bot/formatter.ts` — formatSessionStart, formatNotification, etc.
- `src/sessions/session-store.ts` — CRUD, getByThreadId, getActiveByCwd
- `src/monitoring/verbosity.ts` — tier filtering
- `src/config.ts` — env var validation

**Integration tests:**
- Hook server auth — 401 without token, 200 with token, /health bypass

## 5. Package.json Updates

- Add `test`, `lint`, `lint:fix` scripts
- Add vitest, eslint, @typescript-eslint as dev deps
