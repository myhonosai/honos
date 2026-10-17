import {
  CLASS_SESSION_BOOKING_POLICIES,
  type ClassSessionBookingPolicy,
  type ClassSessionSummary,
  type CreateClassSessionInput,
} from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_MAX = 2_147_483_647;
const RESPONSE_MAX = 4_000;

export const CLASS_SESSION_POLICIES = Object.freeze([...CLASS_SESSION_BOOKING_POLICIES]);
export type ClassSessionKnownIds = Readonly<{ organizationId: string; schoolId: string; programId: string }>;
export type ClassSessionDraft = Readonly<{
  name: string;
  roomName: string;
  startsAt: string;
  endsAt: string;
  capacity: string;
  bookingPolicy: string;
}>;
export type PreparedClassSession = Readonly<{
  path: string;
  organizationId: string;
  schoolId: string;
  key: string;
  body: string;
}>;
export type ClassSessionWorkbenchResult = Readonly<{ classSession: ClassSessionSummary; replayed: boolean }>;
export class ClassSessionUncertainError extends Error {}
export class ClassSessionRejectedError extends Error {}
export class ClassSessionAccessError extends ClassSessionRejectedError {
  constructor(readonly status: 401 | 403) {
    super('Current verified human session or exact school session permission is unavailable. Inputs, receipt and retry were cleared.');
  }
}

function invalid(): never { throw new Error('Unverified exact class-session contract. No class session was assumed.'); }
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function v4(value: unknown): asserts value is string { uuid(value); if (value[14] !== '4') invalid(); }
function text(value: unknown, field: string, optional = false): string | undefined {
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  const normalized = value.trim();
  if (!normalized && !optional) invalid();
  if (normalized.length > 160) invalid();
  return normalized || undefined;
}
function utc(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}
function positiveInteger(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > INTEGER_MAX) invalid();
  return result;
}
function policy(value: unknown): asserts value is ClassSessionBookingPolicy {
  if (typeof value !== 'string' || !CLASS_SESSION_POLICIES.includes(value as ClassSessionBookingPolicy)) invalid();
}
function normalize(ids: ClassSessionKnownIds, draft: ClassSessionDraft): CreateClassSessionInput {
  closed(ids, ['organizationId', 'schoolId', 'programId']);
  for (const value of Object.values(ids)) uuid(value);
  closed(draft, ['name', 'roomName', 'startsAt', 'endsAt', 'capacity', 'bookingPolicy']);
  const name = text(draft.name, 'name')!;
  const roomName = text(draft.roomName, 'roomName', true);
  utc(draft.startsAt); utc(draft.endsAt);
  if (Date.parse(draft.endsAt) <= Date.parse(draft.startsAt)) invalid();
  const capacity = positiveInteger(draft.capacity);
  policy(draft.bookingPolicy);
  return { programId: ids.programId.toLowerCase(), name, ...(roomName ? { roomName } : {}), startsAt: draft.startsAt, endsAt: draft.endsAt, capacity, bookingPolicy: draft.bookingPolicy };
}

