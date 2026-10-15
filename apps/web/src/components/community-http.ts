import { communityUuid, communityVersion, validateCommunityInput, validateCommunityProfile, validateCommunityConsent, verifyCommunityProfile, verifyCommunityPage, verifyCommunityRecord, verifyCommunityHistory, type CommunityInput, type CommunityKind, type CommunityProfileInput, type CommunityConsentInput } from '@hon/contracts';
export class CommunityAccessError extends Error {}
export const communityFingerprint = (v: unknown) => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
async function request(schoolId: string, path: string, query: Record<string, string> = {}, body?: unknown, key?: string): Promise<unknown> {
  communityUuid(schoolId);
  const q = new URLSearchParams({ schoolId, ...query });
  const r = await fetch(`/api/v1/staff/community${path}?${q}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'community', 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new (r.status === 401 || r.status === 403 ? CommunityAccessError : Error)(r.status === 401 ? 'Sign in with a verified human session.' : r.status === 403 ? 'Current verified owner/operator permission or opt-in is unavailable. Content has been cleared. Reload current access.' : r.status === 404 ? 'Discussion is unavailable in your current member visibility.' : r.status === 409 ? 'Version or lifecycle conflict. Reload before editing; retry only unchanged uncertain requests.' : 'No verified result. Check bounded fields; no save assumed.');
  const envelope: unknown = await r.json();
  if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'data')) throw new Error('Unverified response. No save assumed.');
  return (envelope as { data: unknown }).data;
}
export async function loadCommunityProfile(school: string) { return verifyCommunityProfile(await request(school, '/profile')); }
export async function loadCommunity(school: string, kind: CommunityKind, parentId: string | null, after: string | null = null) {
  if (!['TOPIC', 'POST', 'COMMENT'].includes(kind) || ((kind === 'TOPIC') !== (parentId === null))) throw new Error('Closed discussion scope required.');
  if (parentId !== null) communityUuid(parentId); if (after !== null) communityUuid(after);
  const page = verifyCommunityPage(await request(school, '', { kind, ...(parentId ? { parentId } : {}), ...(after ? { after } : {}) }));
  if (page.items.some(r => r.kind !== kind || r.parentId !== parentId || (after !== null && r.id <= after))) throw new Error('Unverified discussion scope.'); return page;
}
export async function readCommunity(school: string, kind: CommunityKind, parentId: string | null, id: string) {
  if (!['TOPIC', 'POST', 'COMMENT'].includes(kind) || ((kind === 'TOPIC') !== (parentId === null))) throw new Error('Closed discussion scope required.');
  communityUuid(id); if (parentId !== null) communityUuid(parentId);
  const r = verifyCommunityRecord(await request(school, `/${id}`, { kind, ...(parentId ? { parentId } : {}) }));
  if (r.id !== id || r.kind !== kind || r.parentId !== parentId) throw new Error('Unverified discussion scope.'); return r;
}
export async function loadCommunityHistory(school: string, id: string, before: number | null = null) {
  communityUuid(id); if (before !== null) communityVersion(before, 1);
  const h = verifyCommunityHistory(await request(school, `/${id}/history`, before === null ? {} : { before: String(before) }));
  if (h.id !== id || (before !== null && h.items.some(x => x.version >= before))) throw new Error('Unverified history scope.'); return h;
}
export type CommunityMutation = { op: 'CONTENT'; id: string | null; input: CommunityInput } | { op: 'PROFILE'; id: null; input: CommunityProfileInput } | { op: 'CONSENT'; id: null; input: CommunityConsentInput };
export async function saveCommunity(school: string, mutation: CommunityMutation, key: string) {
  if (!key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('Retain a valid retry key.');
  if (mutation.op === 'CONTENT') validateCommunityInput(mutation.input); else if (mutation.op === 'PROFILE') validateCommunityProfile(mutation.input); else validateCommunityConsent(mutation.input);
  if (mutation.id !== null) communityUuid(mutation.id);
  if (mutation.op === 'CONTENT' ? ((mutation.id === null) !== (mutation.input.expectedVersion === 0)) : mutation.id !== null) throw new Error('Closed mutation scope required.');
  const path = mutation.op === 'PROFILE' ? '/profile' : mutation.op === 'CONSENT' ? '/organization' : mutation.id === null ? '' : `/${mutation.id}/revisions`;
  const v = await request(school, path, {}, mutation.input, key);
  if (mutation.op !== 'CONTENT') return verifyCommunityProfile(v);
  const r = verifyCommunityRecord(v);
  const fields = { expectedVersion: r.version - 1, kind: r.kind, parentId: r.parentId, title: r.title, body: r.body, status: r.status, reason: r.reason };
  if (!r.canEdit || (mutation.id !== null && r.id !== mutation.id) || communityFingerprint(fields) !== communityFingerprint(mutation.input)) throw new Error('Unverified save. No save assumed.'); return r;
}
