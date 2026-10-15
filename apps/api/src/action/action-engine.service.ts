import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { actionDefinition, authorizeAction, requiresApproval, validateApprovalBinding, type ActionRequestStatus } from '@hon/domain';
import { ACTION_REVIEW_STATUSES, actionReviewFingerprint, safeActionReviewPayload, validateHumanActionDecision, type ActionAuthorityMode, type CommandContext, type HonTier, type ActionReviewContext, type HumanActionDecision, type HumanActionReview, type ActionReviewQueue, type HumanActionReceipt, type ActionReviewStatus } from '@hon/contracts';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLeadDto } from '../crm/create-lead.dto.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface RegisteredActionProposalInput {
  actionCode: string;
  /** This value must already have passed the registered tool's action-specific validation. */
  normalizedPayload: Record<string, unknown>;
}

export interface ActionProposalSummary {
  id: string;
  actionCode: string;
  status: 'AWAITING_APPROVAL' | 'APPROVED';
  effectiveAuthorityMode: ActionAuthorityMode;
  policyVersion: number;
  approvalExpiresAt?: string | undefined;
  replayed: boolean;
}

export interface ActionApprovalInput extends HumanActionDecision { actionRequestId: string }
export type ActionApprovalSummary = HumanActionReceipt;
export type ActionRequestReview = HumanActionReview;

export interface ExecutableAction {
  id: string;
  actionCode: string;
  normalizedPayload: Record<string, unknown>;
  requestedByPrincipalId: string;
  effectiveAuthorityMode: ActionAuthorityMode;
  policyVersion: number;
}

export type ActionExecutionOutcome = 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

type ActionPolicyRow = {
  authority_mode: ActionAuthorityMode;
  policy_version: number;
};

type OrganizationEntitlementRow = {
  tier: HonTier;
};

type ActionRequestRow = Omit<ActionProposalSummary, 'replayed'> & {
  effective_authority_mode: ActionAuthorityMode;
  policy_version: number;
  approval_expires_at: string | null;
  payload_hash: string;
};

type ExecutionRequestRow = {
  id: string;
  action_code: string;
  normalized_payload: Record<string, unknown>;
  requested_by_principal_id: string;
  required_permission: string;
  effective_authority_mode: ActionAuthorityMode;
  policy_version: number;
  approval_expires_at: Date | null;
  status: ActionRequestStatus;
};

type ReviewRow = ExecutionRequestRow & { payload_hash:string; delegated_by_principal_id:string|null; created_at:Date };

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function actionFailure(error: unknown): never {
  const code = error instanceof Error ? error.message : 'ACTION_POLICY_BLOCKED';
  if (code === 'TIER_ENTITLEMENT_REQUIRED' || code === 'PERMISSION_DENIED') {
    throw new ForbiddenException({ code, detail: 'The requested registered HON action is not available in this scope.' });
  }
  if (code === 'ACTION_RESTRICTED') {
    throw new ForbiddenException({ code, detail: 'This action is human-only and may not be queued by the Action Engine.' });
  }
  throw new ForbiddenException({ code: 'POLICY_BLOCKED', detail: 'The requested action is not registered for governed execution.' });
}

