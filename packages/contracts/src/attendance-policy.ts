import type { CommandContext } from './index.js';

export const ATTENDANCE_CATEGORIES = [
  'REGULAR_PARTICIPANT', 'OBSERVER', 'TRIAL_STUDENT', 'GUEST_DROP_IN',
  'PRIVATE_LESSON', 'SPECIAL_EVENT', 'MAKEUP_CLASS',
] as const;
export type AttendanceCategory = (typeof ATTENDANCE_CATEGORIES)[number];
/** Nonfinancial fixed-point evidence: 1000 milli-classes = one class; range 0–10000. */
export const ATTENDANCE_WEIGHT_SCALE = 1000;
export const ATTENDANCE_WEIGHT_MAX = 10000;
export interface AttendanceCategoryPolicy {
  category: AttendanceCategory;
  operationalAllowed: boolean;
  progressionEnabled: boolean;
  weightMilli: number;
}
export interface AttendanceProgressionPolicy {
  programId: string;
  version: number;
  categories: AttendanceCategoryPolicy[];
}
export interface ConfigureAttendancePolicyInput {
  expectedVersion: number;
  categories: AttendanceCategoryPolicy[];
}
export interface AttendanceCommandContext extends CommandContext {
  externalSubject: string;
}
