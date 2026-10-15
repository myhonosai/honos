import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { tierIncludesFeature } from '@hon/config';
import type { CommandContext, HonTier } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export interface CreatePipelineInput { name: string; stages: Array<{ name: string; terminalStatus?: 'WON' | 'LOST' | 'ARCHIVED' }>; }
export interface PipelineSummary { id: string; name: string; version: number; stages: Array<{ id: string; name: string; position: number; terminalStatus?: string | undefined }>; createdAt: string; }

@Injectable()
export class PipelineService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async create(context: CommandContext, input: CreatePipelineInput): Promise<{ pipeline: PipelineSummary; replayed: boolean }> {
    const cleanStages = input.stages.map((stage) => ({ name: stage.name.trim(), terminalStatus: stage.terminalStatus ?? null }));
    if (!input.name.trim() || cleanStages.some((stage) => !stage.name)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Pipeline and stage names cannot be blank.' });
    if (!cleanStages.some((stage) => !stage.terminalStatus)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A pipeline requires at least one non-terminal stage.' });
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ name: input.name.trim(), stages: cleanStages })).digest('hex');
    return this.database.withTenantTransaction(context, async (client) => {
      const entitlement = await client.query<{ tier: HonTier }>(`SELECT tier::text AS tier FROM hon.organization_entitlements WHERE organization_id=$1 AND status='ACTIVE' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())`, [context.organizationId]);
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
      const created = await client.query<{id:string;name:string;version:number;createdAt:string}>(`INSERT INTO hon.crm_pipelines (organization_id,school_id,name) VALUES ($1,$2,$3) RETURNING id,name,version,created_at AS "createdAt"`, [context.organizationId, context.schoolId, input.name.trim()]);
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
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=$5::jsonb WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`, [context.organizationId, context.schoolId, context.principalId, context.idempotencyKey, JSON.stringify(response)]);
      return { pipeline: response, replayed:false };
    });
  }
}
