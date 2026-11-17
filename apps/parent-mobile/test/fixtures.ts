/** Synthetic test-only fixtures. Shapes match the server contracts exactly; no real family data. */
export const NOW = '2026-11-17T15:00:00.000Z';

export function journeyBody(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: NOW, from: '2026-11-17T00:00:00.000Z', to: '2026-12-15T00:00:00.000Z', accessLevel: 'PRIMARY_GUARDIAN',
    children: [
      {
        name: 'Test Child A', profileAvailable: true,
        programs: [{ name: 'Little Dragons', rank: 'Yellow Belt', requirements: { status: 'AVAILABLE', limited: false, items: [
          { label: 'Front kick', kind: 'TECHNIQUE', required: true, status: 'MET', recordedAt: '2026-11-10T18:00:00.000Z' },
          { label: 'Form 1', kind: 'TECHNIQUE', required: true, status: 'PRACTICING', recordedAt: '2026-11-12T18:00:00.000Z' },
          { label: 'Respect', kind: 'CHARACTER', required: false, status: null, recordedAt: null },
        ] } }],
        schedule: { status: 'AVAILABLE', limited: false, items: [
          { name: 'Little Dragons', program: 'Little Dragons', startsAt: '2026-11-19T23:00:00.000Z', endsAt: '2026-11-19T23:45:00.000Z', room: 'Main mat', bookingStatus: 'BOOKED', sessionStatus: 'SCHEDULED', kind: 'REGULAR' },
          { name: 'Little Dragons', program: 'Little Dragons', startsAt: '2026-11-18T23:00:00.000Z', endsAt: '2026-11-18T23:45:00.000Z', room: null, bookingStatus: 'WAITLISTED', sessionStatus: 'SCHEDULED', kind: 'MAKEUP' },
        ] },
        achievements: { status: 'AVAILABLE', limited: false, items: [{ name: 'Best Forms', description: 'Clean first form.', awardedOn: '2026-11-01' }] },
      },
      {
        name: 'Test Child B', profileAvailable: true,
        programs: [{ name: 'Juniors', rank: null, requirements: { status: 'UNAVAILABLE', reason: 'READ_UNAVAILABLE' } }],
        schedule: { status: 'AVAILABLE', limited: false, items: [
          { name: 'Juniors', program: 'Juniors', startsAt: '2026-11-18T22:00:00.000Z', endsAt: '2026-11-18T23:00:00.000Z', room: null, bookingStatus: 'BOOKED', sessionStatus: 'SCHEDULED', kind: 'REGULAR' },
        ] },
        achievements: { status: 'AVAILABLE', limited: false, items: [] },
      },
    ],
    documents: { status: 'AVAILABLE', limited: false, items: [{ title: 'Holiday schedule', publishedAt: '2026-11-15T12:00:00.000Z' }] },
    documentReceipts: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' },
    plannedAbsences: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' },
    ...overrides,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

export const CHILD_A = '11111111-1111-4111-8111-111111111111';
export const SESSION_1 = '22222222-2222-4222-8222-222222222222';
export const SESSION_2 = '33333333-3333-4333-8333-333333333333';
export const BOOKING_1 = '44444444-4444-4444-8444-444444444444';
export function booking(overrides: Record<string, unknown> = {}) {
  return { bookingId: BOOKING_1, sessionId: SESSION_2, studentProfileId: CHILD_A, status: 'BOOKED', source: 'PARENT_APP', version: 1, canCancel: true, ...overrides };
}
export function choicesBody(overrides: { canBook?: boolean; s1?: Record<string, unknown>; s2?: Record<string, unknown> } = {}) {
  return {
    data: {
      canBook: overrides.canBook ?? true, timezone: 'America/Los_Angeles', horizonDays: 14,
      children: [{ studentProfileId: CHILD_A, displayName: 'Test Child A', sessions: [
        { sessionId: SESSION_1, name: 'Little Dragons', programName: 'Kids Program', roomName: 'Main floor', startsAt: '2026-11-18T01:00:00.000Z', endsAt: '2026-11-18T02:00:00.000Z', spotsLeft: 3, booking: null, ...overrides.s1 },
        { sessionId: SESSION_2, name: 'Juniors', programName: 'Kids Program', roomName: null, startsAt: '2026-11-19T01:00:00.000Z', endsAt: '2026-11-19T02:00:00.000Z', spotsLeft: 5, booking: booking(), ...overrides.s2 },
      ] }],
    },
  };
}
