import { CRM_ADULT_MEMBERSHIP_DRAFT_UUID } from './crm-adult-membership-draft.js';
import {
  MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, MEMBERSHIP_PLAN_CODE, MEMBERSHIP_PLAN_MAX_PRICE_MINOR, verifyMembershipPlanVersionSummary,
  type MembershipPlanAvailability, type MembershipPlanVersionSummary,
} from './school-membership-plans.js';

/**
 * Membership plan payment options (0642). A plan (membership type) offers 1 to 6 ways to pay, like the owner's previous CRM:
 * label, amount, how often, number of payments, length, down payment at sign-up and whether checkout pages may offer it.
 * Option 1 is the standard option and is also the plan version's own price, frequency and term (0175), so nothing that
 * reads plan versions changes. Terms only: nothing here schedules, invoices or charges.
 */
export const MEMBERSHIP_PLAN_SETUPS_READ_COMMAND = 'membership-plan-setups-read' as const;
export const MEMBERSHIP_PLAN_CREATE_WITH_OPTIONS_COMMAND = 'membership-plan-create-with-options' as const;
export const MEMBERSHIP_PLAN_REVISE_WITH_OPTIONS_COMMAND = 'membership-plan-revise-with-options' as const;
export const MEMBERSHIP_PAYMENT_OPTION_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL', 'PAID_IN_FULL'] as const;
export type MembershipPaymentOptionFrequency = typeof MEMBERSHIP_PAYMENT_OPTION_FREQUENCIES[number];
export const MEMBERSHIP_PLAN_SETUP_LIMITS = { options: 6, features: 12, featureLength: 120, labelLength: 80, classesPerWeek: 14, payments: 120, termMonths: 60 } as const;

export interface MembershipPaymentOptionInput {
  label: string;
  priceMinor: number;
  billingFrequency: MembershipPaymentOptionFrequency;
  /** Number of payments; absent or null means ongoing. Paid in full is always one payment (null). */
  payments?: number | null;
  /** Length in months; absent or null means ongoing. Required for paid in full. */
  termMonths?: number | null;
  /** Taken at sign-up when set. */
  downPaymentMinor?: number | null;
  checkoutEnabled: boolean;
}
export interface MembershipPlanSetupFields {
  displayName: string;
  description?: string | null;
  programId?: string | null;
  availability: MembershipPlanAvailability;
  currency: string;
  classesPerWeek?: number | null;
  features?: string[];
  paymentOptions: MembershipPaymentOptionInput[];
}
export interface CreateMembershipPlanWithOptionsInput extends MembershipPlanSetupFields { planCode: string; confirmation: typeof MEMBERSHIP_PLAN_CHANGE_CONFIRMATION }
export interface ReviseMembershipPlanWithOptionsInput extends MembershipPlanSetupFields { expectedVersion: number; confirmation: typeof MEMBERSHIP_PLAN_CHANGE_CONFIRMATION }

export interface MembershipPaymentOption {
  optionNo: number;
  /** Null only on a derived option (a version published before options existed). */
  label: string | null;
  priceMinor: number;
  billingFrequency: MembershipPaymentOptionFrequency;
  payments: number | null;
  termMonths: number | null;
  downPaymentMinor: number | null;
  checkoutEnabled: boolean;
}
export interface MembershipPlanSetup {
  planId: string;
  version: number;
  /** True when the version was published without options; its one option is made from the plan's price. */
  derived: boolean;
  classesPerWeek: number | null;
  features: string[];
  paymentOptions: MembershipPaymentOption[];
}
export interface MembershipPlanSetups { setups: MembershipPlanSetup[] }
export interface MembershipPlanWithOptionsResult { plan: MembershipPlanVersionSummary; setup: MembershipPlanSetup; replayed: boolean }
type Meta<R extends boolean> = { requestId: string; correlationId: string; replayed: R };
export interface MembershipPlanSetupsApiResponse { data: MembershipPlanSetups; meta: Meta<false> }
export interface MembershipPlanWithOptionsApiResponse { data: { plan: MembershipPlanVersionSummary; setup: MembershipPlanSetup }; meta: Meta<boolean> }