@Injectable()
export class ActionEngineService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private async hasLivePermission(
    client: import('pg').PoolClient,
    context: CommandContext,
    permissionCode: string,
  ): Promise<boolean> {
    const result = await client.query<{ allowed: boolean }>(
      `SELECT hon.principal_has_school_permission($1::uuid, $2::uuid, $3::uuid, $4) AS allowed`,
      [context.principalId, context.organizationId, context.schoolId, permissionCode],
    );
    return result.rows[0]?.allowed === true;
  }

  private assertHumanReview(context: ActionReviewContext): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.delegatedByPrincipalId || context.actionRequestId || !context.externalSubject) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED', detail: 'A direct verified human school reviewer is required.' });
    }
  }

  private async lockReviewer(client: import('pg').PoolClient, context: ActionReviewContext, requester: string | null = null): Promise<void> {
    await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
    await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
    try { await client.query('SELECT hon.require_human_action_review($1,$2::uuid)', [context.externalSubject, requester]); }
    catch (e) {
      if ((e as { code?: string }).code === '42501') throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'Current exact human school review permission is unavailable.' });
      throw e;
    }
  }

  private async reviewState(client: import('pg').PoolClient, context: ActionReviewContext, request: ReviewRow) {
    const policies = await client.query<ActionPolicyRow>(`SELECT authority_mode,policy_version FROM hon.action_policies
      WHERE organization_id=$1 AND school_id=$2 AND action_code=$3 AND effective_from<=clock_timestamp()
      AND (effective_until IS NULL OR effective_until>clock_timestamp()) ORDER BY policy_version DESC LIMIT 1`, [context.organizationId,context.schoolId,request.action_code]);
    const policy = policies.rows[0];
    const currentPolicyVersion = policy?.policy_version ?? 0;
    let currentAuthorityMode: ActionAuthorityMode | null = null;
    let reviewBlock: string | null = null;
    const action = actionDefinition(request.action_code);
    const entitlement = (await client.query<OrganizationEntitlementRow>(`SELECT tier::text tier FROM hon.organization_entitlements
      WHERE organization_id=$1 AND status='ACTIVE' AND effective_from<=clock_timestamp()
      AND (effective_until IS NULL OR effective_until>clock_timestamp())`, [context.organizationId])).rows[0];
    if (!action || action.requiredPermission !== request.required_permission) reviewBlock = 'ACTION_REGISTRY_MISMATCH';
    else if (!entitlement) reviewBlock = 'TIER_ENTITLEMENT_REQUIRED';
    else {
      try { currentAuthorityMode = authorizeAction({ actionCode: action.code, tier: entitlement.tier,
        grantedPermissions: new Set([action.requiredPermission]), authoritySources: policy
          ? { platform: action.platformAuthorityFloor, school: policy.authority_mode } : { platform: action.platformAuthorityFloor } }).effectiveAuthority; }
      catch { reviewBlock = 'POLICY_BLOCKED'; }
    }
    if (!reviewBlock && (currentPolicyVersion !== request.policy_version || currentAuthorityMode !== request.effective_authority_mode || currentAuthorityMode !== 'CONFIRM')) reviewBlock = 'APPROVAL_POLICY_STALE';
    if (!reviewBlock && !await this.hasLivePermission(client, { ...context, principalId: request.requested_by_principal_id }, request.required_permission)) reviewBlock = 'REQUESTOR_PERMISSION_DENIED';
    if (!reviewBlock && (request.requested_by_principal_id === context.principalId || request.delegated_by_principal_id === context.principalId)) reviewBlock = 'APPROVAL_SELF_REVIEW_DENIED';
    if (!reviewBlock && (!request.approval_expires_at || request.approval_expires_at <= new Date())) reviewBlock = 'APPROVAL_EXPIRED';
    if (!reviewBlock && (!safeActionReviewPayload(request.normalized_payload) || payloadHash(request.normalized_payload) !== request.payload_hash)) reviewBlock = 'APPROVAL_PAYLOAD_UNSAFE';
    // The only existing typed executable adapter is CRM lead creation. Others
    // have catalog metadata but no reviewed domain revalidation adapter yet.
    if (!reviewBlock && request.action_code !== 'crm.lead.create') reviewBlock = 'DOMAIN_REVALIDATION_UNAVAILABLE';
    if (!reviewBlock) {
      const input = plainToInstance(CreateLeadDto, request.normalized_payload);
      const errors = await validate(input, { whitelist: true, forbidNonWhitelisted: true });
      const attribution = input.attribution;
      if (errors.length || (attribution && (Object.entries(attribution).some(([k,v]) => ['migration','campaignId','campaignCode'].includes(k) || typeof v !== 'string') || JSON.stringify(attribution).length > 12000))) reviewBlock = 'APPROVAL_PAYLOAD_INVALID';
      else {
        const target = await client.query<{ current: boolean }>('SELECT hon.crm_lead_target_is_current($1::uuid,$2::uuid) AS current', [input.pipelineId,input.pipelineStageId]);
        if (target.rows[0]?.current !== true) reviewBlock = 'ACTION_TARGET_STALE';
      }
    }
    return { currentPolicyVersion, currentAuthorityMode, reviewBlock };
  }

  private async reviewRequest(client: import('pg').PoolClient, id: string, lock: boolean): Promise<ReviewRow> {
    const result = await client.query<ReviewRow>(`SELECT id,action_code,normalized_payload,payload_hash,required_permission,
      requested_by_principal_id,delegated_by_principal_id,effective_authority_mode,policy_version,status,approval_expires_at,created_at
      FROM hon.action_requests WHERE id=$1::uuid ${lock ? 'FOR UPDATE' : 'FOR SHARE'}`, [id]);
    if (!result.rows[0]) throw new ForbiddenException({ code: 'TENANT_SCOPE_DENIED', detail: 'The requested proposal is unavailable in this school.' });
    return result.rows[0];
  }

  private reviewItem(r: ReviewRow) {
    return { id:r.id,actionCode:r.action_code,status:r.status,requestedByPrincipalId:r.requested_by_principal_id,
      effectiveAuthorityMode:r.effective_authority_mode,policyVersion:r.policy_version,approvalExpiresAt:r.approval_expires_at?.toISOString() ?? null,createdAt:r.created_at.toISOString() };
  }

  async listForReview(context: ActionReviewContext, status: ActionReviewStatus | 'ALL' = 'AWAITING_APPROVAL', after: string | null = null): Promise<ActionReviewQueue> {
    this.assertHumanReview(context);
    if (status !== 'ALL' && !ACTION_REVIEW_STATUSES.includes(status)) throw new BadRequestException({ code:'VALIDATION_FAILED' });
    return this.database.withTenantTransaction(context, async client => {
      await this.lockReviewer(client,context);
      const result = await client.query<ReviewRow>(`SELECT id,action_code,status,requested_by_principal_id,effective_authority_mode,policy_version,approval_expires_at,created_at
        FROM hon.action_requests WHERE ($1='ALL' OR status::text=$1) AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 51`,[status,after]);
      const items=result.rows.slice(0,50).map(r=>this.reviewItem(r));
      return { organizationId:context.organizationId,schoolId:context.schoolId,reviewerPrincipalId:context.principalId,reviewerPermission:'action.approve',status,items,nextAfter:result.rows.length>50 ? items[49]!.id : null,executionTriggered:false };
    });
  }

  /** Exact immutable intent, never verified_result/failure/provider tokens. */
  async getForReview(context: ActionReviewContext, actionRequestId: string): Promise<HumanActionReview> {
    this.assertHumanReview(context);
    return this.database.withTenantTransaction(context, async client => {
      const r=await this.reviewRequest(client,actionRequestId,false);
      await this.lockReviewer(client,context,r.requested_by_principal_id);
      const state=await this.reviewState(client,context,r);
      const safe=safeActionReviewPayload(r.normalized_payload) && payloadHash(r.normalized_payload)===r.payload_hash;
      const decisions=(await client.query<{reviewerPrincipalId:string;decision:'APPROVED'|'DENIED'|'EXPIRED';payloadHash:string;policyVersion:number;decidedAt:Date}>(`SELECT reviewer_principal_id AS "reviewerPrincipalId",decision,reviewed_payload_hash AS "payloadHash",reviewed_policy_version AS "policyVersion",decided_at AS "decidedAt" FROM hon.action_approvals WHERE action_request_id=$1::uuid ORDER BY decided_at,id LIMIT 51`,[r.id])).rows;
      return { ...this.reviewItem(r),organizationId:context.organizationId,schoolId:context.schoolId,payloadHash:r.payload_hash,requiredPermission:r.required_permission,
        normalizedPayload:safe ? r.normalized_payload : null,payloadVisibility:safe ? 'EXACT' : 'WITHHELD_UNSAFE',reviewerPrincipalId:context.principalId,reviewerPermission:'action.approve',
        delegatedByPrincipalId:r.delegated_by_principal_id,...state,reviewBlock:r.status==='AWAITING_APPROVAL' ? state.reviewBlock : 'PROPOSAL_ALREADY_RESOLVED',
        decisions:decisions.slice(0,50).map(d=>({...d,decidedAt:d.decidedAt.toISOString()})),decisionsTruncated:decisions.length>50,executionTriggered:false };
    });
  }

  /**
   * Creates a durable, reviewable action proposal after the caller has resolved
   * the exact registered-action permission into a server-derived CommandContext.
   * It deliberately does not execute a normal domain command or call a provider.
   */
  async propose(
    context: CommandContext,
    input: RegisteredActionProposalInput,
  ): Promise<ActionProposalSummary> {
    const registeredAction = actionDefinition(input.actionCode);
    if (!registeredAction) {
      throw new ForbiddenException({ code: 'POLICY_BLOCKED', detail: 'HON rejects unregistered action codes.' });
    }

    const normalizedHash = payloadHash(input.normalizedPayload);
    return this.database.withTenantTransaction(context, async (client) => {
      if (!await this.hasLivePermission(client, context, registeredAction.requiredPermission)) {
        throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'The registered action permission is no longer active in this school.' });
      }
      const entitlementResult = await client.query<OrganizationEntitlementRow>(
        `SELECT tier::text AS tier
         FROM hon.organization_entitlements
         WHERE organization_id = $1
           AND status = 'ACTIVE'
           AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())`,
        [context.organizationId],
      );
      const entitlement = entitlementResult.rows[0];
      if (!entitlement) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON organization entitlement is required for Action Engine proposals.' });
      }
      const policyResult = await client.query<ActionPolicyRow>(
        `SELECT authority_mode, policy_version
         FROM hon.action_policies
         WHERE organization_id = $1
           AND school_id = $2
           AND action_code = $3
           AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())
         ORDER BY policy_version DESC
         LIMIT 1`,
        [context.organizationId, context.schoolId, registeredAction.code],
      );
      const policy = policyResult.rows[0];

      let authorized: ReturnType<typeof authorizeAction>;
      try {
        // Permission is not supplied by an AI model or client. The typed tool
        // gateway reaches this service only after scope resolution for the
        // registered action's exact permission succeeds.
        const authoritySources = policy
          ? { platform: registeredAction.platformAuthorityFloor, school: policy.authority_mode }
          : { platform: registeredAction.platformAuthorityFloor };
        authorized = authorizeAction({
          actionCode: registeredAction.code,
          tier: entitlement.tier,
          grantedPermissions: new Set([registeredAction.requiredPermission]),
          authoritySources,
        });
      } catch (error) {
        return actionFailure(error);
      }

      const requestedStatus = requiresApproval(authorized.effectiveAuthority) ? 'AWAITING_APPROVAL' : 'APPROVED';
      const approvalExpiresAt = requestedStatus === 'AWAITING_APPROVAL'
        ? new Date(Date.now() + 30 * 60 * 1000)
        : undefined;
      const proposalId = randomUUID();

      const inserted = await client.query<ActionRequestRow>(
        `INSERT INTO hon.action_requests (
           id, organization_id, school_id, requested_by_principal_id, delegated_by_principal_id,
           action_code, normalized_payload, payload_hash, required_permission,
           effective_authority_mode, policy_version, status, approval_expires_at,
           correlation_id, idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
           $6, $7::jsonb, $8, $9,
           $10::hon.authority_mode, $11, $12::hon.action_request_status, $13::timestamptz,
           $14::uuid, $15
         )
         ON CONFLICT (organization_id, school_id, requested_by_principal_id, idempotency_key) DO NOTHING
         RETURNING id, action_code AS "actionCode", status, effective_authority_mode, policy_version, approval_expires_at, payload_hash`,
        [
          proposalId,
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.delegatedByPrincipalId ?? null,
          registeredAction.code,
          JSON.stringify(canonicalize(input.normalizedPayload)),
          normalizedHash,
          registeredAction.requiredPermission,
          authorized.effectiveAuthority,
          policy?.policy_version ?? 0,
          requestedStatus,
          approvalExpiresAt?.toISOString() ?? null,
          context.correlationId,
          context.idempotencyKey,
        ],
      );

      if (!inserted.rowCount) {
        const existing = await client.query<ActionRequestRow>(
          `SELECT id, action_code AS "actionCode", status, effective_authority_mode, policy_version, approval_expires_at, payload_hash
           FROM hon.action_requests
           WHERE organization_id = $1 AND school_id = $2 AND requested_by_principal_id = $3 AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const request = existing.rows[0];
        if (!request) throw new Error('HON action idempotency record unexpectedly missing after lock acquisition.');
        if (request.actionCode !== registeredAction.code || request.payload_hash !== normalizedHash) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different action proposal.' });
        }
        if (request.status !== 'AWAITING_APPROVAL' && request.status !== 'APPROVED') {
          throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching action proposal is no longer replayable.' });
        }
        return {
          id: request.id,
          actionCode: request.actionCode,
          status: request.status,
          effectiveAuthorityMode: request.effective_authority_mode,
          policyVersion: request.policy_version,
          approvalExpiresAt: request.approval_expires_at ?? undefined,
          replayed: true,
        };
      }

      const request = inserted.rows[0];
      if (!request) throw new Error('HON action proposal insert did not return a record.');
      const eventPayload = {
        actionRequestId: request.id,
        actionCode: registeredAction.code,
        effectiveAuthorityMode: authorized.effectiveAuthority,
        policyVersion: policy?.policy_version ?? 0,
        status: requestedStatus,
      };
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, occurred_at
         ) VALUES ($1, $2, $3, $4, 'action.request.propose', 'ACTION_REQUEST', $5, NULL, $6::jsonb,
                   'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, request.id, JSON.stringify(eventPayload), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         ) VALUES ($1::uuid, $2, $3, 'action.request.proposed', 1, 'ACTION_REQUEST', $4::uuid, 1,
                   $5::uuid, $6::uuid, $7::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, request.id, context.correlationId, context.requestId, JSON.stringify(eventPayload)],
      );

      return {
        id: request.id,
        actionCode: request.actionCode,
        status: requestedStatus,
        effectiveAuthorityMode: authorized.effectiveAuthority,
        policyVersion: policy?.policy_version ?? 0,
        approvalExpiresAt: approvalExpiresAt?.toISOString(),
        replayed: false,
      };
    });
  }

  /**
   * Locks and revalidates an approved proposal immediately before a registered
   * ordinary-domain-service adapter executes it. This is internal only.
   */
  async beginExecution(context: CommandContext, actionRequestId: string): Promise<ExecutableAction> {
    return this.database.withTenantTransaction(context, async (client) => {
      const requestResult = await client.query<ExecutionRequestRow>(
        `SELECT id, action_code, normalized_payload, requested_by_principal_id, required_permission,
                effective_authority_mode, policy_version, approval_expires_at, status
         FROM hon.action_requests WHERE id=$1::uuid FOR UPDATE`, [actionRequestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw new ForbiddenException({ code: 'TENANT_SCOPE_DENIED', detail: 'The requested action proposal is not available in this school scope.' });
      if (request.requested_by_principal_id !== context.principalId) {
        throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'Only the original authorized Action Engine principal may execute this proposal.' });
      }
      if (request.status !== 'APPROVED') {
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: 'This action proposal is not approved for execution.' });
      }
      // A CONFIRM proposal is valid for execution only while it retains the
      // immutable timed binding created for qualified human review. Reviewer
      // evidence remains RLS-visible only to qualified human reviewers.
      if (request.effective_authority_mode === 'CONFIRM' && !request.approval_expires_at) {
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: 'A confirmation proposal is missing its approval validity binding.' });
      }
      if (request.approval_expires_at && request.approval_expires_at <= new Date()) {
        await client.query(`UPDATE hon.action_requests SET status='EXPIRED',updated_at=now() WHERE id=$1::uuid`, [request.id]);
        const expiryPayload = { actionRequestId: request.id, actionCode: request.action_code, reason: 'APPROVAL_EXPIRED' };
        await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
          VALUES ($1,$2,$3,$4,'action.request.expire','ACTION_REQUEST',$5::uuid,$6::jsonb,$7::jsonb,'FAILED',$8::uuid,$9::uuid,$5::uuid,now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, request.id, JSON.stringify({ status: 'APPROVED' }), JSON.stringify({ status: 'EXPIRED' }), context.requestId, context.correlationId]);
        await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
          VALUES ($1::uuid,$2,$3,'action.request.expired',1,'ACTION_REQUEST',$4::uuid,3,$5::uuid,$6::uuid,$7::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, request.id, context.correlationId, context.requestId, JSON.stringify(expiryPayload)]);
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: 'This approval expired before HON began execution.' });
      }

      const registeredAction = actionDefinition(request.action_code);
      if (!registeredAction || registeredAction.requiredPermission !== request.required_permission) {
        throw new ForbiddenException({ code: 'POLICY_BLOCKED', detail: 'HON cannot execute an unregistered or mismatched action proposal.' });
      }
      if (!await this.hasLivePermission(client, context, registeredAction.requiredPermission)) {
        throw new ForbiddenException({ code: 'PERMISSION_DENIED', detail: 'The action requestor no longer has this school permission.' });
      }
      const entitlementResult = await client.query<OrganizationEntitlementRow>(
        `SELECT tier::text AS tier FROM hon.organization_entitlements
         WHERE organization_id=$1 AND status='ACTIVE' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())`, [context.organizationId],
      );
      const entitlement = entitlementResult.rows[0];
      if (!entitlement) throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'The organization no longer has an active entitlement for this action.' });
      const policyResult = await client.query<ActionPolicyRow>(
        `SELECT authority_mode,policy_version FROM hon.action_policies
         WHERE organization_id=$1 AND school_id=$2 AND action_code=$3 AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())
         ORDER BY policy_version DESC LIMIT 1`, [context.organizationId, context.schoolId, request.action_code],
      );
      const policy = policyResult.rows[0];
      let authorized: ReturnType<typeof authorizeAction>;
      try {
        authorized = authorizeAction({
          actionCode: registeredAction.code,
          tier: entitlement.tier,
          grantedPermissions: new Set([registeredAction.requiredPermission]),
          authoritySources: policy ? { platform: registeredAction.platformAuthorityFloor, school: policy.authority_mode } : { platform: registeredAction.platformAuthorityFloor },
        });
      } catch (error) {
        return actionFailure(error);
      }
      if (authorized.effectiveAuthority !== request.effective_authority_mode || (policy?.policy_version ?? 0) !== request.policy_version) {
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: 'The authorization policy changed after this action was proposed and must be reviewed again.' });
      }

      await client.query(`UPDATE hon.action_requests SET status='EXECUTING',updated_at=now() WHERE id=$1::uuid`, [request.id]);
      const payload = { actionRequestId: request.id, actionCode: request.action_code, policyVersion: request.policy_version };
      await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
        VALUES ($1,$2,$3,$4,'action.request.execute.start','ACTION_REQUEST',$5::uuid,$6::jsonb,$7::jsonb,'SUCCEEDED',$8::uuid,$9::uuid,$5::uuid,now())`,
      [context.organizationId, context.schoolId, context.principalId, context.source, request.id, JSON.stringify({ status: 'APPROVED' }), JSON.stringify({ status: 'EXECUTING' }), context.requestId, context.correlationId]);
      await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES ($1::uuid,$2,$3,'action.request.execution.started',1,'ACTION_REQUEST',$4::uuid,3,$5::uuid,$6::uuid,$7::jsonb)`,
      [randomUUID(), context.organizationId, context.schoolId, request.id, context.correlationId, context.requestId, JSON.stringify(payload)]);
      return { id: request.id, actionCode: request.action_code, normalizedPayload: request.normalized_payload, requestedByPrincipalId: request.requested_by_principal_id, effectiveAuthorityMode: request.effective_authority_mode, policyVersion: request.policy_version };
    });
  }

  /** Records the verified result of a typed adapter; UNKNOWN is intentionally not success. */
  async recordExecutionOutcome(
    context: CommandContext,
    actionRequestId: string,
    outcome: ActionExecutionOutcome,
    details: Record<string, unknown>,
  ): Promise<void> {
    return this.database.withTenantTransaction(context, async (client) => {
      const requestResult = await client.query<Pick<ExecutionRequestRow, 'id' | 'action_code' | 'requested_by_principal_id' | 'status'>>(
        `SELECT id,action_code,requested_by_principal_id,status FROM hon.action_requests WHERE id=$1::uuid FOR UPDATE`, [actionRequestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw new ForbiddenException({ code: 'TENANT_SCOPE_DENIED', detail: 'The requested action proposal is not available in this school scope.' });
      if (request.requested_by_principal_id !== context.principalId || request.status !== 'EXECUTING') {
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: 'The Action Engine execution state is no longer current.' });
      }
      await client.query(
        `UPDATE hon.action_requests SET status=$2::hon.action_request_status,
          verified_result=CASE WHEN $2='SUCCEEDED' THEN $3::jsonb ELSE verified_result END,
          failure_details=CASE WHEN $2='SUCCEEDED' THEN NULL ELSE $3::jsonb END,updated_at=now() WHERE id=$1::uuid`,
        [request.id, outcome, JSON.stringify(details)],
      );
      const payload = { actionRequestId: request.id, actionCode: request.action_code, outcome, details };
      await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
        VALUES ($1,$2,$3,$4,'action.request.execute.finish','ACTION_REQUEST',$5::uuid,$6::jsonb,$7::jsonb,$8::hon.audit_result,$9::uuid,$10::uuid,$5::uuid,now())`,
      [context.organizationId, context.schoolId, context.principalId, context.source, request.id, JSON.stringify({ status: 'EXECUTING' }), JSON.stringify({ status: outcome }), outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', context.requestId, context.correlationId]);
      await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES ($1::uuid,$2,$3,'action.request.execution.finished',1,'ACTION_REQUEST',$4::uuid,4,$5::uuid,$6::uuid,$7::jsonb)`,
      [randomUUID(), context.organizationId, context.schoolId, request.id, context.correlationId, context.requestId, JSON.stringify(payload)]);
    });
  }

  /**
   * Records a qualified human decision against an exact proposal binding. The
   * endpoint/tool adapter must have separately resolved `action.approve` for
   * the reviewer before reaching this method. Approval never executes the
   * action; a registered executor revalidates it later.
   */
  async decide(context: ActionReviewContext, input: ActionApprovalInput): Promise<ActionApprovalSummary> {
    this.assertHumanReview(context);
    try { const { actionRequestId: _id, ...decision }=input; validateHumanActionDecision(decision); }
    catch { throw new BadRequestException({ code:'VALIDATION_FAILED',detail:'Use the exact displayed proposal binding.' }); }
    if (!context.idempotencyKey || context.idempotencyKey.length>200 || context.idempotencyKey.trim()!==context.idempotencyKey || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) throw new ConflictException({ code:'IDEMPOTENCY_KEY_REQUIRED' });
    return this.database.withTenantTransaction(context,async client=>{
      const r=await this.reviewRequest(client,input.actionRequestId,true);
      await this.lockReviewer(client,context,r.requested_by_principal_id);
      const state=await this.reviewState(client,context,r);
      const exact={actionRequestId:r.id,actionCode:r.action_code,requestedByPrincipalId:r.requested_by_principal_id,payloadHash:r.payload_hash,policyVersion:r.policy_version,approvalExpiresAt:r.approval_expires_at?.toISOString() ?? '',effectiveAuthorityMode:r.effective_authority_mode};
      if (actionReviewFingerprint(exact)!==actionReviewFingerprint(input.binding)) throw new ConflictException({code:'POLICY_BLOCKED',detail:'APPROVAL_PROPOSAL_BINDING_STALE'});
      if (state.reviewBlock) throw new ConflictException({code:'POLICY_BLOCKED',detail:state.reviewBlock});
      try { validateApprovalBinding({actionRequestId:r.id,requestedByPrincipalId:r.requested_by_principal_id,reviewerPrincipalId:context.principalId,normalizedPayloadHash:r.payload_hash,policyVersion:r.policy_version,expiresAt:r.approval_expires_at!},
        {actionRequestId:input.binding.actionRequestId,requestedByPrincipalId:input.binding.requestedByPrincipalId,reviewerPrincipalId:context.principalId,normalizedPayloadHash:input.binding.payloadHash,policyVersion:state.currentPolicyVersion,now:new Date(),reviewerHasPermission:true}); }
      catch { throw new ConflictException({code:'POLICY_BLOCKED',detail:'APPROVAL_BINDING_INVALID'}); }
      const fingerprint=payloadHash({operation:'action.request.decide',...input});
      const reservation=await client.query(`INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
        VALUES($1,$2,$3,$4,$5,'IN_PROGRESS',clock_timestamp()+interval '24 hours') ON CONFLICT(organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`,[context.organizationId,context.schoolId,context.principalId,context.idempotencyKey,fingerprint]);
      if (!reservation.rowCount) {
        const old=(await client.query<{request_fingerprint:string;status:string;response_body:HumanActionReceipt|null}>(`SELECT request_fingerprint,status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`,[context.organizationId,context.schoolId,context.principalId,context.idempotencyKey])).rows[0];
        // The idempotency lock can wait for another decision transaction. The
        // initial check is not durable authorization for a replayed receipt.
        await this.lockReviewer(client,context,r.requested_by_principal_id);
        const live=await this.reviewState(client,context,r); if(live.reviewBlock) throw new ConflictException({code:'POLICY_BLOCKED',detail:live.reviewBlock});
        if (!old || old.request_fingerprint!==fingerprint) throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});
        if (old.status==='COMPLETED' && old.response_body) return old.response_body;
        throw new ConflictException({code:'IDEMPOTENCY_IN_PROGRESS'});
      }
      if (r.status!=='AWAITING_APPROVAL') throw new ConflictException({code:'POLICY_BLOCKED',detail:'PROPOSAL_ALREADY_RESOLVED'});
      // A successful INSERT can also have waited on the unique key. Check again
      // immediately before changing proposal state or writing evidence.
      await this.lockReviewer(client,context,r.requested_by_principal_id);
      const live=await this.reviewState(client,context,r); if(live.reviewBlock) throw new ConflictException({code:'POLICY_BLOCKED',detail:live.reviewBlock});
      // Clock check is after all lock waits, including idempotency. No execution.
      if (!r.approval_expires_at || r.approval_expires_at<=new Date()) throw new ConflictException({code:'POLICY_BLOCKED',detail:'APPROVAL_EXPIRED'});
      const updated=(await client.query<{updated_at:Date}>(`UPDATE hon.action_requests SET status=$2::hon.action_request_status,updated_at=clock_timestamp() WHERE id=$1::uuid RETURNING updated_at`,[r.id,input.decision])).rows[0]!;
      await client.query(`INSERT INTO hon.action_approvals(organization_id,school_id,action_request_id,reviewer_principal_id,decision,reviewed_payload_hash,reviewed_policy_version,reason)
        VALUES($1,$2,$3::uuid,$4::uuid,$5::hon.approval_decision,$6,$7,$8)`,[context.organizationId,context.schoolId,r.id,context.principalId,input.decision,r.payload_hash,r.policy_version,input.reason ?? null]);
      const evidence={actionRequestId:r.id,actionCode:r.action_code,decision:input.decision,payloadHash:r.payload_hash,policyVersion:r.policy_version,reviewerPermission:'action.approve',executionTriggered:false};
      await client.query(`INSERT INTO hon.audit_events(organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at)
        VALUES($1,$2,$3,$4,'action.request.decide','ACTION_REQUEST',$5::uuid,$6::jsonb,$7::jsonb,'SUCCEEDED',$8::uuid,$9::uuid,$5::uuid,clock_timestamp())`,[context.organizationId,context.schoolId,context.principalId,context.source,r.id,JSON.stringify({status:'AWAITING_APPROVAL'}),JSON.stringify(evidence),context.requestId,context.correlationId]);
      await client.query(`INSERT INTO hon.outbox_events(id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload)
        VALUES($1::uuid,$2,$3,'action.request.decided',1,'ACTION_REQUEST',$4::uuid,2,$5::uuid,$6::uuid,$7::jsonb)`,[randomUUID(),context.organizationId,context.schoolId,r.id,context.correlationId,context.requestId,JSON.stringify(evidence)]);
      const response:HumanActionReceipt={actionRequestId:r.id,status:input.decision,actionCode:r.action_code,reviewedAt:updated.updated_at.toISOString(),payloadHash:r.payload_hash,policyVersion:r.policy_version,executionTriggered:false};
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=200,response_body=$5::jsonb WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`,[context.organizationId,context.schoolId,context.principalId,context.idempotencyKey,JSON.stringify(response)]);
      return response;
    });
  }
}
