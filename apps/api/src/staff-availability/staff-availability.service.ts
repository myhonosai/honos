import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateStaffRevision, type StaffAvailabilityContext, type StaffAvailabilityProfile, type StaffRevision, type StaffRevisionInput, type StaffRevisionKind } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export function staffUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid();
}
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use the closed bounded school-local revision contract and current expected version. Qualification metadata is unverified.' }); }
function human(c: StaffAvailabilityContext): void {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) staffUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'STAFF_PLANNING_FORBIDDEN', detail: 'Current exact human school authority and an already-known eligible staff member are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'STAFF_REVISION_UNAVAILABLE' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'STAFF_REVISION_CONFLICT', detail: 'Refresh the current version; retry uncertain unchanged requests with their retained key.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'STAFF_REVISION_TIMEOUT', detail: 'No success assumed. Retry unchanged with retained key.' });
  if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) invalid();
  throw error;
}
@Injectable()
export class StaffAvailabilityService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: StaffAvailabilityContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try {
      return await this.database.withTenantTransaction(c, async client => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        return (await client.query<{ data: T }>(sql, args)).rows[0]!.data;
      });
    } catch (error) { return boundaryError(error); }
  }
  read(c: StaffAvailabilityContext, target: string | null): Promise<StaffAvailabilityProfile> {
    if (target !== null) staffUuid(target);
    return this.boundary(c, 'SELECT hon.read_staff_availability($1,$2::uuid,NULL,NULL) data', [c.externalSubject, target]);
  }
  saved(c: StaffAvailabilityContext, target: string | null, kind: StaffRevisionKind, version: number): Promise<StaffRevision> {
    if (target !== null) staffUuid(target);
    if (!['AVAILABILITY', 'QUALIFICATIONS'].includes(kind) || !Number.isSafeInteger(version) || version < 1 || version > 999999999) invalid();
    return this.boundary(c, 'SELECT hon.read_staff_availability($1,$2::uuid,$3,$4::integer) data', [c.externalSubject, target, kind, version]);
  }
  save(c: StaffAvailabilityContext, target: string | null, kind: StaffRevisionKind, input: StaffRevisionInput): Promise<{ revision: StaffRevision; replayed: boolean }> {
    human(c); if (target !== null) staffUuid(target);
    try { validateStaffRevision(kind, input); } catch { invalid(); }
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.save_staff_planning_revision($1,$2::uuid,$3,$4::jsonb,$5,$6::uuid,$7::uuid) data', [c.externalSubject, target, kind, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  }
}
