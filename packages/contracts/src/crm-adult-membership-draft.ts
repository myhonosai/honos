import type { CommandContext } from './index.js';

export const CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' as const;
export const CRM_ADULT_MEMBERSHIP_DRAFT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface CrmAdultMembershipPreparationInput { studentProfileId: string }
/** No record identifiers, directory, account details, or historical facts. */
export interface CrmAdultMembershipPreparation { studentDisplayName: string; currency: string; readiness: 'READY_FOR_DRAFT' }
export interface CrmAdultMembershipDraftInput extends CrmAdultMembershipPreparationInput {
  planCode: string;
  termStartedAt?: string;
  termEndsAt?: string;
  confirmation: typeof CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION;
}
export interface CrmAdultMembershipDraftReceipt {
  membershipId: string;
  state: 'DRAFT';
  planCode: string;
  termStartedAt: string | null;
  termEndsAt: string | null;
  recordedAt: string;
}
export interface CrmAdultMembershipDraftContext extends CommandContext { externalSubject: string }
export interface CrmAdultMembershipPreparationApiResponse { data: CrmAdultMembershipPreparation; meta: { requestId: string; correlationId: string; replayed: false } }
export interface CrmAdultMembershipDraftApiResponse { data: CrmAdultMembershipDraftReceipt; meta: { requestId: string; correlationId: string; replayed: boolean } }

function invalid(): never { throw new Error('Unverified adult CRM membership draft data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !CRM_ADULT_MEMBERSHIP_DRAFT_UUID.test(value)) invalid();
  return value.toLowerCase();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) invalid();
  return value;
}
/** Canonical UTC milliseconds only; finite years 1900..9999, real calendar dates. */
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
export function validateCrmAdultMembershipPreparationInput(value: unknown): CrmAdultMembershipPreparationInput {
  const row = record(value, ['studentProfileId']);
  return { studentProfileId: uuid(row.studentProfileId) };
}
export function validateCrmAdultMembershipDraftInput(value: unknown): CrmAdultMembershipDraftInput {
  const row = record(value, ['studentProfileId','planCode','termStartedAt','termEndsAt','confirmation']);
  if (row.confirmation !== CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION) invalid();
  const out: CrmAdultMembershipDraftInput = { studentProfileId: uuid(row.studentProfileId), planCode: text(row.planCode, 80), confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION };
  if (Object.hasOwn(row, 'termStartedAt')) out.termStartedAt = instant(row.termStartedAt);
  if (Object.hasOwn(row, 'termEndsAt')) out.termEndsAt = instant(row.termEndsAt);
  if (out.termStartedAt && out.termEndsAt && Date.parse(out.termEndsAt) <= Date.parse(out.termStartedAt)) invalid();
  return out;
}
export function verifyCrmAdultMembershipPreparation(value: unknown): CrmAdultMembershipPreparation {
  const row = record(value, ['studentDisplayName','currency','readiness']);
  if (Object.keys(row).length !== 3 || row.readiness !== 'READY_FOR_DRAFT' || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) invalid();
  return { studentDisplayName: text(row.studentDisplayName, 201), currency: row.currency, readiness: 'READY_FOR_DRAFT' };
}
export function verifyCrmAdultMembershipDraftReceipt(value: unknown, input?: CrmAdultMembershipDraftInput): CrmAdultMembershipDraftReceipt {
  const row = record(value, ['membershipId','state','planCode','termStartedAt','termEndsAt','recordedAt']);
  if (Object.keys(row).length !== 6 || row.state !== 'DRAFT') invalid();
  const receipt: CrmAdultMembershipDraftReceipt = { membershipId: uuid(row.membershipId), state: 'DRAFT', planCode: text(row.planCode, 80), termStartedAt: row.termStartedAt === null ? null : instant(row.termStartedAt), termEndsAt: row.termEndsAt === null ? null : instant(row.termEndsAt), recordedAt: instant(row.recordedAt) };
  if (receipt.termStartedAt && receipt.termEndsAt && Date.parse(receipt.termEndsAt) <= Date.parse(receipt.termStartedAt)) invalid();
  if (input && (receipt.planCode !== input.planCode || receipt.termStartedAt !== (input.termStartedAt ?? null) || receipt.termEndsAt !== (input.termEndsAt ?? null))) invalid();
  return receipt;
}
