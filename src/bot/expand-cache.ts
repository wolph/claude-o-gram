/**
 * LRU cache for expand/collapse content.
 *
 * When compact tool messages are sent to Telegram, the full expanded output
 * is stored here keyed by chatId:messageId. When a user clicks the expand
 * button, the cached content is retrieved and used to edit the message.
 */
import { LRUCache } from 'lru-cache';

export interface ExpandEntry {
  /** Original compact HTML message text (for collapse restoration) */
  compact: string;
  /** Array of per-tool expanded content (for multi-tool batched messages) */
  tools: Array<{ name: string; expanded: string }>;
}

export const expandCache = new LRUCache<string, ExpandEntry>({
  max: 500,
  ttl: 4 * 60 * 60 * 1000, // 4 hours
});

/** Build cache key from chat ID and message ID */
export function cacheKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/**
 * Build the expanded HTML view from an ExpandEntry.
 * Each tool gets a header and its expanded content, separated by lines.
 * Total output capped at 3900 chars to stay within Telegram's 4096 limit
 * after accounting for button markup overhead.
 */
export function buildExpandedHtml(entry: ExpandEntry): string {
  const sections = entry.tools
    .filter(t => t.expanded)
    .map(t => `<b>${escapeHtmlSimple(t.name)}</b>\n<pre>${escapeHtmlSimple(t.expanded)}</pre>`);

  let result = sections.join('\n\n');

  if (result.length > 3900) {
    result = result.slice(0, 3900) + '\n\n(truncated -- full output exceeds Telegram limit)';
  }

  return result;
}

function escapeHtmlSimple(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
