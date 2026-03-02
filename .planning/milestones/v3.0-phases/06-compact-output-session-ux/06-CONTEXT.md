# Phase 6: Compact Output & Session UX - Context

**Gathered:** 2026-03-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Transform Telegram output from verbose bot noise into clean terminal-fidelity display. Tool calls render as compact one-liners with on-demand expand/collapse. Bot commentary removed. Pinned status simplified. /clear reuses existing topic with visual separator and fresh pinned status.

</domain>

<decisions>
## Implementation Decisions

### Tool call formatting
- Single-line format: `Tool(args...)` for all tool types
- Smart path truncation: full relative path for short paths, `src/.../deeply/nested/file.ts` for long ones
- Edit/Write tools include line count stats: `Edit(src/bot/bot.ts) +3 -2`
- Bash shows command + exit status: `Bash(npm test) ✓` or `Bash(npm test) ✗`
- Batched tools (parallel calls within 2s window): each tool gets its own line in the message, not collapsed
- Max 250 chars per tool call line; truncate args with `…` if exceeded
- Grep shows pattern and path: `Grep("pattern", src/**/*.ts)`
- Write shows line count: `Write(src/new-file.ts) 45 lines`
- Agent tool shows name and description: `Agent(researcher) spawned — "Explore API patterns"`

### Expand/collapse behavior
- One Expand button per batched message — tapping expands ALL tool calls in that message
- Expanded view shows each tool's full content with clear headers/separators between them
- Read tool does NOT need expansion — the path is the whole story
- Edit/Write expansion shows full diff or file content
- Bash expansion shows full command output, up to 4096 chars (Telegram limit); beyond that, send as file attachment
- Button labels: `▸ Expand` and `◂ Collapse` (short text labels)
- Content stored in LRU cache keyed by chatId:messageId

### Status message style
- Compact, no emoji: `claude-o-gram | 45% ctx | 1h 30m` + `42 tools | 8 files`
- Topic name: keep current style (emoji + project name + context %)
- No action buttons on status message — pure info display
- Update frequency: keep current 3s debounce
- Smart skip: don't call API if content hasn't changed

### /clear transition behavior
- Detect `source === 'clear'` on SessionStart; detect `reason === 'clear'` on SessionEnd
- SessionEnd with reason=clear: keep topic open (skip close/archive)
- SessionStart with source=clear: reuse existing threadId (no new topic)
- Post timestamped separator: `─── context cleared at 14:30 ───`
- Old messages remain visible above separator (no deletion)
- Topic name stays the same — no rename on /clear
- Create new StatusMessage instance, post + pin it
- Old status message: unpin but leave in chat (historical record)
- Reset session counters: tools, files, duration

### Claude's Discretion
- Exact LRU cache size limit and eviction policy
- How to handle edge case where expand content exceeds 4096 chars after expansion
- Exact formatting of Edit diffs in expanded view (unified diff vs side-by-side)
- How to handle /clear when there are pending approval requests

</decisions>

<specifics>
## Specific Ideas

- Terminal matching: the Telegram output should read like Claude Code's terminal — "If I saw this in the terminal, I'd see exactly this in Telegram"
- The screenshot the user shared shows the current noise: "TaskCreate" x5 as separate messages, JSON file attachments for tool inputs, topic rename notifications — all of this should become clean one-liners
- The current batching (2s window combining multiple tool calls into one message) is good — keep it, just change the format of each line within the batch

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-compact-output-session-ux*
*Context gathered: 2026-03-01*
