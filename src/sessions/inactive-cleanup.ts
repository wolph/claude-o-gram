import type { SessionInfo } from '../types/sessions.js';

export interface InactiveCleanupPlan {
  closed: SessionInfo[];
  staleActive: SessionInfo[];
  candidates: SessionInfo[];
  deletable: SessionInfo[];
  unmapped: SessionInfo[];
}

interface InactiveCleanupOptions {
  nowMs?: number;
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

function parseTimeMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function lastActivityMs(session: SessionInfo): number {
  const last = parseTimeMs(session.lastActivityAt);
  if (last !== null) return last;
  const started = parseTimeMs(session.startedAt);
  return started ?? 0;
}

export function planInactiveCleanup(
  sessions: SessionInfo[],
  options: InactiveCleanupOptions = {},
): InactiveCleanupPlan {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const closed: SessionInfo[] = [];
  const staleActive: SessionInfo[] = [];

  for (const session of sessions) {
    if (session.status === 'closed') {
      closed.push(session);
      continue;
    }
    const inactiveForMs = nowMs - lastActivityMs(session);
    if (inactiveForMs >= staleAfterMs) {
      staleActive.push(session);
    }
  }

  return {
    closed,
    staleActive,
    candidates: [...closed, ...staleActive],
    deletable: [...closed, ...staleActive].filter((s) => s.threadId > 0),
    unmapped: [...closed, ...staleActive].filter((s) => s.threadId <= 0),
  };
}
