import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { CommandContext, CreateCurriculumInput, CurriculumSummary } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Injectable()
export class CurriculumService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async create(context: CommandContext, input: CreateCurriculumInput): Promise<{ curriculum: CurriculumSummary; replayed: boolean }> {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.database.withTenantTransaction(context, async (client) => {
      const reserved = await client.query<{ id: string }>(`INSERT INTO hon.idempotency_records (organization_id, school_id, principal_id, idempotency_key, request_fingerprint, status, expires_at) VALUES ($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '24 hours') ON CONFLICT (organization_id,school_id,principal_id,idempotency_key) DO NOTHING RETURNING id`, [context.organizationId,context.schoolId,context.principalId,context.idempotencyKey,fingerprint]);
      if (!reserved.rowCount) { const existing=await client.query<{request_fingerprint:string;status:string;response_body:CurriculumSummary|null}>(`SELECT request_fingerprint,status,response_body FROM hon.idempotency_records WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4 FOR UPDATE`,[context.organizationId,context.schoolId,context.principalId,context.idempotencyKey]); const record=existing.rows[0]; if (!record || record.request_fingerprint!==fingerprint) throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED',detail:'The idempotency key was used for a different curriculum command.'}); if(record.status==='COMPLETED'&&record.response_body)return {curriculum:record.response_body,replayed:true}; throw new ConflictException({code:'IDEMPOTENCY_IN_PROGRESS',detail:'The matching curriculum command is being processed.'}); }
      const result=await client.query<CurriculumSummary>(`INSERT INTO hon.curricula (organization_id,school_id,name,description,model_code) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,description,lifecycle::text AS lifecycle,model_code AS "modelCode",version,created_at AS "createdAt"`,[context.organizationId,context.schoolId,input.name.trim(),input.description?.trim()??null,input.modelCode]);
      const curriculum=result.rows[0]; if(!curriculum) throw new Error('HON curriculum insert did not return a record.');
      const eventId=randomUUID(); const payload={curriculumId:curriculum.id,name:curriculum.name,modelCode:curriculum.modelCode,version:curriculum.version};
      await client.query(`INSERT INTO hon.audit_events (organization_id,school_id,actor_principal_id,source,action_code,entity_type,entity_id,prior_state,next_state,result,request_id,correlation_id,action_request_id,occurred_at) VALUES ($1,$2,$3,$4,'curriculum.create','CURRICULUM',$5,NULL,$6::jsonb,'SUCCEEDED',$7::uuid,$8::uuid,$9::uuid,now())`,[context.organizationId,context.schoolId,context.principalId,context.source,curriculum.id,JSON.stringify(payload),context.requestId,context.correlationId,context.actionRequestId??null]);
      await client.query(`INSERT INTO hon.outbox_events (id,organization_id,school_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,payload) VALUES ($1::uuid,$2,$3,'curriculum.created',1,'CURRICULUM',$4::uuid,$5,$6::uuid,$7::uuid,$8::jsonb)`,[eventId,context.organizationId,context.schoolId,curriculum.id,curriculum.version,context.correlationId,context.requestId,JSON.stringify(payload)]);
      await client.query(`UPDATE hon.idempotency_records SET status='COMPLETED',response_status=201,response_body=$5::jsonb WHERE organization_id=$1 AND school_id=$2 AND principal_id=$3 AND idempotency_key=$4`,[context.organizationId,context.schoolId,context.principalId,context.idempotencyKey,JSON.stringify(curriculum)]);
      return {curriculum,replayed:false};
    });
  }
}
