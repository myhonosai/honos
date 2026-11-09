/**
 * Membership pause, resume and manual refund records (0224). Owner policy 2026-11-08: staff-only pauses on the
 * member's request, per-school pause limits and a recorded hold fee, immediate cancellation (also from a pause), and no
 * automatic refunds (staff record a refund made outside HON). Nothing here moves money.
 */
import { MEMBERSHIP_LIFECYCLE_STATES, type MembershipLifecycleState } from './membership-date-revision.js';

export const MEMBERSHIP_REFUND_METHODS = ['CASH', 'CHECK', 'CARD_TERMINAL', 'BANK_TRANSFER', 'OTHER'] as const;
export type MembershipRefundMethod = (typeof MEMBERSHIP_REFUND_METHODS)[number];
export const MEMBERSHIP_PAUSE_END_KINDS = ['RESUMED', 'CANCELLED'] as const;
export type MembershipPauseEndKind = (typeof MEMBERSHIP_PAUSE_END_KINDS)[number];

export interface MembershipHoldFee { amountMinor: number; currency: string }
export interface SchoolMembershipPausePolicy {
  version: number;
  pausesAllowed: boolean;
  maxPauseDays: number | null;
  maxPausedDaysPerYear: number | null;
  holdFee: MembershipHoldFee | null;
  createdAt: string;
}
export interface SchoolMembershipPausePolicyRead { policy: SchoolMembershipPausePolicy | null; localToday: string }
export interface SetSchoolMembershipPausePolicyInput {
  expectedVersion: number;
  pausesAllowed: boolean;
  maxPauseDays: number | null;
  maxPausedDaysPerYear: number | null;
  holdFee: MembershipHoldFee | null;
}
export interface PauseMembershipInput { expectedVersion: number; resumeOn: string; pauseReason: string }
export interface ResumeMembershipInput { expectedVersion: number; resumeReason?: string }
export interface RecordMembershipRefundInput { amountMinor: number; currency: string; refundedOn: string; method: MembershipRefundMethod; reason: string }

