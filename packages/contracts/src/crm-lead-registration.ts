import type { CommandContext } from './index.js';

export const CRM_LEAD_REGISTRATION_PERMISSION = 'crm.lead.register' as const;
export const CRM_LEAD_REGISTRATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CRM_LEAD_REGISTRATION_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' as const;
export type CrmLeadRegistrationPath = 'ADULT' | 'GUARDIAN_CHILD';
export interface CrmLeadRegistrationContext extends CommandContext { externalSubject: string }
export type RegisterCrmLeadInput =
  | { registrationPath: 'ADULT'; birthDate: string; confirmation: typeof CRM_LEAD_REGISTRATION_CONFIRMATION }
  | { registrationPath: 'GUARDIAN_CHILD'; childGivenName: string; childFamilyName: string; childBirthDate: string; confirmation: typeof CRM_LEAD_REGISTRATION_CONFIRMATION };
export type CrmLeadRegistrationResult =
  | { outcome: 'NEEDS_STAFF_REVIEW' }
  | { outcome: 'REGISTERED'; leadId: string; sourceContactPersonId: string; registrationPath: CrmLeadRegistrationPath; studentProfileId: string; familyId: string | null; recordedAt: string };

function invalid(): never { throw new Error('Use one exact registration path, bounded required fields, and the direct-human confirmation.'); }
function text(value: unknown, maximum: number): string { if (typeof value !== 'string' || !value || value.trim() !== value || Array.from(value).length > maximum || /[\u0000-\u001f\u007f<>]/u.test(value)) invalid(); return value; }
function birthDate(value: unknown): string {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) invalid();
  return date;
}
export function validateRegisterCrmLeadInput(value: unknown): asserts value is RegisterCrmLeadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (row.confirmation !== CRM_LEAD_REGISTRATION_CONFIRMATION || typeof row.registrationPath !== 'string') invalid();
  if (row.registrationPath === 'ADULT') {
    if (Object.keys(row).length !== 3 || !Object.hasOwn(row, 'birthDate')) invalid();
    birthDate(row.birthDate); return;
  }
  if (row.registrationPath === 'GUARDIAN_CHILD') {
    if (Object.keys(row).length !== 5 || !Object.hasOwn(row, 'childGivenName') || !Object.hasOwn(row, 'childFamilyName') || !Object.hasOwn(row, 'childBirthDate')) invalid();
    if (!/[\p{L}\p{N}]/u.test(text(row.childGivenName, 100)) || !/[\p{L}\p{N}]/u.test(text(row.childFamilyName, 100))) invalid();
    birthDate(row.childBirthDate); return;
  }
  invalid();
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) invalid(); return value.toLowerCase(); }
function instant(value: unknown): string { if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value; }
export function verifyCrmLeadRegistrationResult(value: unknown, leadId: string, input: RegisterCrmLeadInput): CrmLeadRegistrationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (row.outcome === 'NEEDS_STAFF_REVIEW') { if (Object.keys(row).length !== 1) invalid(); return { outcome: 'NEEDS_STAFF_REVIEW' }; }
  if (row.outcome !== 'REGISTERED' || Object.keys(row).length !== 7) invalid();
  const sourceLead = uuid(row.leadId), sourcePerson = uuid(row.sourceContactPersonId), studentProfileId = uuid(row.studentProfileId);
  if (sourceLead !== uuid(leadId) || row.registrationPath !== input.registrationPath || (row.familyId !== null && typeof row.familyId !== 'string')) invalid();
  const familyId = row.familyId === null ? null : uuid(row.familyId);
  if ((input.registrationPath === 'ADULT') !== (familyId === null)) invalid();
  return { outcome: 'REGISTERED', leadId: sourceLead, sourceContactPersonId: sourcePerson, registrationPath: input.registrationPath, studentProfileId, familyId, recordedAt: instant(row.recordedAt) };
}
