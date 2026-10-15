import type { ActionAuthorityMode, CommandContext } from './index.js';
export const ACTION_REVIEW_STATUSES = ['RECEIVED','VALIDATING','AWAITING_APPROVAL','APPROVED','DENIED','EXPIRED','EXECUTING','SUCCEEDED','FAILED','UNKNOWN','RECONCILING'] as const;
export type ActionReviewStatus = typeof ACTION_REVIEW_STATUSES[number];
export interface ActionReviewContext extends CommandContext { externalSubject: string }
export interface ActionReviewBinding {
  actionRequestId: string;
  actionCode: string;
  requestedByPrincipalId: string;
  payloadHash: string;
  policyVersion: number;
  approvalExpiresAt: string;
  effectiveAuthorityMode: ActionAuthorityMode;
}
export interface HumanActionDecision { decision: 'APPROVED' | 'DENIED'; binding: ActionReviewBinding; reason?: string }
export interface ActionReviewItem {
  id: string; actionCode: string; status: ActionReviewStatus; requestedByPrincipalId: string;
  effectiveAuthorityMode: ActionAuthorityMode; policyVersion: number; approvalExpiresAt: string | null; createdAt: string;
}
export interface HumanActionReview extends ActionReviewItem {
  organizationId: string; schoolId: string; payloadHash: string; requiredPermission: string;
  normalizedPayload: Record<string, unknown> | null; payloadVisibility: 'EXACT' | 'WITHHELD_UNSAFE';
  reviewerPrincipalId: string; reviewerPermission: 'action.approve'; delegatedByPrincipalId: string | null;
  currentPolicyVersion: number; currentAuthorityMode: ActionAuthorityMode | null;
  reviewBlock: string | null; decisions: { reviewerPrincipalId: string; decision: 'APPROVED' | 'DENIED' | 'EXPIRED'; payloadHash: string; policyVersion: number; decidedAt: string }[];
  decisionsTruncated: boolean; executionTriggered: false;
}
export interface ActionReviewQueue {
  organizationId: string; schoolId: string; reviewerPrincipalId: string; reviewerPermission: 'action.approve';
  status: ActionReviewStatus | 'ALL'; items: ActionReviewItem[]; nextAfter: string | null; executionTriggered: false;
}
export interface HumanActionReceipt {
  actionRequestId: string; status: 'APPROVED' | 'DENIED'; actionCode: string; reviewedAt: string;
  payloadHash: string; policyVersion: number; executionTriggered: false;
}
export const ACTION_REVIEW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function actionReviewFingerprint(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
}
/** Never sanitize approved intent. Withhold the entire payload if credential-like data is present. */
export function safeActionReviewPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let count = 0;
  const inspect = (v: unknown, depth: number): boolean => {
    if (++count > 4000 || depth > 12) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
    if (typeof v === 'string') return v.length <= 16000 && !/-----BEGIN .*PRIVATE KEY|\bBearer\s+\S+|\bsk[-_](?:live|test|proj)[-_]|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./i.test(v);
    if (Array.isArray(v)) return v.length <= 500 && v.every(x => inspect(x, depth + 1));
    if (v && typeof v === 'object') return Object.entries(v).every(([k,x]) => k.length <= 100 && !/(?:secret|password|credential|token|authorization|cookie|privatekey|apikey|cardnumber|card_number|cvv|cvc|paymentmethod|payment_method)/i.test(k.replace(/[-\s]/g,'')) && !['__proto__','prototype','constructor'].includes(k) && inspect(x, depth + 1));
    return false;
  };
  return inspect(value, 0) && actionReviewFingerprint(value).length <= 64000;
}
export function validateHumanActionDecision(value: unknown): asserts value is HumanActionDecision {
  const closed = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v,k)) && Object.keys(v).every(k => [...required,...optional].includes(k));
  const invalid = () => { throw new Error('INVALID_ACTION_REVIEW_BINDING'); };
  if (!closed(value,['decision','binding'],['reason'])) return invalid();
  if (!['APPROVED','DENIED'].includes(String(value.decision)) || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.reason)))) return invalid();
  const b = value.binding;
  if (!closed(b,['actionRequestId','actionCode','requestedByPrincipalId','payloadHash','policyVersion','approvalExpiresAt','effectiveAuthorityMode'])) return invalid();
  if (typeof b.actionRequestId !== 'string' || !ACTION_REVIEW_UUID.test(b.actionRequestId) || typeof b.requestedByPrincipalId !== 'string' || !ACTION_REVIEW_UUID.test(b.requestedByPrincipalId) || typeof b.actionCode !== 'string' || !/^[a-z][a-z0-9_.]{1,99}$/.test(b.actionCode) || typeof b.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.payloadHash) || !Number.isSafeInteger(b.policyVersion) || Number(b.policyVersion) < 0 || Number(b.policyVersion) > 2147483647 || b.effectiveAuthorityMode !== 'CONFIRM' || typeof b.approvalExpiresAt !== 'string' || !Number.isFinite(Date.parse(b.approvalExpiresAt)) || new Date(b.approvalExpiresAt).toISOString() !== b.approvalExpiresAt) return invalid();
}
