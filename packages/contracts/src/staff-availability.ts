import type { CommandContext } from './index.js';

export const STAFF_AVAILABILITY_PERMISSIONS = ['staff.availability.self_manage', 'staff.availability.manage', 'staff.qualification.manage'] as const;
export type StaffAvailabilityPermission = (typeof STAFF_AVAILABILITY_PERMISSIONS)[number];
export type StaffRevisionKind = 'AVAILABILITY' | 'QUALIFICATIONS';
export interface StaffAvailabilityContext extends CommandContext { externalSubject: string }
export interface WeeklyStaffWindow { weekday: number; start: string; end: string }
export interface StaffQualification { title: string; issuer: string; expiresOn: string | null }
export interface StaffRevisionInput {
  expectedVersion: number;
  status: 'ACTIVE' | 'ENDED';
  /** Inclusive school-local calendar date. */
  effectiveFrom: string;
  /** Exclusive school-local date; optional. */
  endsOn: string | null;
  windows?: WeeklyStaffWindow[];
  qualifications?: StaffQualification[];
}
export interface StaffRevision extends StaffRevisionInput {
  profileId: string; principalId: string; schoolId: string; timezone: string;
  kind: StaffRevisionKind; version: number; recordedAt: string; planningOnly: true;
}
export interface StaffAvailabilityProfile {
  profileId: string | null; principalId: string; schoolId: string; timezone: string; own: boolean;
  canManageAvailability: boolean; canManageQualifications: boolean;
  availability: StaffRevision | null; qualifications: StaffRevision | null;
  planningOnly: true;
}
export const STAFF_AVAILABILITY_HELP = 'Human planning metadata only. Weekly windows are school-local wall times, not class/session availability, assignment or qualification decisions. Qualification metadata is unverified, not credential evidence. No classes or sessions change; no payroll, compensation, time card, attendance, hiring, firing, discipline, automated scheduling/assignment, calendar sync, messages, AI/provider or Action Engine execution.';
const UNSAFE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
function invalid(): never { throw new Error('Use bounded school-local windows or unverified qualification metadata and a current version.'); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) invalid();
}
function text(v: unknown, max: number): asserts v is string {
  if (typeof v !== 'string' || !v || v.trim() !== v || v.length > max || UNSAFE.test(v)) invalid();
}
export function validateStaffDate(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) || new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) !== v) invalid();
}
export function validateStaffRevision(kind: StaffRevisionKind, value: unknown): asserts value is StaffRevisionInput {
  if (kind !== 'AVAILABILITY' && kind !== 'QUALIFICATIONS') invalid();
  closed(value, ['expectedVersion', 'status', 'effectiveFrom', 'endsOn', kind === 'AVAILABILITY' ? 'windows' : 'qualifications']);
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0 || Number(value.expectedVersion) > 999999998 || !['ACTIVE', 'ENDED'].includes(String(value.status))) invalid();
  validateStaffDate(value.effectiveFrom);
  if (value.endsOn !== null) { validateStaffDate(value.endsOn); const days = (Date.parse(value.endsOn) - Date.parse(value.effectiveFrom)) / 86400000; if (days < 1 || days > 3660) invalid(); }
  if (value.status === 'ENDED' && value.expectedVersion === 0) invalid();
  const list = kind === 'AVAILABILITY' ? value.windows : value.qualifications;
  if (!Array.isArray(list) || list.length > (kind === 'AVAILABILITY' ? 28 : 30) || (value.status === 'ENDED' && list.length !== 0)) invalid();
  if (kind === 'AVAILABILITY') {
    const windows: WeeklyStaffWindow[] = [];
    for (const item of list) {
      closed(item, ['weekday', 'start', 'end']);
      if (!Number.isInteger(item.weekday) || Number(item.weekday) < 1 || Number(item.weekday) > 7 || typeof item.start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.start) || typeof item.end !== 'string' || !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(item.end) || item.start >= item.end) invalid();
      const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
      if (minutes(item.end) - minutes(item.start) < 15) invalid();
      const window = item as unknown as WeeklyStaffWindow;
      if (windows.some(w => w.weekday === window.weekday && w.start < window.end && window.start < w.end)) invalid();
      windows.push(window);
    }
  } else {
    const seen = new Set<string>();
    for (const item of list) {
      closed(item, ['title', 'issuer', 'expiresOn']); text(item.title, 120); text(item.issuer, 120);
      if (item.expiresOn !== null) validateStaffDate(item.expiresOn);
      const key = `${item.title.toLowerCase()}\u0000${item.issuer.toLowerCase()}`;
      if (seen.has(key)) invalid(); seen.add(key);
    }
  }
}
