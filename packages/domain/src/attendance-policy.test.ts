import { describe, expect, it } from 'vitest';
import { ATTENDANCE_CATEGORIES, ATTENDANCE_STATUSES } from '@hon/contracts';
import { attendanceCreditMilli, validateAttendancePolicy } from './attendance-policy.js';
const categories = ATTENDANCE_CATEGORIES.map(category => ({ category, operationalAllowed: true, progressionEnabled: true, weightMilli: 1250 }));
describe('attendance progression evidence only', () => {
  it('requires every category exactly once, closed fields, booleans, versions and integer range', () => {
    expect(() => validateAttendancePolicy({ expectedVersion: 0, categories })).not.toThrow();
    for (const input of [
      { expectedVersion: -1, categories }, { expectedVersion: 0.5, categories },
      { expectedVersion: 0, categories: categories.slice(1) },
      { expectedVersion: 0, categories: categories.map(() => categories[0]!) },
      { expectedVersion: 0, categories: categories.map(rule => ({ ...rule, weightMilli: 10001 })) },
      { expectedVersion: 0, categories: categories.map(rule => ({ ...rule, weightMilli: 0.1 })) },
      { expectedVersion: 0, categories, paymentCredit: 1 },
      { expectedVersion: 0, categories: categories.map(rule => ({ ...rule, provider: 'AI' })) },
    ]) expect(() => validateAttendancePolicy(input)).toThrow('VALIDATION_FAILED');
  });
  it('preserves attendance statuses and uses deterministic nonfinancial integer weights', () => {
    for (const category of ATTENDANCE_CATEGORIES) {
      for (const status of ATTENDANCE_STATUSES) {
        const rule = { category, operationalAllowed: true, progressionEnabled: true, weightMilli: 1250 };
        expect(attendanceCreditMilli(status, rule)).toBe(['PRESENT', 'LATE', 'MAKEUP'].includes(status) ? 1250 : 0);
        expect(attendanceCreditMilli(status, { ...rule, progressionEnabled: false })).toBe(0);
      }
    }
  });
  it('operational exclusion is distinct from progression exclusion', () => {
    expect(() => attendanceCreditMilli('PRESENT', { ...categories[0]!, operationalAllowed: false })).toThrow('CATEGORY_NOT_ELIGIBLE');
    expect(attendanceCreditMilli('PRESENT', { ...categories[0]!, progressionEnabled: false })).toBe(0);
  });
});
