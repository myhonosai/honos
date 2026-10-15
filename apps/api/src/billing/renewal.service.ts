import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { RENEWAL_UUID, RENEWAL_STATUSES, validateRenewal, type RenewalContext, type RenewalInput, type RenewalOperation, type RenewalQueue, type RenewalDetail, type RenewalHistory, type RenewalRecord, type RenewalStatus, type RenewalMembershipFacts } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function renewalUuid(v: unknown): asserts v is string { if (typeof v !== 'string' || !RENEWAL_UUID.test(v)) invalid(); }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use the closed bounded human renewal contract, explicit note/reason and current version.' }); }
function human(c: RenewalContext) {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) renewalUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function boundaryError(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'RENEWAL_FORBIDDEN', detail: 'Current exact human school membership-read and renewal-manage staff authority required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'RENEWAL_UNAVAILABLE' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'RENEWAL_CONFLICT', detail: 'Reload current review version. Retain the key for unchanged uncertain requests.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'RENEWAL_TIMEOUT', detail: 'No save assumed. Retry unchanged with the retained key.' });
  if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) invalid();
  throw e;
}
@Injectable()
export class RenewalService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: RenewalContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return (await client.query<{ data: T }>(sql, args)).rows[0]!.data;
    }); } catch (e) { return boundaryError(e); }
  }
  list(c: RenewalContext, status: RenewalStatus | 'ALL' = 'OPEN', after: string | null = null): Promise<RenewalQueue> {
    if (![...RENEWAL_STATUSES, 'ALL'].includes(status)) invalid(); if (after !== null) renewalUuid(after);
    return this.boundary(c, 'SELECT hon.read_renewals($1,NULL,$2,$3::uuid,NULL) data', [c.externalSubject, status, after]);
  }
  read(c: RenewalContext, id: string, version: number | null = null): Promise<RenewalDetail> {
    renewalUuid(id); if (version !== null && (!Number.isSafeInteger(version) || version < 1 || version > 999999999)) invalid();
    return this.boundary(c, "SELECT hon.read_renewals($1,$2::uuid,'ALL',NULL,$3::integer) data", [c.externalSubject, id, version]);
  }
  membership(c: RenewalContext, id: string): Promise<RenewalMembershipFacts> {
    renewalUuid(id); return this.boundary(c, 'SELECT hon.read_renewal_membership($1,$2::uuid) data', [c.externalSubject, id]);
  }
  history(c: RenewalContext, id: string, before: number | null = null): Promise<RenewalHistory> {
    renewalUuid(id); if (before !== null && (!Number.isSafeInteger(before) || before < 1 || before > 999999999)) invalid();
    return this.boundary(c, 'SELECT hon.read_renewal_history($1,$2::uuid,$3::integer) data', [c.externalSubject, id, before]);
  }
  mutate(c: RenewalContext, op: RenewalOperation, id: string | null, input: RenewalInput): Promise<{ renewal: RenewalRecord; replayed: boolean }> {
    human(c); if (id !== null) renewalUuid(id);
    try { validateRenewal(op, input); } catch { invalid(); }
    if ((op === 'CREATE') !== (id === null)) invalid();
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.mutate_renewal($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data', [c.externalSubject, op, id, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  }
}
