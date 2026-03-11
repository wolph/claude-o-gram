import { describe, it, expect } from 'vitest';
import { shouldPostToolCall, parseVerbosityTier } from '../src/monitoring/verbosity.js';

describe('shouldPostToolCall', () => {
  describe('verbose tier', () => {
    it('shows all tools', () => {
      expect(shouldPostToolCall('Read', 'verbose')).toBe(true);
      expect(shouldPostToolCall('Write', 'verbose')).toBe(true);
      expect(shouldPostToolCall('Bash', 'verbose')).toBe(true);
      expect(shouldPostToolCall('Glob', 'verbose')).toBe(true);
      expect(shouldPostToolCall('Grep', 'verbose')).toBe(true);
      expect(shouldPostToolCall('Agent', 'verbose')).toBe(true);
    });
  });

  describe('normal tier', () => {
    it('hides Read, Glob, Grep', () => {
      expect(shouldPostToolCall('Read', 'normal')).toBe(false);
      expect(shouldPostToolCall('Glob', 'normal')).toBe(false);
      expect(shouldPostToolCall('Grep', 'normal')).toBe(false);
    });

    it('shows Write, Edit, Bash', () => {
      expect(shouldPostToolCall('Write', 'normal')).toBe(true);
      expect(shouldPostToolCall('Edit', 'normal')).toBe(true);
      expect(shouldPostToolCall('Bash', 'normal')).toBe(true);
    });

    it('shows Agent', () => {
      expect(shouldPostToolCall('Agent', 'normal')).toBe(true);
    });
  });

  describe('minimal tier', () => {
    it('only shows Write, Edit, MultiEdit, Bash', () => {
      expect(shouldPostToolCall('Write', 'minimal')).toBe(true);
      expect(shouldPostToolCall('Edit', 'minimal')).toBe(true);
      expect(shouldPostToolCall('MultiEdit', 'minimal')).toBe(true);
      expect(shouldPostToolCall('Bash', 'minimal')).toBe(true);
    });

    it('hides everything else', () => {
      expect(shouldPostToolCall('Read', 'minimal')).toBe(false);
      expect(shouldPostToolCall('Glob', 'minimal')).toBe(false);
      expect(shouldPostToolCall('Agent', 'minimal')).toBe(false);
    });
  });
});

describe('parseVerbosityTier', () => {
  it('parses valid tiers', () => {
    expect(parseVerbosityTier('minimal')).toBe('minimal');
    expect(parseVerbosityTier('normal')).toBe('normal');
    expect(parseVerbosityTier('verbose')).toBe('verbose');
  });

  it('defaults to minimal for invalid values', () => {
    expect(parseVerbosityTier('invalid')).toBe('minimal');
    expect(parseVerbosityTier(undefined)).toBe('minimal');
    expect(parseVerbosityTier('')).toBe('minimal');
  });
});
