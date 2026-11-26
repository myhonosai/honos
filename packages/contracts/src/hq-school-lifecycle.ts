import type { HqSchoolOperationalStatus } from './hq-school-directory.js';

/** HQ school lifecycle (0675): pause, resume, archive ("Remove", erased after 30 days by a later job) and restore. */
export const HQ_SCHOOL_LIFECYCLE_ACTIONS = ['PAUSE', 'RESUME', 'ARCHIVE', 'RESTORE'] as const;
export type HqSchoolLifecycleAction = (typeof HQ_SCHOOL_LIFECYCLE_ACTIONS)[number];
export const HQ_SCHOOL_LIFECYCLE_COMMAND = 'hq-school-lifecycle';
export const HQ_SCHOOL_ERASE_DAYS = 30;

export interface HqSchoolLifecycleInput {
  action: HqSchoolLifecycleAction;
  expectedStatus: HqSchoolOperationalStatus;
  /** Required for ARCHIVE only: the exact school name, typed by the HQ person. */
  confirmName?: string;
}
export interface HqSchoolLifecycleReceipt {
  schoolId: string;
  action: HqSchoolLifecycleAction;
  schoolStatus: HqSchoolOperationalStatus;
  organizationStatus: HqSchoolOperationalStatus;
  eraseAfter: string | null;
  replayed: boolean;
}
export interface HqSchoolArchiveDate { schoolId: string; archivedAt: string; eraseAfter: string }
export interface HqSchoolArchiveDates { archives: HqSchoolArchiveDate[] }

const ALLOWED: Record<HqSchoolLifecycleAction, readonly HqSchoolOperationalStatus[]> = {
  PAUSE: ['ACTIVE'], RESUME: ['SUSPENDED'], ARCHIVE: ['ACTIVE', 'SUSPENDED'], RESTORE: ['ARCHIVED'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATUSES: readonly string[] = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'];

export function hqSchoolLifecycleUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  return value.toLowerCase();
}

/** Which actions the row menu may offer for a school status. */
export function hqSchoolLifecycleActionsFor(status: HqSchoolOperationalStatus): HqSchoolLifecycleAction[] {
  return HQ_SCHOOL_LIFECYCLE_ACTIONS.filter((action) => ALLOWED[action].includes(status));
}

export function validateHqSchoolLifecycleInput(value: unknown): HqSchoolLifecycleInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !['action', 'expectedStatus', 'confirmName'].includes(key))) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  const { action, expectedStatus, confirmName } = input;
  if (typeof action !== 'string' || !(HQ_SCHOOL_LIFECYCLE_ACTIONS as readonly string[]).includes(action)) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  if (typeof expectedStatus !== 'string' || !STATUSES.includes(expectedStatus)) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  if (!ALLOWED[action as HqSchoolLifecycleAction].includes(expectedStatus as HqSchoolOperationalStatus)) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  if (action === 'ARCHIVE') {
    if (typeof confirmName !== 'string' || confirmName.length < 1 || confirmName.length > 200) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
    return { action, expectedStatus: expectedStatus as HqSchoolOperationalStatus, confirmName };
  }
  if (confirmName !== undefined) throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_INPUT');
  return { action: action as HqSchoolLifecycleAction, expectedStatus: expectedStatus as HqSchoolOperationalStatus };
}

export function validateHqSchoolLifecycleReceipt(value: unknown): HqSchoolLifecycleReceipt {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Object.keys(r).sort().join() !== 'action,eraseAfter,organizationStatus,replayed,schoolId,schoolStatus'
    || typeof r.schoolId !== 'string' || !UUID.test(r.schoolId)
    || !(HQ_SCHOOL_LIFECYCLE_ACTIONS as readonly unknown[]).includes(r.action)
    || !STATUSES.includes(r.schoolStatus as string) || !STATUSES.includes(r.organizationStatus as string)
    || typeof r.replayed !== 'boolean'
    || (r.action === 'ARCHIVE' ? typeof r.eraseAfter !== 'string' || !ISO.test(r.eraseAfter) : r.eraseAfter !== null)) {
    throw new Error('INVALID_HQ_SCHOOL_LIFECYCLE_RECEIPT');
  }
  return r as unknown as HqSchoolLifecycleReceipt;
}

export function validateHqSchoolArchiveDates(value: unknown): HqSchoolArchiveDates {
  const v = value as { archives?: unknown } | null;
  if (!v || typeof v !== 'object' || Object.keys(v).join() !== 'archives' || !Array.isArray(v.archives)) throw new Error('INVALID_HQ_SCHOOL_ARCHIVES');
  for (const row of v.archives as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join() !== 'archivedAt,eraseAfter,schoolId'
      || typeof row.schoolId !== 'string' || !UUID.test(row.schoolId)
      || typeof row.archivedAt !== 'string' || !ISO.test(row.archivedAt) || typeof row.eraseAfter !== 'string' || !ISO.test(row.eraseAfter)) {
      throw new Error('INVALID_HQ_SCHOOL_ARCHIVES');
    }
  }
  return v as HqSchoolArchiveDates;
}
