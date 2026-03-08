import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DiscoveredSessionTranscript {
  sessionId: string;
  transcriptPath: string;
}

export interface SessionsIndexEntry {
  sessionId: string;
  fullPath?: string;
  projectPath?: string;
  isSidechain?: boolean;
}

export interface DiscoveredLiveSession {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
}

export interface LiveSessionDiscoveryResult {
  sessions: DiscoveredLiveSession[];
  openTranscripts: number;
  unresolved: number;
}

function normalizeRoot(root: string): string {
  return root.endsWith('/') ? root : `${root}/`;
}

export function parseOpenSessionTranscripts(
  lsofOutput: string,
  projectsRoot: string,
): DiscoveredSessionTranscript[] {
  const root = normalizeRoot(projectsRoot);
  const byId = new Map<string, string>();

  for (const rawLine of lsofOutput.split('\n')) {
    if (!rawLine || rawLine[0] !== 'n') continue;
    const path = rawLine.slice(1).trim();
    if (!path.endsWith('.jsonl')) continue;
    if (!path.startsWith(root)) continue;

    const id = basename(path, '.jsonl');
    if (!SESSION_ID_RE.test(id)) continue;
    if (!byId.has(id)) {
      byId.set(id, path);
    }
  }

  return [...byId.entries()].map(([sessionId, transcriptPath]) => ({
    sessionId,
    transcriptPath,
  }));
}

export function resolveProjectPathForSession(
  sessionId: string,
  transcriptPath: string,
  entries: SessionsIndexEntry[],
): string | null {
  const byId = entries.find((e) => e.sessionId === sessionId && typeof e.projectPath === 'string');
  if (byId?.projectPath) {
    return byId.projectPath;
  }
  const byPath = entries.find((e) => e.fullPath === transcriptPath && typeof e.projectPath === 'string');
  return byPath?.projectPath ?? null;
}

function loadSessionsIndexEntries(projectsRoot: string): SessionsIndexEntry[] {
  if (!existsSync(projectsRoot)) return [];
  const entries: SessionsIndexEntry[] = [];
  for (const dirent of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const indexPath = join(projectsRoot, dirent.name, 'sessions-index.json');
    if (!existsSync(indexPath)) continue;
    try {
      const raw = readFileSync(indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as { entries?: unknown[] };
      if (!Array.isArray(parsed.entries)) continue;
      for (const item of parsed.entries) {
        const entry = item as SessionsIndexEntry;
        if (!entry || typeof entry.sessionId !== 'string') continue;
        if (entry.isSidechain === true) continue;
        entries.push(entry);
      }
    } catch {
      // Ignore malformed index files; discovery is best-effort.
    }
  }
  return entries;
}

function getLsofOutput(projectsRoot: string): string {
  try {
    return execFileSync('lsof', ['-Fpctn', '--', projectsRoot], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // lsof returns exit code 1 when no files match; this is not an error.
    const e = err as { stdout?: string; status?: number };
    if (e.status === 1) {
      return typeof e.stdout === 'string' ? e.stdout : '';
    }
    return '';
  }
}

export function discoverActiveClaudeSessions(
  projectsRoot = join(homedir(), '.claude', 'projects'),
): LiveSessionDiscoveryResult {
  const lsofOutput = getLsofOutput(projectsRoot);
  const opened = parseOpenSessionTranscripts(lsofOutput, projectsRoot);
  if (opened.length === 0) {
    return { sessions: [], openTranscripts: 0, unresolved: 0 };
  }

  const indexEntries = loadSessionsIndexEntries(projectsRoot);
  const sessions: DiscoveredLiveSession[] = [];
  let unresolved = 0;

  for (const item of opened) {
    const cwd = resolveProjectPathForSession(
      item.sessionId,
      item.transcriptPath,
      indexEntries,
    );
    if (!cwd) {
      unresolved++;
      continue;
    }
    sessions.push({
      sessionId: item.sessionId,
      transcriptPath: item.transcriptPath,
      cwd,
    });
  }

  return {
    sessions,
    openTranscripts: opened.length,
    unresolved,
  };
}