export interface MembershipPause {
  pauseId: string;
  membershipId: string;
  policyVersion: number;
  startsOn: string;
  plannedResumeOn: string;
  pauseReason: string;
  holdFee: MembershipHoldFee | null;
  pausedAt: string;
  endedKind: MembershipPauseEndKind | null;
  endedOn: string | null;
  endReason: string | null;
  endedAt: string | null;
}
export interface MembershipPauseReceipt extends MembershipPause { membershipState: 'FROZEN' | 'ACTIVE'; membershipVersion: number }
export interface MembershipRefundRecord {
  refundId: string;
  membershipId: string;
  amountMinor: number;
  currency: string;
  refundedOn: string;
  method: MembershipRefundMethod;
  reason: string;
  recordedAt: string;
}
export interface MembershipPausesAndRefunds {
  membershipId: string;
  state: MembershipLifecycleState;
  version: number;
  localToday: string;
  pauses: MembershipPause[];
  refunds: MembershipRefundRecord[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid membership pause data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const present = Object.keys(row);
  if (present.some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1000 || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function holdFee(value: unknown): MembershipHoldFee {
  const row = record(value, ['amountMinor', 'currency']);
  if (typeof row.currency !== 'string' || !CURRENCY.test(row.currency)) invalid();
  return { amountMinor: count(row.amountMinor, 0, 100_000_000), currency: row.currency };
}

// Input validators (the database validates the same rules again).
export function validateSetSchoolMembershipPausePolicyInput(value: unknown): SetSchoolMembershipPausePolicyInput {
  const row = record(value, ['expectedVersion', 'pausesAllowed', 'maxPauseDays', 'maxPausedDaysPerYear', 'holdFee']);
  if (typeof row.pausesAllowed !== 'boolean') invalid();
  const input: SetSchoolMembershipPausePolicyInput = {
    expectedVersion: count(row.expectedVersion, 0),
    pausesAllowed: row.pausesAllowed,
    maxPauseDays: nullable(row.maxPauseDays, v => count(v, 1, 365)),
    maxPausedDaysPerYear: nullable(row.maxPausedDaysPerYear, v => count(v, 1, 365)),
    holdFee: nullable(row.holdFee, holdFee),
  };
  if (input.pausesAllowed
    ? input.maxPauseDays === null || input.maxPausedDaysPerYear === null || input.maxPauseDays > input.maxPausedDaysPerYear
    : input.maxPauseDays !== null || input.maxPausedDaysPerYear !== null || input.holdFee !== null) invalid();
  return input;
}
export function validatePauseMembershipInput(value: unknown): PauseMembershipInput {
  const row = record(value, ['expectedVersion', 'resumeOn', 'pauseReason']);
  return { expectedVersion: count(row.expectedVersion, 1), resumeOn: date(row.resumeOn), pauseReason: text(row.pauseReason) };
}
export function validateResumeMembershipInput(value: unknown): ResumeMembershipInput {
  const row = record(value, ['expectedVersion'], ['resumeReason']);
  const input: ResumeMembershipInput = { expectedVersion: count(row.expectedVersion, 1) };
  if ('resumeReason' in row) input.resumeReason = text(row.resumeReason);
  return input;
}
export function validateRecordMembershipRefundInput(value: unknown): RecordMembershipRefundInput {
  const row = record(value, ['amountMinor', 'currency', 'refundedOn', 'method', 'reason']);
  if (typeof row.currency !== 'string' || !CURRENCY.test(row.currency)) invalid();
  return { amountMinor: count(row.amountMinor, 1, 100_000_000), currency: row.currency, refundedOn: date(row.refundedOn),
    method: oneOf(row.method, MEMBERSHIP_REFUND_METHODS), reason: text(row.reason) };
}

// Output verifiers: every database response is checked strictly before it reaches a client.
export function verifySchoolMembershipPausePolicy(value: unknown): SchoolMembershipPausePolicy {
  const row = record(value, ['version', 'pausesAllowed', 'maxPauseDays', 'maxPausedDaysPerYear', 'holdFee', 'createdAt']);
  if (typeof row.pausesAllowed !== 'boolean') invalid();
  const policy: SchoolMembershipPausePolicy = {
    version: count(row.version, 1), pausesAllowed: row.pausesAllowed,
    maxPauseDays: nullable(row.maxPauseDays, v => count(v, 1, 365)), maxPausedDaysPerYear: nullable(row.maxPausedDaysPerYear, v => count(v, 1, 365)),
    holdFee: nullable(row.holdFee, holdFee), createdAt: instant(row.createdAt),
  };
  if (policy.pausesAllowed !== (policy.maxPauseDays !== null) || policy.pausesAllowed !== (policy.maxPausedDaysPerYear !== null)
    || (!policy.pausesAllowed && policy.holdFee !== null)) invalid();
  return policy;
}
export function verifySchoolMembershipPausePolicyRead(value: unknown): SchoolMembershipPausePolicyRead {
  const row = record(value, ['policy', 'localToday']);
  return { policy: nullable(row.policy, verifySchoolMembershipPausePolicy), localToday: date(row.localToday) };
}
export function verifyMembershipPause(value: unknown, membershipId?: string, extra: readonly string[] = []): MembershipPause {
  const row = record(value, ['pauseId', 'membershipId', 'policyVersion', 'startsOn', 'plannedResumeOn', 'pauseReason', 'holdFee', 'pausedAt',
    'endedKind', 'endedOn', 'endReason', 'endedAt', ...extra]);
  const pause: MembershipPause = {
    pauseId: uuid(row.pauseId), membershipId: uuid(row.membershipId), policyVersion: count(row.policyVersion, 1),
    startsOn: date(row.startsOn), plannedResumeOn: date(row.plannedResumeOn), pauseReason: text(row.pauseReason),
    holdFee: nullable(row.holdFee, holdFee), pausedAt: instant(row.pausedAt),
    endedKind: nullable(row.endedKind, v => oneOf(v, MEMBERSHIP_PAUSE_END_KINDS)), endedOn: nullable(row.endedOn, date),
    endReason: nullable(row.endReason, text), endedAt: nullable(row.endedAt, instant),
  };
  if ((membershipId !== undefined && pause.membershipId !== membershipId.toLowerCase()) || pause.plannedResumeOn <= pause.startsOn
    || (pause.endedKind === null) !== (pause.endedOn === null) || (pause.endedKind === null) !== (pause.endedAt === null)
    || (pause.endedKind === null && pause.endReason !== null) || (pause.endedOn !== null && pause.endedOn < pause.startsOn)) invalid();
  return pause;
}
export function verifyMembershipPauseReceipt(value: unknown, membershipId: string, expected: 'FROZEN' | 'ACTIVE'): MembershipPauseReceipt {
  const pause = verifyMembershipPause(value, membershipId, ['membershipState', 'membershipVersion']);
  const row = value as Record<string, unknown>;
  if (row.membershipState !== expected || (expected === 'FROZEN') !== (pause.endedKind === null)
    || (expected === 'ACTIVE' && pause.endedKind !== 'RESUMED')) invalid();
  return { ...pause, membershipState: expected, membershipVersion: count(row.membershipVersion, 2) };
}
export function verifyMembershipRefundRecord(value: unknown, membershipId?: string): MembershipRefundRecord {
  const row = record(value, ['refundId', 'membershipId', 'amountMinor', 'currency', 'refundedOn', 'method', 'reason', 'recordedAt']);
  if (typeof row.currency !== 'string' || !CURRENCY.test(row.currency)) invalid();
  const refund: MembershipRefundRecord = {
    refundId: uuid(row.refundId), membershipId: uuid(row.membershipId), amountMinor: count(row.amountMinor, 1, 100_000_000), currency: row.currency,
    refundedOn: date(row.refundedOn), method: oneOf(row.method, MEMBERSHIP_REFUND_METHODS), reason: text(row.reason), recordedAt: instant(row.recordedAt),
  };
  if (membershipId !== undefined && refund.membershipId !== membershipId.toLowerCase()) invalid();
  return refund;
}
export function verifyMembershipPausesAndRefunds(value: unknown, membershipId: string): MembershipPausesAndRefunds {
  const row = record(value, ['membershipId', 'state', 'version', 'localToday', 'pauses', 'refunds']);
  if (!Array.isArray(row.pauses) || row.pauses.length > 100 || !Array.isArray(row.refunds) || row.refunds.length > 100) invalid();
  const result: MembershipPausesAndRefunds = {
    membershipId: uuid(row.membershipId), state: oneOf(row.state, MEMBERSHIP_LIFECYCLE_STATES), version: count(row.version, 1),
    localToday: date(row.localToday),
    pauses: row.pauses.map(entry => verifyMembershipPause(entry, membershipId)),
    refunds: row.refunds.map(entry => verifyMembershipRefundRecord(entry, membershipId)),
  };
  if (result.membershipId !== membershipId.toLowerCase()) invalid();
  const open = result.pauses.filter(pause => pause.endedKind === null).length;
  // A FROZEN membership from before 0224 has no pause row; an open pause always means FROZEN.
  if (open > 1 || (open === 1 && result.state !== 'FROZEN') || new Set(result.pauses.map(p => p.pauseId)).size !== result.pauses.length
    || new Set(result.refunds.map(r => r.refundId)).size !== result.refunds.length) invalid();
  return result;
}
