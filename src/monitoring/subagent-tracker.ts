/**
 * SubagentTracker: Tracks subagent lifecycle state.
 *
 * Manages active agents, depth/nesting, parent-child relationships,
 * description stashing (from PreToolUse(Agent) -> SubagentStart correlation),
 * and session cleanup. No Telegram dependencies -- pure state tracking.
 */

import type { SubagentStartPayload, SubagentStopPayload } from '../types/hooks.js';

/** Represents an active subagent being tracked */
export interface ActiveAgent {
  agentId: string;
  agentType: string;       // "Explore", "Plan", etc.
  displayName: string;     // Human-friendly name for [bracket] prefix (uses agentType)
  description: string;     // From PreToolUse(Agent) stash, or fallback to agentType
  startedAt: number;       // Date.now() for duration calculation
  depth: number;           // 0 = top-level subagent, 1 = nested, capped at 2
  parentAgentId?: string;  // undefined for top-level agents
  sessionId: string;       // Session this agent belongs to
}

/** Stashed description entry with auto-expiry timer */
interface PendingDescription {
  description: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Max nesting depth for visual indentation */
const MAX_DEPTH = 2;

/** Auto-expiry timeout for stashed descriptions (ms) */
const DESCRIPTION_EXPIRY_MS = 30_000;

/** Indent string per depth level */
const INDENT_UNIT = '  ';

export class SubagentTracker {
  /** Active agents keyed by agentId */
  private activeAgents = new Map<string, ActiveAgent>();

  /** Per-session ordered stack of active agentIds (most recent last) */
  private sessionAgentStack = new Map<string, string[]>();

  /** Stashed descriptions keyed by `${sessionId}:${agentType}` */
  private pendingDescriptions = new Map<string, PendingDescription>();

  /**
   * Stash a description from PreToolUse(Agent) tool_input.description.
   * Auto-expires after 30 seconds to prevent memory leaks.
   */
  stashDescription(sessionId: string, agentType: string, description: string): void {
    const key = `${sessionId}:${agentType}`;

    // Clear any existing timer for this key
    const existing = this.pendingDescriptions.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.pendingDescriptions.delete(key);
    }, DESCRIPTION_EXPIRY_MS);

    this.pendingDescriptions.set(key, { description, timer });
  }

  /**
   * Retrieve and delete a stashed description.
   * Returns null if expired or not found.
   */
  popDescription(sessionId: string, agentType: string): string | null {
    const key = `${sessionId}:${agentType}`;
    const entry = this.pendingDescriptions.get(key);
    if (!entry) return null;

    clearTimeout(entry.timer);
    this.pendingDescriptions.delete(key);
    return entry.description;
  }

  /**
   * Register a new active subagent.
   * Looks up description via popDescription. Determines depth from existing
   * active agents in the session. Pushes onto session agent stack.
   */
  start(sessionId: string, agentId: string, agentType: string): ActiveAgent {
    // Look up stashed description (from PreToolUse(Agent))
    const description = this.popDescription(sessionId, agentType) || agentType;

    // Determine depth and parent from existing session stack
    const stack = this.sessionAgentStack.get(sessionId) || [];
    let depth = 0;
    let parentAgentId: string | undefined;

    if (stack.length > 0) {
      const parentId = stack[stack.length - 1];
      const parent = this.activeAgents.get(parentId);
      if (parent) {
        depth = Math.min(parent.depth + 1, MAX_DEPTH);
        parentAgentId = parentId;
      }
    }

    const agent: ActiveAgent = {
      agentId,
      agentType,
      displayName: agentType,
      description,
      startedAt: Date.now(),
      depth,
      parentAgentId,
      sessionId,
    };

    this.activeAgents.set(agentId, agent);

    // Push onto session stack
    stack.push(agentId);
    this.sessionAgentStack.set(sessionId, stack);

    return agent;
  }

  /**
   * Remove an agent from tracking when it completes.
   * Returns the agent info and duration, or null if unknown agent.
   */
  stop(agentId: string): { agent: ActiveAgent; durationMs: number } | null {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return null;

    const durationMs = Date.now() - agent.startedAt;

    // Remove from active agents
    this.activeAgents.delete(agentId);

    // Remove from session stack
    const stack = this.sessionAgentStack.get(agent.sessionId);
    if (stack) {
      const idx = stack.indexOf(agentId);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
      if (stack.length === 0) {
        this.sessionAgentStack.delete(agent.sessionId);
      }
    }

    return { agent, durationMs };
  }

  /**
   * Get the most recently started active agent for a session.
   * Used for temporal tool attribution -- when a PostToolUse arrives,
   * attribute it to the top of the session's agent stack.
   */
  getActiveAgent(sessionId: string): ActiveAgent | null {
    const stack = this.sessionAgentStack.get(sessionId);
    if (!stack || stack.length === 0) return null;

    // Top of stack = most recently started agent
    const topId = stack[stack.length - 1];
    return this.activeAgents.get(topId) || null;
  }

  /**
   * Get indentation string for an agent based on its depth.
   * 2 spaces per depth level. Depth 0 = no indent.
   */
  getIndent(agentId: string): string {
    const agent = this.activeAgents.get(agentId);
    if (!agent) return '';
    return INDENT_UNIT.repeat(agent.depth);
  }

  /**
   * Quick check if any subagent is active for a session.
   */
  isSubagentActive(sessionId: string): boolean {
    const stack = this.sessionAgentStack.get(sessionId);
    return !!stack && stack.length > 0;
  }

  /**
   * Remove all agents and stashed descriptions for a session.
   * Called on session end or /clear.
   */
  cleanup(sessionId: string): void {
    // Remove all agents for this session
    const stack = this.sessionAgentStack.get(sessionId);
    if (stack) {
      for (const agentId of stack) {
        this.activeAgents.delete(agentId);
      }
      this.sessionAgentStack.delete(sessionId);
    }

    // Remove stashed descriptions for this session
    for (const [key, entry] of this.pendingDescriptions.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(entry.timer);
        this.pendingDescriptions.delete(key);
      }
    }
  }
}
