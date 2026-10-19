import type { CommandContext } from './index.js';

export const CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION' as const;
export const CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_CRM_MEMBERSHIP_DRAFT' as const;
export const CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The only selector accepted by guardian-child preparation and current-confirmation reads. */
export interface CrmGuardianChildPayerDesignationPreparationInput { studentProfileId: string }
export interface CrmGuardianChildPayerDesignationInput extends CrmGuardianChildPayerDesignationPreparationInput {
  confirmation: typeof CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION;
}
export interface CrmGuardianChildMembershipPreparationInput { studentProfileId: string }
export interface CrmGuardianChildMembershipDraftConfirmationInput { studentProfileId: string }
export interface CrmGuardianChildMembershipDraftInput extends CrmGuardianChildMembershipPreparationInput {
  planCode: string;
  termStartedAt?: string;
  termEndsAt?: string;
  confirmation: typeof CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION;
}

/** Response labels are bounded display facts only; no guardian, family, account, or source identifiers are exposed. */
export interface CrmGuardianChildPayerDesignationPreparation {
  studentDisplayName: string;
  guardianDisplayName: string;
  currency: string;
  readiness: 'READY_FOR_PAYER_DESIGNATION';
}
export interface CrmGuardianChildPayerDesignationReceipt {
  studentDisplayName: string;
  guardianDisplayName: string;
  currency: string;
  state: 'PAYER_DESIGNATED';
  recordedAt: string;
}
export interface CrmGuardianChildMembershipPreparation {
  studentDisplayName: string;
  guardianDisplayName: string;
  currency: string;
  readiness: 'READY_FOR_DRAFT';
}
/** Historical command receipt only. It deliberately omits account, payer, guardian, family, and conversion facts. */
export interface CrmGuardianChildMembershipDraftReceipt {
  membershipId: string;
  state: 'DRAFT';
  planCode: string;
  termStartedAt: string | null;
  termEndsAt: string | null;
  recordedAt: string;
}
/** Current observation only; distinct from stored command replay. */
export interface CrmGuardianChildMembershipDraftConfirmation {
  state: 'RECORDED_DRAFT';
  receipt: CrmGuardianChildMembershipDraftReceipt;
}
export interface CrmGuardianChildMembershipDraftContext extends CommandContext { externalSubject: string }

export interface CrmGuardianChildPayerDesignationPreparationApiResponse {
  data: CrmGuardianChildPayerDesignationPreparation;
  meta: { requestId: string; correlationId: string; replayed: false };
}
export interface CrmGuardianChildPayerDesignationApiResponse {
  data: CrmGuardianChildPayerDesignationReceipt;
  meta: { requestId: string; correlationId: string; replayed: boolean };
}
export interface CrmGuardianChildMembershipPreparationApiResponse {
  data: CrmGuardianChildMembershipPreparation;
  meta: { requestId: string; correlationId: string; replayed: false };
}
export interface CrmGuardianChildMembershipDraftConfirmationApiResponse {
  data: CrmGuardianChildMembershipDraftConfirmation;
  meta: { requestId: string; correlationId: string; replayed: false };
}
export interface CrmGuardianChildMembershipDraftApiResponse {
  data: CrmGuardianChildMembershipDraftReceipt;
  meta: { requestId: string; correlationId: string; replayed: boolean };
}

function invalid(): never { throw new Error('Unverified guardian-child CRM membership draft data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) invalid();
  return row;
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value, keys);
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID.test(value)) invalid();
  return value.toLowerCase();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) invalid();
  return value;
}
/** Canonical UTC milliseconds only; finite years 1900..9999 and real calendar dates. */
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid();
  return value;
}
function preparationInput(value: unknown): { studentProfileId: string } {
  const row = exactRecord(value, ['studentProfileId']);
  return { studentProfileId: uuid(row.studentProfileId) };
}

export function validateCrmGuardianChildPayerDesignationPreparationInput(value: unknown): CrmGuardianChildPayerDesignationPreparationInput {
  return preparationInput(value);
}
export function validateCrmGuardianChildPayerDesignationInput(value: unknown): CrmGuardianChildPayerDesignationInput {
  const row = exactRecord(value, ['studentProfileId', 'confirmation']);
  if (row.confirmation !== CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION) invalid();
  return { studentProfileId: uuid(row.studentProfileId), confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION };
}
export function validateCrmGuardianChildMembershipPreparationInput(value: unknown): CrmGuardianChildMembershipPreparationInput {
  return preparationInput(value);
}
export function validateCrmGuardianChildMembershipDraftConfirmationInput(value: unknown): CrmGuardianChildMembershipDraftConfirmationInput {
  return preparationInput(value);
}
export function validateCrmGuardianChildMembershipDraftInput(value: unknown): CrmGuardianChildMembershipDraftInput {
  const row = record(value, ['studentProfileId', 'planCode', 'termStartedAt', 'termEndsAt', 'confirmation']);
  if (!Object.hasOwn(row, 'studentProfileId') || !Object.hasOwn(row, 'planCode') || !Object.hasOwn(row, 'confirmation')
    || row.confirmation !== CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION) invalid();
  const out: CrmGuardianChildMembershipDraftInput = {
    studentProfileId: uuid(row.studentProfileId),
    planCode: text(row.planCode, 80),
    confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION,
  };
  if (Object.hasOwn(row, 'termStartedAt')) out.termStartedAt = instant(row.termStartedAt);
  if (Object.hasOwn(row, 'termEndsAt')) out.termEndsAt = instant(row.termEndsAt);
  if (out.termStartedAt && out.termEndsAt && Date.parse(out.termEndsAt) <= Date.parse(out.termStartedAt)) invalid();
  return out;
}

