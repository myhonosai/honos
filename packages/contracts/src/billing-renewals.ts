import type { CommandContext } from './index.js';
export const BILLING_RENEWAL_PERMISSIONS = ['billing.membership.read', 'billing.renewal.manage'] as const;
export const RENEWAL_STATUSES = ['OPEN', 'REVIEWED', 'DEFERRED', 'CLOSED'] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];
export type RenewalOperation = 'CREATE' | 'REVISE';
export interface RenewalContext extends CommandContext { externalSubject: string }
export interface RenewalInput {
  expectedVersion: number;
  membershipId: string;
  reviewFrom: string;
  reviewTo: string;
  status: RenewalStatus;
  note: string;
  reason: string;
  reminderNeeded: boolean | null;
}
/** Observations only; no invoice, payer, contact, method or provider fields. */
export interface RenewalMembershipFacts {
  membershipId: string;
  membershipVersion: number;
  state: 'DRAFT' | 'ACTIVE' | 'FROZEN' | 'CANCELLATION_PENDING' | 'CANCELLED' | 'EXPIRED';
  termStartedAt: string | null;
  termEndsAt: string | null;
  scheduleCount: number;
  schedulesTruncated: boolean;
  schedules: Array<{
    scheduleId: string;
    frequency: 'WEEKLY' | 'MONTHLY' | 'ANNUAL' | 'CUSTOM';
    status: 'ACTIVE' | 'PAUSED' | 'CANCELLED';
    amountMinor: number;
    currency: string;
    nextChargeAt: string | null;
    autoRenew: boolean;
  }>;
}
export interface RenewalRecord extends Omit<RenewalInput, 'expectedVersion'> {
  renewalId: string; schoolId: string; version: number; recordedAt: string;
  membershipFacts: RenewalMembershipFacts; humanOnly: true; executionAllowed: false;
}
export interface RenewalQueueItem {
  renewalId: string; membershipId: string; version: number; status: RenewalStatus;
  reviewFrom: string; reviewTo: string; reminderNeeded: boolean | null;
}
export interface RenewalQueue {
  schoolId: string; principalId: string; humanOnly: true; executionAllowed: false;
  status: RenewalStatus | 'ALL'; items: RenewalQueueItem[]; nextAfter: string | null;
}
export interface RenewalDetail { record: RenewalRecord; currentMembershipFacts: RenewalMembershipFacts }
/** Summary history deliberately excludes private note/reason and membership snapshots. */
export interface RenewalHistory {
  schoolId: string; renewalId: string; humanOnly: true; executionAllowed: false;
  items: Array<RenewalQueueItem & { recordedAt: string }>; nextBefore: number | null;
}
export const BILLING_RENEWAL_HELP = 'Human renewal review records only, equally available in Essential, Core and Complete. No collection, notices, emails or texts, payments or refunds, automatic renewal, membership changes or cancellation, AI/provider or Action Engine execution. Windows and reminder-needed flags are manual planning facts; they do not schedule messages or promise a customer renewal. Membership terms and observed schedule auto-renew flags are not renewal eligibility or payment evidence. Parent, HQ and public access are excluded.';
export const RENEWAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('Use the closed human renewal review contract, current version, explicit bounded notes/reason and canonical UTC window of 1 minute to 366 days in 2000–2099.'); }
export function validateRenewalTime(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) invalid();
}
export function validateRenewal(op: RenewalOperation, v: unknown): asserts v is RenewalInput {
  const keys = ['expectedVersion', 'membershipId', 'reviewFrom', 'reviewTo', 'status', 'note', 'reason', 'reminderNeeded'];
  if (!['CREATE', 'REVISE'].includes(op) || !v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) invalid();
  const p = v as Record<string, unknown>;
  if (!Number.isSafeInteger(p.expectedVersion) || Number(p.expectedVersion) < (op === 'CREATE' ? 0 : 1) || Number(p.expectedVersion) > 999999998 || (op === 'CREATE' && p.expectedVersion !== 0)) invalid();
  if (typeof p.membershipId !== 'string' || !RENEWAL_UUID.test(p.membershipId)) invalid();
  validateRenewalTime(p.reviewFrom); validateRenewalTime(p.reviewTo);
  const duration = Date.parse(p.reviewTo) - Date.parse(p.reviewFrom);
  if (duration < 60_000 || duration > 366 * 86_400_000 || !RENEWAL_STATUSES.includes(p.status as RenewalStatus) || (op === 'CREATE' && p.status !== 'OPEN')) invalid();
  for (const k of ['note', 'reason']) {
    const s = p[k];
    if (typeof s !== 'string' || !s || [...s].length > (k === 'note' ? 2000 : 500) || s.trim() !== s || /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(k === 'note' ? s.replaceAll('\n', '') : s)) invalid();
  }
  if (p.reminderNeeded !== null && typeof p.reminderNeeded !== 'boolean') invalid();
}
