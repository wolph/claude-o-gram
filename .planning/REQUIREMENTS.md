# Requirements: Claude Code Telegram Bridge

**Defined:** 2026-03-02
**Core Value:** See what Claude Code is doing and respond to its questions from anywhere, without needing to be at the terminal.

## v4.0 Requirements

Requirements for v4.0 Status & Settings. Each maps to roadmap phases.

### Status Indicators

- [ ] **STAT-01**: Active/ready sessions display green emoji prefix (🟢) in topic name
- [ ] **STAT-02**: Down/offline sessions display gray emoji prefix (⚪) in topic name
- [ ] **STAT-03**: Busy sessions display yellow emoji prefix (🟡) when processing tools
- [ ] **STAT-04**: Error sessions display red emoji prefix (🔴) in topic name
- [ ] **STAT-05**: On bot startup, all existing session topics are set to gray status
- [ ] **STAT-06**: Status emoji changes are debounced to prevent editForumTopic rate limits

### Sub-Agent Control

- [ ] **AGNT-01**: Sub-agent output is suppressed by default (no spawn/done announcements, no tool calls, no text)
- [ ] **AGNT-02**: Sub-agents do not create their own Telegram topics by default
- [ ] **AGNT-03**: Sub-agent visibility is toggleable via settings topic

### Sticky Messages

- [ ] **STKY-01**: On /clear, existing pinned message is reused if content matches
- [ ] **STKY-02**: On bot restart/reconnect, existing pinned message is adopted from stored statusMessageId
- [ ] **STKY-03**: New sticky messages are only created for brand new sessions or when content differs

### Settings

- [ ] **SETT-01**: Bot creates a dedicated "Settings" topic in the Telegram group
- [ ] **SETT-02**: Settings topic displays inline keyboard with toggle buttons for each setting
- [ ] **SETT-03**: Sub-agent visibility toggle available in settings
- [ ] **SETT-04**: Permission mode selection available in settings
- [ ] **SETT-05**: Settings changes take effect immediately without bot restart
- [ ] **SETT-06**: Settings persist to disk and survive bot restarts
- [ ] **SETT-07**: Only bot owner can modify settings (auth guard on callbacks)

## v5+ Requirements

Deferred to future release. Tracked but not in current roadmap.

### Sub-Agent Control

- **AGNT-04**: Per-session sub-agent visibility override via /agents command in session topic

### Settings

- **SETT-08**: Summary interval configuration exposed in settings topic
- **SETT-09**: Output verbosity control exposed in settings topic

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| `icon_color` API for topic colors | Not editable after topic creation — Telegram API hard constraint |
| Per-sub-agent Telegram topics | Topic list clutter, rate limit cascade risk |
| Settings stored in Telegram messages | Unreliable, unreadable by bot on restart |
| Starting new Claude Code sessions from Telegram | Deferred from v1.0, still out of scope |
| SDK streaming output / canUseTool callback | Deferred from v3.0, still out of scope |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STAT-01 | — | Pending |
| STAT-02 | — | Pending |
| STAT-03 | — | Pending |
| STAT-04 | — | Pending |
| STAT-05 | — | Pending |
| STAT-06 | — | Pending |
| AGNT-01 | — | Pending |
| AGNT-02 | — | Pending |
| AGNT-03 | — | Pending |
| STKY-01 | — | Pending |
| STKY-02 | — | Pending |
| STKY-03 | — | Pending |
| SETT-01 | — | Pending |
| SETT-02 | — | Pending |
| SETT-03 | — | Pending |
| SETT-04 | — | Pending |
| SETT-05 | — | Pending |
| SETT-06 | — | Pending |
| SETT-07 | — | Pending |

**Coverage:**
- v4.0 requirements: 19 total
- Mapped to phases: 0
- Unmapped: 19 ⚠️

---
*Requirements defined: 2026-03-02*
*Last updated: 2026-03-02 after initial definition*
