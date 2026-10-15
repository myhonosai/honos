import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AiInvocationPlanSummary, AiInvocationPlanningResult, CommandContext, PlanAiInvocationInput } from '@hon/contracts';
import { validateAiInvocationPlanInput } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireUuid(value: unknown): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Planning identifiers must be UUIDs.' });
}
function requireHuman(context: CommandContext): void {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.delegatedByPrincipalId || context.actionRequestId) {
    throw new ForbiddenException('AI planning requires a direct human UI context, never delegation or Action Engine.');
  }
  for (const id of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) requireUuid(id);
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'A live human planning permission and active Complete entitlement are required.' });
  if (code === '22023' || code === '22P02') throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only approved planning metadata and task/work types are allowed.' });
  if (code === '40001') throw new ConflictException({ code: 'VERSION_CONFLICT', detail: 'Refresh the durable work item state/version before planning.' });
  if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The planning key was already used for a different request.' });
  if (code === 'P0002') throw new NotFoundException('The durable work item was not found in this school.');
  throw error;
}

const PROJECTION = `id, work_item_id AS "workItemId", work_item_version AS "workItemVersion", work_item_state AS "workItemState",
  agent_key AS "agentKey", modality, task_class AS "taskClass", risk_class AS "riskClass",
  input_budget AS "inputBudget", output_budget AS "outputBudget", max_provider_cost_microunits::float8 AS "maxProviderCostMicrounits",
  estimated_provider_cost_microunits::float8 AS "estimatedProviderCostMicrounits", customer_credit_estimate AS "customerCreditEstimate",
  provider_id AS "providerId", model_id AS "modelId", catalog_id AS "catalogId", catalog_version AS "catalogVersion",
  routing_policy_id AS "routingPolicyId", routing_policy_version AS "routingPolicyVersion", provider_version AS "providerVersion",
  request_hash AS "requestHash", status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`;

@Injectable()
export class AiInvocationPlanService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  /** Internal DI service ONLY. Intentionally has no controller write/execute endpoint. */
  async plan(context: CommandContext, workItemId: string, input: PlanAiInvocationInput): Promise<AiInvocationPlanningResult> {
    requireHuman(context);
    requireUuid(workItemId);
    requireUuid(context.idempotencyKey);
    let normalized: PlanAiInvocationInput;
    try { normalized = validateAiInvocationPlanInput(input); }
    catch { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Only the closed planning metadata contract is accepted.' }); }
    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
        await client.query('SELECT hon.require_ai_invocation_plan_access()');
        // Fixed metadata-only reference boundary; runtime cannot select raw work rows.
        await client.query('SELECT hon.lock_ai_planning_work_reference($1::uuid)', [workItemId]);
        const result = await client.query<{ data: AiInvocationPlanningResult }>(
          'SELECT hon.plan_ai_invocation($1::uuid,$2::jsonb,$3::uuid,$4::uuid,$5::uuid) AS data',
          [workItemId, JSON.stringify(normalized), context.idempotencyKey, context.requestId, context.correlationId],
        );
        return result.rows[0]!.data;
      });
    } catch (error) { return boundaryError(error); }
  }

  async read(context: CommandContext, planId: string): Promise<AiInvocationPlanSummary> {
    requireHuman(context);
    requireUuid(planId);
    try {
      return await this.database.withTenantTransaction(context, async (client) => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
        await client.query('SELECT hon.require_ai_invocation_plan_access()');
        const result = await client.query<AiInvocationPlanSummary>(`SELECT ${PROJECTION} FROM hon.ai_invocation_plans WHERE id = $1::uuid`, [planId]);
        if (!result.rows[0]) throw new NotFoundException('The invocation plan was not found in this school.');
        return result.rows[0];
      });
    } catch (error) { return boundaryError(error); }
  }
}