export function verifyCrmGuardianChildPayerDesignationPreparation(value: unknown): CrmGuardianChildPayerDesignationPreparation {
  const row = exactRecord(value, ['studentDisplayName', 'guardianDisplayName', 'currency', 'readiness']);
  if (row.readiness !== 'READY_FOR_PAYER_DESIGNATION') invalid();
  return {
    studentDisplayName: text(row.studentDisplayName, 201),
    guardianDisplayName: text(row.guardianDisplayName, 201),
    currency: currency(row.currency),
    readiness: 'READY_FOR_PAYER_DESIGNATION',
  };
}
export function verifyCrmGuardianChildPayerDesignationReceipt(value: unknown): CrmGuardianChildPayerDesignationReceipt {
  const row = exactRecord(value, ['studentDisplayName', 'guardianDisplayName', 'currency', 'state', 'recordedAt']);
  if (row.state !== 'PAYER_DESIGNATED') invalid();
  return {
    studentDisplayName: text(row.studentDisplayName, 201),
    guardianDisplayName: text(row.guardianDisplayName, 201),
    currency: currency(row.currency),
    state: 'PAYER_DESIGNATED',
    recordedAt: instant(row.recordedAt),
  };
}
export function verifyCrmGuardianChildMembershipPreparation(value: unknown): CrmGuardianChildMembershipPreparation {
  const row = exactRecord(value, ['studentDisplayName', 'guardianDisplayName', 'currency', 'readiness']);
  if (row.readiness !== 'READY_FOR_DRAFT') invalid();
  return {
    studentDisplayName: text(row.studentDisplayName, 201),
    guardianDisplayName: text(row.guardianDisplayName, 201),
    currency: currency(row.currency),
    readiness: 'READY_FOR_DRAFT',
  };
}
export function verifyCrmGuardianChildMembershipDraftReceipt(value: unknown, input?: CrmGuardianChildMembershipDraftInput): CrmGuardianChildMembershipDraftReceipt {
  const row = exactRecord(value, ['membershipId', 'state', 'planCode', 'termStartedAt', 'termEndsAt', 'recordedAt']);
  if (row.state !== 'DRAFT') invalid();
  const receipt: CrmGuardianChildMembershipDraftReceipt = {
    membershipId: uuid(row.membershipId),
    state: 'DRAFT',
    planCode: text(row.planCode, 80),
    termStartedAt: row.termStartedAt === null ? null : instant(row.termStartedAt),
    termEndsAt: row.termEndsAt === null ? null : instant(row.termEndsAt),
    recordedAt: instant(row.recordedAt),
  };
  if (receipt.termStartedAt && receipt.termEndsAt && Date.parse(receipt.termEndsAt) <= Date.parse(receipt.termStartedAt)) invalid();
  if (input && (receipt.planCode !== input.planCode || receipt.termStartedAt !== (input.termStartedAt ?? null) || receipt.termEndsAt !== (input.termEndsAt ?? null))) invalid();
  return receipt;
}
export function verifyCrmGuardianChildMembershipDraftConfirmation(value: unknown): CrmGuardianChildMembershipDraftConfirmation {
  const row = exactRecord(value, ['state', 'receipt']);
  if (row.state !== 'RECORDED_DRAFT') invalid();
  return { state: 'RECORDED_DRAFT', receipt: verifyCrmGuardianChildMembershipDraftReceipt(row.receipt) };
}

function verifyMeta(value: unknown, replayed: boolean | undefined): { requestId: string; correlationId: string; replayed: boolean } {
  const row = exactRecord(value, ['requestId', 'correlationId', 'replayed']);
  if (typeof row.replayed !== 'boolean' || replayed !== undefined && row.replayed !== replayed) invalid();
  return { requestId: uuid(row.requestId), correlationId: uuid(row.correlationId), replayed: row.replayed };
}
function verifyEnvelope<T>(value: unknown, data: (candidate: unknown) => T, replayed: boolean | undefined): { data: T; meta: { requestId: string; correlationId: string; replayed: boolean } } {
  const row = exactRecord(value, ['data', 'meta']);
  return { data: data(row.data), meta: verifyMeta(row.meta, replayed) };
}
export function verifyCrmGuardianChildPayerDesignationPreparationApiResponse(value: unknown): CrmGuardianChildPayerDesignationPreparationApiResponse {
  return verifyEnvelope(value, verifyCrmGuardianChildPayerDesignationPreparation, false) as CrmGuardianChildPayerDesignationPreparationApiResponse;
}
export function verifyCrmGuardianChildPayerDesignationApiResponse(value: unknown): CrmGuardianChildPayerDesignationApiResponse {
  return verifyEnvelope(value, verifyCrmGuardianChildPayerDesignationReceipt, undefined) as CrmGuardianChildPayerDesignationApiResponse;
}
export function verifyCrmGuardianChildMembershipPreparationApiResponse(value: unknown): CrmGuardianChildMembershipPreparationApiResponse {
  return verifyEnvelope(value, verifyCrmGuardianChildMembershipPreparation, false) as CrmGuardianChildMembershipPreparationApiResponse;
}
export function verifyCrmGuardianChildMembershipDraftConfirmationApiResponse(value: unknown): CrmGuardianChildMembershipDraftConfirmationApiResponse {
  return verifyEnvelope(value, verifyCrmGuardianChildMembershipDraftConfirmation, false) as CrmGuardianChildMembershipDraftConfirmationApiResponse;
}
export function verifyCrmGuardianChildMembershipDraftApiResponse(value: unknown, input?: CrmGuardianChildMembershipDraftInput): CrmGuardianChildMembershipDraftApiResponse {
  return verifyEnvelope(value, candidate => verifyCrmGuardianChildMembershipDraftReceipt(candidate, input), undefined) as CrmGuardianChildMembershipDraftApiResponse;
}
