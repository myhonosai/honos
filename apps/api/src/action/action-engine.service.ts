import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { actionDefinition, authorizeAction, requiresApproval, validateApprovalBinding } from '@hon/domain';
import type { ActionAuthorityMode, CommandContext, HonTier } from '@hon/contracts';
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

export interface ActionApprovalInput {
  actionRequestId: string;
  decision: 'APPROVED' | 'DENIED';
  reason?: string;
}

export interface ActionApprovalSummary {
  actionRequestId: string;
  status: 'APPROVED' | 'DENIED';
  actionCode: string;
  reviewedAt: string;
}

export interface ActionRequestReview {
  id: string;
  actionCode: string;
  normalizedPayload: Record<string, unknown>;
  payloadHash: string;
  requestedByPrincipalId: string;
  effectiveAuthorityMode: ActionAuthorityMode;
  policyVersion: number;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  approvalExpiresAt?: string | undefined;
  createdAt: string;
}

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

type PendingActionRequestRow = {
  id: string;
  requested_by_principal_id: string;
  action_code: string;
  payload_hash: string;
  policy_version: number;
  approval_expires_at: Date | null;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'DENIED' | 'EXPIRED';
};

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

  /** Returns the exact immutable proposal a separately authorized human must review. */
  async getForReview(context: CommandContext, actionRequestId: string): Promise<ActionRequestReview> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<ActionRequestReview>(
        `SELECT id, action_code AS "actionCode", normalized_payload AS "normalizedPayload", payload_hash AS "payloadHash",
                requested_by_principal_id AS "requestedByPrincipalId", effective_authority_mode AS "effectiveAuthorityMode",
                policy_version AS "policyVersion", status, approval_expires_at AS "approvalExpiresAt", created_at AS "createdAt"
         FROM hon.action_requests
         WHERE id = $1::uuid`,
        [actionRequestId],
      );
      const proposal = result.rows[0];
      if (!proposal) throw new ForbiddenException({ code: 'TENANT_SCOPE_DENIED', detail: 'The requested action proposal is not available in this school scope.' });
      return proposal;
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
   * Records a qualified human decision against an exact proposal binding. The
   * endpoint/tool adapter must have separately resolved `action.approve` for
   * the reviewer before reaching this method. Approval never executes the
   * action; a registered executor revalidates it later.
   */
  async decide(
    context: CommandContext,
    input: ActionApprovalInput,
  ): Promise<ActionApprovalSummary> {
    return this.database.withTenantTransaction(context, async (client) => {
      const requestResult = await client.query<PendingActionRequestRow>(
        `SELECT id, requested_by_principal_id, action_code, payload_hash, policy_version, approval_expires_at, status
         FROM hon.action_requests
         WHERE id = $1::uuid
         FOR UPDATE`,
        [input.actionRequestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw new ForbiddenException({ code: 'TENANT_SCOPE_DENIED', detail: 'The requested action proposal is not available in this school scope.' });
      if (request.status !== 'AWAITING_APPROVAL' || !request.approval_expires_at) {
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: 'This action proposal is not awaiting a review decision.' });
      }

      const policy = await client.query<ActionPolicyRow>(
        `SELECT authority_mode, policy_version
         FROM hon.action_policies
         WHERE organization_id = $1 AND school_id = $2 AND action_code = $3
           AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
         ORDER BY policy_version DESC LIMIT 1`,
        [context.organizationId, context.schoolId, request.action_code],
      );
      const activePolicy = policy.rows[0];
      try {
        validateApprovalBinding({
          actionRequestId: request.id,
          requestedByPrincipalId: request.requested_by_principal_id,
          reviewerPrincipalId: context.principalId,
          normalizedPayloadHash: request.payload_hash,
          policyVersion: request.policy_version,
          expiresAt: request.approval_expires_at,
        }, {
          actionRequestId: input.actionRequestId,
          requestedByPrincipalId: request.requested_by_principal_id,
          reviewerPrincipalId: context.principalId,
          normalizedPayloadHash: request.payload_hash,
          policyVersion: activePolicy?.policy_version ?? 0,
          now: new Date(),
          reviewerHasPermission: true,
        });
      } catch (error) {
        throw new ConflictException({ code: 'POLICY_BLOCKED', detail: error instanceof Error ? error.message : 'HON could not bind this approval safely.' });
      }

      const decision = input.decision;
      const updated = await client.query<{ status: 'APPROVED' | 'DENIED'; updated_at: Date }>(
        `UPDATE hon.action_requests
         SET status = $2::hon.action_request_status, updated_at = now()
         WHERE id = $1::uuid
         RETURNING status, updated_at`,
        [request.id, decision],
      );
      const result = updated.rows[0];
      if (!result) throw new Error('HON action proposal update did not return a record.');
      await client.query(
        `INSERT INTO hon.action_approvals (
           organization_id, school_id, action_request_id, reviewer_principal_id, decision,
           reviewed_payload_hash, reviewed_policy_version, reason
         ) VALUES ($1, $2, $3::uuid, $4::uuid, $5::hon.approval_decision, $6, $7, $8)`,
        [context.organizationId, context.schoolId, request.id, context.principalId, decision, request.payload_hash, request.policy_version, input.reason ?? null],
      );
      const eventPayload = { actionRequestId: request.id, actionCode: request.action_code, decision, policyVersion: request.policy_version };
      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, action_request_id, occurred_at
         ) VALUES ($1, $2, $3, $4, 'action.request.decide', 'ACTION_REQUEST', $5::uuid,
                   $6::jsonb, $7::jsonb, 'SUCCEEDED', $8::uuid, $9::uuid, $5::uuid, now())`,
        [context.organizationId, context.schoolId, context.principalId, context.source, request.id, JSON.stringify({ status: 'AWAITING_APPROVAL' }), JSON.stringify({ status: decision }), context.requestId, context.correlationId],
      );
      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         ) VALUES ($1::uuid, $2, $3, 'action.request.decided', 1, 'ACTION_REQUEST', $4::uuid, 2,
                   $5::uuid, $6::uuid, $7::jsonb)`,
        [randomUUID(), context.organizationId, context.schoolId, request.id, context.correlationId, context.requestId, JSON.stringify(eventPayload)],
      );
      return { actionRequestId: request.id, status: result.status, actionCode: request.action_code, reviewedAt: result.updated_at.toISOString() };
    });
  }
}
