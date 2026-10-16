import { communityUuid } from './community.js';
import { RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION, verifyRetentionReviewAcknowledgementEvidence, verifyRetentionReviewAcknowledgementInput, type RetentionReviewSignals, type RetentionReviewAcknowledgementEvidence, type RetentionReviewAcknowledgementInput } from './retention-review-signals.js';

export const RETENTION_ATTENTION_CODES = ['TERM_ENDING_WITHIN_30_DAYS','TERM_ENDED','RENEWAL_REVIEW_NOT_RECORDED','UNEXCUSED_ABSENCE_RECORDED'] as const;
export const RETENTION_ATTENTION_RESOLUTION_REASONS = ['REVIEW_COMPLETED','EVIDENCE_CHANGED','NO_FURTHER_REVIEW_NEEDED'] as const;
export const RETENTION_ATTENTION_PERMISSIONS = { read: 'retention.review.alert.read', record: 'retention.review.alert.record', resolve: 'retention.review.alert.resolve' } as const;
export type RetentionAttentionCode = typeof RETENTION_ATTENTION_CODES[number];
export type RetentionAttentionResolutionReason = typeof RETENTION_ATTENTION_RESOLUTION_REASONS[number];
export interface RetentionAttentionEvidence extends RetentionReviewAcknowledgementEvidence { attentionCodes: RetentionAttentionCode[] }
export interface RetentionAttentionRecordInput extends RetentionReviewAcknowledgementInput { evidenceCode: RetentionAttentionCode }
export interface RetentionAttentionResolutionInput { alertId: string; expectedAlertVersion: 1; resolutionReason: RetentionAttentionResolutionReason; idempotencyKey: string }
/** Version/state is a projection of immutable root + at most one immutable resolution. */
export interface RetentionAttentionAlert {
  membershipId: string; alertId: string; evidenceCode: RetentionAttentionCode;
  observedAt: string; createdAt: string; alertVersion: 1 | 2; state: 'OPEN' | 'RESOLVED';
  resolvedAt: string | null; resolutionReason: RetentionAttentionResolutionReason | null;
}
export interface RetentionAttentionAlerts { membershipId: string; alerts: RetentionAttentionAlert[] }
function invalid(): never { throw new Error('No verified redacted factual attention result is available.'); }
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value,key))) invalid();
  return value as Record<string,unknown>;
}
function id(value: unknown, expected?: string): string { try { communityUuid(value); } catch { invalid(); } if (expected && value !== expected) invalid(); return value as string; }
function time(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) invalid(); return value as T; }
/** Displayed facts only: never derives an alert from attendance/progression availability. */
export function deriveRetentionAttentionCodes(signals: RetentionReviewSignals): RetentionAttentionCode[] {
  const codes: RetentionAttentionCode[] = [];
  if (signals.membershipTerm.endingObservation === 'ENDING_WITHIN_30_DAYS') codes.push('TERM_ENDING_WITHIN_30_DAYS');
  if (signals.membershipTerm.endingObservation === 'TERM_ENDED') codes.push('TERM_ENDED');
  if (signals.renewalReview.reason === 'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED') codes.push('RENEWAL_REVIEW_NOT_RECORDED');
  if (signals.attendance.status === 'AVAILABLE' && signals.attendance.unexcusedAbsenceCount > 0) codes.push('UNEXCUSED_ABSENCE_RECORDED');
  return codes;
}
export function verifyRetentionAttentionEvidence(value: unknown, membershipId?: string): RetentionAttentionEvidence {
  const source = row(value,['signals','evidenceVersion','evidenceFingerprint','attentionCodes']);
  const evidence = verifyRetentionReviewAcknowledgementEvidence({ signals: source.signals, evidenceVersion: source.evidenceVersion, evidenceFingerprint: source.evidenceFingerprint },membershipId);
  const attentionCodes = deriveRetentionAttentionCodes(evidence.signals);
  if (!Array.isArray(source.attentionCodes) || JSON.stringify(source.attentionCodes) !== JSON.stringify(attentionCodes)) invalid();
  return { ...evidence, attentionCodes };
}
export function verifyRetentionAttentionRecordInput(value: unknown): RetentionAttentionRecordInput {
  const source = row(value,['evidenceVersion','evidenceFingerprint','observedAt','idempotencyKey','evidenceCode']);
  const evidence = verifyRetentionReviewAcknowledgementInput({ evidenceVersion: source.evidenceVersion, evidenceFingerprint: source.evidenceFingerprint, observedAt: source.observedAt, idempotencyKey: source.idempotencyKey });
  return { ...evidence, evidenceCode: choice(source.evidenceCode,RETENTION_ATTENTION_CODES) };
}
export function verifyRetentionAttentionResolutionInput(value: unknown): RetentionAttentionResolutionInput {
  const source = row(value,['alertId','expectedAlertVersion','resolutionReason','idempotencyKey']);
  if (source.expectedAlertVersion !== 1) invalid();
  return { alertId: id(source.alertId), expectedAlertVersion: 1, resolutionReason: choice(source.resolutionReason,RETENTION_ATTENTION_RESOLUTION_REASONS), idempotencyKey: id(source.idempotencyKey) };
}
export function verifyRetentionAttentionAlert(value: unknown, membershipId: string): RetentionAttentionAlert {
  const source = row(value,['membershipId','alertId','evidenceCode','observedAt','createdAt','alertVersion','state','resolvedAt','resolutionReason']);
  const observedAt = time(source.observedAt), createdAt = time(source.createdAt);
  if (Date.parse(createdAt) < Date.parse(observedAt) || Date.parse(createdAt) - Date.parse(observedAt) > 300_000) invalid();
  const state = choice(source.state,['OPEN','RESOLVED'] as const);
  let resolvedAt: string | null = null, resolutionReason: RetentionAttentionResolutionReason | null = null;
  if (state === 'OPEN') { if (source.alertVersion !== 1 || source.resolvedAt !== null || source.resolutionReason !== null) invalid(); }
  else { if (source.alertVersion !== 2) invalid(); resolvedAt = time(source.resolvedAt); resolutionReason = choice(source.resolutionReason,RETENTION_ATTENTION_RESOLUTION_REASONS); if (Date.parse(resolvedAt) < Date.parse(createdAt)) invalid(); }
  return { membershipId: id(source.membershipId,membershipId), alertId: id(source.alertId), evidenceCode: choice(source.evidenceCode,RETENTION_ATTENTION_CODES), observedAt, createdAt, alertVersion: state === 'OPEN' ? 1 : 2, state, resolvedAt, resolutionReason };
}
export function verifyRetentionAttentionAlerts(value: unknown, membershipId: string): RetentionAttentionAlerts {
  const source = row(value,['membershipId','alerts']);
  if (!Array.isArray(source.alerts) || source.alerts.length > 50) invalid();
  const alerts = source.alerts.map(alert => verifyRetentionAttentionAlert(alert,membershipId));
  if (new Set(alerts.map(alert => alert.alertId)).size !== alerts.length) invalid();
  return { membershipId: id(source.membershipId,membershipId), alerts };
}
/** This is the immutable creation receipt. Reload alerts to display later current state. */
export function verifyRetentionAttentionRecord(value: unknown, membershipId: string, input: RetentionAttentionRecordInput): RetentionAttentionAlert {
  const result = verifyRetentionAttentionAlert(value,membershipId);
  if (input.evidenceVersion !== RETENTION_REVIEW_SIGNALS_SCHEMA_VERSION || result.state !== 'OPEN' || result.evidenceCode !== input.evidenceCode || result.observedAt !== input.observedAt) invalid();
  return result;
}
export function verifyRetentionAttentionResolution(value: unknown, membershipId: string, input: RetentionAttentionResolutionInput): RetentionAttentionAlert {
  const result = verifyRetentionAttentionAlert(value,membershipId);
  if (result.state !== 'RESOLVED' || result.alertId !== input.alertId || result.alertVersion !== input.expectedAlertVersion + 1 || result.resolutionReason !== input.resolutionReason) invalid();
  return result;
}
