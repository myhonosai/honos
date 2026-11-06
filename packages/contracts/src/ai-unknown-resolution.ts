// S4-d UNKNOWN outcome resolution (owner decision AI-D3). A human HQ owner resolves a lost provider outcome once,
// with closed provider evidence; the database enforces authority, eligibility and idempotency. No money moves:
// resolving releases an agent-credit hold and, for a recorded cost or a write-off, writes one usage ledger row.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const AI_UNKNOWN_AGENTS = ['MARKETING', 'TEACHING', 'CHAD_FOLLOW_UP', 'HON_REPLY'] as const;
export type AiUnknownAgent = typeof AI_UNKNOWN_AGENTS[number];
export const AI_UNKNOWN_DECISIONS = ['RECORD_PROVIDER_COST', 'NO_PROVIDER_CHARGE', 'WRITE_OFF'] as const;
export type AiUnknownDecision = typeof AI_UNKNOWN_DECISIONS[number];

export type AiUnknownResolutionInput =
  | { decision: 'RECORD_PROVIDER_COST'; reason: string; evidence: { providerGenerationId: string; inputTokens: number; outputTokens: number; providerCostMicrounits: number } }
  | { decision: 'NO_PROVIDER_CHARGE'; reason: string; evidence: { providerLookupReference: string } }
  | { decision: 'WRITE_OFF'; reason: string; evidence: { estimatedProviderCostMicrounits: number } };
export interface AiUnknownResolutionReceipt {
  resolutionId: string; agent: AiUnknownAgent; invocationId: string; organizationId: string; schoolId: string; decision: AiUnknownDecision;
  releasedCredits: number; ledgerEntryId: string | null; customerCredits: number | null; resolvedAt: string; replayed: boolean;
}
export interface AiUnknownOpenItem {
  agent: AiUnknownAgent; invocationId: string; organizationId: string; schoolId: string; status: 'UNKNOWN' | 'SENDING'; reservedCredits: number;
  /** Immutable time the hold was taken; null when no trustworthy origin exists (then it always counts). */
  heldAt: string | null; countsAgainstCurrentWindow: boolean;
}
/** A verified provider charge recorded after a WRITE_OFF: separate evidence, no ledger row, no customer credits, original hold window. */
export interface AiLateProviderExpenseSummary { expenseId: string; providerCostMicrounits: number; occurredAt: string; recordedAt: string }
export interface AiLateProviderExpenseInput {
  reason: string; evidence: { providerGenerationId: string; inputTokens: number; outputTokens: number; providerCostMicrounits: number };
}
export interface AiLateProviderExpenseReceipt {
  expenseId: string; resolutionId: string; agent: AiUnknownAgent; invocationId: string; providerCostMicrounits: number;
  estimatedProviderCostMicrounits: number; customerCredits: 0; occurredAt: string; recordedAt: string; replayed: boolean;
}
export interface AiUnknownResolvedItem extends Omit<AiUnknownResolutionReceipt, 'replayed'> {
  reason: string; evidence: Record<string, unknown>; resolvedByPrincipalId: string; priorStatus: 'UNKNOWN' | 'SENDING'; heldAt: string;
  lateProviderExpense: AiLateProviderExpenseSummary | null;
}
/** At most 200 open items (oldest first) and the latest 100 resolutions. */
export interface AiUnknownQueue { open: AiUnknownOpenItem[]; resolved: AiUnknownResolvedItem[]; staleAfterSeconds: number; asOf: string }

const REF = /^[A-Za-z0-9._:-]{1,200}$/;
const isAgent = (v: unknown): v is AiUnknownAgent => (AI_UNKNOWN_AGENTS as readonly unknown[]).includes(v);
const isDecision = (v: unknown): v is AiUnknownDecision => (AI_UNKNOWN_DECISIONS as readonly unknown[]).includes(v);
const isReason = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;
const isCount = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isRef = (v: unknown): v is string => typeof v === 'string' && REF.test(v);

export function validateAiUnknownAgent(value: unknown): AiUnknownAgent {
  if (!isAgent(value)) invalid();
  return value;
}

export function validateAiUnknownResolutionInput(value: unknown): AiUnknownResolutionInput {
  const r = record(value, invalid); exactKeys(r, ['decision', 'reason', 'evidence'], invalid);
  if (!isDecision(r.decision) || !isReason(r.reason)) invalid();
  const e = record(r.evidence, invalid);
  if (r.decision === 'RECORD_PROVIDER_COST') {
    providerEvidence(e);
  } else if (r.decision === 'NO_PROVIDER_CHARGE') {
    exactKeys(e, ['providerLookupReference'], invalid);
    if (!isRef(e.providerLookupReference)) invalid();
  } else {
    exactKeys(e, ['estimatedProviderCostMicrounits'], invalid);
    if (!isCount(e.estimatedProviderCostMicrounits, 999_999_999_999)) invalid();
  }
  return { decision: r.decision, reason: r.reason, evidence: e } as AiUnknownResolutionInput;
}

function providerEvidence(e: Record<string, unknown>): void {
  exactKeys(e, ['providerGenerationId', 'inputTokens', 'outputTokens', 'providerCostMicrounits'], invalid);
  if (!isRef(e.providerGenerationId) || !isCount(e.inputTokens, 100_000_000) || !isCount(e.outputTokens, 100_000_000)
    || !isCount(e.providerCostMicrounits, 999_999_999_999)) invalid();
}

