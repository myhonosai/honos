import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { CommandContext, HonTier } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { assertCurrentCrmAuthority } from './crm-authority-recheck.js';
import { assertCrmEntitlementInEffect } from './crm-entitlement.js';

interface Queryable { query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>; }

export interface CreatePipelineInput { name: string; stages: Array<{ name: string; terminalStatus?: 'WON' | 'LOST' | 'ARCHIVED' }>; }
export interface PipelineSummary { id: string; name: string; version: number; stages: Array<{ id: string; name: string; position: number; terminalStatus?: string | undefined }>; createdAt: string; }

/** The funnel a new school starts with, so its first lead needs no pipeline design. Staff can add others later. */
export const STARTER_PIPELINE: CreatePipelineInput = Object.freeze({
  name: 'New students',
  stages: Object.freeze([
    Object.freeze({ name: 'New lead' }),
    Object.freeze({ name: 'Trial booked' }),
    Object.freeze({ name: 'Enrolled', terminalStatus: 'WON' as const }),
    Object.freeze({ name: 'Not now', terminalStatus: 'LOST' as const }),
  ]) as CreatePipelineInput['stages'],
});

const LIST_SQL = `SELECT pipeline.id, pipeline.name, pipeline.version, pipeline.created_at AS "createdAt",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', stage.id, 'name', stage.name, 'position', stage.position, 'terminalStatus', stage.terminal_status) ORDER BY stage.position)
      FROM hon.crm_pipeline_stages AS stage
      WHERE stage.pipeline_id = pipeline.id AND stage.organization_id = pipeline.organization_id AND stage.school_id = pipeline.school_id), '[]'::jsonb) AS stages
  FROM hon.crm_pipelines AS pipeline
  WHERE pipeline.organization_id = $1 AND pipeline.school_id = $2
  ORDER BY pipeline.created_at, pipeline.id
  LIMIT 50`;

type StarterResponse = { pipeline: PipelineSummary; created: boolean };

function normalize(row: PipelineSummary): PipelineSummary {
  return { ...row, stages: row.stages.map((stage) => ({ id: stage.id, name: stage.name, position: stage.position, terminalStatus: stage.terminalStatus ?? undefined })) };
}

