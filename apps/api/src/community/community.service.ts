import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { communityUuid, communityVersion, validateCommunityInput, validateCommunityProfile, validateCommunityConsent, verifyCommunityPage, verifyCommunityProfile, verifyCommunityRecord, verifyCommunityHistory, type CommunityContext, type CommunityInput, type CommunityKind, type CommunityProfileInput, type CommunityConsentInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function communityId(v: unknown): asserts v is string { try { communityUuid(v); } catch { invalid(); } }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Closed bounded plain fields only; no URLs, contacts, markup, attachments or operational data.' }); }
function human(c: CommunityContext) {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) communityId(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function boundaryError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'COMMUNITY_FORBIDDEN', detail: 'Current verified human owner/operator authority and explicit opt-in required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'COMMUNITY_UNAVAILABLE' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'COMMUNITY_CONFLICT', detail: 'Reload current version; retain the key for unchanged uncertain requests.' });
  if (['22023', '22P02', '23514', '23503', '22003'].includes(code ?? '')) invalid();
  // Do not expose database messages, content, identity, connection strings or provider details.
  throw new ServiceUnavailableException({ code: 'COMMUNITY_UNAVAILABLE', detail: 'No verified result. No save assumed.' });
}
@Injectable()
export class CommunityService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: CommunityContext, sql: string, args: unknown[], verify: (v: unknown) => T): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return verify((await client.query<{ data: unknown }>(sql, args)).rows[0]?.data);
    }); } catch (e) { return boundaryError(e); }
  }
  profile(c: CommunityContext) { return this.boundary(c, 'SELECT hon.read_community_profile($1) data', [c.externalSubject], verifyCommunityProfile); }
  list(c: CommunityContext, kind: CommunityKind, parentId: string | null, after: string | null = null) {
    if (!['TOPIC', 'POST', 'COMMENT'].includes(kind) || ((kind === 'TOPIC') !== (parentId === null))) invalid();
    if (parentId !== null) communityId(parentId); if (after !== null) communityId(after);
    return this.boundary(c, 'SELECT hon.read_community($1,$2,$3::uuid,NULL,$4::uuid) data', [c.externalSubject, kind, parentId, after], verifyCommunityPage);
  }
  read(c: CommunityContext, kind: CommunityKind, parentId: string | null, id: string) {
    communityId(id); if (!['TOPIC', 'POST', 'COMMENT'].includes(kind) || ((kind === 'TOPIC') !== (parentId === null))) invalid(); if (parentId !== null) communityId(parentId);
    return this.boundary(c, 'SELECT hon.read_community($1,$2,$3::uuid,$4::uuid,NULL) data', [c.externalSubject, kind, parentId, id], verifyCommunityRecord);
  }
  history(c: CommunityContext, id: string, before: number | null = null) {
    communityId(id); if (before !== null) { try { communityVersion(before, 1); } catch { invalid(); } }
    return this.boundary(c, 'SELECT hon.read_community_history($1,$2::uuid,$3::integer) data', [c.externalSubject, id, before], verifyCommunityHistory);
  }
  mutate(c: CommunityContext, op: 'CONTENT' | 'PROFILE' | 'CONSENT', id: string | null, input: CommunityInput | CommunityProfileInput | CommunityConsentInput) {
    human(c); if (id !== null) communityId(id);
    try {
      if (op === 'CONTENT') { validateCommunityInput(input); if ((id === null) !== (input.expectedVersion === 0)) invalid(); }
      else if (op === 'PROFILE') validateCommunityProfile(input);
      else if (op === 'CONSENT') validateCommunityConsent(input);
      else invalid();
      if (op !== 'CONTENT' && id !== null) invalid();
    } catch { invalid(); }
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.mutate_community($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid) data', [c.externalSubject, op, id, JSON.stringify(input), c.idempotencyKey, c.requestId], v => {
      if (!v || typeof v !== 'object' || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'result') || typeof (v as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified community output');
      const r = v as { result: unknown; replayed: boolean };
      return { result: op === 'CONTENT' ? verifyCommunityRecord(r.result) : verifyCommunityProfile(r.result), replayed: r.replayed };
    });
  }
}
