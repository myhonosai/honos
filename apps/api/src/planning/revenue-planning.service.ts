import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { projectRevenuePlan, type RevenuePlanningContext, type RevenueProjection, type RevenuePlanSnapshot, type RevenuePlanSummary, type SaveRevenuePlanInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { invalidRevenueInput, revenueUuid, validateRevenueInput } from './revenue-planning.dto.js';
function human(c: RevenuePlanningContext): void {
  if(c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({code:'HUMAN_COMMAND_REQUIRED'});
  for(const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) revenueUuid(id);
  if(typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalidRevenueInput();
}
function dbError(error: unknown): never {
  const code = (error as {code?:string}).code;
  if(code === '42501') throw new ForbiddenException({code:'REVENUE_PLANNING_FORBIDDEN',detail:'Current exact school planning permission and active entitlement are required.'});
  if(code === 'P0002') throw new NotFoundException({code:'REVENUE_PLAN_NOT_FOUND'});
  if(['40001','23505','55P03','40P01'].includes(code ?? '')) throw new ConflictException({code:'REVENUE_PLAN_CONFLICT',detail:'Refresh versions. Unchanged uncertain retries must retain their original key.'});
  if(code === '57014') throw new ServiceUnavailableException({code:'REVENUE_PLANNING_TIMEOUT',detail:'No success is assumed; retry unchanged with the retained key.'});
  if(['22023','22P02','22007','22008','23514','23503','22003'].includes(code ?? '')) invalidRevenueInput();
  throw error;
}
@Injectable()
export class RevenuePlanningService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: RevenuePlanningContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)",[c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return (await client.query<{data:T}>(sql,args)).rows[0]!.data;
    }); } catch(error) { return dbError(error); }
  }
  async list(c: RevenuePlanningContext): Promise<RevenuePlanSummary[]> {
    return this.boundary(c, 'SELECT hon.read_revenue_plan($1,$2,$3::uuid,$4::integer) data', [c.externalSubject,'LIST',null,null]);
  }
  async read(c: RevenuePlanningContext, id: string, savedVersion?: number): Promise<RevenueProjection> {
    human(c); revenueUuid(id);
    if(savedVersion !== undefined && (!Number.isSafeInteger(savedVersion) || savedVersion < 1 || savedVersion > 999999999)) invalidRevenueInput();
    const snapshot = await this.boundary<RevenuePlanSnapshot>(c, 'SELECT hon.read_revenue_plan($1,$2,$3::uuid,$4::integer) data', [c.externalSubject,savedVersion === undefined ? 'CURRENT' : 'SAVED',id,savedVersion ?? null]);
    return projectRevenuePlan(snapshot, savedVersion === undefined ? 'LIVE' : 'SAVED');
  }
  async save(c: RevenuePlanningContext, id: string | null, input: SaveRevenuePlanInput): Promise<{projection:RevenueProjection;replayed:boolean}> {
    human(c); if(id !== null) revenueUuid(id); validateRevenueInput(input);
    if((id === null) !== (input.expectedVersion === 0)) invalidRevenueInput();
    if(typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    const result = await this.boundary<{snapshot:RevenuePlanSnapshot;replayed:boolean}>(c, 'SELECT hon.save_revenue_plan($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data', [c.externalSubject,id,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId]);
    return {projection:projectRevenuePlan(result.snapshot),replayed:result.replayed};
  }
}
