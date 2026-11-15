/**
 * B-TUI-2 piece 4 (0322): a payer's autopay plan and the school's sibling discount, test mode only. A plan names one of the
 * payer's saved methods (0321); preparing a cycle turns the payer's due membership schedules into ISSUED invoices with the
 * sibling discount, grouped for one combined charge that piece 5 sends. Nothing here charges anyone, and HON takes no fee.
 */
import { verifySchoolPayMethod, type SchoolPayMethod } from './school-pay-methods.js';

export const SCHOOL_PAY_DISCOUNT_KINDS = ['NONE', 'PERCENT', 'FIXED'] as const;
export type SchoolPayDiscountKind = (typeof SCHOOL_PAY_DISCOUNT_KINDS)[number];
export const SCHOOL_PAY_AUTOPAY_STATES = ['ACTIVE', 'PAUSED', 'CANCELLED'] as const;
export type SchoolPayAutopayState = (typeof SCHOOL_PAY_AUTOPAY_STATES)[number];
export const SCHOOL_PAY_SCHEDULE_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'ANNUAL'] as const;
export type SchoolPayScheduleFrequency = (typeof SCHOOL_PAY_SCHEDULE_FREQUENCIES)[number];
/** The consent text version the payer agrees to when autopay is turned on. */
export const SCHOOL_PAY_AUTOPAY_CONSENT_VERSION = 'autopay-v1';
/** Largest fixed sibling discount, in minor units (the database checks the same bound). */
export const SCHOOL_PAY_DISCOUNT_FIXED_MAX = 100_000_000;

export interface SchoolPayDiscountRule {
  version: number; kind: SchoolPayDiscountKind; secondValue: number | null; laterValue: number | null; currency: string | null; createdAt: string;
}
export interface SchoolPayDiscountRuleRead { canManage: boolean; rule: SchoolPayDiscountRule | null; history: SchoolPayDiscountRule[] }
export interface SchoolPayAutopayPlan {
  planId: string; billingAccountId: string; methodId: string; state: SchoolPayAutopayState; consentTextVersion: string; version: number;
  createdAt: string; updatedAt: string; endedAt: string | null; endReason: string | null;
}
export interface SchoolPayAutopayPreviewLine {
  membershipId: string; scheduleId: string; planCode: string; frequency: SchoolPayScheduleFrequency; participantName: string; periodAt: string;
  studentRank: number; amountMinor: number; discountMinor: number;
}
export interface SchoolPayAutopayPreview { cycleDate: string; currency: string; subtotalMinor: number; discountMinor: number; totalMinor: number; lines: SchoolPayAutopayPreviewLine[] }
export interface SchoolPayAutopayCycleLine {
  membershipId: string; scheduleId: string; periodAt: string; studentRank: number; amountMinor: number; discountMinor: number; invoiceId: string;
}
export interface SchoolPayAutopayCycle {
  cycleId: string; billingAccountId: string; planId: string; methodId: string; cycleDate: string; currency: string; subtotalMinor: number;
  discountMinor: number; totalMinor: number; discountRuleVersion: number | null; state: 'READY'; createdAt: string; lines: SchoolPayAutopayCycleLine[];
}
export interface SchoolPayAutopayMethodOption { method: SchoolPayMethod; autopayUsable: boolean }
export interface SchoolPayPayerAutopay {
  billingAccountId: string; canManage: boolean; platformFee: 'NONE'; currency: string; schoolToday: string; payerName: string;
  plan: SchoolPayAutopayPlan | null; pastPlans: SchoolPayAutopayPlan[]; methods: SchoolPayAutopayMethodOption[];
  discountRule: SchoolPayDiscountRule | null; preview: SchoolPayAutopayPreview | null; cycles: SchoolPayAutopayCycle[];
}

