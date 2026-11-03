import type { RecordAttendanceInput, AttendanceRecordSummary } from '@hon/contracts';
import { currentSchoolClassSessionsUuid } from '@hon/contracts';
import { verifyExactAttendanceEnvelope, validateAttendanceRecordInput } from './attendance-workbench-http';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

export type StudentOperationsScope = Readonly<{ organizationId: string; schoolId: string; studentProfileId: string }>;
export type AttendanceSelection = StudentOperationsScope & Readonly<{ sessionId: string }>;
export type AttendanceCommand = Readonly<{ operation: 'attendance'; selection: AttendanceSelection; path: string; body: string; key: string }>;
export class StudentOperationsError extends Error {
  constructor(readonly status: number, readonly uncertain = false) { super('No verified operation result.'); }
}
function exact(value: object, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new Error('Invalid exact student operation.');
}
export function attendanceSelection(scope: StudentOperationsScope, sessionId: string): AttendanceSelection {
  exact(scope, ['organizationId', 'schoolId', 'studentProfileId']);
  return Object.freeze({ organizationId: currentSchoolClassSessionsUuid(scope.organizationId), schoolId: currentSchoolClassSessionsUuid(scope.schoolId), studentProfileId: currentSchoolClassSessionsUuid(scope.studentProfileId), sessionId: currentSchoolClassSessionsUuid(sessionId) });
}
function path(s: AttendanceSelection): string {
  const v = attendanceSelection({ organizationId: s.organizationId, schoolId: s.schoolId, studentProfileId: s.studentProfileId }, s.sessionId);
  return `/api/v1/organizations/${v.organizationId}/schools/${v.schoolId}/schedule/sessions/${v.sessionId}/attendance`;
}
async function envelope(response: Response, selection: AttendanceSelection, mutation: boolean) {
  if (response.status === 401) reportConfirmedSessionInvalidation();
  if (!response.ok) {
    let processing = false;
    if (response.status === 409) {
      try { const raw = await response.text(); processing = raw.length < 4000 && JSON.parse(raw)?.code === 'IDEMPOTENCY_IN_PROGRESS'; } catch { /* No raw error disclosure. */ }
    }
    throw new StudentOperationsError(response.status, mutation && (processing || ![400,401,403,404,405,409,413,415,422].includes(response.status)));
  }
  try {
    if (![200,201].includes(response.status) || (!mutation && response.status !== 200) || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
    const raw = await response.text(); if (raw.length > 12_000) throw new Error();
    return verifyExactAttendanceEnvelope(JSON.parse(raw), selection, mutation);
  } catch { throw new StudentOperationsError(503, mutation); }
}
const options = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
export async function readStudentAttendance(selection: AttendanceSelection, signal: AbortSignal): Promise<AttendanceRecordSummary | null> {
  let response: Response;
  try { response = await fetch(`${path(selection)}?studentProfileId=${selection.studentProfileId}`, { ...options, method: 'GET', headers: { Accept: 'application/json', 'X-HON-Human-Command': 'attendance' }, signal }); }
  catch { throw new StudentOperationsError(503); }
  return (await envelope(response, selection, false)).attendance;
}
export function prepareStudentAttendance(selection: AttendanceSelection, input: RecordAttendanceInput, key: string): AttendanceCommand {
  exact(selection, ['organizationId', 'schoolId', 'studentProfileId', 'sessionId']);
  exact(input, input.expectedVersion === undefined ? ['studentProfileId','status','category','note'] : ['studentProfileId','status','category','note','expectedVersion']);
  validateAttendanceRecordInput(input);
  if (input.studentProfileId !== selection.studentProfileId) throw new Error('Student mismatch.');
  const normalizedKey = currentSchoolClassSessionsUuid(key);
  if (normalizedKey[14] !== '4') throw new Error('Generated request key required.');
  return Object.freeze({ operation: 'attendance', selection: Object.freeze({ ...selection }), path: path(selection), body: JSON.stringify(input), key: normalizedKey });
}
export async function sendStudentAttendance(command: AttendanceCommand) {
  exact(command, ['operation','selection','path','body','key']);
  const normalized = prepareStudentAttendance(command.selection, JSON.parse(command.body), command.key);
  if (command.operation !== 'attendance' || normalized.path !== command.path || normalized.body !== command.body) throw new Error('Immutable request mismatch.');
  let response: Response;
  try { response = await fetch(command.path, { ...options, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'attendance', 'Idempotency-Key': command.key }, body: command.body }); }
  catch { throw new StudentOperationsError(503, true); }
  const result = await envelope(response, command.selection, true);
  const input: RecordAttendanceInput = JSON.parse(command.body);
  if (!result.attendance || result.attendance.status !== input.status || result.attendance.category !== input.category
    || (result.attendance.note ?? '') !== (input.note?.trim() ?? '')) throw new StudentOperationsError(503, true);
  return result;
}
