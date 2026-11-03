import {
  CLASS_BOOKING_KINDS,
  CLASS_SESSION_BOOKING_POLICIES,
  type ClassBookingSummary,
  type ClassSessionBookingPolicy,
  type CreateClassBookingInput,
  type GenericClassBookingKind,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_MAX = 2_147_483_647;
const RESPONSE_MAX = 4000;

// Deliberately use the generic command kinds, never the broader ClassBookingKind.
export const MANUAL_CLASS_BOOKING_KINDS = Object.freeze(CLASS_BOOKING_KINDS.filter(kind => String(kind) !== 'CLASS_PASS'));
export type ClassBookingKnownIds = Readonly<{
  organizationId: string;
  schoolId: string;
  sessionId: string;
  studentProfileId: string;
}>;
export type PreparedClassBooking = Readonly<{
  path: string;
  organizationId: string;
  schoolId: string;
  sessionId: string;
  key: string;
  body: string;
}>;
export type ClassBookingWorkbenchResult = {
  booking: ClassBookingSummary & { bookingKind: GenericClassBookingKind; status: 'BOOKED' | 'WAITLISTED'; source: 'STAFF' };
  replayed: boolean;
};
export class ClassBookingUncertainError extends Error {}
export class ClassBookingRejectedError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export class ClassBookingAccessError extends ClassBookingRejectedError {
  constructor(readonly status: 401 | 403) {
    super('Current verified human session or exact school booking permission is unavailable. Inputs, receipt and retry were cleared.');
  }
}

function invalid(): never {
  throw new Error('Unverified exact class-booking contract. No booking outcome is assumed.');
}
function closed(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
}
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
}
function kind(value: unknown): asserts value is GenericClassBookingKind {
  if (typeof value !== 'string' || value === 'CLASS_PASS' || !MANUAL_CLASS_BOOKING_KINDS.includes(value as GenericClassBookingKind)) invalid();
}
function integer(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > INTEGER_MAX) invalid();
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
}

/** Local syntax only: exact IDs never establish identity, school authority or eligibility. */
export function validateClassBookingDraft(ids: ClassBookingKnownIds, bookingKind: unknown): void {
  closed(ids, ['organizationId', 'schoolId', 'sessionId', 'studentProfileId']);
  for (const value of Object.values(ids)) uuid(value);
  kind(bookingKind);
}
export function classBookingPath(organizationId: string, schoolId: string, sessionId: string): string {
  for (const value of [organizationId, schoolId, sessionId]) uuid(value);
  return `/api/v1/organizations/${organizationId.toLowerCase()}/schools/${schoolId.toLowerCase()}/schedule/sessions/${sessionId.toLowerCase()}/bookings`;
}

/** Only the explicit submit handler allocates the UUID key; preparing makes no request. */
export function prepareClassBooking(ids: ClassBookingKnownIds, bookingKind: GenericClassBookingKind, key: string): PreparedClassBooking {
  validateClassBookingDraft(ids, bookingKind);
  uuid(key);
  if (key[14] !== '4') invalid();
  return Object.freeze({
    path: classBookingPath(ids.organizationId, ids.schoolId, ids.sessionId),
    organizationId: ids.organizationId.toLowerCase(), schoolId: ids.schoolId.toLowerCase(), sessionId: ids.sessionId.toLowerCase(), key,
    body: JSON.stringify({ studentProfileId: ids.studentProfileId.toLowerCase(), bookingKind }),
  });
}
function verifyCommand(command: PreparedClassBooking): CreateClassBookingInput {
  closed(command, ['path', 'organizationId', 'schoolId', 'sessionId', 'key', 'body']);
  uuid(command.key);
  if (command.key[14] !== '4' || command.path !== classBookingPath(command.organizationId, command.schoolId, command.sessionId)
    || typeof command.body !== 'string' || command.body.length > 200) invalid();
  const body: unknown = JSON.parse(command.body);
  closed(body, ['studentProfileId', 'bookingKind']); uuid(body.studentProfileId); kind(body.bookingKind);
  if (command.body !== JSON.stringify({ studentProfileId: body.studentProfileId.toLowerCase(), bookingKind: body.bookingKind })) invalid();
  return body as unknown as CreateClassBookingInput;
}

