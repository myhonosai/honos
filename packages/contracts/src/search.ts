import type { TenantScope } from './index.js';

export const STAFF_SEARCH_KINDS = ['STUDENT', 'LEAD', 'CLASS_SESSION', 'PROGRAM', 'CURRICULUM'] as const;
export type StaffSearchKind = (typeof STAFF_SEARCH_KINDS)[number];
export const STAFF_SEARCH_QUERY_MAX = 120;
export const STAFF_SEARCH_LIMIT = 20;
export interface StaffSearchQuery { q: string; types?: string }
export interface StaffSearchResult {
  kind: StaffSearchKind;
  entityId: string;
  title: string;
  subtitle: string;
  route: string;
}
export interface StaffSearchResponse extends TenantScope { results: StaffSearchResult[] }

/** Fixed code-owned routes. No table, column, redirect URL or route input. */
export function staffSearchResultRoute(scope: TenantScope, kind: StaffSearchKind, entityId: string): string {
  return `/staff/search/${scope.organizationId}/${scope.schoolId}/${kind}/${entityId}`;
}
