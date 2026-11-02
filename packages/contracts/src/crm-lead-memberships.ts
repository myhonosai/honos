// D-M1 CRM lead membership discovery. One lead at the verified current school -> the memberships its own CRM
// registration workflow created (adult DRAFT source, guardian/child per-child DRAFT sources), in any lifecycle state.
// Only ids, origin, lifecycle state/version and creation instant: detail stays behind the existing activation-context,
// activation-preview and date reads, which re-prove their own authority. ACTIVE here is lifecycle state only; it is not
// proof of current effective dates, benefits, payment or agreement.
import { MEMBERSHIP_LIFECYCLE_STATES, type MembershipLifecycleState } from './membership-date-revision.js';

export const CRM_LEAD_MEMBERSHIP_ORIGINS = ['ADULT_REGISTRATION', 'GUARDIAN_CHILD_REGISTRATION'] as const;
export type CrmLeadMembershipOrigin = typeof CRM_LEAD_MEMBERSHIP_ORIGINS[number];
export const CRM_LEAD_MEMBERSHIPS_LIMIT = 20;

export interface CrmLeadMembershipItem {
  membershipId: string;
  origin: CrmLeadMembershipOrigin;
  studentProfileId: string;
  state: MembershipLifecycleState;
  version: number;
  createdAt: string;
}
export interface CrmLeadMemberships { leadId: string; memberships: CrmLeadMembershipItem[]; truncated: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const drift = (): never => { throw new Error('INVALID_CRM_LEAD_MEMBERSHIPS_RESPONSE'); };
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : drift());
const exact = (r: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(r).sort();
  if (actual.length !== keys.length || [...keys].sort().some((k, i) => k !== actual[i])) drift();
};

/** Fails closed on any unexpected shape, a different lead, duplicates, wrong order or more than the limit. */
export function verifyCrmLeadMemberships(value: unknown, leadId: string): CrmLeadMemberships {
  const r = record(value);
  exact(r, ['leadId', 'memberships', 'truncated']);
  if (r.leadId !== leadId || !UUID.test(leadId) || typeof r.truncated !== 'boolean' || !Array.isArray(r.memberships)
    || r.memberships.length > CRM_LEAD_MEMBERSHIPS_LIMIT || (r.truncated && r.memberships.length !== CRM_LEAD_MEMBERSHIPS_LIMIT)) drift();
  const seen = new Set<string>();
  let previous = '';
  const memberships = (r.memberships as unknown[]).map((x) => {
    const m = record(x);
    exact(m, ['membershipId', 'origin', 'studentProfileId', 'state', 'version', 'createdAt']);
    if (typeof m.membershipId !== 'string' || !UUID.test(m.membershipId) || seen.has(m.membershipId)
      || !(CRM_LEAD_MEMBERSHIP_ORIGINS as readonly unknown[]).includes(m.origin)
      || typeof m.studentProfileId !== 'string' || !UUID.test(m.studentProfileId)
      || !(MEMBERSHIP_LIFECYCLE_STATES as readonly unknown[]).includes(m.state)
      || !Number.isSafeInteger(m.version) || (m.version as number) < 1
      || typeof m.createdAt !== 'string' || !INSTANT.test(m.createdAt) || Number.isNaN(Date.parse(m.createdAt)) || m.createdAt < previous) drift();
    seen.add(m.membershipId as string);
    previous = m.createdAt as string;
    return { membershipId: m.membershipId, origin: m.origin, studentProfileId: m.studentProfileId, state: m.state, version: m.version, createdAt: m.createdAt } as CrmLeadMembershipItem;
  });
  return { leadId, memberships, truncated: r.truncated as boolean };
}
