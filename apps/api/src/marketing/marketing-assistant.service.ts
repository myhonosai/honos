import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateMarketingRequest, validateMarketingDraft, MARKETING_LIMITS, type AiDraftWorkItem, type MarketingAssistantContext, type MarketingInvocationView } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import { MARKETING_PROVIDER_RUNTIME, ProviderRuntimeError, type ProviderRuntime, type TextInvocation, type TextResult } from '../ai/provider-runtime.js';
import { ActionEngineService } from '../action/action-engine.service.js';
import type { PoolClient } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException({ code: 'INVALID_MARKETING_IDENTIFIER' }); }
function human(context: MarketingAssistantContext) {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId || !context.externalSubject) throw new ForbiddenException({ code: 'MARKETING_OWNER_REQUIRED' });
  for (const id of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) uuid(id);
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'MARKETING_FORBIDDEN', detail: 'Exact live school owner permission and active Complete entitlement are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'MARKETING_UNAVAILABLE' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'MARKETING_CONFLICT', detail: 'Retain the exact request key. Never resend an unknown provider outcome.' });
  if (['22023', '22P02', '23514', '23503', '22003'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_MARKETING_REQUEST' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'MARKETING_TIMEOUT', detail: 'No success assumed. Read durable state before any retry.' });
  throw error;
}

@Injectable()
export class MarketingAssistantService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly plans: AiInvocationPlanService, private readonly actions: ActionEngineService, @Inject(MARKETING_PROVIDER_RUNTIME) private readonly provider: ProviderRuntime) {}

  private async transaction<T>(context: MarketingAssistantContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    human(context);
    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        return work(client);
      });
    } catch (error) { return boundaryError(error); }
  }

  /** A read-only presentation of this human's existing durable Marcus work only. */
  private async readTransaction<T>(context: MarketingAssistantContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    human(context);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async (client) => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_external_subject',$2,true),set_config('app.hon_action_request_id',$3,true),set_config('app.hon_delegated_by_principal_id',$4,true)", [context.source, context.externalSubject, context.actionRequestId ?? '', context.delegatedByPrincipalId ?? '']);
        await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0");
        return work(client);
      });
    } catch (error) { return boundaryError(error); }
  }

  read(context: MarketingAssistantContext, id: string): Promise<MarketingInvocationView> {
    uuid(id);
    return this.transaction(context, async (client) => (await client.query<{ data: MarketingInvocationView }>('SELECT hon.read_marketing_invocation($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
  }

  listMine(context: MarketingAssistantContext): Promise<AiDraftWorkItem[]> {
    return this.transaction(context, async (client) => (await client.query<{ data: AiDraftWorkItem[] }>('SELECT hon.list_my_marketing_invocations($1) data', [context.externalSubject])).rows[0]?.data ?? []);
  }

  async submit(context: MarketingAssistantContext, input: unknown): Promise<MarketingInvocationView> {
    uuid(context.idempotencyKey);
    let normalized;
    try { normalized = validateMarketingRequest(input); } catch { throw new BadRequestException({ code: 'INVALID_MARKETING_REQUEST', detail: 'Supply only campaignId and a safe brief up to 2000 characters; never credentials or personal records.' }); }
    const view = await this.transaction(context, async (client) => (await client.query<{ data: MarketingInvocationView }>('SELECT hon.begin_marketing_request($1,$2::jsonb,$3::uuid) data', [context.externalSubject, JSON.stringify(normalized), context.idempotencyKey])).rows[0]!.data);
    if (view.status !== 'PENDING') return view;
    return this.generate(context, view.id);
  }

  async generate(context: MarketingAssistantContext, id: string): Promise<MarketingInvocationView> {
    uuid(id);
    const ref = await this.transaction(context, async (client) => (await client.query<{ data: { planId: string | null; workItemId: string; workVersion: number } | null }>('SELECT hon.marketing_planning_reference($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (!ref) { await this.resumeRecorded(context, id); return this.read(context, id); }
    let planId = ref.planId;
    if (!planId) {
      const planned = await this.plans.plan({ ...context, idempotencyKey: id }, ref.workItemId, { expectedVersion: ref.workVersion, expectedState: 'READY', agentKey: 'marcus', modality: 'TEXT', taskClass: 'DRAFT_MARKETING', inputBudget: MARKETING_LIMITS.inputTokens, outputBudget: MARKETING_LIMITS.outputTokens, maxProviderCostMicrounits: MARKETING_LIMITS.maxProviderCostMicrounits });
      planId = planned.status === 'PLANNED' ? planned.plan.id : null;
    }
    const ready = this.provider.readiness('OPENROUTER') === 'READY';
    const invocation = await this.transaction(context, async (client) => (await client.query<{ data: TextInvocation | null }>('SELECT hon.prepare_marketing_invocation($1,$2::uuid,$3::uuid,$4) data', [context.externalSubject, id, planId, ready])).rows[0]!.data);
    if (!invocation) return this.read(context, id);
    let result: TextResult;
    try {
      result = await this.provider.generate(invocation);
      result = { ...result, draft: validateMarketingDraft(result.draft) };
      if (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 1 || result.inputTokens > 1_000_000 || !Number.isSafeInteger(result.outputTokens) || result.outputTokens < 1 || result.outputTokens > 1_000_000 || !Number.isSafeInteger(result.providerCostMicrounits) || result.providerCostMicrounits < 0 || result.providerCostMicrounits > 1_000_000_000) throw new ProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
    } catch (error) {
      const failure = error instanceof ProviderRuntimeError ? error : new ProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN');
      await this.transaction(context, async (client) => { await client.query('SELECT hon.fail_marketing_invocation($1,$2::uuid,$3,$4)', [context.externalSubject, id, failure.outcome, failure.reason]); });
      return this.read(context, id);
    }
    // S4-a transaction 1: durable usage evidence only. It never shares a transaction with draft creation,
    // and its evidence-only check still succeeds after an entitlement lapse while the call was in flight.
    let payload: Record<string, unknown> | null;
    try {
      payload = await this.transaction(context, async (client) => (await client.query<{ data: Record<string, unknown> | null }>('SELECT hon.record_marketing_result($1,$2::uuid,$3::jsonb) data', [context.externalSubject, id, JSON.stringify(result)])).rows[0]!.data);
    } catch {
      try { await this.transaction(context, async (client) => { await client.query('SELECT hon.fail_marketing_invocation($1,$2::uuid,$3,$4)', [context.externalSubject, id, 'UNKNOWN', 'PROVIDER_UNKNOWN']); }); } catch { /* In-flight durable send remains quarantined; status read reports stale SENDING as UNKNOWN. */ }
      throw new ServiceUnavailableException({ code: 'MARKETING_PERSISTENCE_UNKNOWN', detail: 'Provider outcome requires reconciliation. No resend is allowed.' });
    }
    if (payload) await this.bindRecorded(context, id, payload);
    return this.read(context, id);
  }

  /** Re-attempts the approval proposal for a recorded or held result (for example after access returns). Never calls a provider. */
  private async resumeRecorded(context: MarketingAssistantContext, id: string): Promise<void> {
    const payload = await this.transaction(context, async (client) => (await client.query<{ data: Record<string, unknown> | null }>('SELECT hon.read_marketing_result_payload($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data);
    if (payload) await this.bindRecorded(context, id, payload);
  }

  /** S4-a transaction 2: proposal under the full access gate. A refusal never touches the recorded usage. */
  private async bindRecorded(context: MarketingAssistantContext, id: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.transaction(context, async (client) => {
        const proposal = await this.actions.proposeInTransaction({ ...context, idempotencyKey: `marketing-draft:${id}` }, { actionCode: 'marketing.draft.save', normalizedPayload: payload }, client);
        if (proposal.effectiveAuthorityMode !== 'CONFIRM' || proposal.status !== 'AWAITING_APPROVAL') throw new ConflictException({ code: 'MARKETING_CONFIRM_REQUIRED' });
        await client.query('SELECT hon.bind_marketing_proposal($1,$2::uuid,$3::uuid)', [context.externalSubject, id, proposal.id]);
      });
    } catch (error) {
      // Hold succeeds only when the database confirms access has lapsed; otherwise the result stays RESULT_RECORDED for retry.
      try { await this.transaction(context, async (client) => { await client.query('SELECT hon.hold_marketing_result($1,$2::uuid)', [context.externalSubject, id]); }); } catch { throw error; }
      throw new ForbiddenException({ code: 'MARKETING_RESULT_HELD', detail: 'The result and its usage are recorded and held. It becomes reviewable only after access returns.' });
    }
  }

  /** Internal typed adapter only; no arbitrary content/action/provider parameter is accepted. */
  saveApproved(context: MarketingAssistantContext, id: string): Promise<MarketingInvocationView> { uuid(id); return this.transaction(context, async (client) => (await client.query<{ data: MarketingInvocationView }>('SELECT hon.save_approved_marketing_draft($1,$2::uuid) data', [context.externalSubject, id])).rows[0]!.data); }
  workspace(context: MarketingAssistantContext, campaignId: string): Promise<{ title: string; content: string; savedAt: string }[]> { uuid(campaignId); return this.transaction(context, async (client) => (await client.query<{ data: { title: string; content: string; savedAt: string }[] }>('SELECT hon.read_marketing_campaign_content($1,$2::uuid) data', [context.externalSubject, campaignId])).rows[0]!.data); }
}
