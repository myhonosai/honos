/** Synthetic test-only fixtures. Shapes match the server contracts exactly; no real school or staff data. */
export function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
export const ORG = '11111111-1111-4111-8111-111111111111';
export const SCHOOL_A = '22222222-2222-4222-8222-222222222222';
export const SCHOOL_B = '33333333-3333-4333-8333-333333333333';
export const RESOLVED = { data: { state: 'RESOLVED', organizationId: ORG, schoolId: SCHOOL_A } };
export const MANUAL = { data: { state: 'MANUAL_ENTRY_REQUIRED' } };
export const CHOICES = { data: { state: 'SELECTION_REQUIRED', schools: [
  { organizationId: ORG, schoolId: SCHOOL_A, organizationName: 'Test Organization', schoolName: 'North Test School' },
  { organizationId: ORG, schoolId: SCHOOL_B, organizationName: 'Test Organization', schoolName: 'South Test School' },
] } };

/** A fetch that answers by path, recording each call. */
export function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected ${path}`);
    return route();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/* S1 Today fixtures (synthetic). School time zone America/Los_Angeles; "today" is 2026-11-22 there. */
export const REQ = '44444444-4444-4444-8444-444444444444';
export const CLASS_1 = '55555555-5555-4555-8555-555555555555';
export const CLASS_2 = '66666666-6666-4666-8666-666666666666';
export const CLASS_TOMORROW = '77777777-7777-4777-8777-777777777777';
export const STUDENT_1 = '88888888-8888-4888-8888-888888888888';
export const STUDENT_2 = '99999999-9999-4999-8999-999999999999';
export const PERSON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const RECORD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const BOOKING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const ME = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const ENTRY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const session = (sessionId: string, startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) => ({
  sessionId, name: 'Kids Fundamentals', startsAt, endsAt, roomName: 'Main mat', capacity: 20, bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED', createdAt: '2026-11-01T10:00:00.000Z', ...extra,
});
export const CLASS_LIST = {
  data: [
    session(CLASS_1, '2026-11-23T01:00:00.000Z', '2026-11-23T02:00:00.000Z'), // 5:00 PM local, Nov 22
    session(CLASS_2, '2026-11-23T03:00:00.000Z', '2026-11-23T04:00:00.000Z', { name: 'Adult BJJ', roomName: null, status: 'CANCELLED' }), // 7:00 PM
    session(CLASS_TOMORROW, '2026-11-23T17:00:00.000Z', '2026-11-23T18:00:00.000Z', { name: 'Tomorrow Class' }), // Nov 23 local
  ],
  meta: { requestId: REQ, correlationId: REQ, limit: 50, nextCursor: null, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-22', fromDate: '2026-11-22' },
};
export const booking = (extra: Record<string, unknown> = {}) => ({ id: BOOKING, kind: 'REGULAR', status: 'BOOKED', source: 'STAFF', bookedAt: '2026-11-20T10:00:00.000Z', cancelledAt: null, version: 1, ...extra });
export const ROSTER = {
  data: [
    { studentProfileId: STUDENT_1, personId: PERSON, givenName: 'Test', familyName: 'Student', studentStatus: 'ACTIVE', booking: booking(), attendance: null },
    { studentProfileId: STUDENT_2, personId: PERSON, givenName: 'Trial', familyName: 'Kid', studentStatus: 'ACTIVE', booking: booking({ kind: 'TRIAL' }),
      attendance: { id: RECORD, status: 'LATE', category: 'TRIAL_STUDENT', recordedAt: '2026-11-23T01:05:00.000Z', version: 2 } },
  ],
  meta: { requestId: REQ, correlationId: REQ, limit: 50, nextCursor: null },
};
export const record = (studentProfileId: string, status: string, version: number, extra: Record<string, unknown> = {}) => ({
  id: RECORD, classSessionId: CLASS_1, studentProfileId, status, category: 'TRIAL_STUDENT', progressionPolicyVersion: 0, progressionEnabled: false,
  progressionWeightMilli: 0, progressionCreditMilli: 0, recordedAt: '2026-11-23T01:05:00.000Z', version, createdAt: '2026-11-23T01:05:00.000Z', updatedAt: '2026-11-23T01:05:00.000Z', ...extra,
});
export const entry = (extra: Record<string, unknown> = {}) => ({
  entryId: ENTRY, staffPrincipalId: ME, localDate: '2026-11-22', clockInAt: '2026-11-22T23:00:00.000Z', clockOutAt: null, origin: 'CLOCK', version: 1, workedMinutes: null, updatedAt: '2026-11-22T23:00:00.000Z', ...extra,
});
export const clock = (open: unknown) => ({
  data: { approval: null, entries: open ? [open] : [], now: '2026-11-23T00:00:00.000Z', open, timezone: 'America/Los_Angeles', todayShifts: [], weekStart: '2026-11-16' },
  meta: { requestId: REQ, correlationId: REQ },
});