export function validateAiLateProviderExpenseInput(value: unknown): AiLateProviderExpenseInput {
  const r = record(value, invalid); exactKeys(r, ['reason', 'evidence'], invalid);
  if (!isReason(r.reason)) invalid();
  const e = record(r.evidence, invalid); providerEvidence(e);
  return { reason: r.reason, evidence: e } as unknown as AiLateProviderExpenseInput;
}

export function validateAiLateProviderExpenseReceipt(value: unknown): AiLateProviderExpenseReceipt {
  const r = record(value, drift);
  exactKeys(r, ['expenseId', 'resolutionId', 'agent', 'invocationId', 'providerCostMicrounits', 'estimatedProviderCostMicrounits', 'customerCredits', 'occurredAt', 'recordedAt', 'replayed'], drift);
  if (!isUuid(r.expenseId) || !isUuid(r.resolutionId) || !isAgent(r.agent) || !isUuid(r.invocationId) || !isCount(r.providerCostMicrounits, 999_999_999_999)
    || !isCount(r.estimatedProviderCostMicrounits, 999_999_999_999) || r.customerCredits !== 0 || !isTimestamp(r.occurredAt) || !isTimestamp(r.recordedAt)
    || typeof r.replayed !== 'boolean') drift();
  return r as unknown as AiLateProviderExpenseReceipt;
}

function receiptCore(r: Record<string, unknown>): void {
  const recorded = r.ledgerEntryId !== null;
  if (!isUuid(r.resolutionId) || !isAgent(r.agent) || !isUuid(r.invocationId) || !isUuid(r.organizationId) || !isUuid(r.schoolId)
    || !isDecision(r.decision) || !isCount(r.releasedCredits, 2_147_483_647) || (r.releasedCredits as number) < 1 || !isTimestamp(r.resolvedAt)
    || (r.decision === 'NO_PROVIDER_CHARGE') === recorded
    || (recorded ? !(isUuid(r.ledgerEntryId) && isCount(r.customerCredits, Number.MAX_SAFE_INTEGER)) : r.customerCredits !== null)
    || (r.decision === 'WRITE_OFF' && r.customerCredits !== 0)) drift();
}

export function validateAiUnknownResolutionReceipt(value: unknown): AiUnknownResolutionReceipt {
  const r = record(value, drift);
  exactKeys(r, ['resolutionId', 'agent', 'invocationId', 'organizationId', 'schoolId', 'decision', 'releasedCredits', 'ledgerEntryId', 'customerCredits', 'resolvedAt', 'replayed'], drift);
  receiptCore(r);
  if (typeof r.replayed !== 'boolean') drift();
  return r as unknown as AiUnknownResolutionReceipt;
}

function validateOpen(value: unknown): AiUnknownOpenItem {
  const r = record(value, drift);
  exactKeys(r, ['agent', 'invocationId', 'organizationId', 'schoolId', 'status', 'reservedCredits', 'heldAt', 'countsAgainstCurrentWindow'], drift);
  if (!isAgent(r.agent) || !isUuid(r.invocationId) || !isUuid(r.organizationId) || !isUuid(r.schoolId) || (r.status !== 'UNKNOWN' && r.status !== 'SENDING')
    || !isCount(r.reservedCredits, 2_147_483_647) || (r.reservedCredits as number) < 1 || (r.heldAt !== null && !isTimestamp(r.heldAt))
    || typeof r.countsAgainstCurrentWindow !== 'boolean' || (r.heldAt === null && r.countsAgainstCurrentWindow !== true)) drift();
  return r as unknown as AiUnknownOpenItem;
}

function validateResolved(value: unknown): AiUnknownResolvedItem {
  const r = record(value, drift);
  exactKeys(r, ['resolutionId', 'agent', 'invocationId', 'organizationId', 'schoolId', 'decision', 'releasedCredits', 'ledgerEntryId', 'customerCredits', 'resolvedAt',
    'reason', 'evidence', 'resolvedByPrincipalId', 'priorStatus', 'heldAt', 'lateProviderExpense'], drift);
  receiptCore(r);
  if (!isReason(r.reason) || !isUuid(r.resolvedByPrincipalId) || (r.priorStatus !== 'UNKNOWN' && r.priorStatus !== 'SENDING')
    || !isTimestamp(r.heldAt)) drift();
  if (r.lateProviderExpense !== null) {
    if (r.decision !== 'WRITE_OFF') drift();
    const l = record(r.lateProviderExpense, drift); exactKeys(l, ['expenseId', 'providerCostMicrounits', 'occurredAt', 'recordedAt'], drift);
    if (!isUuid(l.expenseId) || !isCount(l.providerCostMicrounits, 999_999_999_999) || !isTimestamp(l.occurredAt) || !isTimestamp(l.recordedAt)) drift();
  }
  record(r.evidence, drift);
  return r as unknown as AiUnknownResolvedItem;
}

export function validateAiUnknownQueue(value: unknown): AiUnknownQueue {
  const r = record(value, drift); exactKeys(r, ['open', 'resolved', 'staleAfterSeconds', 'asOf'], drift);
  if (!Array.isArray(r.open) || r.open.length > 200 || !Array.isArray(r.resolved) || r.resolved.length > 100 || !isCount(r.staleAfterSeconds, 86_400)
    || !isTimestamp(r.asOf)) drift();
  return { open: r.open.map(validateOpen), resolved: r.resolved.map(validateResolved), staleAfterSeconds: r.staleAfterSeconds as number, asOf: r.asOf };
}