export function parseClassBookingResult(value: unknown, command: PreparedClassBooking): ClassBookingWorkbenchResult {
  const input = verifyCommand(command);
  closed(value, ['data', 'meta']); closed(value.meta, ['requestId', 'correlationId', 'replayed']);
  uuid(value.meta.requestId); uuid(value.meta.correlationId);
  if (value.meta.requestId !== value.meta.correlationId || typeof value.meta.replayed !== 'boolean') invalid();
  closed(value.data, ['id', 'classSessionId', 'studentProfileId', 'bookingKind', 'status', 'source', 'bookedAt', 'version', 'createdAt', 'updatedAt', 'sessionCapacity', 'bookingPolicy', 'activeSeatCount']);
  const data = value.data;
  for (const field of ['id', 'classSessionId', 'studentProfileId']) uuid(data[field]);
  kind(data.bookingKind);
  if ((data.classSessionId as string).toLowerCase() !== command.sessionId.toLowerCase()
    || (data.studentProfileId as string).toLowerCase() !== input.studentProfileId
    || data.bookingKind !== input.bookingKind || (data.status !== 'BOOKED' && data.status !== 'WAITLISTED')
    || data.source !== 'STAFF' || !CLASS_SESSION_BOOKING_POLICIES.includes(data.bookingPolicy as ClassSessionBookingPolicy)) invalid();
  integer(data.version, 1); integer(data.sessionCapacity, 0); integer(data.activeSeatCount, 0);
  for (const field of ['bookedAt', 'createdAt', 'updatedAt']) timestamp(data[field]);
  // No browser capacity decision: WALK_IN can legitimately exceed capacity.
  return { booking: data as unknown as ClassBookingWorkbenchResult['booking'], replayed: value.meta.replayed };
}

async function inProgress(response: Response): Promise<boolean> {
  try {
    const text = await response.text();
    if (text.length > RESPONSE_MAX) return false;
    const problem: unknown = JSON.parse(text);
    closed(problem, ['code', 'detail']);
    return problem.code === 'IDEMPOTENCY_IN_PROGRESS' && typeof problem.detail === 'string';
  } catch { return false; }
}

/** POST only. Retain identical path/body/key only on uncertainty; never automatically retry. */
export async function submitClassBooking(command: PreparedClassBooking): Promise<ClassBookingWorkbenchResult> {
  verifyCommand(command);
  let response: Response;
  try {
    response = await fetch(command.path, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': command.key, 'X-HON-Human-Command': 'class-booking' },
      body: command.body,
    });
  } catch {
    throw new ClassBookingUncertainError('Booking outcome is uncertain. No receipt is assumed; only the exact retained command may be retried.');
  }
  if (response.status === 401) reportConfirmedSessionInvalidation();
  if (response.status === 401 || response.status === 403) throw new ClassBookingAccessError(response.status);
  if (response.status === 409 && await inProgress(response)) {
    throw new ClassBookingUncertainError('The exact command is still processing. No receipt is assumed; retry is a separate human action.');
  }
  if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
    throw new ClassBookingRejectedError('Class-booking command rejected. No verified receipt; review the exact IDs and kind before a new explicit submit.', response.status);
  }
  try {
    if (!response.ok || ![200, 201].includes(response.status) || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    const text = await response.text(); if (text.length > RESPONSE_MAX) invalid();
    const result = parseClassBookingResult(JSON.parse(text), command);
    if (result.replayed !== (response.status === 200)) invalid();
    return result;
  } catch {
    throw new ClassBookingUncertainError('No verified exact booking receipt was returned. Outcome is uncertain; only the unchanged retained command may be retried.');
  }
}
