import { validateSaasAccessExceptionGrantInput, validateSaasAccessExceptionRevokeInput, type SaasAccessExceptionGrantInput,
  type SaasAccessOverview, type SaasAccessOverviewOrganization } from '@hon/contracts';
import { AccessOverviewError } from './http';

export type OverviewState =
  | Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; view: SaasAccessOverview; organizations: readonly SaasAccessOverviewOrganization[]; loadingMore: boolean; moreFailed: boolean }>;
export type AccessCommand = 'grant' | 'revoke';
/** What the last command from this tab is known to have done. */
export type AccessOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'UNKNOWN' | 'CHANGED' | 'DENIED' | 'INVALID' | 'LOCAL_INVALID'; command: AccessCommand; organization: string }>
  | Readonly<{ kind: 'REFUSED'; command: AccessCommand; organization: string; code: string | null }>;

/** Only an unknown outcome keeps the request and key for Try again; every other answer is final. */
export function commandOutcome(error: unknown, command: AccessCommand, organization: string): Readonly<{ outcome: AccessOutcome; keep: boolean }> {
  if (!(error instanceof AccessOverviewError) || error.kind === 'UNKNOWN') return { outcome: { kind: 'UNKNOWN', command, organization }, keep: true };
  if (error.kind === 'SESSION') return { outcome: null, keep: false };
  if (error.kind === 'REFUSED') return { outcome: { kind: 'REFUSED', command, organization, code: error.code }, keep: false };
  return { outcome: { kind: error.kind, command, organization }, keep: false };
}

export type GrantDraft = Readonly<{ schoolId: string; purpose: string; scopeTier: string; startDate: string; days: string; reason: string }>;
const DAY = 86_400_000;
/**
 * The closed grant body from the form, or null when it cannot be sent. An empty or today's start date means now; a
 * later date starts at local midnight. The window is the chosen number of days, never more than the approved policy.
 */
export function grantInput(org: SaasAccessOverviewOrganization, policyMaxDays: number | null, draft: GrantDraft, now = new Date()): SaasAccessExceptionGrantInput | null {
  if (policyMaxDays === null || org.exceptionGrant.expectedEntitlementVersion === null) return null;
  if (!org.schools.some(s => s.schoolId === draft.schoolId && s.schoolStatus === 'ACTIVE')) return null;
  const days = Number(draft.days);
  if (!Number.isInteger(days) || days < 1 || days > policyMaxDays) return null;
  let start = now;
  if (draft.startDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(draft.startDate);
    if (!m) return null;
    const local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (local.getTime() > now.getTime()) start = local;
    else if (draft.startDate !== localDay(now)) return null;
  }
  if (start.getTime() > now.getTime() + 30 * DAY) return null;
  const startsAt = new Date(Math.floor(start.getTime())).toISOString(), expiresAt = new Date(start.getTime() + days * DAY).toISOString();
  try {
    return validateSaasAccessExceptionGrantInput({ schoolId: draft.schoolId, purpose: draft.purpose, reason: draft.reason.trim(), scopeTier: draft.scopeTier,
      startsAt, expiresAt, expectedEntitlementVersion: org.exceptionGrant.expectedEntitlementVersion });
  } catch { return null; }
}
export function revokeReason(reason: string): string | null {
  try { return validateSaasAccessExceptionRevokeInput({ reason: reason.trim() }).reason; } catch { return null; }
}
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
