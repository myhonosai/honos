/**
 * HON OS 14-day free trial (D11-B, 0246): a REGISTERED school starts one HQ-published public trial. No charge.
 * AI during the trial is the promotional credit budget HQ set on the campaign (agent work only, never Creative Studio
 * media); a campaign without a budget means no trial AI. The credit is promotional and internal, never sold or carried over.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const TRIAL_CONFIRMATION = 'START_HON_OS_FREE_TRIAL' as const;
export const TRIAL_HUMAN_COMMAND = 'hon-os-free-trial' as const;
const DURATIONS = [7, 14, 30, 60, 90];
const instant = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 40 || !Number.isFinite(Date.parse(v))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return v;
};
const count = (v: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return v as number;
};
/** Credits per school, daily cap and per-request cap, as HQ set them (0187 bounds: per request <= daily <= total). */
const caps = (o: Record<string, unknown>) => {
  const credits = count(o.credits, 1, 1_000_000), dailyCap = count(o.dailyCap, 1, credits), perRequestCap = count(o.perRequestCap, 1, dailyCap);
  return { credits, dailyCap, perRequestCap };
};

export interface TrialAiCredits { credits: number; dailyCap: number; perRequestCap: number; expiresAt: string; used: number }
export interface TrialOfferAiCredits { credits: number; dailyCap: number; perRequestCap: number; expiryDays: number }

export interface TrialStartInput { schoolId: string; campaignId: string; confirmation: typeof TRIAL_CONFIRMATION }
export function validateTrialStartInput(v: unknown): TrialStartInput {
  const o = accountClosed(v, ['schoolId', 'campaignId', 'confirmation']);
  if (o.confirmation !== TRIAL_CONFIRMATION) throw new Error('ACCOUNT_INPUT_INVALID');
  return Object.freeze({ schoolId: accountUuid(o.schoolId), campaignId: accountUuid(o.campaignId), confirmation: TRIAL_CONFIRMATION });
}

export type TrialLifecycle = 'TRIAL_ACTIVE' | 'TRIAL_ENDED' | 'SUPERSEDED';
export interface HonOsTrial {
  enrollmentId: string; organizationId: string; schoolId: string; campaignId: string; durationDays: number; startsAt: string; endsAt: string;
  status: TrialLifecycle; automaticCharge: false; paymentMethodRequired: false; aiIncluded: boolean; aiCredits: TrialAiCredits | null;
  creativeCreditsIncluded: false;
}
export function validateHonOsTrial(v: unknown): HonOsTrial {
  const o = accountClosed(v, ['enrollmentId', 'organizationId', 'schoolId', 'campaignId', 'durationDays', 'startsAt', 'endsAt', 'status',
    'automaticCharge', 'paymentMethodRequired', 'aiIncluded', 'aiCredits', 'creativeCreditsIncluded']);
  if (!DURATIONS.includes(o.durationDays as number) || !['TRIAL_ACTIVE', 'TRIAL_ENDED', 'SUPERSEDED'].includes(String(o.status))
    || o.automaticCharge !== false || o.paymentMethodRequired !== false || typeof o.aiIncluded !== 'boolean'
    || o.aiIncluded !== (o.aiCredits !== null) || o.creativeCreditsIncluded !== false) throw new Error('ACCOUNT_RESPONSE_INVALID');
  const startsAt = instant(o.startsAt), endsAt = instant(o.endsAt);
  if (Date.parse(endsAt) - Date.parse(startsAt) !== (o.durationDays as number) * 86_400_000) throw new Error('ACCOUNT_RESPONSE_INVALID');
  let aiCredits: TrialAiCredits | null = null;
  if (o.aiCredits !== null) {
    const a = accountClosed(o.aiCredits, ['credits', 'dailyCap', 'perRequestCap', 'expiresAt', 'used']);
    const expiresAt = instant(a.expiresAt);
    // Credits expire after at least one day and never after the trial ends.
    if (Date.parse(expiresAt) <= Date.parse(startsAt) || Date.parse(expiresAt) > Date.parse(endsAt)) throw new Error('ACCOUNT_RESPONSE_INVALID');
    aiCredits = Object.freeze({ ...caps(a), expiresAt, used: count(a.used, 0, Number.MAX_SAFE_INTEGER) });
  }
  return Object.freeze({ enrollmentId: accountUuid(o.enrollmentId), organizationId: accountUuid(o.organizationId), schoolId: accountUuid(o.schoolId),
    campaignId: accountUuid(o.campaignId), durationDays: o.durationDays as number, startsAt, endsAt, status: o.status as TrialLifecycle,
    automaticCharge: false, paymentMethodRequired: false, aiIncluded: aiCredits !== null, aiCredits, creativeCreditsIncluded: false });
}

export interface TrialOffer {
  campaignId: string; name: string; durationDays: number; automaticCharge: false; paymentMethodRequired: false;
  aiIncluded: boolean; aiCredits: TrialOfferAiCredits | null;
}
export interface TrialStatus { trialStatus: 'CLOSED' | 'TEST_MODE'; schoolId: string | null; available: TrialOffer | null; trial: HonOsTrial | null }
export function validateTrialStatus(v: unknown): TrialStatus {
  const o = accountClosed(v, ['trialStatus', 'schoolId', 'available', 'trial']);
  if (!['CLOSED', 'TEST_MODE'].includes(String(o.trialStatus))) throw new Error('ACCOUNT_RESPONSE_INVALID');
  const schoolId = o.schoolId === null ? null : accountUuid(o.schoolId);
  let available: TrialOffer | null = null;
  if (o.available !== null) {
    const a = accountClosed(o.available, ['campaignId', 'name', 'durationDays', 'automaticCharge', 'paymentMethodRequired', 'aiIncluded', 'aiCredits']);
    if (typeof a.name !== 'string' || a.name.length < 1 || a.name.length > 120 || !DURATIONS.includes(a.durationDays as number)
      || a.automaticCharge !== false || a.paymentMethodRequired !== false || typeof a.aiIncluded !== 'boolean'
      || a.aiIncluded !== (a.aiCredits !== null)) throw new Error('ACCOUNT_RESPONSE_INVALID');
    let aiCredits: TrialOfferAiCredits | null = null;
    if (a.aiCredits !== null) {
      const b = accountClosed(a.aiCredits, ['credits', 'dailyCap', 'perRequestCap', 'expiryDays']);
      aiCredits = Object.freeze({ ...caps(b), expiryDays: count(b.expiryDays, 1, a.durationDays as number) });
    }
    available = Object.freeze({ campaignId: accountUuid(a.campaignId), name: a.name, durationDays: a.durationDays as number, automaticCharge: false,
      paymentMethodRequired: false, aiIncluded: aiCredits !== null, aiCredits });
  }
  const trial = o.trial === null ? null : validateHonOsTrial(o.trial);
  // An offer is shown only to a registered school with no trial, and only while the trial program is open.
  if ((available || trial) && schoolId === null) throw new Error('ACCOUNT_RESPONSE_INVALID');
  if (available && (trial || o.trialStatus !== 'TEST_MODE')) throw new Error('ACCOUNT_RESPONSE_INVALID');
  if (trial && trial.schoolId !== schoolId) throw new Error('ACCOUNT_RESPONSE_INVALID');
  return Object.freeze({ trialStatus: o.trialStatus as TrialStatus['trialStatus'], schoolId, available, trial });
}
