import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { STAFF_SEARCH_KINDS, STAFF_SEARCH_LIMIT, STAFF_SEARCH_QUERY_MAX, staffSearchResultRoute } from '@hon/contracts';
import type { StaffSearchKind, StaffSearchQuery, StaffSearchResponse, StaffSearchResult } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const SPACES = /[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Enter 1–120 characters and unique known search types.' }); }
export function normalizeStaffSearch(input: StaffSearchQuery): { q: string; types: StaffSearchKind[] } {
  if (!input || typeof input.q !== 'string' || Array.from(input.q).length > STAFF_SEARCH_QUERY_MAX || UNSAFE_TEXT.test(input.q)) invalid();
  const q = input.q.replace(SPACES, ' ').replace(/^ +| +$/g, '');
  if (!q) invalid();
  let types: StaffSearchKind[] = [...STAFF_SEARCH_KINDS];
  if (input.types !== undefined) {
    if (typeof input.types !== 'string' || input.types.length > 80) invalid();
    const values = input.types.split(',');
    if (!values.length || values.length > STAFF_SEARCH_KINDS.length || new Set(values).size !== values.length
      || values.some(value => !STAFF_SEARCH_KINDS.includes(value as StaffSearchKind))) invalid();
    // Canonical registry ordering, never caller-provided SQL or routing names.
    types = STAFF_SEARCH_KINDS.filter(kind => values.includes(kind));
  }
  return { q, types };
}
function display(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || Array.from(value).length > max || UNSAFE_TEXT.test(value)
    || value !== value.replace(SPACES, ' ').replace(/^ +| +$/g, '')) throw new Error('Invalid HON search display.');
  return value;
}
const SUBTITLE = {
  STUDENT: /^Student · (ACTIVE|SUSPENDED|ARCHIVED)$/,
  LEAD: /^Lead · (OPEN|WON|LOST|ARCHIVED)$/,
  CLASS_SESSION: /^Class session · (DRAFT|SCHEDULED|CANCELLED|COMPLETED)$/,
  PROGRAM: /^Program · (DRAFT|SCHEDULED|CANCELLED|COMPLETED)$/,
  CURRICULUM: /^Curriculum · (DRAFT|PUBLISHED|ARCHIVED)$/,
};
@Injectable()
export class StaffSearchService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async project(externalSubject: string, organizationId: string, schoolId: string, q: string, types: StaffSearchKind[], entityId?: string): Promise<StaffSearchResponse> {
    organizationId = organizationId.toLowerCase(); schoolId = schoolId.toLowerCase(); entityId = entityId?.toLowerCase();
    if (!UUID.test(organizationId) || !UUID.test(schoolId) || (entityId !== undefined && !UUID.test(entityId))) invalid();
    let row: StaffSearchResponse;
    try { row = await this.database.readStaffSearch(externalSubject, organizationId, schoolId, q, types, entityId); }
    catch (error) {
      const failure = error as { code?: string } | undefined;
      if (failure?.code === '42501') throw new ForbiddenException({ code: 'SEARCH_FORBIDDEN', detail: 'Staff search is not authorized for this school.' });
      if (failure?.code === '22023') invalid();
      throw error;
    }
    if (!row || row.organizationId !== organizationId || row.schoolId !== schoolId || !Array.isArray(row.results)
      || row.results.length > STAFF_SEARCH_LIMIT) throw new Error('Invalid HON search scope.');
    const seen = new Set<string>();
    const results = row.results.map(result => {
      if (!result || !types.includes(result.kind) || !UUID.test(result.entityId) || (entityId && result.entityId !== entityId)) throw new Error('Invalid HON search result.');
      const key = `${result.kind}:${result.entityId}`;
      if (seen.has(key)) throw new Error('Invalid HON search duplicate.');
      seen.add(key);
      const title = display(result.title, 160); const subtitle = display(result.subtitle, 80);
      if (!SUBTITLE[result.kind].test(subtitle)) throw new Error('Invalid HON search subtitle.');
      // Do not trust a database/client-supplied route; compose from current IDs.
      const route = staffSearchResultRoute({ organizationId, schoolId }, result.kind, result.entityId);
      if (result.route !== route) throw new Error('Invalid HON search route.');
      return { kind: result.kind, entityId: result.entityId, title, subtitle, route };
    });
    return { organizationId, schoolId, results };
  }
  async search(externalSubject: string, organizationId: string, schoolId: string, input: StaffSearchQuery): Promise<StaffSearchResponse> {
    const { q, types } = normalizeStaffSearch(input);
    return this.project(externalSubject, organizationId, schoolId, q, types);
  }
  async readResult(externalSubject: string, organizationId: string, schoolId: string, kind: string, entityId: string): Promise<StaffSearchResult> {
    if (!STAFF_SEARCH_KINDS.includes(kind as StaffSearchKind)) invalid();
    const row = await this.project(externalSubject, organizationId, schoolId, 'record', [kind as StaffSearchKind], entityId);
    if (row.results.length !== 1) throw new NotFoundException({ code: 'SEARCH_RESULT_NOT_FOUND', detail: 'No scoped search record is available.' });
    return row.results[0]!;
  }
}
