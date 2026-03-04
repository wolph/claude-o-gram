/**
 * Text utilities for HTML escaping, truncation, and smart splitting
 * for Telegram's 4096 character message limit.
 */

/**
 * Common GitHub/Slack-style emoji shortcodes → Unicode.
 * Covers shortcodes frequently emitted by Claude Code in its output.
 */
const EMOJI_MAP: Record<string, string> = {
  // Status / feedback
  tada: '\u{1F389}',
  white_check_mark: '\u2705',
  heavy_check_mark: '\u2714\uFE0F',
  x: '\u274C',
  warning: '\u26A0\uFE0F',
  exclamation: '\u2757',
  question: '\u2753',
  bangbang: '\u203C\uFE0F',
  // Arrows
  arrow_forward: '\u25B6\uFE0F',
  arrow_right: '\u27A1\uFE0F',
  arrow_left: '\u2B05\uFE0F',
  arrow_up: '\u2B06\uFE0F',
  arrow_down: '\u2B07\uFE0F',
  arrows_counterclockwise: '\u{1F504}',
  // Objects
  rocket: '\u{1F680}',
  bulb: '\u{1F4A1}',
  memo: '\u{1F4DD}',
  pencil: '\u270F\uFE0F',
  pencil2: '\u270F\uFE0F',
  wrench: '\u{1F527}',
  hammer: '\u{1F528}',
  gear: '\u2699\uFE0F',
  link: '\u{1F517}',
  package: '\u{1F4E6}',
  clipboard: '\u{1F4CB}',
  file_folder: '\u{1F4C1}',
  open_file_folder: '\u{1F4C2}',
  page_facing_up: '\u{1F4C4}',
  mag: '\u{1F50D}',
  key: '\u{1F511}',
  lock: '\u{1F512}',
  unlock: '\u{1F513}',
  bell: '\u{1F514}',
  bookmark: '\u{1F516}',
  books: '\u{1F4DA}',
  book: '\u{1F4D6}',
  // People / hands
  thumbsup: '\u{1F44D}',
  thumbsdown: '\u{1F44E}',
  point_right: '\u{1F449}',
  point_left: '\u{1F448}',
  raised_hands: '\u{1F64C}',
  clap: '\u{1F44F}',
  wave: '\u{1F44B}',
  thinking: '\u{1F914}',
  // Symbols
  star: '\u2B50',
  star2: '\u{1F31F}',
  sparkles: '\u2728',
  fire: '\u{1F525}',
  zap: '\u26A1',
  boom: '\u{1F4A5}',
  heart: '\u2764\uFE0F',
  green_heart: '\u{1F49A}',
  // Shapes / indicators
  green_circle: '\u{1F7E2}',
  red_circle: '\u{1F534}',
  yellow_circle: '\u{1F7E1}',
  blue_circle: '\u{1F535}',
  white_circle: '\u26AA',
  black_circle: '\u26AB',
  large_blue_diamond: '\u{1F537}',
  small_blue_diamond: '\u{1F539}',
  small_orange_diamond: '\u{1F538}',
  heavy_plus_sign: '\u2795',
  heavy_minus_sign: '\u2796',
  // Common in Claude Code output
  checkered_flag: '\u{1F3C1}',
  construction: '\u{1F6A7}',
  rotating_light: '\u{1F6A8}',
  shield: '\u{1F6E1}\uFE0F',
  trophy: '\u{1F3C6}',
  target: '\u{1F3AF}',
  chart_with_upwards_trend: '\u{1F4C8}',
  bar_chart: '\u{1F4CA}',
  stopwatch: '\u23F1\uFE0F',
  hourglass: '\u231B',
  light_bulb: '\u{1F4A1}',
  muscle: '\u{1F4AA}',
  eyes: '\u{1F440}',
  brain: '\u{1F9E0}',
  broom: '\u{1F9F9}',
  wastebasket: '\u{1F5D1}\uFE0F',
  inbox_tray: '\u{1F4E5}',
  outbox_tray: '\u{1F4E4}',
  pushpin: '\u{1F4CC}',
  round_pushpin: '\u{1F4CD}',
  triangular_flag_on_post: '\u{1F6A9}',
  label: '\u{1F3F7}\uFE0F',
  seedling: '\u{1F331}',
  evergreen_tree: '\u{1F332}',
  deciduous_tree: '\u{1F333}',
  herb: '\u{1F33F}',
  four_leaf_clover: '\u{1F340}',
  leaves: '\u{1F343}',
  sun_with_face: '\u{1F31E}',
  full_moon_with_face: '\u{1F31D}',
  new_moon: '\u{1F311}',
  crescent_moon: '\u{1F319}',
  cloud: '\u2601\uFE0F',
  umbrella: '\u2602\uFE0F',
  snowflake: '\u2744\uFE0F',
  rainbow: '\u{1F308}',
  ocean: '\u{1F30A}',
};

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
 * Replace GitHub/Slack-style :emoji_name: shortcodes with Unicode emojis.
 * Only matches known shortcodes from EMOJI_MAP to avoid false positives.
 * Applied before HTML escaping since emoji chars are safe in HTML.
 */
