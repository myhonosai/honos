import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateAutomationRule, validateAutomationDryRun, type AutomationRuleContext, type AutomationRuleInput, type AutomationRule, type AutomationRuleList, type AutomationDryRunInput, type AutomationEvaluationPlan } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function automationUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) invalid();
}
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use closed configuration descriptors or synthetic metadata only. No executable input is accepted.' }); }
function human(c: AutomationRuleContext): void {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) automationUuid(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'AUTOMATION_CONFIGURATION_FORBIDDEN' });
  if (code === 'P0002') throw new NotFoundException({ code: 'AUTOMATION_RULE_UNAVAILABLE' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'AUTOMATION_RULE_CONFLICT', detail: 'Refresh current configuration. Retain the key only for unchanged uncertain saves.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'AUTOMATION_RULE_TIMEOUT' });
  if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) invalid();
  throw error;
}
@Injectable()
export class AutomationRuleService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: AutomationRuleContext, sql: string, args: unknown[]): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return (await client.query<{ data: T }>(sql, args)).rows[0]!.data;
    }); } catch (error) { return boundaryError(error); }
  }
  list(c: AutomationRuleContext): Promise<AutomationRuleList> { return this.boundary(c, 'SELECT hon.read_automation_rules($1,NULL,NULL) data', [c.externalSubject]); }
  read(c: AutomationRuleContext, id: string, version: number | null = null): Promise<AutomationRule> {
    automationUuid(id); if (version !== null && (!Number.isSafeInteger(version) || version < 1 || version > 999999999)) invalid();
    return this.boundary(c, 'SELECT hon.read_automation_rules($1,$2::uuid,$3::integer) data', [c.externalSubject, id, version]);
  }
  save(c: AutomationRuleContext, id: string | null, input: AutomationRuleInput): Promise<{ rule: AutomationRule; replayed: boolean }> {
    human(c); if (id !== null) automationUuid(id);
    try { validateAutomationRule(input); } catch { invalid(); }
    if (typeof c.idempotencyKey !== 'string' || !c.idempotencyKey || c.idempotencyKey.length > 200 || c.idempotencyKey.trim() !== c.idempotencyKey || /[\u0000-\u001f\u007f]/.test(c.idempotencyKey)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.save_automation_rule($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) data', [c.externalSubject, id, JSON.stringify(input), c.idempotencyKey, c.requestId, c.correlationId]);
  }
  dryRun(c: AutomationRuleContext, id: string, input: AutomationDryRunInput): Promise<AutomationEvaluationPlan> {
    human(c); automationUuid(id); try { validateAutomationDryRun(input); } catch { invalid(); }
    // SQL reads saved configuration and returns JSON only. No event/action/work persistence.
    return this.boundary(c, 'SELECT hon.dry_run_automation_rule($1,$2::uuid,$3::jsonb) data', [c.externalSubject, id, JSON.stringify(input)]);
  }
}
