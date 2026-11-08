// Exception-only decisions. These never approve full paid-access terms or activate programs.
import { championsDrift as drift, championsInvalid as invalid, championsRecord as record,
  championsExactKeys as keys, championsIsInt as int, championsIsTimestamp as timestamp, championsIsUuid as uuid } from './champions-club.js';

export const SAAS_EXCEPTION_POLICY_CONFIRMATION = 'APPROVE_ACCESS_EXCEPTION_POLICY_ONLY' as const;
export type SaasExceptionPolicyStatus = 'PROPOSED' | 'APPROVED' | 'WITHDRAWN' | 'REVOKED';
export type SaasExceptionPolicyDecisionInput = {
  expectedRevision: number; decision: 'PROPOSED' | 'APPROVED'; termsVersion: number; maxDays: number;
  validFrom: string; validUntil: string; reason: string; confirmation?: typeof SAAS_EXCEPTION_POLICY_CONFIRMATION;
} | { expectedRevision: number; decision: 'WITHDRAWN' | 'REVOKED'; reason: string };
export interface SaasExceptionPolicyDecision {
  approvalId: string; revision: number; status: SaasExceptionPolicyStatus; termsVersion: number; maxDays: number;
  validFrom: string; validUntil: string; reason: string; actorPrincipalId: string; recordedAt: string;
}
export interface SaasExceptionPolicyReceipt { policy: SaasExceptionPolicyDecision; replayed: boolean }
export interface SaasExceptionPolicyView {
  scope: 'ACCESS_EXCEPTIONS_ONLY'; current: SaasExceptionPolicyDecision | null;
  effectiveStatus: 'ABSENT' | 'PROPOSED' | 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'WITHDRAWN' | 'REVOKED' | 'SUPERSEDED';
  history: SaasExceptionPolicyDecision[]; historyLimit: 100; asOf: string; termsStatus: 'PROPOSED';
  /** The current access terms (0222): a new PROPOSED or APPROVED decision must cite this version and stay within its maximum. */
  terms: { policyVersion: number; exceptionMaxDays: number; exceptionAuthority: 'HQ_OWNER' };
  /** Whether this reader is the HQ owner (0222). Advisory only: the decision command checks the owner again. */
  viewer: { canDecide: boolean };
  paidAccessProgram: 'INACTIVE' | 'ACTIVE'; aiCreditProgram: 'INACTIVE' | 'ACTIVE';
}
const reason = (v: unknown) => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;
const statuses = ['PROPOSED', 'APPROVED', 'WITHDRAWN', 'REVOKED'];
export function validateSaasExceptionPolicyDecisionInput(value: unknown): SaasExceptionPolicyDecisionInput {
  const r = record(value, invalid), populated = r.decision === 'PROPOSED' || r.decision === 'APPROVED';
  keys(r, ['expectedRevision','decision','reason', ...(populated ? ['termsVersion','maxDays','validFrom','validUntil'] : []),
    ...(r.decision === 'APPROVED' ? ['confirmation'] : [])], invalid);
  if (!statuses.includes(r.decision as string) || !int(r.expectedRevision, 0, 999_999_998) || !reason(r.reason)
    || (populated && (!int(r.termsVersion, 1, 999_999) || !int(r.maxDays, 1, 90) || !timestamp(r.validFrom) || !timestamp(r.validUntil)
      || Date.parse(r.validUntil as string) <= Date.parse(r.validFrom as string)))
    || (r.decision === 'APPROVED' && r.confirmation !== SAAS_EXCEPTION_POLICY_CONFIRMATION)) invalid();
  return r as unknown as SaasExceptionPolicyDecisionInput;
}
export function validateSaasExceptionPolicyDecision(value: unknown): SaasExceptionPolicyDecision {
  const r = record(value, drift);
  keys(r, ['approvalId','revision','status','termsVersion','maxDays','validFrom','validUntil','reason','actorPrincipalId','recordedAt'], drift);
  if (!uuid(r.approvalId) || !int(r.revision, 1, 999_999_999) || !statuses.includes(r.status as string) || !int(r.termsVersion, 1, 999_999)
    || !int(r.maxDays, 1, 90) || !timestamp(r.validFrom) || !timestamp(r.validUntil) || Date.parse(r.validUntil as string) <= Date.parse(r.validFrom as string)
    || !reason(r.reason) || !uuid(r.actorPrincipalId) || !timestamp(r.recordedAt)) drift();
  return r as unknown as SaasExceptionPolicyDecision;
}
export function validateSaasExceptionPolicyReceipt(value: unknown): SaasExceptionPolicyReceipt {
  const r = record(value, drift); keys(r, ['policy','replayed'], drift); validateSaasExceptionPolicyDecision(r.policy);
  if (typeof r.replayed !== 'boolean') drift(); return r as unknown as SaasExceptionPolicyReceipt;
}
export function validateSaasExceptionPolicyView(value: unknown): SaasExceptionPolicyView {
  const r = record(value, drift);
  keys(r, ['scope','current','effectiveStatus','history','historyLimit','asOf','termsStatus','terms','viewer','paidAccessProgram','aiCreditProgram'], drift);
  const terms = record(r.terms, drift), viewer = record(r.viewer, drift);
  keys(terms, ['policyVersion','exceptionMaxDays','exceptionAuthority'], drift); keys(viewer, ['canDecide'], drift);
  if (!int(terms.policyVersion, 1, 999_999) || !int(terms.exceptionMaxDays, 1, 90) || terms.exceptionAuthority !== 'HQ_OWNER'
    || typeof viewer.canDecide !== 'boolean') drift();
  if (r.scope !== 'ACCESS_EXCEPTIONS_ONLY' || r.termsStatus !== 'PROPOSED' || r.historyLimit !== 100 || !timestamp(r.asOf)
    || !['INACTIVE','ACTIVE'].includes(r.paidAccessProgram as string) || !['INACTIVE','ACTIVE'].includes(r.aiCreditProgram as string)
    || !Array.isArray(r.history) || r.history.length > 100) drift();
  const rows = (r.history as unknown[]).map(validateSaasExceptionPolicyDecision);
  if (rows.some((p, i) => i > 0 && p.revision >= rows[i - 1]!.revision)) drift();
  if (r.current === null) { if (rows.length || r.effectiveStatus !== 'ABSENT') drift(); }
  else {
    const p = validateSaasExceptionPolicyDecision(r.current);
    if (!rows.length || Object.keys(p).some(k => p[k as keyof SaasExceptionPolicyDecision] !== rows[0]![k as keyof SaasExceptionPolicyDecision])) drift();
    if (rows.some(x => x.termsVersion > (terms.policyVersion as number))) drift();
    const expected = p.status !== 'APPROVED' ? p.status : p.termsVersion !== terms.policyVersion ? 'SUPERSEDED'
      : Date.parse(p.validFrom) > Date.parse(r.asOf as string) ? 'SCHEDULED'
      : Date.parse(p.validUntil) <= Date.parse(r.asOf as string) ? 'EXPIRED' : 'ACTIVE';
    if (r.effectiveStatus !== expected) drift();
  }
  return r as unknown as SaasExceptionPolicyView;
}
