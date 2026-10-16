import {
  ATTENDANCE_CATEGORIES,
  ATTENDANCE_STATUSES,
  ATTENDANCE_WEIGHT_MAX,
  type AttendanceCategory,
  type AttendanceCategoryPolicy,
  type AttendanceProgressionPolicy,
  type AttendanceRecordSummary,
  type AttendanceStatus,
  type ConfigureAttendancePolicyInput,
  type RecordAttendanceInput,
} from '@hon/contracts';

const API_BASE = '/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const VERSION_MAX = 2_147_483_646;

export type AttendanceKnownScope = {
  organizationId: string;
  schoolId: string;
  programId: string;
  sessionId: string;
  studentProfileId: string;
};

type AttendanceOperation = 'POLICY_LOAD' | 'POLICY_SAVE' | 'RECORD_LOAD' | 'RECORD_SAVE';
type ResponseMeta = { requestId: string; correlationId: string; replayed?: boolean };

export class AttendanceWorkbenchUiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function invalid(): never {
  throw new Error('The attendance result was not verified for this exact request. No load, save, or attendance outcome is assumed.');
}

function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}

function optionalClosed(value: unknown, required: readonly string[], optional: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const fields = Object.keys(value);
  if (required.some(field => !Object.hasOwn(value, field)) || fields.some(field => !required.includes(field) && !optional.includes(field))) invalid();
}

function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
}

function version(value: unknown, allowZero = false): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > VERSION_MAX) invalid();
}

function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid();
}

