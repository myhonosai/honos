import {
  ATTENDANCE_CATEGORIES, ATTENDANCE_WEIGHT_MAX,
  type AttendanceCategoryPolicy, type AttendanceStatus, type ConfigureAttendancePolicyInput,
} from '@hon/contracts';

export function validateAttendancePolicy(input: ConfigureAttendancePolicyInput): void {
  if (!input || Object.keys(input).some(key => !['expectedVersion', 'categories'].includes(key))
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || input.expectedVersion > 2147483646 || !Array.isArray(input.categories)
    || input.categories.length !== ATTENDANCE_CATEGORIES.length) throw new Error('VALIDATION_FAILED');
  const seen = new Set<string>();
  for (const rule of input.categories) {
    if (!rule || Object.keys(rule).length !== 4
      || Object.keys(rule).some(key => !['category', 'operationalAllowed', 'progressionEnabled', 'weightMilli'].includes(key))
      || !ATTENDANCE_CATEGORIES.includes(rule.category) || seen.has(rule.category)
      || typeof rule.operationalAllowed !== 'boolean' || typeof rule.progressionEnabled !== 'boolean'
      || !Number.isSafeInteger(rule.weightMilli) || rule.weightMilli < 0 || rule.weightMilli > ATTENDANCE_WEIGHT_MAX) {
      throw new Error('VALIDATION_FAILED');
    }
    seen.add(rule.category);
  }
}

/** Snapshot evidence only. This function never mutates student progress or any other domain. */
export function attendanceCreditMilli(status: AttendanceStatus, rule: AttendanceCategoryPolicy): number {
  if (!rule.operationalAllowed) throw new Error('CATEGORY_NOT_ELIGIBLE');
  return rule.progressionEnabled && ['PRESENT', 'LATE', 'MAKEUP'].includes(status) ? rule.weightMilli : 0;
}
