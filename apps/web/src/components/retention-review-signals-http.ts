import { verifyRetentionReviewAcknowledgementEvidence, verifyRetentionReviewAcknowledgementInput, verifyRetentionReviewAcknowledgement, type RetentionReviewAcknowledgementInput, communityUuid, verifyRetentionReviewSignals, type RetentionReviewSignals } from '@hon/contracts';

const base = '/api/v1/staff/retention/review';
export class RetentionReviewUiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function id(value: unknown): asserts value is string { try { communityUuid(value); } catch { throw new Error('Use an already-known school and membership UUID.'); } }

/** Known selectors only; server-derived scope and SQL independently authorize every read. */
export function retentionReviewPath(schoolId: string, membershipId: string): string {
  id(schoolId); id(membershipId);
  return `${base}?schoolId=${encodeURIComponent(schoolId)}&membershipId=${encodeURIComponent(membershipId)}`;
}
export async function loadRetentionReviewSignals(schoolId: string, membershipId: string): Promise<RetentionReviewSignals> {
  const path = retentionReviewPath(schoolId, membershipId);
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const message = response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact school permission or active entitlement is unavailable.' : response.status === 404 ? 'The known membership is unavailable in the current authorized school.' : 'No verified Retention Review Signals result is available.';
    throw new RetentionReviewUiError(message, response.status);
  }
  let envelope: unknown;
  try { envelope = await response.json(); } catch { throw new Error('The Retention Review Signals response could not be verified.'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, 'data') || !Object.hasOwn(envelope, 'meta')) throw new Error('The Retention Review Signals response could not be verified.');
  const data = (envelope as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'retentionReviewSignals')) throw new Error('The Retention Review Signals response could not be verified.');
  return verifyRetentionReviewSignals((data as { retentionReviewSignals: unknown }).retentionReviewSignals, membershipId);
}

export async function loadRetentionReviewAcknowledgementEvidence(schoolId: string, membershipId: string) {
  const path = retentionReviewPath(schoolId, membershipId).replace('?', '/acknowledgement-evidence?');
  const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  return verifyRetentionReviewAcknowledgementEvidence(await acknowledgementEnvelope(response, 'retentionReviewAcknowledgementEvidence'), membershipId);
}
async function acknowledgementEnvelope(response: Response, key: string): Promise<unknown> {
  if (!response.ok) throw new RetentionReviewUiError(response.status === 409 ? 'Evidence changed or this retry no longer matches. Reload and review verified evidence.' : response.status === 401 ? 'Sign in with a verified human staff session.' : response.status === 403 ? 'Current exact acknowledgement permission or active school authority is unavailable.' : 'No verified acknowledgement is shown; the result may be unknown. Reload evidence before reviewing again.', response.status);
  const envelope: unknown = await response.json();
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'data,meta') throw new Error('Unverified acknowledgement envelope.');
  const { data, meta } = envelope as { data: Record<string, unknown>; meta: Record<string, unknown> };
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).join(',') !== key || !meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).sort().join(',') !== 'correlationId,requestId') throw new Error('Unverified acknowledgement envelope.');
  id(meta.requestId); id(meta.correlationId);
  return data[key];
}
export async function acknowledgeRetentionReviewEvidence(schoolId: string, membershipId: string, value: RetentionReviewAcknowledgementInput) {
  const input = verifyRetentionReviewAcknowledgementInput(value);
  const path = retentionReviewPath(schoolId, membershipId).replace('?', '/acknowledgement?');
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'retention-review-acknowledgement' }, body: JSON.stringify(input) });
  return verifyRetentionReviewAcknowledgement(await acknowledgementEnvelope(response, 'retentionReviewAcknowledgement'), membershipId, input);
}

export type RetentionMember = Readonly<{ membershipId: string; displayName: string; state: string; termEndsAt: string | null }>;
const MEMBER_STATES = ['ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'EXPIRED'];
/** 0407 member list for the signed-in school: names to choose from. The server checks retention.review.read on every read. */
export async function loadRetentionMembers(schoolId: string): Promise<readonly RetentionMember[]> {
  id(schoolId);
  const response = await fetch(`${base}/memberships?schoolId=${encodeURIComponent(schoolId)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new RetentionReviewUiError(response.status === 401 ? 'Please sign in again.' : response.status === 403 ? 'Your role does not include retention reviews at this school.' : 'The member list could not be loaded.', response.status);
  const bad = (): never => { throw new Error('The member list could not be verified.'); };
  let envelope: unknown; try { envelope = await response.json(); } catch { bad(); }
  const data = (envelope as { data?: { items?: unknown } } | null)?.data;
  if (!data || typeof data !== 'object' || Object.keys(data).join() !== 'items' || !Array.isArray(data.items) || data.items.length > 200) bad();
  const rows = (data!.items as unknown[]).map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join() !== 'displayName,membershipId,state,termEndsAt') bad();
    const x = row as Record<string, unknown>;
    try { communityUuid(x.membershipId); } catch { bad(); }
    if (typeof x.displayName !== 'string' || !x.displayName || x.displayName.length > 120 || typeof x.state !== 'string' || !MEMBER_STATES.includes(x.state) || !(x.termEndsAt === null || typeof x.termEndsAt === 'string')) bad();
    return Object.freeze({ membershipId: (x.membershipId as string).toLowerCase(), displayName: x.displayName as string, state: x.state as string, termEndsAt: x.termEndsAt as string | null });
  });
  if (new Set(rows.map((x) => x.membershipId)).size !== rows.length) bad();
  return Object.freeze(rows);
}
/** "Ann Able · Frozen" — the state only when it is not plain active. */
export const memberLabel = (m: RetentionMember): string => m.state === 'ACTIVE' ? m.displayName : `${m.displayName} · ${m.state.replaceAll('_', ' ').toLowerCase()}`;
