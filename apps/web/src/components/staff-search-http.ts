import { STAFF_SEARCH_KINDS, STAFF_SEARCH_LIMIT, staffSearchResultRoute } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchResult } from '@hon/contracts';
export const SEARCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KIND_LABEL: Record<StaffSearchKind, string> = { STUDENT: 'Students', LEAD: 'Leads', CLASS_SESSION: 'Class sessions', PROGRAM: 'Programs', CURRICULUM: 'Curricula' };
export function searchApiPath(org: string, school: string): string {
  if (!SEARCH_UUID.test(org) || !SEARCH_UUID.test(school)) throw new Error('Enter your already-known organization and school UUIDs.');
  return `/api/v1/organizations/${org.toLowerCase()}/schools/${school.toLowerCase()}/search`;
}
export function safeSearchCard(value: unknown, org: string, school: string): StaffSearchResult {
  if (!value || typeof value !== 'object') throw new Error('Search returned an invalid record.');
  const row = value as StaffSearchResult;
  if (!STAFF_SEARCH_KINDS.includes(row.kind) || typeof row.entityId !== 'string' || !SEARCH_UUID.test(row.entityId)
    || typeof row.title !== 'string' || !row.title || Array.from(row.title).length > 160
    || typeof row.subtitle !== 'string' || !row.subtitle || row.subtitle.length > 80
    || /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(row.title + row.subtitle)) throw new Error('Search returned an invalid record.');
  const route = staffSearchResultRoute({ organizationId: org.toLowerCase(), schoolId: school.toLowerCase() }, row.kind, row.entityId.toLowerCase());
  if (row.route !== route) throw new Error('Search returned an unsafe navigation path.');
  return { kind: row.kind, entityId: row.entityId.toLowerCase(), title: row.title, subtitle: row.subtitle, route };
}
export function safeSearchResults(value: unknown, org: string, school: string): StaffSearchResult[] {
  if (!value || typeof value !== 'object') throw new Error('Search result is unavailable.');
  const row = value as { organizationId?: string; schoolId?: string; results?: unknown[] };
  if (row.organizationId !== org.toLowerCase() || row.schoolId !== school.toLowerCase() || !Array.isArray(row.results)
    || row.results.length > STAFF_SEARCH_LIMIT) throw new Error('Search returned an invalid school scope.');
  const cards = row.results.map(result => safeSearchCard(result, org, school));
  if (new Set(cards.map(card => `${card.kind}:${card.entityId}`)).size !== cards.length) throw new Error('Search returned duplicate records.');
  return cards;
}
export function searchFailure(status: number): string {
  if (status === 401) return 'Sign in with a verified staff session, then search again.';
  if (status === 403) return 'Search is not authorized for this school. Ask your administrator about search.global access; no plan upgrade is needed.';
  if (status === 400) return 'Enter 1–120 characters and select known result types.';
  if (status === 404) return 'This scoped record is no longer available.';
  return 'Search is temporarily unavailable. No changes were made; try again.';
}
