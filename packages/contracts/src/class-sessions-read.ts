import type { CommandContext, ClassSessionBookingPolicy, ScheduleItemStatus } from './index.js';

export const CURRENT_SCHOOL_CLASS_SESSIONS_MAXIMUM = 50;
export const CURRENT_SCHOOL_CLASS_SESSIONS_WINDOW = Object.freeze({
  priorCalendarDays: 30,
  futureCalendarDays: 90,
  endsAtExclusive: true,
});

/** Direct human/current-school read context. No caller-selected session, roster, or availability input exists. */
export interface CurrentSchoolClassSessionsReadContext extends CommandContext {
  externalSubject: string;
}

/** Only operational facts returned for one bounded current-school session row. */
export interface CurrentSchoolClassSession {
  sessionId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  roomName: string | null;
  capacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
  status: ScheduleItemStatus;
  createdAt: string;
}

function invalid(): never { throw new Error('The bounded class-session read result could not be verified. No session is selected.'); }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}
export function currentSchoolClassSessionsUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function operationalText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

/** Verifies the exact projection; it intentionally has no roster, booking, attendance, or availability fields. */
export function verifyCurrentSchoolClassSessions(value: unknown): CurrentSchoolClassSession[] {
  if (!Array.isArray(value) || value.length > CURRENT_SCHOOL_CLASS_SESSIONS_MAXIMUM) invalid();
  const seen = new Set<string>();
  let previous: [number, string] | undefined;
  return value.map((value) => {
    const item = closed(value, ['sessionId', 'name', 'startsAt', 'endsAt', 'roomName', 'capacity', 'bookingPolicy', 'status', 'createdAt']);
    const sessionId = currentSchoolClassSessionsUuid(item.sessionId);
    const name = operationalText(item.name);
    const startsAt = timestamp(item.startsAt), endsAt = timestamp(item.endsAt), createdAt = timestamp(item.createdAt);
    if (Date.parse(endsAt) <= Date.parse(startsAt) || seen.has(sessionId)
      || !Number.isSafeInteger(item.capacity) || Number(item.capacity) < 1 || Number(item.capacity) > 2_147_483_647
      || typeof item.bookingPolicy !== 'string' || !['WALK_IN', 'OPTIONAL_BOOKING', 'REQUIRED_BOOKING'].includes(item.bookingPolicy)
      || typeof item.status !== 'string' || !['DRAFT', 'SCHEDULED', 'CANCELLED', 'COMPLETED'].includes(item.status)
      || (item.roomName !== null && (typeof item.roomName !== 'string' || !item.roomName.trim() || item.roomName.trim() !== item.roomName || item.roomName.length > 160 || /[\u0000-\u001f\u007f]/.test(item.roomName)))) invalid();
    const order: [number, string] = [Date.parse(startsAt), sessionId];
    if (previous && (order[0] < previous[0] || (order[0] === previous[0] && order[1] <= previous[1]))) invalid();
    previous = order; seen.add(sessionId);
    return { sessionId, name, startsAt, endsAt, roomName: item.roomName as string | null, capacity: item.capacity as number,
      bookingPolicy: item.bookingPolicy as ClassSessionBookingPolicy, status: item.status as ScheduleItemStatus, createdAt };
  });
}
