import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  replaceEmojiShortcodes,
  markdownToHtml,
  truncateText,
  splitForTelegram,
  isProceduralNarration,
  convertCommandsForTelegram,
} from '../src/utils/text.js';

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through safe text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes multiple occurrences', () => {
    expect(escapeHtml('<b>bold</b> & <i>italic</i>')).toBe(
      '&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;',
    );
  });
});

describe('replaceEmojiShortcodes', () => {
  it('replaces known shortcodes', () => {
    expect(replaceEmojiShortcodes(':rocket: launch')).toBe('\u{1F680} launch');
  });

  it('leaves unknown shortcodes unchanged', () => {
    expect(replaceEmojiShortcodes(':nonexistent: text')).toBe(':nonexistent: text');
  });

  it('handles multiple shortcodes', () => {
    const result = replaceEmojiShortcodes(':tada: :star:');
    expect(result).toBe('\u{1F389} \u2B50');
  });
});

describe('markdownToHtml', () => {
  it('converts bold', () => {
    expect(markdownToHtml('**bold**')).toBe('<b>bold</b>');
  });

  it('converts italic', () => {
    expect(markdownToHtml('*italic*')).toBe('<i>italic</i>');
  });

  it('converts inline code', () => {
    expect(markdownToHtml('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('converts links', () => {
    expect(markdownToHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>',
    );
  });

  it('converts headers to bold', () => {
    expect(markdownToHtml('# Title')).toBe('<b>Title</b>');
    expect(markdownToHtml('## Subtitle')).toBe('<b>Subtitle</b>');
  });

  it('escapes HTML in input', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('converts fenced code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToHtml(input)).toContain('<pre>');
    expect(markdownToHtml(input)).toContain('const x = 1;');
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });

  it('truncates long text with default suffix', () => {
    const result = truncateText('a'.repeat(200), 100);
    expect(result.length).toBe(100);
    expect(result).toContain('(truncated)');
  });

  it('uses custom suffix', () => {
    const result = truncateText('a'.repeat(200), 100, '...');
    expect(result.length).toBe(100);
    expect(result.endsWith('...')).toBe(true);
  });
});

describe('splitForTelegram', () => {
  it('returns inline for short text', () => {
    const result = splitForTelegram('hello');
    expect(result.inline).toBe(true);
  });

  it('returns non-inline for text over 4000 chars', () => {
    const result = splitForTelegram('a'.repeat(4001));
    expect(result.inline).toBe(false);
  });

  it('returns inline at exactly 4000 chars', () => {
    const result = splitForTelegram('a'.repeat(4000));
    expect(result.inline).toBe(true);
  });
});

describe('isProceduralNarration', () => {
  it('detects "Let me" prefixes', () => {
    expect(isProceduralNarration("Let me read the file...")).toBe(true);
  });

  it('detects "I\'ll" prefixes', () => {
    expect(isProceduralNarration("I'll check the config.")).toBe(true);
  });

  it('returns false for long text', () => {
    expect(isProceduralNarration("Let me " + "x".repeat(200))).toBe(false);
  });

  it('returns false for non-narration', () => {
    expect(isProceduralNarration("The function returns a string")).toBe(false);
  });
});

describe('convertCommandsForTelegram', () => {
  it('converts namespaced commands', () => {
    expect(convertCommandsForTelegram('/gsd:complete-milestone')).toBe('/gsd_complete_milestone');
  });

  it('converts hyphenated commands', () => {
    expect(convertCommandsForTelegram('/release-notes')).toBe('/release_notes');
  });

  it('leaves simple commands unchanged', () => {
    expect(convertCommandsForTelegram('/status')).toBe('/status');
  });
});
