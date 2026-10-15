import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { CommandContext, CreateLeadInput, HonTier, LeadListItem, LeadSummary } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface CreateLeadCommandResult {
  lead: LeadSummary;
  replayed: boolean;
}

function fingerprint(input: CreateLeadInput): string {
  const attribution = Object.fromEntries(Object.entries(input.attribution ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify({
    pipelineId: input.pipelineId,
    pipelineStageId: input.pipelineStageId,
    primaryContact: {
      givenName: input.primaryContact.givenName,
      familyName: input.primaryContact.familyName,
      email: input.primaryContact.email ?? null,
      phoneE164: input.primaryContact.phoneE164 ?? null,
    },
    sourceId: input.sourceId ?? null,
    programInterestCode: input.programInterestCode ?? null,
    nextFollowUpAt: input.nextFollowUpAt ?? null,
    attribution,
  })).digest('hex');
}

@Injectable()
export class LeadService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async list(context: CommandContext, options: { status?: LeadListItem['status']; limit?: number }): Promise<LeadListItem[]> {
    return this.database.withTenantTransaction(context, async (client) => {
      const result = await client.query<LeadListItem>(
        `SELECT lead.id, lead.status, lead.pipeline_stage_id AS "pipelineStageId", lead.primary_person_id AS "primaryPersonId",
                lead.version, lead.created_at AS "createdAt", person.given_name AS "givenName", person.family_name AS "familyName",
                person.email::text AS email, person.phone_e164 AS "phoneE164", lead.next_follow_up_at AS "nextFollowUpAt"
         FROM hon.crm_leads AS lead
         JOIN hon.people AS person ON person.id = lead.primary_person_id
         WHERE lead.organization_id = $1 AND lead.school_id = $2
           AND ($3::hon.lead_status IS NULL OR lead.status = $3::hon.lead_status)
         ORDER BY lead.created_at DESC
         LIMIT $4`,
        [context.organizationId, context.schoolId, options.status ?? null, options.limit ?? 50],
      );
      return result.rows;
    });
  }

  async create(context: CommandContext, input: CreateLeadInput): Promise<CreateLeadCommandResult> {
    const requestFingerprint = fingerprint(input);
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(
        `SELECT tier::text AS tier
         FROM hon.organization_entitlements
         WHERE organization_id = $1
           AND status = 'ACTIVE'
           AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())`,
        [context.organizationId],
      );
      const activeEntitlement = entitlement.rows[0];
      if (!activeEntitlement || !tierIncludesFeature(activeEntitlement.tier, 'crm.foundation')) {
        throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON CRM entitlement is required for lead creation.' });
      }

      const reservation = await client.query<{ id: string }>(
        `INSERT INTO hon.idempotency_records (
           organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now() + interval '24 hours')
         ON CONFLICT (organization_id, school_id, principal_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint],
      );

      if (!reservation.rowCount) {
        const existing = await client.query<{
        request_fingerprint: string;
        status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
        response_body: LeadSummary | null;
        }>(
          `SELECT request_fingerprint, status, response_body
           FROM hon.idempotency_records
           WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4
           FOR UPDATE`,
          [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey],
        );
        const record = existing.rows[0];
        if (!record) throw new Error('HON idempotency record unexpectedly missing after lock acquisition.');
        if (record.request_fingerprint !== requestFingerprint) {
          throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', detail: 'The idempotency key was already used for a different lead command.' });
        }
        if (record.status === 'COMPLETED' && record.response_body) {
          return { lead: record.response_body, replayed: true };
        }
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS', detail: 'The matching command is already being processed.' });
      }

      const stage = await client.query(
        `SELECT stage.id
         FROM hon.crm_pipeline_stages AS stage
         JOIN hon.crm_pipelines AS pipeline
           ON pipeline.id = stage.pipeline_id
          AND pipeline.organization_id = stage.organization_id
          AND pipeline.school_id = stage.school_id
         WHERE stage.id = $1
           AND stage.pipeline_id = $2
           AND stage.organization_id = $3
           AND stage.school_id = $4
           AND stage.terminal_status IS NULL`,
        [input.pipelineStageId, input.pipelineId, context.organizationId, context.schoolId],
      );
      if (!stage.rowCount) {
        throw new BadRequestException({ code: 'CRM_PIPELINE_STAGE_INVALID', detail: 'The selected non-terminal pipeline stage is not available in this school.' });
      }

      const person = await client.query<{ id: string }>(
        `INSERT INTO hon.people (organization_id, school_id, given_name, family_name, email, phone_e164)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          context.organizationId,
          context.schoolId,
          input.primaryContact.givenName.trim(),
          input.primaryContact.familyName.trim(),
          input.primaryContact.email?.trim().toLowerCase() ?? null,
          input.primaryContact.phoneE164 ?? null,
        ],
      );
      const primaryPerson = person.rows[0];
      if (!primaryPerson) throw new Error('HON lead contact insert did not return an identifier.');

      const leadResult = await client.query<LeadSummary>(
        `INSERT INTO hon.crm_leads (
           organization_id, school_id, primary_person_id, pipeline_id, pipeline_stage_id,
           source_code, program_interest_code, attribution, next_follow_up_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
         RETURNING
           id,
           status,
           pipeline_stage_id AS "pipelineStageId",
           primary_person_id AS "primaryPersonId",
           version,
           created_at AS "createdAt"`,
        [
          context.organizationId,
          context.schoolId,
          primaryPerson.id,
          input.pipelineId,
          input.pipelineStageId,
          input.sourceId ?? null,
          input.programInterestCode ?? null,
          JSON.stringify(input.attribution ?? {}),
          input.nextFollowUpAt ?? null,
        ],
      );
      const lead = leadResult.rows[0];
      if (!lead) throw new Error('HON lead insert did not return a record.');
      const eventId = randomUUID();
      const eventPayload = {
        leadId: lead.id,
        primaryPersonId: lead.primaryPersonId,
        pipelineId: input.pipelineId,
        pipelineStageId: lead.pipelineStageId,
        sourceCode: input.sourceId ?? null,
        programInterestCode: input.programInterestCode ?? null,
      };

      await client.query(
        `INSERT INTO hon.audit_events (
           organization_id, school_id, actor_principal_id, source, action_code, entity_type, entity_id,
           prior_state, next_state, result, request_id, correlation_id, occurred_at
         ) VALUES ($1, $2, $3, $4, 'crm.lead.create', 'CRM_LEAD', $5, NULL, $6::jsonb,
                   'SUCCEEDED', $7::uuid, $8::uuid, now())`,
        [
          context.organizationId,
          context.schoolId,
          context.principalId,
          context.source,
          lead.id,
          JSON.stringify({ ...eventPayload, version: lead.version }),
          context.requestId,
          context.correlationId,
        ],
      );

      await client.query(
        `INSERT INTO hon.outbox_events (
           id, organization_id, school_id, event_type, schema_version, aggregate_type, aggregate_id,
           aggregate_version, correlation_id, causation_id, payload
         ) VALUES ($1::uuid, $2, $3, 'crm.lead.created', 1, 'CRM_LEAD', $4::uuid, $5,
                   $6::uuid, $7::uuid, $8::jsonb)`,
        [
          eventId,
          context.organizationId,
          context.schoolId,
          lead.id,
          lead.version,
          context.correlationId,
          context.requestId,
          JSON.stringify(eventPayload),
        ],
      );

      await client.query(
        `UPDATE hon.idempotency_records
         SET status = 'COMPLETED', response_status = 201, response_body = $5::jsonb
         WHERE organization_id = $1 AND school_id = $2 AND principal_id = $3 AND idempotency_key = $4`,
        [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(lead)],
      );

      return { lead, replayed: false };
    });
  }
}