@Injectable()
export class PipelineService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(context: CommandContext, input: CreatePipelineInput): Promise<{ pipeline: PipelineSummary; replayed: boolean }> {
    const cleanStages = input.stages.map((stage) => ({ name: stage.name.trim(), terminalStatus: stage.terminalStatus ?? null }));
    if (!input.name.trim() || cleanStages.some((stage) => !stage.name)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Pipeline and stage names cannot be blank.' });
    if (!cleanStages.some((stage) => !stage.terminalStatus)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A pipeline requires at least one non-terminal stage.' });
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ name: input.name.trim(), stages: cleanStages })).digest('hex');
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>('SELECT tier FROM hon.read_current_organization_entitlement()');
      if (!entitlement.rows[0] || !tierIncludesFeature(entitlement.rows[0].tier, 'crm.foundation')) throw new ForbiddenException({ code: 'TIER_ENTITLEMENT_REQUIRED', detail: 'An active HON CRM entitlement is required for pipeline setup.' });
      const reserve = await client.query<{ id: string }>(`INSERT INTO hon.idempotency_records (organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at) VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours') ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint]);
      if (!reserve.rowCount) {
        const previous = await client.query<{ request_fingerprint:string; status:'IN_PROGRESS'|'COMPLETED'; response_body:PipelineSummary|null }>(`SELECT request_fingerprint,status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey]);
        const record = previous.rows[0];
        if (!record) throw new Error('HON pipeline idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code:'IDEMPOTENCY_KEY_REUSED', detail:'The idempotency key was already used for another pipeline.' });
        if (record.status === 'COMPLETED' && record.response_body) return { pipeline: record.response_body, replayed:true };
        throw new ConflictException({ code:'IDEMPOTENCY_IN_PROGRESS', detail:'The matching pipeline command is being processed.' });
      }
      const response = await this.insertPipeline(client, context, input.name.trim(), cleanStages);
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=$5::jsonb WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(response)]);
      return { pipeline: response, replayed:false };
    });
  }

  /** Pipelines and their stages for the exact school, for the lead form's stage picker. */
  async list(context: CommandContext, authority: { externalSubject: string; permission: 'crm.lead.create' | 'crm.lead.read' }): Promise<PipelineSummary[]> {
    return this.database.withTenantTransaction(context, async (client) => {
      await assertCurrentCrmAuthority(client, authority.externalSubject, context, authority.permission, 'HON CRM access is no longer authorized for this school.');
      await assertCrmEntitlementInEffect(client, 'An active HON CRM entitlement is required to read pipelines.');
      const result = await client.query<PipelineSummary>(LIST_SQL, [context.organizationId, context.schoolId]);
      return result.rows.map(normalize);
    });
  }

  /**
   * Creates STARTER_PIPELINE only when the school has no pipeline yet. A per-school advisory lock makes two concurrent
   * first-time setups produce one pipeline; the loser gets the winner's pipeline with created=false.
   */
  async createStarter(context: CommandContext, authority: { externalSubject: string }): Promise<StarterResponse & { replayed: boolean }> {
    const requestFingerprint = createHash('sha256').update('crm.pipeline.starter:v1').digest('hex');
    return this.database.withTenantTransaction(context, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hon.crm.pipeline.starter:' || $1::text, 0))", [context.schoolId]);
      await assertCurrentCrmAuthority(client, authority.externalSubject, context, 'crm.pipeline.manage', 'HON pipeline management is no longer authorized for this school.');
      await assertCrmEntitlementInEffect(client, 'An active HON CRM entitlement is required for pipeline setup.');
      const reserve = await client.query<{ id: string }>(`INSERT INTO hon.idempotency_records (organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at) VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours') ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, requestFingerprint]);
      if (!reserve.rowCount) {
        const previous = await client.query<{ request_fingerprint:string; status:'IN_PROGRESS'|'COMPLETED'; response_body:StarterResponse|null }>(`SELECT request_fingerprint,status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey]);
        const record = previous.rows[0];
        if (!record) throw new Error('HON starter pipeline idempotency record unexpectedly missing.');
        if (record.request_fingerprint !== requestFingerprint) throw new ConflictException({ code:'IDEMPOTENCY_KEY_REUSED', detail:'The idempotency key was already used for another command.' });
        if (record.status === 'COMPLETED' && record.response_body) return { ...record.response_body, replayed:true };
        throw new ConflictException({ code:'IDEMPOTENCY_IN_PROGRESS', detail:'The matching starter pipeline command is being processed.' });
      }
      const existing = (await client.query<PipelineSummary>(LIST_SQL, [context.organizationId, context.schoolId])).rows[0];
      const response: StarterResponse = existing
        ? { pipeline: normalize(existing), created: false }
        : { pipeline: await this.insertPipeline(client, context, STARTER_PIPELINE.name, STARTER_PIPELINE.stages.map((stage) => ({ name: stage.name, terminalStatus: stage.terminalStatus ?? null }))), created: true };
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=$6,response_body=$5::jsonb WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(response), response.created ? 201 : 200]);
      return { ...response, replayed:false };
    });
  }

  private async insertPipeline(client: Queryable, context: CommandContext, name: string, cleanStages: Array<{ name: string; terminalStatus: string | null }>): Promise<PipelineSummary> {
      const created = await client.query<{id:string;name:string;version:number;createdAt:string}>(`INSERT INTO hon.crm_pipelines (organization_id,school_id,name) VALUES ($1,$2,$3) RETURNING id,name,version,created_at AS "createdAt"`, [context.organizationId, context.schoolId, name]);
      const pipeline = created.rows[0];
      if (!pipeline) throw new Error('HON pipeline insert did not return a record.');
      const stages: PipelineSummary['stages'] = [];
      for (const [index, stage] of cleanStages.entries()) {
        const result = await client.query<{id:string;name:string;position:number;terminalStatus:string|null}>(`INSERT INTO hon.crm_pipeline_stages (organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES ($1,$2,$3::uuid,$4,$5,$6::hon.lead_status) RETURNING id,name,position,terminal_status AS "terminalStatus"`, [context.organizationId, context.schoolId, pipeline.id, stage.name, index + 1, stage.terminalStatus]);
        const record = result.rows[0]; if (!record) throw new Error('HON pipeline stage insert did not return a record.');
        stages.push({ ...record, terminalStatus: record.terminalStatus ?? undefined });
      }
      const response: PipelineSummary = { ...pipeline, stages };
      await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,occurred_at) VALUES ($1,$2,$3,$4,'crm.pipeline.create','CRM_PIPELINE',$5::uuid,NULL,$6::jsonb,'SUCCEEDED',$7::uuid,$8::uuid,now())`, [context.organizationId, context.schoolId, context.principalId, context.source, pipeline.id, JSON.stringify(response), context.requestId, context.correlationId]);
      await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload) VALUES ($1::uuid,$2,$3,'crm.pipeline.created',1,'CRM_PIPELINE',$4::uuid,$5,$6::uuid,$7::uuid,$8::jsonb)`, [randomUUID(), context.organizationId, context.schoolId, pipeline.id, pipeline.version, context.correlationId, context.requestId, JSON.stringify(response)]);
      return response;
  }
}