export function replaceEmojiShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_]+):/g, (match, name: string) => {
    return EMOJI_MAP[name] ?? match;
  });
}

/**
 * Convert basic Markdown to Telegram-compatible HTML.
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```,
 * and [text](url) links. Escapes HTML entities first, then applies
 * Markdown conversions on the escaped text.
 */
export function markdownToHtml(text: string): string {
  // Replace :emoji: shortcodes before escaping (emoji chars are HTML-safe)
  let html = escapeHtml(replaceEmojiShortcodes(text));

  // Wrap markdown tables in <pre> before other transforms
  html = wrapTablesInPre(html);

  // Fenced code blocks: ```lang\n...\n``` → <pre>...</pre>
  html = html.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => `<pre>${code.trimEnd()}</pre>`);

  // ATX headers: # text → bold (Telegram has no <h1>–<h6>)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Horizontal rules: --- → blank line
  html = html.replace(/^-{3,}$/gm, '');

  // Inline code: `...` → <code>...</code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **...** → <b>...</b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic: *...* → <i>...</i> (but not inside words like file*name)
  html = html.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<i>$1</i>');

  // Links: [text](url) → <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Strip <sub>/<sup> tags (not supported by Telegram HTML; already escaped)
  html = html.replace(/&lt;sub&gt;(.*?)&lt;\/sub&gt;/g, '$1');
  html = html.replace(/&lt;sup&gt;(.*?)&lt;\/sup&gt;/g, '$1');

  return html;
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

/**
 * Detect short procedural narration messages that add no value
 * (e.g. "Let me read the plan...", "I'll check the file...").
 * Only filters short messages (<200 chars) with explicit prefixes.
 */
export function isProceduralNarration(text: string): boolean {
  if (text.length >= 200) return false;
  const trimmed = text.trim();
  return /^(let me |i'll |i will |now i'll |now let me |now i will )/i.test(trimmed);
}

/**
 * Convert Claude Code command references to Telegram-clickable format.
 * Telegram commands only allow [a-z0-9_], so:
 *   /gsd:complete-milestone → /gsd_complete_milestone
 *   /release-notes → /release_notes
 * Applied to assistant messages before posting to Telegram.
 */
export function convertCommandsForTelegram(text: string): string {
  // Match /command patterns: /word:word-word or /word-word (not inside code blocks)
  return text.replace(/\/([a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)+)/g, (_match, cmd: string) => {
    // Namespaced commands: gsd:complete-milestone → gsd_complete_milestone
    return '/' + cmd.replace(/:/g, '_').replace(/-/g, '_');
  }).replace(/\/([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+)/g, (_match, cmd: string) => {
    // Hyphenated commands: release-notes → release_notes
    return '/' + cmd.replace(/-/g, '_');
  });
}

/**
 * Shorten absolute paths by replacing $HOME prefix with ~/
 */
export function shortenCommand(command: string): string {
  const home = process.env.HOME;
  if (!home) return command;
  return command.replaceAll(home + '/', '~/');
}

/**
 * Detect markdown tables (header | separator | data rows) and wrap in <pre> blocks
 * so they render in monospace on Telegram's proportional font.
 */
function wrapTablesInPre(html: string): string {
  // Match a table: header row, separator row (|---|), and one or more data rows
  const tableRegex = /^(\|.+\|)\n(\|[\s:|-]+\|)\n((?:\|.+\|\n?)+)/gm;
  return html.replace(tableRegex, (_match, header, separator, body) => {
    const tableText = `${header}\n${separator}\n${body.trimEnd()}`;
    return `<pre>${tableText}</pre>`;
  });
}
