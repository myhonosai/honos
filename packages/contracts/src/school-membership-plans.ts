import type { CommandContext } from './index.js';
import { CRM_ADULT_MEMBERSHIP_DRAFT_UUID, verifyCrmAdultMembershipDraftReceipt, type CrmAdultMembershipDraftReceipt } from './crm-adult-membership-draft.js';

/**
 * School-to-family membership plans: what one school sells to its own students. Unrelated to HON's own
 * Core/Complete SaaS catalog. A plan is published terms only; nothing here schedules, invoices or charges.
 */
export const MEMBERSHIP_PLAN_CHANGE_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_MEMBERSHIP_PLAN_CHANGE' as const;
export const CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN' as const;
export const MEMBERSHIP_PLAN_CATALOG_READ_COMMAND = 'membership-plan-catalog-read' as const;
export const MEMBERSHIP_PLAN_CREATE_COMMAND = 'membership-plan-create' as const;
export const MEMBERSHIP_PLAN_REVISE_COMMAND = 'membership-plan-revise' as const;
export const CRM_ADULT_MEMBERSHIP_PLAN_OPTIONS_COMMAND = 'crm-adult-membership-plan-options' as const;
export const CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND = 'crm-adult-membership-draft-from-plan' as const;
export const MEMBERSHIP_PLAN_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
export const MEMBERSHIP_PLAN_MAX_PRICE_MINOR = 100_000_000;
export const MEMBERSHIP_PLAN_BILLING_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'ANNUAL', 'PAID_IN_FULL'] as const;
export const MEMBERSHIP_PLAN_TERM_KINDS = ['OPEN_ENDED', 'FIXED_MONTHS'] as const;
export type MembershipPlanAvailability = 'AVAILABLE' | 'UNAVAILABLE';
/** Price is per billing period; PAID_IN_FULL is one price for a whole fixed term. */
export type MembershipPlanBillingFrequency = typeof MEMBERSHIP_PLAN_BILLING_FREQUENCIES[number];
export type MembershipPlanTermKind = typeof MEMBERSHIP_PLAN_TERM_KINDS[number];

/** One complete set of published terms; a revision always sends all of them. */
export interface MembershipPlanTermsInput {
  displayName: string;
  description?: string | null;
  programId?: string | null;
  availability: MembershipPlanAvailability;
  currency: string;
  priceMinor: number;
  billingFrequency: MembershipPlanBillingFrequency;
  termKind: MembershipPlanTermKind;
  /** Required for FIXED_MONTHS (1..60), absent or null for OPEN_ENDED. */
  termMonths?: number | null;
}
export interface CreateMembershipPlanInput extends MembershipPlanTermsInput { planCode: string; confirmation: typeof MEMBERSHIP_PLAN_CHANGE_CONFIRMATION }
export interface ReviseMembershipPlanInput extends MembershipPlanTermsInput { expectedVersion: number; confirmation: typeof MEMBERSHIP_PLAN_CHANGE_CONFIRMATION }
/** Exact immutable terms of one published version. */
export interface MembershipPlanVersionSummary {
  planId: string;
  planCode: string;
  version: number;
  displayName: string;
  description: string | null;
  programId: string | null;
  availability: MembershipPlanAvailability;
  currency: string;
  priceMinor: number;
  billingFrequency: MembershipPlanBillingFrequency;
  termKind: MembershipPlanTermKind;
  termMonths: number | null;
  publishedAt: string;
}
/** A plan at its current version, with the program's current name for display only. */
export interface MembershipPlanListing extends MembershipPlanVersionSummary { programName: string | null }
export interface MembershipPlanProgramOption { programId: string; name: string }
export interface MembershipPlanCatalog { plans: MembershipPlanListing[]; programs: MembershipPlanProgramOption[] }
export interface CrmAdultMembershipPlanOptions { plans: MembershipPlanListing[] }
export interface MembershipPlanCommandResult { plan: MembershipPlanVersionSummary; replayed: boolean }
export interface CrmAdultMembershipDraftFromPlanInput {
  studentProfileId: string;
  membershipPlanId: string;
  /** The exact version the staff member reviewed; a newer published version makes the request stale. */
  membershipPlanVersion: number;
  termStartedAt?: string;
  confirmation: typeof CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION;
}
/** `receipt` is the ordinary adult DRAFT receipt; `plan` is the immutable version it was created from. */
export interface CrmAdultMembershipDraftFromPlan { receipt: CrmAdultMembershipDraftReceipt; plan: MembershipPlanVersionSummary }
export interface MembershipPlanContext extends CommandContext { externalSubject: string }
type Meta<R extends boolean> = { requestId: string; correlationId: string; replayed: R };
export interface MembershipPlanCatalogApiResponse { data: MembershipPlanCatalog; meta: Meta<false> }
export interface MembershipPlanCommandApiResponse { data: MembershipPlanVersionSummary; meta: Meta<boolean> }
export interface CrmAdultMembershipPlanOptionsApiResponse { data: CrmAdultMembershipPlanOptions; meta: Meta<false> }
export interface CrmAdultMembershipDraftFromPlanApiResponse { data: CrmAdultMembershipDraftFromPlan; meta: Meta<boolean> }

