import {
  CRM_LEAD_REGISTRATION_CONFIRMATION, validateRegisterCrmLeadInput, verifyCrmLeadRegistrationResult,
  validateFollowUp, type FollowUpInput, type FollowUpQueue, type FollowUpRecord,
  type LeadListItem, type CrmAppointmentSummary, type CrmLeadRegistrationResult,
} from '@hon/contracts';
import { crmLeadListPath, verifyCrmLeadList } from '../crm-leads-http';
import { verifyFollowUpQueue, verifyFollowUpRecord } from '../crm-follow-ups-http';
import { trialSchedulePath, trialOutcomePath, validateScheduleInput, validateOutcomeInput, verifyTrialAppointment, type TrialScheduleInput, type TrialOutcomeInput } from '../trial-appointment-http';
import { prepareCrmLeadClose, parseCrmLeadCloseResult } from '../crm-lead-close-http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { verifyCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import { CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND, verifyCrmGuardianChildEnrollment } from '@hon/contracts';

export type Scope = Readonly<{ organizationId: string; schoolId: string }>;
export type Kind = 'FOLLOW_UP' | 'SCHEDULE' | 'OUTCOME' | 'CLOSE' | 'REGISTER';
export type Command = Readonly<{ kind: Kind; scope: Scope; leadId: string; contactId: string; key: string; body: string; prior: string | null }>;
export type Receipt = { kind: 'FOLLOW_UP'; record: FollowUpRecord } | { kind: 'SCHEDULE' | 'OUTCOME'; record: CrmAppointmentSummary }
  | { kind: 'CLOSE'; record: ReturnType<typeof parseCrmLeadCloseResult>['receipt'] } | { kind: 'REGISTER'; record: CrmLeadRegistrationResult };
export class JourneyError extends Error {
  constructor(readonly kind: 'SESSION' | 'DENIED' | 'REJECTED' | 'UNKNOWN' | 'READ', readonly status = 0) { super(kind); }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function id(v: string): string { if (!UUID.test(v)) throw new JourneyError('REJECTED'); return v.toLowerCase(); }
function closed(v: unknown, keys: string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new JourneyError('UNKNOWN');
}
const registrationPath = (s: Scope, lead: string) => crmLeadListPath(s.organizationId, s.schoolId).split('?')[0] + `/${id(lead)}/register`;
async function request(path: string, signal: AbortSignal, body?: string, key?: string, marker?: string, readOnly = body === undefined): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-HON-Human-Command': marker!, ...(key ? { 'Idempotency-Key': key } : {}) }) }, ...(body === undefined ? {} : { body }) });
  } catch { throw new JourneyError(readOnly ? 'READ' : 'UNKNOWN'); }
  if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new JourneyError('SESSION', 401); }
  if (response.status === 403) throw new JourneyError('DENIED', 403);
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new JourneyError('REJECTED', response.status);
  if (!response.ok) throw new JourneyError(readOnly ? 'READ' : 'UNKNOWN', response.status);
  try {
    if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
    const raw = await response.text(); if (raw.length > 250_000) throw new Error();
    const envelope: unknown = JSON.parse(raw); closed(envelope, path === '/api/identity/me' || path === '/api/v1/staff/current-reporting-school' ? ['data'] : ['data', 'meta']);
    if (body !== undefined) {
      closed(envelope.meta, ['requestId', 'correlationId', 'replayed']);
      if (readOnly && envelope.meta.replayed !== false) throw new Error();
      if (id(String(envelope.meta.requestId)) !== id(String(envelope.meta.correlationId)) || typeof envelope.meta.replayed !== 'boolean') throw new Error();
    }
    return envelope;
  } catch { throw new JourneyError(readOnly ? 'READ' : 'UNKNOWN'); }
}
export async function verifyJourneySession(subject: string, signal: AbortSignal): Promise<void> {
  const envelope = await request('/api/identity/me', signal) as { data: unknown };
  const v = envelope.data;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['externalSubject','displayName','email'].includes(k))) throw new JourneyError('READ');
  if (!subject || !('externalSubject' in v) || v.externalSubject !== subject) { reportConfirmedSessionInvalidation(); throw new JourneyError('SESSION'); }
}
export async function readCurrentSchool(signal: AbortSignal): Promise<Scope | null> {
  const v = verifyCurrentStaffReportingSchool(await request('/api/v1/staff/current-reporting-school', signal));
  return v.state === 'RESOLVED' ? { organizationId: v.organizationId, schoolId: v.schoolId } : null;
}
export async function readRegistration(scope: Scope, row: LeadListItem, signal: AbortSignal): Promise<'NOT_REGISTERED' | 'EXISTING_RECORD'> {
  const path = registrationPath(scope, row.id).replace(/\/register$/, '/guardian-child-enrollment');
  const v = await request(path, signal, '{}', undefined, CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND, true) as { data: unknown };
  const r = verifyCrmGuardianChildEnrollment(v.data, row.id);
  if ('historicalRegistrationReceipt' in r && r.historicalRegistrationReceipt.sourceContactPersonId !== row.primaryPersonId) throw new JourneyError('READ');
  return r.workflowState === 'NOT_REGISTERED' ? 'NOT_REGISTERED' : 'EXISTING_RECORD';
}

