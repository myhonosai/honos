import { describe, expect, it } from 'vitest';
import { aiUsageThreshold } from '../src/index.js';

describe('HON AI usage economics', () => {
  it('emits the specified 75, 90, and 100 percent thresholds', () => {
    expect(aiUsageThreshold(74, 100)).toBe('NORMAL');
    expect(aiUsageThreshold(75, 100)).toBe('WARNING_75');
    expect(aiUsageThreshold(90, 100)).toBe('WARNING_90');
    expect(aiUsageThreshold(100, 100)).toBe('EXHAUSTED');
  });

  it('rejects invalid usage input instead of hiding a metering defect', () => {
    expect(() => aiUsageThreshold(-1, 100)).toThrow('AI_USAGE_INPUT_INVALID');
    expect(() => aiUsageThreshold(10, 0)).toThrow('AI_USAGE_INPUT_INVALID');
  });
});