function invalid(): never { throw new Error('Unverified membership plan data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(value)) invalid(); return value.toLowerCase(); }
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) invalid();
  return value;
}
/** Display-only names from existing school records: bounded, no control characters. */
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
const TERM_KEYS = ['displayName', 'description', 'programId', 'availability', 'currency', 'priceMinor', 'billingFrequency', 'termKind', 'termMonths'] as const;

function terms(row: Record<string, unknown>): MembershipPlanTermsInput {
  const out: MembershipPlanTermsInput = {
    displayName: text(row.displayName, 120),
    availability: oneOf(row.availability, ['AVAILABLE', 'UNAVAILABLE'] as const),
    currency: typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : invalid(),
    priceMinor: integer(row.priceMinor, 0, MEMBERSHIP_PLAN_MAX_PRICE_MINOR),
    billingFrequency: oneOf(row.billingFrequency, MEMBERSHIP_PLAN_BILLING_FREQUENCIES),
    termKind: oneOf(row.termKind, MEMBERSHIP_PLAN_TERM_KINDS),
  };
  if (Object.hasOwn(row, 'description')) out.description = row.description === null ? null : text(row.description, 500);
  if (Object.hasOwn(row, 'programId')) out.programId = row.programId === null ? null : uuid(row.programId);
  if (out.termKind === 'FIXED_MONTHS') out.termMonths = integer(row.termMonths, 1, 60);
  else if (Object.hasOwn(row, 'termMonths')) { if (row.termMonths !== null) invalid(); out.termMonths = null; }
  if (out.billingFrequency === 'PAID_IN_FULL' && out.termKind !== 'FIXED_MONTHS') invalid();
  if (out.billingFrequency === 'ANNUAL' && out.termKind === 'FIXED_MONTHS' && out.termMonths! % 12 !== 0) invalid();
  return out;
}
export function validateCreateMembershipPlanInput(value: unknown): CreateMembershipPlanInput {
  const row = record(value, ['planCode', 'displayName', 'availability', 'currency', 'priceMinor', 'billingFrequency', 'termKind', 'confirmation'], ['description', 'programId', 'termMonths']);
  if (typeof row.planCode !== 'string' || !MEMBERSHIP_PLAN_CODE.test(row.planCode) || row.confirmation !== MEMBERSHIP_PLAN_CHANGE_CONFIRMATION) invalid();
  return { planCode: row.planCode, ...terms(row), confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
}
export function validateReviseMembershipPlanInput(value: unknown): ReviseMembershipPlanInput {
  const row = record(value, ['expectedVersion', 'displayName', 'availability', 'currency', 'priceMinor', 'billingFrequency', 'termKind', 'confirmation'], ['description', 'programId', 'termMonths']);
  if (row.confirmation !== MEMBERSHIP_PLAN_CHANGE_CONFIRMATION) invalid();
  return { expectedVersion: integer(row.expectedVersion, 1, 999_999), ...terms(row), confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
}
/** Reads carry no selector: the body is always exactly `{}`. */
export function validateMembershipPlanReadInput(value: unknown): Record<string, never> { record(value, []); return {}; }
export function validateCrmAdultMembershipDraftFromPlanInput(value: unknown): CrmAdultMembershipDraftFromPlanInput {
  const row = record(value, ['studentProfileId', 'membershipPlanId', 'membershipPlanVersion', 'confirmation'], ['termStartedAt']);
  if (row.confirmation !== CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION) invalid();
  const out: CrmAdultMembershipDraftFromPlanInput = { studentProfileId: uuid(row.studentProfileId), membershipPlanId: uuid(row.membershipPlanId),
    membershipPlanVersion: integer(row.membershipPlanVersion, 1, 999_999), confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  if (Object.hasOwn(row, 'termStartedAt')) out.termStartedAt = instant(row.termStartedAt);
  return out;
}

const SUMMARY_KEYS = ['planId', 'planCode', 'version', ...TERM_KEYS, 'publishedAt'] as const;
export function verifyMembershipPlanVersionSummary(value: unknown): MembershipPlanVersionSummary {
  const row = record(value, SUMMARY_KEYS);
  if (typeof row.planCode !== 'string' || !MEMBERSHIP_PLAN_CODE.test(row.planCode)) invalid();
  const t = terms(row);
  return { planId: uuid(row.planId), planCode: row.planCode, version: integer(row.version, 1, 999_999), displayName: t.displayName,
    description: t.description ?? null, programId: t.programId ?? null, availability: t.availability, currency: t.currency, priceMinor: t.priceMinor,
    billingFrequency: t.billingFrequency, termKind: t.termKind, termMonths: t.termMonths ?? null, publishedAt: instant(row.publishedAt) };
}
function listing(value: unknown): MembershipPlanListing {
  const row = record(value, [...SUMMARY_KEYS, 'programName']);
  const { programName, ...summary } = row;
  const plan = verifyMembershipPlanVersionSummary(summary);
  if ((plan.programId === null) !== (programName === null)) invalid();
  return { ...plan, programName: programName === null ? null : label(programName) };
}
function unique(plans: MembershipPlanListing[]): MembershipPlanListing[] {
  if (new Set(plans.map(plan => plan.planId)).size !== plans.length || new Set(plans.map(plan => plan.planCode)).size !== plans.length) invalid();
  return plans;
}
export function verifyMembershipPlanCatalog(value: unknown): MembershipPlanCatalog {
  const row = record(value, ['plans', 'programs']);
  if (!Array.isArray(row.plans) || row.plans.length > 200 || !Array.isArray(row.programs) || row.programs.length > 1000) invalid();
  const programs = row.programs.map(item => { const p = record(item, ['programId', 'name']); return { programId: uuid(p.programId), name: label(p.name) }; });
  if (new Set(programs.map(p => p.programId)).size !== programs.length) invalid();
  return { plans: unique(row.plans.map(listing)), programs };
}
/** Every option is AVAILABLE: the staff enrollment read never lists hidden plans. */
export function verifyCrmAdultMembershipPlanOptions(value: unknown): CrmAdultMembershipPlanOptions {
  const row = record(value, ['plans']);
  if (!Array.isArray(row.plans) || row.plans.length > 200) invalid();
  const plans = unique(row.plans.map(listing));
  if (plans.some(plan => plan.availability !== 'AVAILABLE')) invalid();
  return { plans };
}
/** UTC calendar months with end-of-month clamping, matching PostgreSQL timestamp + interval. */
export function membershipPlanFixedTermEnd(termStartedAt: string, termMonths: number): string {
  const start = new Date(instant(termStartedAt));
  const months = start.getUTCMonth() + integer(termMonths, 1, 60);
  const year = start.getUTCFullYear() + Math.floor(months / 12), month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds())).toISOString();
}
/** The receipt must carry exactly the plan's code and the term derived from the plan and the requested start. */
export function verifyCrmAdultMembershipDraftFromPlan(value: unknown, input?: CrmAdultMembershipDraftFromPlanInput): CrmAdultMembershipDraftFromPlan {
  const row = record(value, ['receipt', 'plan']);
  const plan = verifyMembershipPlanVersionSummary(row.plan);
  const receipt = verifyCrmAdultMembershipDraftReceipt(row.receipt);
  const end = receipt.termStartedAt && plan.termKind === 'FIXED_MONTHS' ? membershipPlanFixedTermEnd(receipt.termStartedAt, plan.termMonths!) : null;
  if (receipt.planCode !== plan.planCode || receipt.termEndsAt !== end) invalid();
  if (input && (plan.planId !== input.membershipPlanId || plan.version !== input.membershipPlanVersion || receipt.termStartedAt !== (input.termStartedAt ?? null))) invalid();
  return { receipt, plan };
}