export async function readLeads(scope: Scope, signal: AbortSignal): Promise<LeadListItem[]> {
  const v = await request(crmLeadListPath(scope.organizationId, scope.schoolId), signal) as { data: unknown };
  return verifyCrmLeadList(v.data);
}
export async function readQueue(scope: Scope, signal: AbortSignal): Promise<FollowUpQueue> {
  const v = await request('/api/v1/staff/crm/follow-ups?queue=mine&status=ALL', signal) as { data: unknown };
  const q = verifyFollowUpQueue(v.data, 'mine', 'ALL');
  if (q.schoolId !== id(scope.schoolId)) throw new JourneyError('DENIED', 403);
  return q;
}
export function prepareCommand(kind: Kind, scope: Scope, row: LeadListItem, input: unknown, key: string, prior: CrmAppointmentSummary | null = null): Command {
  const s = Object.freeze({ organizationId: id(scope.organizationId), schoolId: id(scope.schoolId) }); id(key); id(row.id); id(row.primaryPersonId);
  if (row.status === 'ARCHIVED') throw new JourneyError('REJECTED');
  if (kind === 'FOLLOW_UP') {
    validateFollowUp('CREATE', input); const b = input as FollowUpInput;
    if (b.leadId !== row.id || b.expectedVersion !== 0) throw new JourneyError('REJECTED');
  } else if (kind === 'SCHEDULE') validateScheduleInput(input as TrialScheduleInput);
  else if (kind === 'OUTCOME') {
    validateOutcomeInput(input as TrialOutcomeInput);
    if (!prior || prior.crmLeadId !== row.id || prior.status !== 'SCHEDULED' || (input as TrialOutcomeInput).expectedVersion !== prior.version) throw new JourneyError('REJECTED');
  } else if (kind === 'CLOSE') prepareCrmLeadClose(s.organizationId, s.schoolId, row, input as Parameters<typeof prepareCrmLeadClose>[3], key);
  else if (kind === 'REGISTER') validateRegisterCrmLeadInput(input);
  else throw new JourneyError('REJECTED');
  return Object.freeze({ kind, scope: s, leadId: id(row.id), contactId: id(row.primaryPersonId), key: id(key), body: JSON.stringify(input), prior: prior ? JSON.stringify(prior) : null });
}
export async function sendCommand(c: Command, signal: AbortSignal): Promise<Receipt> {
  const input = JSON.parse(c.body), prior = c.prior ? JSON.parse(c.prior) as CrmAppointmentSummary : null;
  const root = crmLeadListPath(c.scope.organizationId, c.scope.schoolId).split('?')[0]!;
  const paths: Record<Kind, string> = { FOLLOW_UP: '/api/v1/staff/crm/follow-ups', SCHEDULE: trialSchedulePath(c.scope.organizationId, c.scope.schoolId, c.leadId),
    OUTCOME: prior ? trialOutcomePath(c.scope.organizationId, c.scope.schoolId, prior.id) : '', CLOSE: `${root}/${id(c.leadId)}/close`, REGISTER: registrationPath(c.scope, c.leadId) };
  const markers: Record<Kind, string> = { FOLLOW_UP: 'crm-follow-ups', SCHEDULE: 'crm-trial-appointment', OUTCOME: 'crm-trial-appointment', CLOSE: 'crm-lead-close', REGISTER: 'crm-lead-register' };
  if (!paths[c.kind] || !UUID.test(c.key)) throw new JourneyError('REJECTED');
  const v = await request(paths[c.kind], signal, c.body, c.key, markers[c.kind]) as { data: unknown };
  try {
    if (c.kind === 'FOLLOW_UP') {
      const r = verifyFollowUpRecord(v.data); validateFollowUp('CREATE', input); const fields = input as FollowUpInput;
      if (r.schoolId !== c.scope.schoolId || r.leadId !== c.leadId || r.assigneeId !== fields.assigneeId || r.version !== 1 || r.status !== 'OPEN'
        || ['subject', 'note', 'priority', 'dueAt'].some(k => r[k as keyof FollowUpRecord] !== fields[k as keyof FollowUpInput])) throw new Error();
      return { kind: c.kind, record: r };
    }
    if (c.kind === 'SCHEDULE' || c.kind === 'OUTCOME') return { kind: c.kind, record: verifyTrialAppointment(v.data, { leadId: c.leadId,
      ...(c.kind === 'SCHEDULE' ? { schedule: input } : { prior: prior!, outcome: input.status }) }) };
    if (c.kind === 'CLOSE') return { kind: c.kind, record: parseCrmLeadCloseResult(v, { ...c.scope, path: paths.CLOSE, leadId: c.leadId, key: c.key, body: c.body }).receipt };
    validateRegisterCrmLeadInput(input);
    const r = verifyCrmLeadRegistrationResult(v.data, c.leadId, input);
    if (r.outcome === 'REGISTERED' && r.sourceContactPersonId !== c.contactId) throw new Error();
    return { kind: 'REGISTER', record: r };
  } catch { throw new JourneyError('UNKNOWN'); }
}
export { CRM_LEAD_REGISTRATION_CONFIRMATION };
