import type { HonTier } from './index.js';

export const HQ_SCHOOL_OPERATIONAL_STATUSES = ['ACTIVE', 'SUSPENDED', 'ARCHIVED'] as const;
export type HqSchoolOperationalStatus = (typeof HQ_SCHOOL_OPERATIONAL_STATUSES)[number];

/**
 * Selector-free HQ customer-account directory entry. `schoolId` is an opaque
 * React key only; it is not a selector, support-session token, or authority.
 */
export interface HqSchoolDirectoryEntry {
  schoolId: string;
  organizationDisplayName: string;
  schoolDisplayName: string;
  organizationOperationalStatus: HqSchoolOperationalStatus;
  schoolOperationalStatus: HqSchoolOperationalStatus;
  entitlementTier: HonTier | null;
  createdAt: string;
}

/** A closed list: no caller role, aggregate, selector, or raw source row is returned. */
export interface HqSchoolDirectory {
  schools: HqSchoolDirectoryEntry[];
}