function invalid(): never { throw new Error('Unverified membership plan setup.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
function optionalInteger(row: Record<string, unknown>, key: string, min: number, max: number): number | null {
  return !Object.hasOwn(row, key) || row[key] === null ? null : integer(row[key], min, max);
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(value)) invalid(); return value.toLowerCase(); }

/** The same rules the database applies to one option, so a screen can explain a refusal before sending. */
export function membershipPaymentOptionProblem(option: Pick<MembershipPaymentOption, 'billingFrequency' | 'payments' | 'termMonths'>, optionNo: number):
  'FIRST_NOT_QUARTERLY' | 'PAID_IN_FULL_NEEDS_LENGTH' | 'ANNUAL_WHOLE_YEARS' | 'QUARTERLY_WHOLE_QUARTERS' | null {
  if (optionNo === 1 && option.billingFrequency === 'QUARTERLY') return 'FIRST_NOT_QUARTERLY';
  if (option.billingFrequency === 'PAID_IN_FULL' && (option.termMonths === null || option.payments !== null)) return 'PAID_IN_FULL_NEEDS_LENGTH';
  if (option.billingFrequency === 'ANNUAL' && option.termMonths !== null && option.termMonths % 12 !== 0) return 'ANNUAL_WHOLE_YEARS';
  if (option.billingFrequency === 'QUARTERLY' && option.termMonths !== null && option.termMonths % 3 !== 0) return 'QUARTERLY_WHOLE_QUARTERS';
  return null;
}
const OPTION_KEYS = ['label', 'priceMinor', 'billingFrequency', 'checkoutEnabled'] as const;
const OPTION_OPTIONAL = ['payments', 'termMonths', 'downPaymentMinor'] as const;
function optionInput(value: unknown, index: number): MembershipPaymentOptionInput {
  const row = record(value, OPTION_KEYS, OPTION_OPTIONAL);
  if (typeof row.checkoutEnabled !== 'boolean') invalid();
  const out: MembershipPaymentOptionInput = { label: text(row.label, MEMBERSHIP_PLAN_SETUP_LIMITS.labelLength), priceMinor: integer(row.priceMinor, 0, MEMBERSHIP_PLAN_MAX_PRICE_MINOR),
    billingFrequency: oneOf(row.billingFrequency, MEMBERSHIP_PAYMENT_OPTION_FREQUENCIES), checkoutEnabled: row.checkoutEnabled };
  const payments = optionalInteger(row, 'payments', 1, MEMBERSHIP_PLAN_SETUP_LIMITS.payments), termMonths = optionalInteger(row, 'termMonths', 1, MEMBERSHIP_PLAN_SETUP_LIMITS.termMonths);
  const downPaymentMinor = optionalInteger(row, 'downPaymentMinor', 1, MEMBERSHIP_PLAN_MAX_PRICE_MINOR);
  if (membershipPaymentOptionProblem({ billingFrequency: out.billingFrequency, payments, termMonths }, index + 1)) invalid();
  if (Object.hasOwn(row, 'payments')) out.payments = payments;
  if (Object.hasOwn(row, 'termMonths')) out.termMonths = termMonths;
  if (Object.hasOwn(row, 'downPaymentMinor')) out.downPaymentMinor = downPaymentMinor;
  return out;
}
const SETUP_REQUIRED = ['displayName', 'availability', 'currency', 'paymentOptions', 'confirmation'] as const;
const SETUP_OPTIONAL = ['description', 'programId', 'classesPerWeek', 'features'] as const;
function setupFields(row: Record<string, unknown>): MembershipPlanSetupFields {
  if (row.confirmation !== MEMBERSHIP_PLAN_CHANGE_CONFIRMATION || !Array.isArray(row.paymentOptions)
    || row.paymentOptions.length < 1 || row.paymentOptions.length > MEMBERSHIP_PLAN_SETUP_LIMITS.options) invalid();
  const out: MembershipPlanSetupFields = { displayName: text(row.displayName, 120), availability: oneOf(row.availability, ['AVAILABLE', 'UNAVAILABLE'] as const),
    currency: typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : invalid(), paymentOptions: row.paymentOptions.map(optionInput) };
  const labels = out.paymentOptions.map(o => o.label.toLowerCase());
  if (new Set(labels).size !== labels.length) invalid();
  if (Object.hasOwn(row, 'description')) out.description = row.description === null ? null : text(row.description, 500);
  if (Object.hasOwn(row, 'programId')) out.programId = row.programId === null ? null : uuid(row.programId);
  if (Object.hasOwn(row, 'classesPerWeek')) out.classesPerWeek = row.classesPerWeek === null ? null : integer(row.classesPerWeek, 1, MEMBERSHIP_PLAN_SETUP_LIMITS.classesPerWeek);
  if (Object.hasOwn(row, 'features')) {
    if (!Array.isArray(row.features) || row.features.length > MEMBERSHIP_PLAN_SETUP_LIMITS.features) invalid();
    out.features = row.features.map(f => text(f, MEMBERSHIP_PLAN_SETUP_LIMITS.featureLength));
  }
  return out;
}
export function validateCreateMembershipPlanWithOptionsInput(value: unknown): CreateMembershipPlanWithOptionsInput {
  const row = record(value, ['planCode', ...SETUP_REQUIRED], SETUP_OPTIONAL);
  if (typeof row.planCode !== 'string' || !MEMBERSHIP_PLAN_CODE.test(row.planCode)) invalid();
  return { planCode: row.planCode, ...setupFields(row), confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
}
export function validateReviseMembershipPlanWithOptionsInput(value: unknown): ReviseMembershipPlanWithOptionsInput {
  const row = record(value, ['expectedVersion', ...SETUP_REQUIRED], SETUP_OPTIONAL);
  return { expectedVersion: integer(row.expectedVersion, 1, 999_999), ...setupFields(row), confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION };
}

const OPTION_SUMMARY_KEYS = ['optionNo', 'label', 'priceMinor', 'billingFrequency', 'payments', 'termMonths', 'downPaymentMinor', 'checkoutEnabled'] as const;
function option(value: unknown, index: number, derived: boolean): MembershipPaymentOption {
  const row = record(value, OPTION_SUMMARY_KEYS);
  if (typeof row.checkoutEnabled !== 'boolean' || row.optionNo !== index + 1) invalid();
  const nullable = (key: string, min: number, max: number) => row[key] === null ? null : integer(row[key], min, max);
  const out: MembershipPaymentOption = { optionNo: index + 1, label: derived && row.label === null ? null : text(row.label, MEMBERSHIP_PLAN_SETUP_LIMITS.labelLength),
    priceMinor: integer(row.priceMinor, 0, MEMBERSHIP_PLAN_MAX_PRICE_MINOR), billingFrequency: oneOf(row.billingFrequency, MEMBERSHIP_PAYMENT_OPTION_FREQUENCIES),
    payments: nullable('payments', 1, MEMBERSHIP_PLAN_SETUP_LIMITS.payments), termMonths: nullable('termMonths', 1, MEMBERSHIP_PLAN_SETUP_LIMITS.termMonths),
    downPaymentMinor: nullable('downPaymentMinor', 1, MEMBERSHIP_PLAN_MAX_PRICE_MINOR), checkoutEnabled: row.checkoutEnabled };
  if (!derived && membershipPaymentOptionProblem(out, out.optionNo)) invalid();
  return out;
}
export function verifyMembershipPlanSetup(value: unknown): MembershipPlanSetup {
  const row = record(value, ['planId', 'version', 'derived', 'classesPerWeek', 'features', 'paymentOptions']);
  if (typeof row.derived !== 'boolean' || !Array.isArray(row.features) || row.features.length > MEMBERSHIP_PLAN_SETUP_LIMITS.features
    || !Array.isArray(row.paymentOptions) || row.paymentOptions.length < 1 || row.paymentOptions.length > MEMBERSHIP_PLAN_SETUP_LIMITS.options
    || (row.derived && (row.paymentOptions.length !== 1 || row.features.length || row.classesPerWeek !== null))) invalid();
  const derived = row.derived;
  return { planId: uuid(row.planId), version: integer(row.version, 1, 999_999), derived,
    classesPerWeek: row.classesPerWeek === null ? null : integer(row.classesPerWeek, 1, MEMBERSHIP_PLAN_SETUP_LIMITS.classesPerWeek),
    features: row.features.map(f => text(f, MEMBERSHIP_PLAN_SETUP_LIMITS.featureLength)), paymentOptions: row.paymentOptions.map((o, i) => option(o, i, derived)) };
}
export function verifyMembershipPlanSetups(value: unknown): MembershipPlanSetups {
  const row = record(value, ['setups']);
  if (!Array.isArray(row.setups) || row.setups.length > 200) invalid();
  const setups = row.setups.map(verifyMembershipPlanSetup);
  if (new Set(setups.map(s => s.planId)).size !== setups.length) invalid();
  return { setups };
}
/** A publish result: the version summary, its setup, and option 1 equal to the version's own price, frequency and term. */
export function verifyMembershipPlanWithOptions(value: unknown): { plan: MembershipPlanVersionSummary; setup: MembershipPlanSetup } {
  const row = record(value, ['plan', 'setup']);
  const plan = verifyMembershipPlanVersionSummary(row.plan), setup = verifyMembershipPlanSetup(row.setup), first = setup.paymentOptions[0]!;
  if (setup.derived || setup.planId !== plan.planId || setup.version !== plan.version || first.priceMinor !== plan.priceMinor
    || first.billingFrequency !== plan.billingFrequency || first.termMonths !== plan.termMonths) invalid();
  return { plan, setup };
}