/** Local syntax only; entered known IDs never grant organization, school or program authority. */
export function validateClassSessionDraft(ids: ClassSessionKnownIds, draft: ClassSessionDraft): void { normalize(ids, draft); }
export function classSessionPath(organizationId: string, schoolId: string): string {
  uuid(organizationId); uuid(schoolId);
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/schedule/sessions`;
}
/** Only an explicit confirmed submit allocates the v4 key. Preparation never performs I/O. */
export function prepareClassSession(ids: ClassSessionKnownIds, draft: ClassSessionDraft, key: string): PreparedClassSession {
  const input = normalize(ids, draft); v4(key);
  return Object.freeze({
    path: classSessionPath(ids.organizationId, ids.schoolId), organizationId: ids.organizationId.toLowerCase(), schoolId: ids.schoolId.toLowerCase(), key,
    body: JSON.stringify(input),
  });
}
function verifyCommand(command: PreparedClassSession): CreateClassSessionInput {
  closed(command, ['path', 'organizationId', 'schoolId', 'key', 'body']);
  uuid(command.organizationId); uuid(command.schoolId); v4(command.key);
  if (command.path !== classSessionPath(command.organizationId, command.schoolId) || typeof command.body !== 'string' || command.body.length > 900) invalid();
  let body: unknown;
  try { body = JSON.parse(command.body); } catch { invalid(); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const fields = Object.hasOwn(body, 'roomName')
    ? ['programId', 'name', 'roomName', 'startsAt', 'endsAt', 'capacity', 'bookingPolicy']
    : ['programId', 'name', 'startsAt', 'endsAt', 'capacity', 'bookingPolicy'];
  closed(body, fields);
  const input = normalize({ organizationId: command.organizationId, schoolId: command.schoolId, programId: (body as Record<string, unknown>).programId as string }, {
    name: (body as Record<string, unknown>).name as string,
    roomName: ((body as Record<string, unknown>).roomName as string | undefined) ?? '',
    startsAt: (body as Record<string, unknown>).startsAt as string,
    endsAt: (body as Record<string, unknown>).endsAt as string,
    capacity: String((body as Record<string, unknown>).capacity),
    bookingPolicy: (body as Record<string, unknown>).bookingPolicy as string,
  });
  if (command.body !== JSON.stringify(input)) invalid();
  return input;
}

export function parseClassSessionResult(value: unknown, command: PreparedClassSession): ClassSessionWorkbenchResult {
  const input = verifyCommand(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  v4(value.meta.requestId); v4(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  const dataFields = input.roomName
    ? ['id', 'programId', 'name', 'roomName', 'startsAt', 'endsAt', 'capacity', 'bookingPolicy', 'status', 'version', 'createdAt']
    : ['id', 'programId', 'name', 'startsAt', 'endsAt', 'capacity', 'bookingPolicy', 'status', 'version', 'createdAt'];
  closed(value.data, dataFields);
  const data = value.data;
  v4(data.id); uuid(data.programId);
  if ((data.programId as string).toLowerCase() !== input.programId || text(data.name, 'name') !== input.name
    || data.startsAt !== input.startsAt || data.endsAt !== input.endsAt || data.capacity !== input.capacity
    || data.bookingPolicy !== input.bookingPolicy || data.status !== 'SCHEDULED') invalid();
  if (input.roomName ? text(data.roomName, 'roomName') !== input.roomName : Object.hasOwn(data, 'roomName')) invalid();
  if (!Number.isSafeInteger(data.version) || Number(data.version) < 1 || Number(data.version) > INTEGER_MAX) invalid();
  utc(data.startsAt); utc(data.endsAt); utc(data.createdAt);
  return { classSession: data as unknown as ClassSessionSummary, replayed: value.meta.replayed };
}

async function inProgress(response: Response): Promise<boolean> {
  try {
    const body = await response.text(); if (body.length > RESPONSE_MAX) return false;
    const problem: unknown = JSON.parse(body); closed(problem, ['code', 'detail']);
    return problem.code === 'IDEMPOTENCY_IN_PROGRESS' && typeof problem.detail === 'string';
  } catch { return false; }
}

/** POST only; exact path/body/key is retained only after uncertainty and is never retried automatically. */
export async function submitClassSession(command: PreparedClassSession): Promise<ClassSessionWorkbenchResult> {
  verifyCommand(command);
  let response: Response;
  try {
    response = await fetch(command.path, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'class-session' },
      body: command.body,
    });
  } catch { throw new ClassSessionUncertainError('Class-session outcome is uncertain. No receipt is assumed; only the exact retained command may be retried.'); }
  if (response.status === 401 || response.status === 403) throw new ClassSessionAccessError(response.status);
  if (response.status === 409 && await inProgress(response)) {
    throw new ClassSessionUncertainError('The exact command is still processing. No receipt is assumed; retry is a separate human action.');
  }
  if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) {
    throw new ClassSessionRejectedError('Class-session command rejected. No verified receipt or retry is retained; review the exact values before a new explicit submit.');
  }
  try {
    if (!response.ok || ![200, 201].includes(response.status) || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    const body = await response.text(); if (body.length > RESPONSE_MAX) invalid();
    const result = parseClassSessionResult(JSON.parse(body), command);
    if (result.replayed !== (response.status === 200)) invalid();
    return result;
  } catch {
    throw new ClassSessionUncertainError('No verified exact class-session receipt was returned. Outcome is uncertain; only the unchanged retained command may be retried.');
  }
}
