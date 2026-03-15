import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  replaceEmojiShortcodes,
  markdownToHtml,
  truncateText,
  splitForTelegram,
  isProceduralNarration,
  convertCommandsForTelegram,
  stripSystemTags,
  parseNumberedOptions,
  extractPromptText,
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

  it('does not convert asterisks inside inline code to italic/bold', () => {
    const input = 'uses `*args: object, **kwargs: object` for forwarding';
    const result = markdownToHtml(input);
    expect(result).toContain('<code>*args: object, **kwargs: object</code>');
    expect(result).not.toContain('<i>');
    expect(result).not.toContain('<b>');
  });

  it('does not convert asterisks inside pre blocks to italic/bold', () => {
    const input = '```\ndef foo(*args, **kwargs):\n    pass\n```';
    const result = markdownToHtml(input);
    expect(result).toContain('*args');
    expect(result).not.toContain('<i>');
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

describe('stripSystemTags', () => {
  it('strips system-reminder tags and content', () => {
    const input = 'Hello\n<system-reminder>\nSystem instructions here\n</system-reminder>\nWorld';
    expect(stripSystemTags(input)).toBe('Hello\n\nWorld');
  });

  it('strips local-command-caveat tags', () => {
    const input = '<local-command-caveat>Caveat: messages were generated locally</local-command-caveat>\nText';
    expect(stripSystemTags(input)).toBe('Text');
  });

  it('strips command-name, command-message, command-args tags', () => {
    const input = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>';
    expect(stripSystemTags(input)).toBe('');
  });

  it('strips local-command-stdout tags', () => {
    const input = '<local-command-stdout>\x1b[2mCompacted\x1b[22m</local-command-stdout>';
    expect(stripSystemTags(input)).toBe('');
  });

  it('strips available-deferred-tools tags', () => {
    const input = 'Before\n<available-deferred-tools>\nTool1\nTool2\n</available-deferred-tools>\nAfter';
    expect(stripSystemTags(input)).toBe('Before\n\nAfter');
  });

  it('passes through normal text unchanged', () => {
    expect(stripSystemTags('Hello world')).toBe('Hello world');
  });

  it('passes through HTML-like tags that are not system tags', () => {
    expect(stripSystemTags('Use <b>bold</b> text')).toBe('Use <b>bold</b> text');
  });

  it('handles multiple system tags in one string', () => {
    const input = '<system-reminder>A</system-reminder>Keep this<command-name>X</command-name>';
    expect(stripSystemTags(input)).toBe('Keep this');
  });

  it('collapses excessive blank lines', () => {
    const input = 'A\n\n\n\n\nB';
    expect(stripSystemTags(input)).toBe('A\n\nB');
  });
});

describe('parseNumberedOptions', () => {
  const planMessage = [
    ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    ' \u276F 1. Yes, clear context (3% used) and auto-accept edits',
    '   2. Yes, auto-accept edits',
    '   3. Yes, manually approve edits',
    '   4. Type here to tell Claude what to change',
  ].join('\n');

  it('parses all 4 plan mode options', () => {
    const options = parseNumberedOptions(planMessage);
    expect(options).toHaveLength(4);
    expect(options[0].label).toBe('Yes, clear context (3% used) and auto-accept edits');
    expect(options[1].label).toBe('Yes, auto-accept edits');
    expect(options[2].label).toBe('Yes, manually approve edits');
    expect(options[3].label).toBe('Type here to tell Claude what to change');
  });

  it('assigns sequential indices', () => {
    const options = parseNumberedOptions(planMessage);
    expect(options.map(o => o.index)).toEqual([0, 1, 2, 3]);
  });

  it('returns empty array for messages without numbered options', () => {
    expect(parseNumberedOptions('Claude Code needs your approval.')).toEqual([]);
  });

  it('handles arrow indicator on first option', () => {
    const msg = '❯ 1. Option A\n  2. Option B';
    const options = parseNumberedOptions(msg);
    expect(options).toHaveLength(2);
    expect(options[0].label).toBe('Option A');
    expect(options[1].label).toBe('Option B');
  });

  it('handles > as alternative arrow indicator', () => {
    const msg = '> 1. First\n  2. Second';
    const options = parseNumberedOptions(msg);
    expect(options).toHaveLength(2);
    expect(options[0].label).toBe('First');
  });
});

describe('extractPromptText', () => {
  it('extracts text before numbered options', () => {
    const msg = 'Would you like to proceed?\n\n 1. Yes\n 2. No';
    expect(extractPromptText(msg)).toBe('Would you like to proceed?');
  });

  it('returns full message when no options present', () => {
    expect(extractPromptText('Just a plain message')).toBe('Just a plain message');
  });

  it('handles leading arrow indicators', () => {
    const msg = 'Choose:\n❯ 1. A\n  2. B';
    expect(extractPromptText(msg)).toBe('Choose:');
  });
});
