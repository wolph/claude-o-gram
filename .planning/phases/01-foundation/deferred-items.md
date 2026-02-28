# Phase 01: Deferred Items

## Pre-existing Issues (Out of Scope)

### 1. TypeScript errors in src/bot/bot.ts
- **Discovered during:** Plan 02, Task 2 verification
- **Issue:** `@grammyjs/parse-mode` exports `hydrateReply`, `parseMode`, and `ParseModeFlavor` are not found. Likely an API change in the installed version of the plugin.
- **Impact:** Does not affect Plan 02 files (session-store.ts, handlers.ts, server.ts)
- **Action needed:** Fix imports in src/bot/bot.ts to match installed @grammyjs/parse-mode version
