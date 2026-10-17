export type TestingScorecardInitialIds = Readonly<{ schoolId: string; testingCandidateId: string; testingEventId: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ['schoolId', 'testingCandidateId', 'testingEventId'] as const;
const EMPTY_IDS: TestingScorecardInitialIds = Object.freeze({ schoolId: '', testingCandidateId: '', testingEventId: '' });

function closedUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }

/** An untrusted, inert selector prefill; extra, repeated, missing, or malformed query values fail closed. */
export function testingScorecardInitialIds(query: unknown): TestingScorecardInitialIds {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return EMPTY_IDS;
  const values = query as Record<string, unknown>;
  if (Object.keys(values).some(key => !(FIELDS as readonly string[]).includes(key))) return EMPTY_IDS;
  const [schoolId, testingCandidateId, testingEventId] = FIELDS.map(field => values[field]);
  if (!closedUuid(schoolId) || !closedUuid(testingCandidateId) || !closedUuid(testingEventId)) return EMPTY_IDS;
  return Object.freeze({ schoolId: schoolId.toLowerCase(), testingCandidateId: testingCandidateId.toLowerCase(), testingEventId: testingEventId.toLowerCase() });
}

/** A normal navigation link carries selectors only; it neither grants nor checks scorecard access. */
export function pendingCandidateScorecardHref(schoolId: string, testingCandidateId: string, testingEventId: string): string | undefined {
  if (![schoolId, testingCandidateId, testingEventId].every(closedUuid)) return undefined;
  return `/staff/testing/scorecards?${new URLSearchParams({ schoolId: schoolId.toLowerCase(), testingCandidateId: testingCandidateId.toLowerCase(), testingEventId: testingEventId.toLowerCase() }).toString()}`;
}
