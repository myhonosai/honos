import { communityUuid, communityVersion, validateAchievementDefinition, validateAchievementAward, verifyAchievementDefinition, verifyAchievementAward, verifyAchievementPage, verifyAchievementHistory, verifyAchievementAccess, verifyParentAchievements, type AchievementDefinitionInput, type AchievementAwardInput } from '@hon/contracts';
export class AchievementAccessError extends Error {}
export const achievementFingerprint = (v: unknown) => JSON.stringify(v, (_, x: unknown) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
const base = '/api/v1/staff/students/achievements';
async function request(url: string, body?: unknown, key?: string): Promise<unknown> {
  const r = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'student-achievements', 'Idempotency-Key': key! } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new (r.status === 401 || r.status === 403 ? AchievementAccessError : Error)(r.status === 401 || r.status === 403 ? 'Current school or child access unavailable. Content cleared.' : r.status === 409 ? 'Version conflict. Reload; retry unchanged uncertain requests only.' : r.status === 404 ? 'Known student or definition unavailable.' : 'No verified result; no save assumed.');
  const e: unknown = await r.json(); if (!e || typeof e !== 'object' || !Object.hasOwn(e, 'data')) throw new Error('Unverified response'); return (e as { data: unknown }).data;
}
function url(school: string, path: string, q: Record<string, string> = {}) { communityUuid(school); return `${base}${path}?${new URLSearchParams({ schoolId: school, ...q })}`; }
export async function loadAchievementAccess(school: string) { return verifyAchievementAccess(await request(url(school, '/access'))); }
export async function loadAchievementDefinitions(school: string, after: string | null = null) {
  if (after !== null) communityUuid(after);
  const p = verifyAchievementPage(await request(url(school, '/definitions', after ? { after } : {})), verifyAchievementDefinition);
  if (after && p.items.some(x => x.id <= after)) throw new Error('Invalid page'); return p;
}
export async function loadAchievementAwards(school: string, student: string, after: string | null = null) {
  communityUuid(student); if (after !== null) communityUuid(after);
  const p = verifyAchievementPage(await request(url(school, `/students/${student}/awards`, after ? { after } : {})), verifyAchievementAward);
  if (p.items.some(x => x.studentProfileId !== student || (after !== null && x.id <= after))) throw new Error('Invalid student scope'); return p;
}
export async function loadAchievementHistory(school: string, kind: 'DEFINITION' | 'AWARD', id: string, student: string | null = null, before: number | null = null) {
  communityUuid(id); if (!['DEFINITION', 'AWARD'].includes(kind) || (kind === 'AWARD') !== (student !== null)) throw new Error('Closed scope');
  if (student !== null) communityUuid(student); if (before !== null) communityVersion(before, 1);
  const path = kind === 'DEFINITION' ? `/definitions/${id}/history` : `/students/${student}/awards/${id}/history`;
  const v = await request(url(school, path, before === null ? {} : { before: String(before) }));
  const h = kind === 'DEFINITION' ? verifyAchievementHistory(v, verifyAchievementDefinition) : verifyAchievementHistory(v, verifyAchievementAward);
  if (h.id !== id || h.items.some(x => (before !== null && x.version >= before) || ('studentProfileId' in x && x.studentProfileId !== student))) throw new Error('Invalid history'); return h;
}
export type AchievementMutation = { op: 'DEFINITION'; id: string | null; input: AchievementDefinitionInput } | { op: 'AWARD'; id: string | null; student: string; input: AchievementAwardInput };
export async function saveAchievement(school: string, m: AchievementMutation, key: string) {
  if (!key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw new Error('Retain a valid key');
  if (m.id !== null) communityUuid(m.id);
  if (m.op === 'DEFINITION') validateAchievementDefinition(m.input); else { communityUuid(m.student); validateAchievementAward(m.input); }
  if ((m.id === null) !== (m.input.expectedVersion === 0)) throw new Error('Version scope');
  const path = (m.op === 'DEFINITION' ? '/definitions' : `/students/${m.student}/awards`) + (m.id ? `/${m.id}/revisions` : '');
  const v = await request(url(school, path), m.input, key); const r = m.op === 'DEFINITION' ? verifyAchievementDefinition(v) : verifyAchievementAward(v);
  const fields = { ...r } as Record<string, unknown>; delete fields.id; delete fields.version; delete fields.definition; delete fields.studentProfileId; delete fields.recordedAt; delete fields.awardedByPrincipalId; delete fields.recordedByPrincipalId;
  if ((m.id !== null && r.id !== m.id) || r.version !== m.input.expectedVersion + 1 || achievementFingerprint({ expectedVersion: r.version - 1, ...fields }) !== achievementFingerprint(m.input)
    || (m.op === 'AWARD' && (!('studentProfileId' in r) || r.studentProfileId !== m.student))) throw new Error('Unverified human save'); return r;
}
export async function loadParentAchievements(school: string, family: string, student: string, after: string | null = null) {
  for (const x of [school, family, student]) communityUuid(x); if (after !== null) communityUuid(after);
  const p = verifyParentAchievements(await request(`/api/v1/parent/students/${student}/achievements?${new URLSearchParams({ schoolId: school, familyId: family, ...(after ? { after } : {}) })}`), student);
  if (after && p.items.some(x => x.id <= after)) throw new Error('Invalid child page'); return p;
}
