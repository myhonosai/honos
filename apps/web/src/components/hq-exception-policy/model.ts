import { SAAS_EXCEPTION_POLICY_CONFIRMATION, validateSaasExceptionPolicyDecisionInput, type SaasExceptionPolicyDecision,
  type SaasExceptionPolicyDecisionInput, type SaasExceptionPolicyView } from '@hon/contracts';
import { PolicyError } from './http';

export type PolicyState = Readonly<{ state: 'LOADING' }> | Readonly<{ state: 'DENIED' }> | Readonly<{ state: 'UNAVAILABLE' }>
  | Readonly<{ state: 'READY'; view: SaasExceptionPolicyView }>;
export type PolicyCommand = 'PROPOSED' | 'APPROVED' | 'WITHDRAWN' | 'REVOKED';
export type PolicyForm = 'DECIDE' | 'END' | null;
/** What the last decision from this tab is known to have done. */
export type PolicyOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | 'UNKNOWN' | 'CHANGED' | 'DENIED' | 'INVALID' | 'LOCAL_INVALID'; command: PolicyCommand }>
  | Readonly<{ kind: 'REFUSED'; command: PolicyCommand; code: string | null }>;

/** Only an unknown outcome keeps the request and key for Try again; every other answer is final. */
export function decisionOutcome(error: unknown, command: PolicyCommand): Readonly<{ outcome: PolicyOutcome; keep: boolean }> {
  if (!(error instanceof PolicyError) || error.kind === 'UNKNOWN') return { outcome: { kind: 'UNKNOWN', command }, keep: true };
  if (error.kind === 'SESSION') return { outcome: null, keep: false };
  if (error.kind === 'REFUSED') return { outcome: { kind: 'REFUSED', command, code: error.code }, keep: false };
  return { outcome: { kind: error.kind, command }, keep: false };
}

export type DecisionDraft = Readonly<{ maxDays: string; startDate: string; endDate: string; reason: string; confirmed: boolean }>;
export const EMPTY_DRAFT: DecisionDraft = { maxDays: '', startDate: '', endDate: '', reason: '', confirmed: false };

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localMidnight(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return localDay(d) === day ? d : null;
}

/** The decision the open choices allow, from the latest read. Ending is only possible while the latest decision still cites the current terms. */
export function allowed(view: SaasExceptionPolicyView): Readonly<{ decide: boolean; end: 'WITHDRAWN' | 'REVOKED' | null }> {
  if (!view.viewer.canDecide) return { decide: false, end: null };
  const c = view.current, current = c !== null && c.termsVersion === view.terms.policyVersion;
  return { decide: true, end: !current ? null : c.status === 'PROPOSED' ? 'WITHDRAWN' : c.status === 'APPROVED' ? 'REVOKED' : null };
}

/** A form prefilled from the latest proposal or approval, so approving a proposal starts from its terms. */
export function draftFrom(current: SaasExceptionPolicyDecision | null, now = new Date()): DecisionDraft {
  if (!current || (current.status !== 'PROPOSED' && current.status !== 'APPROVED')) return EMPTY_DRAFT;
  const from = new Date(current.validFrom), until = new Date(Date.parse(current.validUntil) - 1);
  return { maxDays: String(current.maxDays), startDate: from.getTime() > now.getTime() ? localDay(from) : '',
    endDate: until.getTime() > now.getTime() ? localDay(until) : '', reason: '', confirmed: false };
}

/**
 * The closed PROPOSED or APPROVED body from the form, or null when it cannot be sent. An empty or today's start means now;
 * a later start is local midnight. The policy runs through the end of the chosen last day (local midnight after it).
 */
export function decisionInput(view: SaasExceptionPolicyView, decision: 'PROPOSED' | 'APPROVED', draft: DecisionDraft, now = new Date()): SaasExceptionPolicyDecisionInput | null {
  if (!allowed(view).decide) return null;
  const days = Number(draft.maxDays);
  if (!/^\d{1,2}$/.test(draft.maxDays.trim()) || !Number.isInteger(days) || days < 1 || days > view.terms.exceptionMaxDays) return null;
  let from = now;
  if (draft.startDate) {
    const start = localMidnight(draft.startDate);
    if (!start) return null;
    if (start.getTime() > now.getTime()) from = start; else if (draft.startDate !== localDay(now)) return null;
  }
  const last = localMidnight(draft.endDate);
  if (!last) return null;
  const until = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  if (until.getTime() <= from.getTime() || until.getTime() <= now.getTime()) return null;
  if (decision === 'APPROVED' && !draft.confirmed) return null;
  try {
    return validateSaasExceptionPolicyDecisionInput({ expectedRevision: view.current?.revision ?? 0, decision, termsVersion: view.terms.policyVersion, maxDays: days,
      validFrom: from.toISOString(), validUntil: until.toISOString(), reason: draft.reason.trim(),
      ...(decision === 'APPROVED' ? { confirmation: SAAS_EXCEPTION_POLICY_CONFIRMATION } : {}) });
  } catch { return null; }
}
/** The closed WITHDRAWN or REVOKED body, or null. */
export function endInput(view: SaasExceptionPolicyView, reason: string): SaasExceptionPolicyDecisionInput | null {
  const end = allowed(view).end;
  if (!end || !view.current) return null;
  try { return validateSaasExceptionPolicyDecisionInput({ expectedRevision: view.current.revision, decision: end, reason: reason.trim() }); } catch { return null; }
}