function key(value: string): void {
  if (!value || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('A generated retained idempotency key is required for this exact unchanged command.');
}

function requiredScope(scope: AttendanceKnownScope): void {
  for (const value of [scope.organizationId, scope.schoolId, scope.programId, scope.sessionId, scope.studentProfileId]) {
    if (!UUID.test(value)) throw new Error('Use only the five exact already-known UUIDs. Names, searches, URLs, query selectors, and inferred scope are not accepted.');
  }
}

function policyPath(scope: AttendanceKnownScope): string {
  return `${API_BASE}/organizations/${scope.organizationId}/schools/${scope.schoolId}/programs/${scope.programId}/attendance-policy`;
}

function recordPath(scope: AttendanceKnownScope): string {
  return `${API_BASE}/organizations/${scope.organizationId}/schools/${scope.schoolId}/schedule/sessions/${scope.sessionId}/attendance`;
}

/** Fixed, generated paths only. This is intentionally not a general URL client. */
export const attendancePaths = {
  policy(scope: AttendanceKnownScope): string {
    requiredScope(scope);
    return policyPath(scope);
  },
  record(scope: AttendanceKnownScope): string {
    requiredScope(scope);
    return recordPath(scope);
  },
  exactRecordLookup(scope: AttendanceKnownScope): string {
    requiredScope(scope);
    return `${recordPath(scope)}?studentProfileId=${scope.studentProfileId}`;
  },
};

/** Used internally and in focused tests to prove that no arbitrary endpoint/method is accepted. */
export function assertAttendanceEndpoint(path: string, operation: AttendanceOperation): void {
  const parsed = new URL(path, 'https://hon.invalid');
  const policy = new RegExp(`^${API_BASE}/organizations/${UUID_PATH}/schools/${UUID_PATH}/programs/${UUID_PATH}/attendance-policy$`, 'i');
  const record = new RegExp(`^${API_BASE}/organizations/${UUID_PATH}/schools/${UUID_PATH}/schedule/sessions/${UUID_PATH}/attendance$`, 'i');
  if (parsed.origin !== 'https://hon.invalid' || parsed.hash || !path.startsWith(`${API_BASE}/`)) invalid();
  if ((operation === 'POLICY_LOAD' || operation === 'POLICY_SAVE') && (!policy.test(parsed.pathname) || parsed.search)) invalid();
  if ((operation === 'RECORD_SAVE') && (!record.test(parsed.pathname) || parsed.search)) invalid();
  if (operation === 'RECORD_LOAD') {
    if (!record.test(parsed.pathname) || parsed.searchParams.size !== 1 || !UUID.test(parsed.searchParams.get('studentProfileId') ?? '')) invalid();
  }
}

function exactCategories(value: unknown): AttendanceCategoryPolicy[] {
  if (!Array.isArray(value) || value.length !== ATTENDANCE_CATEGORIES.length) invalid();
  const byCategory = new Map<AttendanceCategory, AttendanceCategoryPolicy>();
  for (const item of value) {
    closed(item, ['category', 'operationalAllowed', 'progressionEnabled', 'weightMilli']);
    const candidate = item as Record<string, unknown>;
    if (!ATTENDANCE_CATEGORIES.includes(candidate.category as AttendanceCategory) || typeof candidate.operationalAllowed !== 'boolean' || typeof candidate.progressionEnabled !== 'boolean' || !Number.isSafeInteger(candidate.weightMilli) || Number(candidate.weightMilli) < 0 || Number(candidate.weightMilli) > ATTENDANCE_WEIGHT_MAX || byCategory.has(candidate.category as AttendanceCategory)) invalid();
    byCategory.set(candidate.category as AttendanceCategory, candidate as unknown as AttendanceCategoryPolicy);
  }
  if (byCategory.size !== ATTENDANCE_CATEGORIES.length) invalid();
  return ATTENDANCE_CATEGORIES.map(category => byCategory.get(category)!);
}

export function validateAttendancePolicyInput(input: ConfigureAttendancePolicyInput): void {
  if (!input || typeof input !== 'object') invalid();
  version(input.expectedVersion, true);
  exactCategories(input.categories);
}

export function validateAttendanceRecordInput(input: RecordAttendanceInput): void {
  if (!input || typeof input !== 'object' || !UUID.test(input.studentProfileId) || !ATTENDANCE_STATUSES.includes(input.status) || !ATTENDANCE_CATEGORIES.includes(input.category as AttendanceCategory) || typeof input.note !== 'string' || input.note.length > 2000) invalid();
  if (input.expectedVersion !== undefined) version(input.expectedVersion);
}

function responseMeta(value: unknown, mutation: boolean): ResponseMeta {
  closed(value, mutation ? ['requestId', 'correlationId', 'replayed'] : ['requestId', 'correlationId']);
  const meta = value as Record<string, unknown>;
  uuid(meta.requestId);
  uuid(meta.correlationId);
  if (mutation && typeof meta.replayed !== 'boolean') invalid();
  return meta as unknown as ResponseMeta;
}

function policy(value: unknown, scope: AttendanceKnownScope): AttendanceProgressionPolicy {
  closed(value, ['programId', 'version', 'categories']);
  const data = value as Record<string, unknown>;
  if (data.programId !== scope.programId) invalid();
  version(data.version, true);
  return { programId: data.programId as string, version: data.version as number, categories: exactCategories(data.categories) };
}

function attendance(value: unknown, scope: AttendanceKnownScope): AttendanceRecordSummary {
  optionalClosed(value,
    ['id', 'classSessionId', 'studentProfileId', 'status', 'category', 'progressionPolicyVersion', 'progressionEnabled', 'progressionWeightMilli', 'progressionCreditMilli', 'recordedAt', 'version', 'createdAt', 'updatedAt'],
    ['classBookingId', 'recordedByPrincipalId', 'note']);
  const data = value as Record<string, unknown>;
  for (const field of ['id', 'classSessionId', 'studentProfileId']) uuid(data[field]);
  if (data.classSessionId !== scope.sessionId || data.studentProfileId !== scope.studentProfileId || !ATTENDANCE_STATUSES.includes(data.status as AttendanceStatus) || !ATTENDANCE_CATEGORIES.includes(data.category as AttendanceCategory)) invalid();
  version(data.progressionPolicyVersion, true);
  if (typeof data.progressionEnabled !== 'boolean' || !Number.isSafeInteger(data.progressionWeightMilli) || Number(data.progressionWeightMilli) < 0 || Number(data.progressionWeightMilli) > ATTENDANCE_WEIGHT_MAX || !Number.isSafeInteger(data.progressionCreditMilli) || Number(data.progressionCreditMilli) < 0 || Number(data.progressionCreditMilli) > ATTENDANCE_WEIGHT_MAX) invalid();
  version(data.version);
  for (const field of ['recordedAt', 'createdAt', 'updatedAt']) timestamp(data[field]);
  for (const field of ['classBookingId', 'recordedByPrincipalId']) if (field in data) uuid(data[field]);
  if ('note' in data && (typeof data.note !== 'string' || data.note.length > 2000)) invalid();
  return data as unknown as AttendanceRecordSummary;
}

async function request(path: string, operation: AttendanceOperation, body?: ConfigureAttendancePolicyInput | RecordAttendanceInput, idempotencyKey?: string): Promise<{ data: unknown; meta: ResponseMeta }> {
  assertAttendanceEndpoint(path, operation);
  const mutation = operation === 'POLICY_SAVE' || operation === 'RECORD_SAVE';
  if (mutation !== Boolean(body) || (mutation && !idempotencyKey)) invalid();
  if (idempotencyKey) key(idempotencyKey);
  const response = await fetch(path, {
    method: mutation ? 'POST' : 'GET',
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/json',
      // The policy controller's Human UI guard requires this direct-human command marker.
      'X-HON-Human-Command': 'attendance',
      ...(mutation ? { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey! } : {}),
    },
    ...(mutation ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session.'
      : response.status === 403 ? 'Current human staff permission or authorized school scope is unavailable.'
        : response.status === 404 ? 'One exact known identifier is unavailable in the current authorized school.'
          : response.status === 409 ? 'Version or retained retry-key conflict. Reload the exact current policy or attendance record before changing it.'
            : 'No verified attendance result was returned. Nothing is assumed.';
    throw new AttendanceWorkbenchUiError(message, response.status);
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { invalid(); }
  closed(envelope, ['data', 'meta']);
  const parsed = envelope as Record<string, unknown>;
  return { data: parsed.data, meta: responseMeta(parsed.meta, mutation) };
}

export async function loadAttendancePolicy(scope: AttendanceKnownScope): Promise<AttendanceProgressionPolicy> {
  requiredScope(scope);
  const response = await request(attendancePaths.policy(scope), 'POLICY_LOAD');
  return policy(response.data, scope);
}

export async function saveAttendancePolicy(scope: AttendanceKnownScope, input: ConfigureAttendancePolicyInput, idempotencyKey: string): Promise<{ policy: AttendanceProgressionPolicy; replayed: boolean }> {
  requiredScope(scope);
  validateAttendancePolicyInput(input);
  const response = await request(attendancePaths.policy(scope), 'POLICY_SAVE', input, idempotencyKey);
  return { policy: policy(response.data, scope), replayed: response.meta.replayed === true };
}

export async function loadExactAttendanceRecord(scope: AttendanceKnownScope): Promise<AttendanceRecordSummary | null> {
  requiredScope(scope);
  const response = await request(attendancePaths.exactRecordLookup(scope), 'RECORD_LOAD');
  if (response.data === null) return null;
  return attendance(response.data, scope);
}

export async function saveAttendanceRecord(scope: AttendanceKnownScope, input: RecordAttendanceInput, idempotencyKey: string): Promise<{ attendance: AttendanceRecordSummary; replayed: boolean }> {
  requiredScope(scope);
  if (input.studentProfileId !== scope.studentProfileId) invalid();
  validateAttendanceRecordInput(input);
  const response = await request(attendancePaths.record(scope), 'RECORD_SAVE', input, idempotencyKey);
  return { attendance: attendance(response.data, scope), replayed: response.meta.replayed === true };
}
