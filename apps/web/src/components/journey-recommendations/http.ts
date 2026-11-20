import {
  validateSaveJourneyRecommendationInput, validateSetJourneyRecommendationStatusInput, verifyJourneyRecommendationReceipt, verifyJourneyRecommendations,
  type JourneyRecommendationReceipt, type JourneyRecommendationStatus, type JourneyRecommendations, type SaveJourneyRecommendationInput,
} from '@hon/contracts';

/**
 * Journey recommendations (0603): same-origin browser commands only. Staff send the shell's school scope, which the server
 * checks again with curriculum.manage. Saving changes what families see on their child's belt path; nothing is texted,
 * emailed, pushed, sold or booked.
 */
export class JourneyRecommendationsAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
/** A definite refusal: nothing was stored, so a retry is a new command. Other failures keep the key for an exact retry. */
export class JourneyRecommendationsRefusal extends Error {}
export type JourneyScope = Readonly<{ organizationId: string; schoolId: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new Error('The answer could not be checked. Nothing is assumed. Refresh to see the current recommendations.'); }
const MESSAGES: Record<string, string> = {
  JOURNEY_RECOMMENDATIONS_LIMIT: 'A program can have at most 50 recommendations. Remove one first.',
  JOURNEY_RECOMMENDATIONS_NOT_FOUND: 'That program, rank, sign-up page, event or recommendation is not available any more. Refresh and pick again.',
  VERSION_CONFLICT: 'This recommendation changed. Refresh to see the latest.',
  VALIDATION_FAILED: 'Check the fields: a title is 1 to 80 characters on one line, the message is 1 to 400 characters, and each "when" and "where" needs its choice.',
  IDEMPOTENCY_KEY_REUSED: 'This save could not be matched to the earlier one. Refresh and save it again.',
};

async function call(url: string, method: 'GET' | 'POST', command?: string, body?: unknown, key?: string): Promise<{ data: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-HON-Human-Command'] = command!; if (key) headers['Idempotency-Key'] = key; }
  const response = await fetch(url, { method, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', headers,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
  const value: unknown = await response.json().catch(() => invalid());
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const root = value as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401) throw new JourneyRecommendationsAccessError('Your session has ended. Sign in again.', 401);
    if (response.status === 403) throw new JourneyRecommendationsAccessError('Journey recommendations need curriculum permission on this account.', 403);
    if (MESSAGES[String(root.code)]) throw new JourneyRecommendationsRefusal(MESSAGES[String(root.code)]!);
    throw new Error('Recommendations are unavailable right now. If you were saving, it may or may not have gone through. Refresh to check.');
  }
  if (!Object.hasOwn(root, 'data')) invalid();
  return root as { data: unknown };
}
function base(scope: JourneyScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/journey-recommendations`;
}
export async function loadJourneyRecommendations(scope: JourneyScope): Promise<JourneyRecommendations> {
  return verifyJourneyRecommendations((await call(base(scope), 'GET')).data);
}
export async function saveJourneyRecommendation(scope: JourneyScope, draft: SaveJourneyRecommendationInput, key: string): Promise<JourneyRecommendationReceipt> {
  const input = validateSaveJourneyRecommendationInput(draft);
  const out = await call(base(scope), 'POST', 'journey_recommendations.save', input, key);
  return verifyJourneyRecommendationReceipt(out.data, { title: input.title, ...(input.recommendationId ? { recommendationId: input.recommendationId } : {}) });
}
export async function setJourneyRecommendationStatus(scope: JourneyScope, recommendationId: string, expectedVersion: number, status: JourneyRecommendationStatus, key: string): Promise<JourneyRecommendationReceipt> {
  const input = validateSetJourneyRecommendationStatusInput({ recommendationId: recommendationId.toLowerCase(), expectedVersion, status });
  const out = await call(`${base(scope)}/${input.recommendationId}/status`, 'POST', 'journey_recommendations.status', { expectedVersion: input.expectedVersion, status: input.status }, key);
  return verifyJourneyRecommendationReceipt(out.data, { recommendationId: input.recommendationId, status: input.status });
}
/** An unknown outcome keeps its key so Try again repeats the same command; changing anything starts a new one. */
export function attemptFor(identity: string, previous: { identity: string; key: string } | null, key: () => string) {
  return previous?.identity === identity ? previous : { identity, key: key() };
}
