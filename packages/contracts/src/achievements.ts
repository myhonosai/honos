import { communityUuid, communityVersion } from './community.js';

export const ACHIEVEMENT_CATEGORIES = ['EFFORT', 'PRACTICE', 'CHARACTER', 'TEAMWORK', 'LEARNING'] as const;
export const ACHIEVEMENT_AGE_BANDS = ['EARLY_CHILDHOOD', 'CHILD', 'TEEN', 'ADULT'] as const;
export const ACHIEVEMENT_VISUALS = ['STAR', 'RIBBON', 'LEAF', 'BOOK', 'HANDSHAKE'] as const;
export const ACHIEVEMENT_HELP = 'Human recognition only. No scores, readiness guarantees, automatic promotion or testing eligibility. Awards do not change rank, attendance, points or curriculum observations. No child social feed, AI, actions, providers, communications or payments.';
export interface AchievementContext {
  organizationId: string; schoolId: string; principalId: string; externalSubject: string;
  principalType: string; source: string; requestId: string; correlationId: string;
  idempotencyKey?: string; actionRequestId?: string; delegatedByPrincipalId?: string;
}
export interface AchievementDefinitionInput {
  expectedVersion: number; name: string; description: string;
  category: typeof ACHIEVEMENT_CATEGORIES[number]; ageBand: typeof ACHIEVEMENT_AGE_BANDS[number];
  visualToken: typeof ACHIEVEMENT_VISUALS[number] | null; status: 'ACTIVE' | 'ARCHIVED';
}
export interface AchievementDefinition extends Omit<AchievementDefinitionInput, 'expectedVersion'> { id: string; version: number }
export interface AchievementAwardInput {
  expectedVersion: number; definitionId: string; definitionVersion: number; reason: string | null;
  awardedOn: string; visibleToFamily: boolean; status: 'AWARDED' | 'WITHDRAWN';
}
export interface AchievementAward extends Omit<AchievementAwardInput, 'expectedVersion'> {
  id: string; studentProfileId: string; version: number; definition: AchievementDefinition;
  awardedByPrincipalId: string; recordedByPrincipalId: string; recordedAt: string;
}
export interface ParentAchievementAward { id: string; awardedOn: string; definition: AchievementDefinition }
export interface AchievementPage<T> { items: T[]; nextAfter: string | null }
export interface AchievementHistory<T> { id: string; items: T[]; nextBefore: number | null }
export interface AchievementAccess { canReadDefinitions: boolean; canManageDefinitions: boolean; canReadAwards: boolean; canRecordAwards: boolean }
const definitionFields = ['name', 'description', 'category', 'ageBand', 'visualToken', 'status'];
const awardFields = ['definitionId', 'definitionVersion', 'reason', 'awardedOn', 'visibleToFamily', 'status'];
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('Closed achievement fields required');
  return v as Record<string, unknown>;
}
export function achievementText(v: unknown, max: number, empty = false): asserts v is string {
  if (typeof v !== 'string' || [...v].length > max || (!empty && !v) || v.trim() !== v
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff<>\[\]{}=`$]|https?:|www\.|\b(?:javascript|eval|function|script|guaranteed|guarantee|score|scores|points|automatic|readiness)\b|\b(?:test|testing)[ -]ready\b|\bready for (?:testing|promotion)\b/i.test(v)) throw new Error('Bounded plain recognition text only');
}
export function achievementDate(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw new Error('Canonical award date required');
}
export function validateAchievementDefinition(v: unknown): asserts v is AchievementDefinitionInput {
  const r = object(v, ['expectedVersion', ...definitionFields]); communityVersion(r.expectedVersion, 0); if (Number(r.expectedVersion) > 999999997) throw new Error('Version limit');
  achievementText(r.name, 100); achievementText(r.description, 600, true);
  if (!(ACHIEVEMENT_CATEGORIES as readonly unknown[]).includes(r.category) || !(ACHIEVEMENT_AGE_BANDS as readonly unknown[]).includes(r.ageBand)
    || (r.visualToken !== null && !(ACHIEVEMENT_VISUALS as readonly unknown[]).includes(r.visualToken)) || !['ACTIVE', 'ARCHIVED'].includes(r.status as string)
    || (r.expectedVersion === 0 && r.status !== 'ACTIVE')) throw new Error('Closed recognition metadata required');
}
export function validateAchievementAward(v: unknown): asserts v is AchievementAwardInput {
  const r = object(v, ['expectedVersion', ...awardFields]); communityVersion(r.expectedVersion, 0); if (Number(r.expectedVersion) > 999999997) throw new Error('Version limit');
  communityUuid(r.definitionId); communityVersion(r.definitionVersion, 1); achievementDate(r.awardedOn);
  if (r.reason !== null) achievementText(r.reason, 1000);
  if (typeof r.visibleToFamily !== 'boolean' || !['AWARDED', 'WITHDRAWN'].includes(r.status as string) || (r.expectedVersion === 0 && r.status !== 'AWARDED')
    || (r.status === 'WITHDRAWN' && r.visibleToFamily)) throw new Error('Explicit human decision required');
}
export function verifyAchievementDefinition(v: unknown): AchievementDefinition {
  const r = object(v, ['id', 'version', ...definitionFields]); communityUuid(r.id); communityVersion(r.version, 1);
  const { id: ignored, version, ...fields } = r; void ignored; validateAchievementDefinition({ expectedVersion: Number(version) - 1, ...fields }); return v as AchievementDefinition;
}
export function verifyAchievementAward(v: unknown): AchievementAward {
  const r = object(v, ['id', 'version', 'studentProfileId', 'definition', 'awardedByPrincipalId', 'recordedByPrincipalId', 'recordedAt', ...awardFields]);
  communityUuid(r.awardedByPrincipalId); communityUuid(r.recordedByPrincipalId);
  if (typeof r.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(r.recordedAt) || !Number.isFinite(Date.parse(r.recordedAt))) throw new Error('Human recording timestamp required');
  communityUuid(r.id); communityUuid(r.studentProfileId); communityVersion(r.version, 1);
  const { id: ignored, studentProfileId: ignoredStudent, recordedAt: ignoredTime, awardedByPrincipalId: ignoredAwarder, recordedByPrincipalId: ignoredActor, definition, version, ...fields } = r; void ignoredTime; void ignoredAwarder; void ignoredActor; void ignored; void ignoredStudent;
  validateAchievementAward({ expectedVersion: Number(version) - 1, ...fields }); const d = verifyAchievementDefinition(definition);
  if (d.id !== r.definitionId || d.version !== r.definitionVersion || d.status !== 'ACTIVE') throw new Error('Pinned definition mismatch'); return v as AchievementAward;
}
export function verifyParentAchievementAward(v: unknown): ParentAchievementAward {
  const r = object(v, ['id', 'awardedOn', 'definition']); communityUuid(r.id); achievementDate(r.awardedOn);
  if (verifyAchievementDefinition(r.definition).status !== 'ACTIVE') throw new Error('Unverified award metadata'); return v as ParentAchievementAward;
}
export function verifyAchievementPage<T>(v: unknown, verify: (x: unknown) => T): AchievementPage<T> {
  const r = object(v, ['items', 'nextAfter']); if (!Array.isArray(r.items) || r.items.length > 30) throw new Error('Bounded page required');
  if (r.nextAfter !== null) communityUuid(r.nextAfter);
  const items = r.items.map(verify); const ids = r.items.map(x => (x as { id: string }).id);
  if (new Set(ids).size !== ids.length || ids.some((id, i) => i > 0 && id <= ids[i - 1]!) || (r.nextAfter !== null && (ids.length !== 30 || r.nextAfter !== ids.at(-1)))) throw new Error('Invalid keyset page');
  return { items, nextAfter: r.nextAfter as string | null };
}
export function verifyAchievementHistory<T extends { version: number }>(v: unknown, verify: (x: unknown) => T): AchievementHistory<T> {
  const r = object(v, ['id', 'items', 'nextBefore']); communityUuid(r.id);
  if (!Array.isArray(r.items) || r.items.length > 30) throw new Error('Bounded history required');
  if (r.nextBefore !== null) communityVersion(r.nextBefore, 1);
  const items = r.items.map(verify);
  if (items.some((x, i) => (x as { id?: string }).id !== r.id || (i > 0 && x.version >= items[i - 1]!.version))
    || (r.nextBefore !== null && (items.length !== 30 || r.nextBefore !== items.at(-1)?.version))) throw new Error('Invalid history scope');
  return { id: r.id as string, items, nextBefore: r.nextBefore as number | null };
}
export function verifyAchievementAccess(v: unknown): AchievementAccess {
  const r = object(v, ['canReadDefinitions', 'canManageDefinitions', 'canReadAwards', 'canRecordAwards']);
  if (Object.values(r).some(x => typeof x !== 'boolean')) throw new Error('Verified permission flags required'); return v as AchievementAccess;
}
export function verifyParentAchievements(v: unknown, student: string): AchievementPage<ParentAchievementAward> {
  const r = object(v, ['studentProfileId', 'items', 'nextAfter']); communityUuid(r.studentProfileId);
  if (r.studentProfileId !== student) throw new Error('Exact authorized child required');
  return verifyAchievementPage({ items: r.items, nextAfter: r.nextAfter }, verifyParentAchievementAward);
}
