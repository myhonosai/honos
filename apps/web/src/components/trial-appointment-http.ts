import type { CrmAppointmentSummary, CrmTrialOutcomeStatus } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] as const;

export class TrialAppointmentAccessError extends Error {}

export type TrialScheduleInput = { startsAt: string; endsAt: string; location?: string; notes?: string };
export type TrialOutcomeInput = { status: CrmTrialOutcomeStatus; outcomeNotes?: string; expectedVersion: number };

function invalid(): never { throw new Error('Unverified trial appointment result. No calendar, booking, enrollment, message, or outcome success is assumed.'); }
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function instant(value: unknown): asserts value is string { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(); }
function text(value: unknown, maximum: number): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > maximum) invalid(); }
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}

export function trialSchedulePath(organizationId: string, schoolId: string, leadId: string): string {
  uuid(organizationId); uuid(schoolId); uuid(leadId);
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/crm/leads/${leadId.toLowerCase()}/trials`;
}

export function trialOutcomePath(organizationId: string, schoolId: string, appointmentId: string): string {
  uuid(organizationId); uuid(schoolId); uuid(appointmentId);
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/crm/appointments/${appointmentId.toLowerCase()}/outcome`;
}

export function verifyTrialAppointment(value: unknown, expected: { leadId: string; schedule?: Pick<TrialScheduleInput, 'startsAt' | 'endsAt'>; prior?: CrmAppointmentSummary; outcome?: CrmTrialOutcomeStatus }): CrmAppointmentSummary {
  closed(value, ['id', 'crmLeadId', 'appointmentType', 'status', 'startsAt', 'endsAt', 'createdByPrincipalId', 'version', 'createdAt', 'updatedAt'], ['location', 'notes']);
  uuid(value.id); uuid(value.crmLeadId); uuid(value.createdByPrincipalId); instant(value.startsAt); instant(value.endsAt); instant(value.createdAt); instant(value.updatedAt);
  uuid(expected.leadId);
  if (value.crmLeadId.toLowerCase() !== expected.leadId.toLowerCase() || value.appointmentType !== 'TRIAL' || !STATUSES.includes(value.status as typeof STATUSES[number]) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || Date.parse(value.endsAt as string) <= Date.parse(value.startsAt as string)) invalid();
  if (value.location !== undefined) text(value.location, 160);
  if (value.notes !== undefined) text(value.notes, 2000);
  if (expected.prior) {
    if (value.id.toLowerCase() !== expected.prior.id.toLowerCase() || value.startsAt !== expected.prior.startsAt || value.endsAt !== expected.prior.endsAt || value.version !== expected.prior.version + 1 || value.status !== expected.outcome) invalid();
  } else if (!expected.schedule || value.status !== 'SCHEDULED' || value.version !== 1 || Date.parse(value.startsAt as string) !== Date.parse(expected.schedule.startsAt) || Date.parse(value.endsAt as string) !== Date.parse(expected.schedule.endsAt)) invalid();
  return value as unknown as CrmAppointmentSummary;
}

function validateScheduleInput(input: TrialScheduleInput): TrialScheduleInput {
  closed(input, ['startsAt', 'endsAt'], ['location', 'notes']); instant(input.startsAt); instant(input.endsAt);
  if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) invalid();
  if (input.location !== undefined) text(input.location, 160);
  if (input.notes !== undefined) text(input.notes, 2000);
  return input;
}

function validateOutcomeInput(input: TrialOutcomeInput): TrialOutcomeInput {
  closed(input, ['status', 'expectedVersion'], ['outcomeNotes']);
  if (!['COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(input.status) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) invalid();
  if (input.outcomeNotes !== undefined) text(input.outcomeNotes, 2000);
  return input;
}

async function command(path: string, body: object, key: string): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) invalid();
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-trial-appointment' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human school session.'
      : response.status === 403 ? 'Current human trial permission or exact school scope is unavailable.'
        : response.status === 404 ? 'The current lead or trial appointment is unavailable in this school.'
          : response.status === 409 ? 'The trial appointment changed or this retry key conflicts. No outcome is assumed.'
            : 'The trial command is unavailable. Retry the exact same retained request; do not assume success.';
    throw new (response.status === 401 || response.status === 403 ? TrialAppointmentAccessError : Error)(message);
  }
  const envelope: unknown = await response.json();
  closed(envelope, ['data', 'meta']);
  return envelope.data;
}

export async function scheduleTrial(organizationId: string, schoolId: string, leadId: string, input: TrialScheduleInput, key: string): Promise<CrmAppointmentSummary> {
  const normalized = validateScheduleInput(input);
  return verifyTrialAppointment(await command(trialSchedulePath(organizationId, schoolId, leadId), normalized, key), { leadId, schedule: normalized });
}

export async function recordTrialOutcome(organizationId: string, schoolId: string, appointment: CrmAppointmentSummary, input: TrialOutcomeInput, key: string): Promise<CrmAppointmentSummary> {
  const normalized = validateOutcomeInput(input);
  return verifyTrialAppointment(await command(trialOutcomePath(organizationId, schoolId, appointment.id), normalized, key), { leadId: appointment.crmLeadId, prior: appointment, outcome: normalized.status });
}