export interface SetSchoolPayDiscountRuleInput { basedOnVersion: number; kind: SchoolPayDiscountKind; secondValue?: number; laterValue?: number; currency?: string }
export interface EnrollSchoolPayAutopayInput { methodId: string; consentTextVersion: string }
export interface ChangeSchoolPayAutopayMethodInput { expectedVersion: number; methodId: string }
export interface SetSchoolPayAutopayStateInput { expectedVersion: number; state: 'ACTIVE' | 'PAUSED' }
export interface CancelSchoolPayAutopayInput { expectedVersion: number; reason: string }
export interface PrepareSchoolPayAutopayCycleInput { expectedVersion: number; cycleDate: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE = /^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const CURRENCY = /^[A-Z]{3}$/;
const CONSENT = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const PLAN_CODE = /^.{1,200}$/s;
const CONTROL = /[\u0000-\u001f\u007f]/;

function invalid(): never { throw new Error('Invalid school autopay data.'); }
function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (keys.some(key => !(key in row)) || Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function count(value: unknown, minimum: number, maximum = 999_999_999): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
/** A real calendar date (no 2026-02-30). */
function day(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function text(value: unknown, maximum = 1000, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.trim() !== value || CONTROL.test(value)) invalid();
  return value;
}
function matching(value: unknown, pattern: RegExp): string { if (typeof value !== 'string' || !pattern.test(value)) invalid(); return value; }
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function list(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }

/** The sibling discount for one line, exactly as the database computes it (never more than the line). */
export function schoolPaySiblingDiscount(rule: Pick<SchoolPayDiscountRule, 'kind' | 'secondValue' | 'laterValue' | 'currency'> | null, studentRank: number, amountMinor: number, currency: string): number {
  if (!rule || rule.kind === 'NONE' || studentRank < 2 || rule.secondValue === null || rule.laterValue === null) return 0;
  const value = studentRank === 2 ? rule.secondValue : rule.laterValue;
  if (rule.kind === 'PERCENT') return Math.floor((amountMinor * value) / 100);
  return rule.currency === currency ? Math.min(amountMinor, value) : 0;
}

// Input validators (the database validates the same rules again).
export function validateSetSchoolPayDiscountRuleInput(value: unknown): SetSchoolPayDiscountRuleInput {
  const row = record(value, ['basedOnVersion', 'kind'], ['secondValue', 'laterValue', 'currency']);
  const basedOnVersion = count(row.basedOnVersion, 0), kind = oneOf(row.kind, SCHOOL_PAY_DISCOUNT_KINDS);
  if (kind === 'NONE') {
    if ('secondValue' in row || 'laterValue' in row || 'currency' in row) invalid();
    return { basedOnVersion, kind };
  }
  const maximum = kind === 'PERCENT' ? 100 : SCHOOL_PAY_DISCOUNT_FIXED_MAX;
  const secondValue = count(row.secondValue, 0, maximum), laterValue = count(row.laterValue, 0, maximum);
  if (secondValue + laterValue === 0) invalid();
  if (kind === 'PERCENT') { if ('currency' in row) invalid(); return { basedOnVersion, kind, secondValue, laterValue }; }
  return { basedOnVersion, kind, secondValue, laterValue, currency: matching(row.currency, CURRENCY) };
}
export function validateEnrollSchoolPayAutopayInput(value: unknown): EnrollSchoolPayAutopayInput {
  const row = record(value, ['methodId', 'consentTextVersion']);
  return { methodId: uuid(row.methodId), consentTextVersion: matching(row.consentTextVersion, CONSENT) };
}
export function validateChangeSchoolPayAutopayMethodInput(value: unknown): ChangeSchoolPayAutopayMethodInput {
  const row = record(value, ['expectedVersion', 'methodId']);
  return { expectedVersion: count(row.expectedVersion, 1), methodId: uuid(row.methodId) };
}
export function validateSetSchoolPayAutopayStateInput(value: unknown): SetSchoolPayAutopayStateInput {
  const row = record(value, ['expectedVersion', 'state']);
  return { expectedVersion: count(row.expectedVersion, 1), state: oneOf(row.state, ['ACTIVE', 'PAUSED'] as const) };
}
export function validateCancelSchoolPayAutopayInput(value: unknown): CancelSchoolPayAutopayInput {
  const row = record(value, ['expectedVersion', 'reason']);
  return { expectedVersion: count(row.expectedVersion, 1), reason: text(row.reason) };
}
export function validatePrepareSchoolPayAutopayCycleInput(value: unknown): PrepareSchoolPayAutopayCycleInput {
  const row = record(value, ['expectedVersion', 'cycleDate']);
  return { expectedVersion: count(row.expectedVersion, 1), cycleDate: day(row.cycleDate) };
}

// Output verifiers: every database response is checked strictly before it is used or reaches a client.
export function verifySchoolPayDiscountRule(value: unknown): SchoolPayDiscountRule {
  const row = record(value, ['version', 'kind', 'secondValue', 'laterValue', 'currency', 'createdAt']);
  const rule: SchoolPayDiscountRule = {
    version: count(row.version, 1), kind: oneOf(row.kind, SCHOOL_PAY_DISCOUNT_KINDS), secondValue: nullable(row.secondValue, v => count(v, 0, SCHOOL_PAY_DISCOUNT_FIXED_MAX)),
    laterValue: nullable(row.laterValue, v => count(v, 0, SCHOOL_PAY_DISCOUNT_FIXED_MAX)), currency: nullable(row.currency, v => matching(v, CURRENCY)), createdAt: instant(row.createdAt),
  };
  if ((rule.kind === 'NONE') !== (rule.secondValue === null) || (rule.secondValue === null) !== (rule.laterValue === null) || (rule.kind === 'FIXED') !== (rule.currency !== null)) invalid();
  if (rule.kind !== 'NONE' && (rule.secondValue! + rule.laterValue! === 0 || (rule.kind === 'PERCENT' && (rule.secondValue! > 100 || rule.laterValue! > 100)))) invalid();
  return rule;
}
export function verifySchoolPayDiscountRuleRead(value: unknown): SchoolPayDiscountRuleRead {
  const row = record(value, ['canManage', 'rule', 'history']);
  const history = list(row.history, 10).map(verifySchoolPayDiscountRule);
  const rule = nullable(row.rule, verifySchoolPayDiscountRule);
  if ((rule === null) !== (history.length === 0) || (rule && history[0]!.version !== rule.version)
    || history.some((r, i) => i > 0 && r.version >= history[i - 1]!.version)) invalid();
  return { canManage: bool(row.canManage), rule, history };
}
export function verifySchoolPayAutopayPlan(value: unknown, expect: { planId?: string; billingAccountId?: string } = {}): SchoolPayAutopayPlan {
  const row = record(value, ['planId', 'billingAccountId', 'methodId', 'state', 'consentTextVersion', 'version', 'createdAt', 'updatedAt', 'endedAt', 'endReason']);
  const plan: SchoolPayAutopayPlan = {
    planId: uuid(row.planId), billingAccountId: uuid(row.billingAccountId), methodId: uuid(row.methodId), state: oneOf(row.state, SCHOOL_PAY_AUTOPAY_STATES),
    consentTextVersion: matching(row.consentTextVersion, CONSENT), version: count(row.version, 1), createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt),
    endedAt: nullable(row.endedAt, instant), endReason: nullable(row.endReason, v => text(v)),
  };
  const cancelled = plan.state === 'CANCELLED';
  if (cancelled !== (plan.endedAt !== null) || cancelled !== (plan.endReason !== null) || (plan.version === 1 && plan.state !== 'ACTIVE')) invalid();
  if ((expect.planId !== undefined && plan.planId !== expect.planId.toLowerCase())
    || (expect.billingAccountId !== undefined && plan.billingAccountId !== expect.billingAccountId.toLowerCase())) invalid();
  return plan;
}
function verifyPreview(value: unknown, currency: string): SchoolPayAutopayPreview {
  const row = record(value, ['cycleDate', 'currency', 'subtotalMinor', 'discountMinor', 'totalMinor', 'lines']);
  const lines = list(row.lines, 50).map(entry => {
    const l = record(entry, ['membershipId', 'scheduleId', 'planCode', 'frequency', 'participantName', 'periodAt', 'studentRank', 'amountMinor', 'discountMinor']);
    const line: SchoolPayAutopayPreviewLine = {
      membershipId: uuid(l.membershipId), scheduleId: uuid(l.scheduleId), planCode: text(matching(l.planCode, PLAN_CODE), 200), frequency: oneOf(l.frequency, SCHOOL_PAY_SCHEDULE_FREQUENCIES),
      participantName: text(l.participantName, 200, 0), periodAt: instant(l.periodAt), studentRank: count(l.studentRank, 1, 50), amountMinor: count(l.amountMinor, 1, 2147483647),
      discountMinor: count(l.discountMinor, 0, 2147483647),
    };
    if (line.discountMinor > line.amountMinor) invalid();
    return line;
  });
  return { ...totals(row, lines, currency), cycleDate: day(row.cycleDate), lines };
}
function totals(row: Record<string, unknown>, lines: readonly { amountMinor: number; discountMinor: number; studentRank: number; scheduleId: string }[], currency: string) {
  const subtotalMinor = count(row.subtotalMinor, 1, Number.MAX_SAFE_INTEGER), discountMinor = count(row.discountMinor, 0, Number.MAX_SAFE_INTEGER), totalMinor = count(row.totalMinor, 0, Number.MAX_SAFE_INTEGER);
  const ranks = [...new Set(lines.map(l => l.studentRank))].sort((a, b) => a - b);
  if (matching(row.currency, CURRENCY) !== currency || lines.length === 0 || totalMinor !== subtotalMinor - discountMinor
    || subtotalMinor !== lines.reduce((n, l) => n + l.amountMinor, 0) || discountMinor !== lines.reduce((n, l) => n + l.discountMinor, 0)
    || ranks.some((r, i) => r !== i + 1) || lines.some((l, i) => i > 0 && l.studentRank < lines[i - 1]!.studentRank)
    || lines.some(l => l.studentRank === 1 && l.discountMinor !== 0) || new Set(lines.map(l => l.scheduleId)).size !== lines.length) invalid();
  return { currency, subtotalMinor, discountMinor, totalMinor };
}
export function verifySchoolPayAutopayCycle(value: unknown, expect: { billingAccountId?: string; planId?: string; currency?: string } = {}): SchoolPayAutopayCycle {
  const row = record(value, ['cycleId', 'billingAccountId', 'planId', 'methodId', 'cycleDate', 'currency', 'subtotalMinor', 'discountMinor', 'totalMinor',
    'discountRuleVersion', 'state', 'createdAt', 'lines']);
  const lines = list(row.lines, 50).map(entry => {
    const l = record(entry, ['membershipId', 'scheduleId', 'periodAt', 'studentRank', 'amountMinor', 'discountMinor', 'invoiceId']);
    const line: SchoolPayAutopayCycleLine = {
      membershipId: uuid(l.membershipId), scheduleId: uuid(l.scheduleId), periodAt: instant(l.periodAt), studentRank: count(l.studentRank, 1, 50),
      amountMinor: count(l.amountMinor, 1, 2147483647), discountMinor: count(l.discountMinor, 0, 2147483647), invoiceId: uuid(l.invoiceId),
    };
    if (line.discountMinor > line.amountMinor) invalid();
    return line;
  });
  const currency = matching(row.currency, CURRENCY);
  const cycle: SchoolPayAutopayCycle = {
    cycleId: uuid(row.cycleId), billingAccountId: uuid(row.billingAccountId), planId: uuid(row.planId), methodId: uuid(row.methodId), cycleDate: day(row.cycleDate),
    ...totals(row, lines, currency), discountRuleVersion: nullable(row.discountRuleVersion, v => count(v, 1)), state: oneOf(row.state, ['READY'] as const),
    createdAt: instant(row.createdAt), lines,
  };
  if (new Set(lines.map(l => l.invoiceId)).size !== lines.length || (cycle.discountRuleVersion === null && cycle.discountMinor !== 0)) invalid();
  if ((expect.billingAccountId !== undefined && cycle.billingAccountId !== expect.billingAccountId.toLowerCase())
    || (expect.planId !== undefined && cycle.planId !== expect.planId.toLowerCase()) || (expect.currency !== undefined && cycle.currency !== expect.currency)) invalid();
  return cycle;
}
export function verifySchoolPayPayerAutopay(value: unknown, billingAccountId?: string): SchoolPayPayerAutopay {
  const row = record(value, ['billingAccountId', 'canManage', 'platformFee', 'currency', 'schoolToday', 'payerName', 'plan', 'pastPlans', 'methods', 'discountRule', 'preview', 'cycles']);
  const payer = uuid(row.billingAccountId);
  if (billingAccountId !== undefined && payer !== billingAccountId.toLowerCase()) invalid();
  const currency = matching(row.currency, CURRENCY);
  const plan = nullable(row.plan, v => verifySchoolPayAutopayPlan(v, { billingAccountId: payer }));
  const pastPlans = list(row.pastPlans, 5).map(v => verifySchoolPayAutopayPlan(v, { billingAccountId: payer }));
  const methods = list(row.methods, 200).map(entry => {
    const m = record(entry, ['method', 'autopayUsable']);
    const method = verifySchoolPayMethod(m.method, { billingAccountId: payer });
    if (method.status !== 'ACTIVE') invalid();
    return { method, autopayUsable: bool(m.autopayUsable) };
  });
  const cycles = list(row.cycles, 12).map(v => verifySchoolPayAutopayCycle(v, { billingAccountId: payer }));
  if ((plan && plan.state === 'CANCELLED') || pastPlans.some(p => p.state !== 'CANCELLED') || new Set(methods.map(m => m.method.methodId)).size !== methods.length
    || new Set(cycles.map(c => c.cycleId)).size !== cycles.length) invalid();
  return {
    billingAccountId: payer, canManage: bool(row.canManage), platformFee: oneOf(row.platformFee, ['NONE'] as const), currency, schoolToday: day(row.schoolToday),
    payerName: text(row.payerName, 200, 0), plan, pastPlans, methods, discountRule: nullable(row.discountRule, verifySchoolPayDiscountRule),
    preview: nullable(row.preview, v => verifyPreview(v, currency)), cycles,
  };
}
export function verifySchoolPayAutopayPlanReceipt(value: unknown, expect: { planId?: string; billingAccountId?: string; state?: SchoolPayAutopayState } = {}): { plan: SchoolPayAutopayPlan } {
  const row = record(value, ['plan']);
  const plan = verifySchoolPayAutopayPlan(row.plan, expect);
  if (expect.state !== undefined && plan.state !== expect.state) invalid();
  return { plan };
}
export function verifySchoolPayAutopayCycleReceipt(value: unknown, expect: { billingAccountId?: string; planId?: string } = {}): { cycle: SchoolPayAutopayCycle } {
  const row = record(value, ['cycle']);
  return { cycle: verifySchoolPayAutopayCycle(row.cycle, expect) };
}
export function verifySchoolPayDiscountRuleReceipt(value: unknown): { rule: SchoolPayDiscountRule } {
  const row = record(value, ['rule']);
  return { rule: verifySchoolPayDiscountRule(row.rule) };
}
