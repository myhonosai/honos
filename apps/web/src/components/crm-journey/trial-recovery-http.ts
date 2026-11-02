import { CRM_APPOINTMENT_STATUSES, type CrmAppointmentSummary } from '@hon/contracts';
import { JourneyError, type Scope } from './http';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

export type TrialRecovery = { activeTrial: CrmAppointmentSummary | null; trials: CrmAppointmentSummary[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_BYTES = 512 * 1024;
function invalid(): never { throw new JourneyError('READ'); }
function id(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function instant(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const parts = INSTANT.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) invalid();
  const [, y, m, d, h, minute, second] = parts;
  const year = Number(y), month = Number(m), day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || Number(h) > 23 || Number(minute) > 59 || Number(second) > 59) invalid();
  return value;
}
function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  // Saved rows are not new-command input: preserve their text instead of imposing trim normalization.
  if (typeof value !== 'string' || Array.from(value).length > maximum) invalid();
  return value;
}

/** A current saved row, not a version-one scheduling receipt or a new-command clock check. */
function appointment(value: unknown, leadId: string): CrmAppointmentSummary {
  const v = closed(value, ['id','crmLeadId','appointmentType','status','startsAt','endsAt','createdByPrincipalId','version','createdAt','updatedAt'], ['location','notes']);
  const lead = id(v.crmLeadId), startsAt = instant(v.startsAt), endsAt = instant(v.endsAt);
  if (lead !== id(leadId) || v.appointmentType !== 'TRIAL'
    || !CRM_APPOINTMENT_STATUSES.includes(v.status as CrmAppointmentSummary['status'])
    || typeof v.version !== 'number' || !Number.isSafeInteger(v.version) || v.version < 1
    || Date.parse(endsAt) <= Date.parse(startsAt)) invalid();
  const location = optionalText(v.location, 160), notes = optionalText(v.notes, 2000);
  return {
    id: id(v.id), crmLeadId: lead, appointmentType: 'TRIAL', status: v.status as CrmAppointmentSummary['status'],
    startsAt, endsAt, createdByPrincipalId: id(v.createdByPrincipalId), version: v.version,
    createdAt: instant(v.createdAt), updatedAt: instant(v.updatedAt),
    ...(location === undefined ? {} : { location }), ...(notes === undefined ? {} : { notes }),
  };
}
function recovery(value: unknown, leadId: string): TrialRecovery {
  const v = closed(value, ['activeTrial','trials']);
  if (!Array.isArray(v.trials) || v.trials.length > 50) invalid();
  const trials = v.trials.map(row => appointment(row, leadId)), seen = new Set<string>();
  for (let index = 0; index < trials.length; index++) {
    const row = trials[index]!;
    if (seen.has(row.id)) invalid(); seen.add(row.id);
    const previous = trials[index - 1];
    // PostgreSQL orders microseconds; serialized JS Dates lose that precision. Equal displayed instants
    // cannot prove an actual database tie, so retain the server order without imposing a UUID tie-break.
    if (previous && Date.parse(previous.createdAt) < Date.parse(row.createdAt)) invalid();
  }
  const activeTrial = v.activeTrial === null ? null : appointment(v.activeTrial, leadId);
  if (activeTrial) {
    if (activeTrial.status !== 'SCHEDULED') invalid();
    const listed = trials.find(row => row.id === activeTrial.id);
    if (listed && JSON.stringify(listed) !== JSON.stringify(activeTrial)) invalid();
    // The server independently finds the active row; it can be older than all 50 history rows.
  }
  return { activeTrial, trials };
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted(); if (!response.body) invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > MAX_BYTES) invalid();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}
async function read(path: string, signal: AbortSignal): Promise<unknown> {
  try {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]); bounded.throwIfAborted();
    const response = await fetch(path, { method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: bounded });
    bounded.throwIfAborted();
    if (response.status === 401) { reportConfirmedSessionInvalidation(); throw new JourneyError('SESSION', 401); }
    if (response.status === 403) throw new JourneyError('DENIED', 403);
    if (response.status !== 200) throw new JourneyError('READ', response.status);
    if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')
      || !/(?:^|,)\s*private\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')
      || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('Cache-Control') ?? '')) invalid();
    if (response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)) invalid();
    const envelope = closed(await boundedJson(response, bounded), ['data','meta']);
    const meta = closed(envelope.meta, ['requestId','correlationId']);
    if (id(meta.requestId) !== id(meta.correlationId)) invalid();
    return envelope.data;
  } catch (error) { if (error instanceof JourneyError) throw error; throw new JourneyError('READ'); }
}
function root(scope: Scope): string {
  const v = closed(scope, ['organizationId','schoolId']);
  return `/api/v1/organizations/${id(v.organizationId)}/schools/${id(v.schoolId)}/crm`;
}
export async function readTrialRecovery(scope: Scope, leadId: string, signal: AbortSignal): Promise<TrialRecovery> {
  const lead = id(leadId);
  return recovery(await read(`${root(scope)}/leads/${lead}/trials`, signal), lead);
}
export async function readTrialDetail(scope: Scope, leadId: string, appointmentId: string, signal: AbortSignal): Promise<CrmAppointmentSummary> {
  const lead = id(leadId), requested = id(appointmentId);
  const row = appointment(await read(`${root(scope)}/appointments/${requested}`, signal), lead);
  if (row.id !== requested) invalid();
  return row;
}

/** Return only a verified existing row; never expose the upstream conflict detail or infer submitted times. */
export function parseTrialConflict(value: unknown, leadId: string): CrmAppointmentSummary | null {
  if (!value || typeof value !== 'object' || (value as { code?: unknown }).code !== 'TRIAL_ALREADY_SCHEDULED') return null;
  const v = closed(value, ['code','detail','existingAppointment']);
  if (typeof v.detail !== 'string' || !v.detail.trim() || v.detail.length > 2048) invalid();
  const existing = appointment(v.existingAppointment, id(leadId));
  if (existing.status !== 'SCHEDULED') invalid();
  return existing;
}
