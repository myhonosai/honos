import { ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateCampaignInput, validateCampaignStatus, validateCampaignWindow, type CampaignContext, type CampaignSummary, type CampaignFunnel, type CampaignStatusInput, type SaveCampaignInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { campaignUuid, invalidCampaignInput } from './campaign.dto.js';

function human(c: CampaignContext): void {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) campaignUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalidCampaignInput();
}
function dbError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'CAMPAIGN_FORBIDDEN', detail: 'Current exact school permission, human authority and active entitlement are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'CAMPAIGN_NOT_FOUND' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'CAMPAIGN_CONFLICT', detail: 'Refresh versions. Retry uncertain unchanged requests with their retained key.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'CAMPAIGN_TIMEOUT', detail: 'No success is assumed; retry unchanged with the retained key.' });
  if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) invalidCampaignInput();
  throw error;
}
@Injectable()
export class CampaignService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: CampaignContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try {
      return await this.database.withTenantTransaction(c, async client => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        return (await client.query<{ data: T }>(sql, args)).rows[0]!.data;
      });
    } catch (error) { return dbError(error); }
  }
  list(c: CampaignContext): Promise<CampaignSummary[]> {
    return this.boundary(c, 'SELECT hon.read_campaigns($1,$2,$3::uuid,$4,$5,$6::integer) data', [c.externalSubject, 'LIST', null, null, null, null]);
  }
  read(c: CampaignContext, id: string, version?: number): Promise<CampaignSummary> {
    campaignUuid(id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1 || version > 999999999)) invalidCampaignInput();
    return this.boundary(c, 'SELECT hon.read_campaigns($1,$2,$3::uuid,$4,$5,$6::integer) data', [c.externalSubject, version === undefined ? 'CURRENT' : 'SAVED', id, null, null, version ?? null]);
  }
  funnel(c: CampaignContext, id: string, from: string, to: string): Promise<CampaignFunnel> {
    campaignUuid(id);
    try { validateCampaignWindow(from, to, true); } catch { invalidCampaignInput(); }
    return this.boundary(c, 'SELECT hon.read_campaigns($1,$2,$3::uuid,$4,$5,$6::integer) data', [c.externalSubject, 'FUNNEL', id, from, to, null]);
  }
  save(c: CampaignContext, id: string | null, input: SaveCampaignInput): Promise<{ campaign: CampaignSummary; replayed: boolean }> {
    try { validateCampaignInput(input); } catch { invalidCampaignInput(); }
    if ((id === null) !== (input.expectedVersion === 0)) invalidCampaignInput();
    return this.mutate(c, id === null ? 'create' : 'update', id, input);
  }
  status(c: CampaignContext, id: string, input: CampaignStatusInput): Promise<{ campaign: CampaignSummary; replayed: boolean }> {
    try { validateCampaignStatus(input); } catch { invalidCampaignInput(); }
    return this.mutate(c, 'status', id, input);
  }
  private mutate(c: CampaignContext, operation: string, id: string | null, input: object): Promise<{ campaign: CampaignSummary; replayed: boolean }> {
    human(c); if (id !== null) campaignUuid(id);
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.mutate_campaign($1,$2,$3::uuid,$4::jsonb,$5,$6::uuid,$7::uuid) data', [c.externalSubject, operation, id, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  }
}
