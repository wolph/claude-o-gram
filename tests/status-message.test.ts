import { describe, it, expect } from 'vitest';
import { hasMeaningfulChange } from '../src/monitoring/status-message.js';
import type { StatusData } from '../src/types/monitoring.js';

const base: StatusData = {
  contextPercent: 30,
  currentTool: 'Read',
  sessionDuration: '5m',
  toolCallCount: 10,
  filesChanged: 2,
  status: 'active',
};

describe('hasMeaningfulChange', () => {
  it('returns true when no previous data exists', () => {
    expect(hasMeaningfulChange(base, null)).toBe(true);
  });

  it('returns true when context % delta >= 10', () => {
    const updated = { ...base, contextPercent: 40 };
    expect(hasMeaningfulChange(updated, base)).toBe(true);
  });

  it('returns false when context % delta < 10', () => {
    const updated = { ...base, contextPercent: 35 };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('returns true when filesChanged changes', () => {
    const updated = { ...base, filesChanged: 3 };
    expect(hasMeaningfulChange(updated, base)).toBe(true);
  });

  it('returns false when only currentTool changes', () => {
    const updated = { ...base, currentTool: 'Grep' };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('returns false when only toolCallCount changes', () => {
    const updated = { ...base, toolCallCount: 15 };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('returns false when only sessionDuration changes', () => {
    const updated = { ...base, sessionDuration: '10m' };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });

  it('does NOT treat status change as meaningful (handled by settle timer)', () => {
    const updated = { ...base, status: 'idle' as const };
    expect(hasMeaningfulChange(updated, base)).toBe(false);
  });
});
