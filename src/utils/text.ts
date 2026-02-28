/**
 * Text utilities for HTML escaping, truncation, and smart splitting
 * for Telegram's 4096 character message limit.
 */

/**
 * Escape HTML special characters to prevent parse errors in Telegram HTML mode.
 * Per Pitfall 3: always escape user content before embedding in HTML templates.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Truncate text to a maximum length, appending a suffix if truncated.
 */
export function truncateText(
  text: string,
  maxLength: number,
  suffix: string = '\n... (truncated)',
): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Smart output splitting for Telegram messages.
 *
 * - Short output (<= 400 chars): inline in message
 * - Medium output (<= 4000 chars): code block, still inline
 * - Long output (> 4000 chars): sent as .txt file attachment
 *
 * The 4000 threshold leaves room for message template wrapping
 * before hitting Telegram's 4096 limit.
 */
export function splitForTelegram(
  text: string,
): { inline: true; text: string } | { inline: false; text: string } {
  if (text.length <= 4000) {
    return { inline: true, text };
  }
  return { inline: false, text };
}
