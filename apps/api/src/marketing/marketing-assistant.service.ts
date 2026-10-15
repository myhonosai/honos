import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { validateMarketingRequest, validateMarketingDraft, MARKETING_LIMITS, type MarketingAssistantContext, type MarketingInvocationView } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AiInvocationPlanService } from '../ai/ai-invocation-plan.service.js';
import { MARKETING_PROVIDER_RUNTIME, ProviderRuntimeError, type ProviderRuntime, type TextInvocation, type TextResult } from '../ai/provider-runtime.js';
import { ActionEngineService } from '../action/action-engine.service.js';
import type { PoolClient } from 'pg';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(v:unknown):asserts v is string { if(typeof v!=='string'||!UUID.test(v)) throw new BadRequestException({code:'INVALID_MARKETING_IDENTIFIER'}); }
function human(c:MarketingAssistantContext) {
  if(c.principalType!=='HUMAN_USER'||c.source!=='HUMAN_UI'||c.actionRequestId||c.delegatedByPrincipalId||!c.externalSubject) throw new ForbiddenException({code:'MARKETING_OWNER_REQUIRED'});
  for(const id of [c.organizationId,c.schoolId,c.principalId,c.requestId,c.correlationId]) uuid(id);
}
function boundaryError(e:unknown):never {
  const code=(e as {code?:string}).code;
  if(code==='42501') throw new ForbiddenException({code:'MARKETING_FORBIDDEN',detail:'Exact live school owner permission and active Complete entitlement are required.'});
  if(code==='P0002') throw new NotFoundException({code:'MARKETING_UNAVAILABLE'});
  if(['40001','23505','55P03','40P01'].includes(code??'')) throw new ConflictException({code:'MARKETING_CONFLICT',detail:'Retain the exact request key. Never resend an unknown provider outcome.'});
  if(['22023','22P02','23514','23503','22003'].includes(code??'')) throw new BadRequestException({code:'INVALID_MARKETING_REQUEST'});
  if(code==='57014') throw new ServiceUnavailableException({code:'MARKETING_TIMEOUT',detail:'No success assumed. Read durable status before any retry.'});
  throw e;
}
@Injectable()
export class MarketingAssistantService {
  constructor(private readonly database:RuntimeDatabaseService, private readonly plans:AiInvocationPlanService, private readonly actions:ActionEngineService, @Inject(MARKETING_PROVIDER_RUNTIME) private readonly provider:ProviderRuntime) {}
  private async transaction<T>(c:MarketingAssistantContext,work:(client:PoolClient)=>Promise<T>):Promise<T> {
    human(c); try { return await this.database.withTenantTransaction(c,async client=>{
      await client.query("SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)");
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return work(client);
    }); } catch(e) { return boundaryError(e); }
  }
  read(c:MarketingAssistantContext,id:string):Promise<MarketingInvocationView> { uuid(id); return this.transaction(c,async client=>(await client.query<{data:MarketingInvocationView}>('SELECT hon.read_marketing_invocation($1,$2::uuid) data',[c.externalSubject,id])).rows[0]!.data); }
  async submit(c:MarketingAssistantContext,input:unknown):Promise<MarketingInvocationView> {
    uuid(c.idempotencyKey); let normalized;
    try { normalized=validateMarketingRequest(input); } catch { throw new BadRequestException({code:'INVALID_MARKETING_REQUEST',detail:'Supply only campaignId and a safe brief up to 2000 characters; never credentials or personal records.'}); }
    const view=await this.transaction(c,async client=>(await client.query<{data:MarketingInvocationView}>('SELECT hon.begin_marketing_request($1,$2::jsonb,$3::uuid) data',[c.externalSubject,JSON.stringify(normalized),c.idempotencyKey])).rows[0]!.data);
    // HTTP replay returns durable state, not another provider send. Retry requires a separate explicit safe-state command.
    if(view.status!=='PENDING') return view;
    return this.generate(c,view.id);
  }
  async generate(c:MarketingAssistantContext,id:string):Promise<MarketingInvocationView> {
    uuid(id);
    const ref=await this.transaction(c,async client=>(await client.query<{data:{planId:string|null;workItemId:string;workVersion:number}|null}>('SELECT hon.marketing_planning_reference($1,$2::uuid) data',[c.externalSubject,id])).rows[0]!.data);
    if(!ref) return this.read(c,id);
    let planId=ref.planId;
    if(!planId) {
      const planned=await this.plans.plan({...c,idempotencyKey:id},ref.workItemId,{expectedVersion:ref.workVersion,expectedState:'READY',agentKey:'marcus',modality:'TEXT',taskClass:'DRAFT_MARKETING',inputBudget:MARKETING_LIMITS.inputTokens,outputBudget:MARKETING_LIMITS.outputTokens,maxProviderCostMicrounits:MARKETING_LIMITS.maxProviderCostMicrounits});
      planId=planned.status==='PLANNED'?planned.plan.id:null;
    }
    // Production adapter always checks credentials AND explicit paid-call approval again immediately before transport.
    const ready=this.provider.readiness('OPENROUTER')==='READY';
    const invocation=await this.transaction(c,async client=>(await client.query<{data:TextInvocation|null}>('SELECT hon.prepare_marketing_invocation($1,$2::uuid,$3::uuid,$4) data',[c.externalSubject,id,planId,ready])).rows[0]!.data);
    if(!invocation) return this.read(c,id);
    let result:TextResult;
    try {
      result=await this.provider.generate(invocation);
      result={...result,draft:validateMarketingDraft(result.draft)};
      if(!Number.isSafeInteger(result.inputTokens)||result.inputTokens<1||result.inputTokens>1000000||!Number.isSafeInteger(result.outputTokens)||result.outputTokens<1||result.outputTokens>1000000||!Number.isSafeInteger(result.providerCostMicrounits)||result.providerCostMicrounits<0||result.providerCostMicrounits>1000000000) throw new ProviderRuntimeError('UNKNOWN','PROVIDER_UNKNOWN');
    } catch(e) {
      const failure=e instanceof ProviderRuntimeError?e:new ProviderRuntimeError('UNKNOWN','PROVIDER_UNKNOWN');
      await this.transaction(c,async client=>{await client.query('SELECT hon.fail_marketing_invocation($1,$2::uuid,$3,$4)',[c.externalSubject,id,failure.outcome,failure.reason]);});
      return this.read(c,id);
    }
    // Atomic actual usage + immutable draft + existing CONFIRM proposal. No model can select an action or authority.
    try { await this.transaction(c,async client=>{
      const payload=(await client.query<{data:Record<string,unknown>|null}>('SELECT hon.record_marketing_result($1,$2::uuid,$3::jsonb) data',[c.externalSubject,id,JSON.stringify(result)])).rows[0]!.data;
      if(!payload) return;
      const proposal=await this.actions.proposeInTransaction({...c,idempotencyKey:`marketing-draft:${id}`},{actionCode:'marketing.draft.save',normalizedPayload:payload},client);
      if(proposal.effectiveAuthorityMode!=='CONFIRM'||proposal.status!=='AWAITING_APPROVAL') throw new ConflictException({code:'MARKETING_CONFIRM_REQUIRED'});
      await client.query('SELECT hon.bind_marketing_proposal($1,$2::uuid,$3::uuid)',[c.externalSubject,id,proposal.id]);
    }); } catch {
      // A provider succeeded but durable commit is unverified. Preserve UNKNOWN; do not infer a safe retry or fake content.
      try { await this.transaction(c,async client=>{await client.query('SELECT hon.fail_marketing_invocation($1,$2::uuid,$3,$4)',[c.externalSubject,id,'UNKNOWN','PROVIDER_UNKNOWN']);}); } catch { /* In-flight durable send remains quarantined; status read reports stale SENDING as UNKNOWN. */ }
      throw new ServiceUnavailableException({code:'MARKETING_PERSISTENCE_UNKNOWN',detail:'Provider outcome requires reconciliation. No resend is allowed.'});
    }
    return this.read(c,id);
  }
  /** Internal typed adapter only; no arbitrary content/action/provider parameter is accepted. */
  saveApproved(c:MarketingAssistantContext,id:string):Promise<MarketingInvocationView> { uuid(id); return this.transaction(c,async client=>(await client.query<{data:MarketingInvocationView}>('SELECT hon.save_approved_marketing_draft($1,$2::uuid) data',[c.externalSubject,id])).rows[0]!.data); }
  workspace(c:MarketingAssistantContext,campaignId:string):Promise<{title:string;content:string;savedAt:string}[]> { uuid(campaignId);return this.transaction(c,async client=>(await client.query<{data:{title:string;content:string;savedAt:string}[]}>('SELECT hon.read_marketing_campaign_content($1,$2::uuid) data',[c.externalSubject,campaignId])).rows[0]!.data); }
}
