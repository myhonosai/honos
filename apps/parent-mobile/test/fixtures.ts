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
