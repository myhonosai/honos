// S4-c HQ emergency AI spend pause. Only a human HQ owner may pause or resume (the database enforces it). A pause
// covers one organization or the whole platform (organizationId null) for one spend class or ALL, and it refuses new
// AI work before any provider call. Pause records are append-only; resuming ends a pause, it never deletes one.
import { championsDrift as drift, championsExactKeys as exactKeys, championsInvalid as invalid, championsIsTimestamp as isTimestamp,
  championsIsUuid as isUuid, championsRecord as record } from './champions-club.js';

export const AI_SPEND_PAUSE_CLASSES = ['AGENT_INFERENCE', 'CREATIVE_MEDIA', 'ALL'] as const;
export type AiSpendPauseClass = typeof AI_SPEND_PAUSE_CLASSES[number];
export type AiSpendPauseAction = 'PAUSE' | 'RESUME';
export type AiSpendPauseStatus = 'ACTIVE' | 'ENDED';

export interface AiSpendPauseInput { action: AiSpendPauseAction; organizationId: string | null; spendClass: AiSpendPauseClass; reason: string }
export interface AiSpendPauseReceipt { pauseId: string; organizationId: string | null; spendClass: AiSpendPauseClass; status: AiSpendPauseStatus; replayed: boolean }
export interface AiSpendPause {
  pauseId: string; organizationId: string | null; spendClass: AiSpendPauseClass; reason: string; pausedAt: string; pausedByPrincipalId: string;
  status: AiSpendPauseStatus; endReason: string | null; endedAt: string | null; endedByPrincipalId: string | null;
}
/** At most 200 pauses, active first, then newest. */
export interface AiSpendPauseList { pauses: AiSpendPause[]; asOf: string }

const isClass = (v: unknown): v is AiSpendPauseClass => (AI_SPEND_PAUSE_CLASSES as readonly unknown[]).includes(v);
const isReason = (v: unknown): v is string => typeof v === 'string' && v === v.trim() && v.length >= 10 && v.length <= 500;
const orgOrNull = (v: unknown) => v === null || isUuid(v);

export function validateAiSpendPauseInput(value: unknown): AiSpendPauseInput {
  const r = record(value, invalid); exactKeys(r, ['action', 'organizationId', 'spendClass', 'reason'], invalid);
  if ((r.action !== 'PAUSE' && r.action !== 'RESUME') || !orgOrNull(r.organizationId) || !isClass(r.spendClass) || !isReason(r.reason)) invalid();
  return { action: r.action, organizationId: (r.organizationId as string | null), spendClass: r.spendClass, reason: r.reason };
}

export function validateAiSpendPauseReceipt(value: unknown): AiSpendPauseReceipt {
  const r = record(value, drift); exactKeys(r, ['pauseId', 'organizationId', 'spendClass', 'status', 'replayed'], drift);
  if (!isUuid(r.pauseId) || !orgOrNull(r.organizationId) || !isClass(r.spendClass) || (r.status !== 'ACTIVE' && r.status !== 'ENDED')
    || typeof r.replayed !== 'boolean') drift();
  return r as unknown as AiSpendPauseReceipt;
}

function validatePause(value: unknown): AiSpendPause {
  const r = record(value, drift);
  exactKeys(r, ['pauseId', 'organizationId', 'spendClass', 'reason', 'pausedAt', 'pausedByPrincipalId', 'status', 'endReason', 'endedAt', 'endedByPrincipalId'], drift);
  const ended = r.status === 'ENDED';
  if (!isUuid(r.pauseId) || !orgOrNull(r.organizationId) || !isClass(r.spendClass) || !isReason(r.reason) || !isTimestamp(r.pausedAt)
    || !isUuid(r.pausedByPrincipalId) || (r.status !== 'ACTIVE' && !ended)) drift();
  if (ended ? !(isReason(r.endReason) && isTimestamp(r.endedAt) && isUuid(r.endedByPrincipalId))
    : !(r.endReason === null && r.endedAt === null && r.endedByPrincipalId === null)) drift();
  return r as unknown as AiSpendPause;
}

export function validateAiSpendPauseList(value: unknown): AiSpendPauseList {
  const r = record(value, drift); exactKeys(r, ['pauses', 'asOf'], drift);
  if (!Array.isArray(r.pauses) || r.pauses.length > 200 || !isTimestamp(r.asOf)) drift();
  return { pauses: r.pauses.map(validatePause), asOf: r.asOf };
}
