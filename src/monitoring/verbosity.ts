import type { VerbosityTier } from '../types/monitoring.js';

/** Tools shown in Minimal tier: only file-modifying and bash */
const MINIMAL_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash']);

/** Tools excluded from Normal tier: noisy read/search operations */
const NORMAL_EXCLUDE = new Set(['Read', 'Glob', 'Grep']);

/**
 * Determine whether a tool call should be posted to Telegram
 * based on the current verbosity tier.
 *
 * - verbose: all tools shown
 * - normal: all except Read/Glob/Grep
 * - minimal: only Write/Edit/MultiEdit/Bash
 */
export function shouldPostToolCall(toolName: string, tier: VerbosityTier): boolean {
  switch (tier) {
    case 'verbose':
      return true;
    case 'minimal':
      return MINIMAL_TOOLS.has(toolName);
    case 'normal':
      return !NORMAL_EXCLUDE.has(toolName);
  }
}

/**
 * Parse a string value into a valid VerbosityTier.
 * Returns 'normal' as the default per user decision.
 */
export function parseVerbosityTier(value: string | undefined): VerbosityTier {
  if (value === 'minimal' || value === 'normal' || value === 'verbose') {
    return value;
  }
  return 'normal';
}
