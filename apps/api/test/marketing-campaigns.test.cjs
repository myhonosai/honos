const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
require('reflect-metadata');
const { ValidationPipe } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { CampaignService } = require('../dist/marketing/campaign.service.js');
const { CampaignController } = require('../dist/marketing/campaign.controller.js');
const { CampaignHumanUiGuard } = require('../dist/marketing/campaign-human-ui.guard.js');
const { SaveCampaignDto } = require('../dist/marketing/campaign.dto.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { LeadService } = require('../dist/crm/lead.service.js');
const { validateCampaignInput, validateCampaignStatus, validateCampaignWindow } = require('@hon/contracts');
const { ACTION_CATALOG, CAMPAIGN_COMMAND_REGISTRY } = require('@hon/config');
const organizationId=randomUUID(),schoolId=randomUUID(),principalId=randomUUID(),campaignId=randomUUID();
const ctx=(p={})=>({organizationId,schoolId,principalId,externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...p});
const input=(p={})=>({expectedVersion:0,code:'REFERRAL_2026',name:'Human plan',goal:'Manual referrals',offerLabel:'',channel:'REFERRAL',startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2026-02-01T00:00:00.000Z',plannedBudgetMinor:10000,currency:'USD',...p});
const status=n=>e=>e.getStatus?.()===n;
test('campaign contracts are closed and bounded; budgets and date/currency semantics are explicit',()=>{
 validateCampaignInput(input());validateCampaignStatus({expectedVersion:1,status:'ACTIVE'});
 for(const p of [{expectedVersion:1.5},{expectedVersion:1000000000},{plannedBudgetMinor:-1},{plannedBudgetMinor:0.5},{plannedBudgetMinor:1000000000001},{currency:'usd'},{currency:'XXX'},{channel:'AI'},{code:'lower'},{name:' padded '},{goal:'unsafe\u202e'},{actorId:principalId},{schoolId},{actualSpendMinor:1},{startsAt:'2026-02-30T00:00:00.000Z'},{endsAt:'2026-01-01T00:00:00.000Z'},{endsAt:'2028-01-01T00:00:00.000Z'}])assert.throws(()=>validateCampaignInput(input(p)));
 assert.throws(()=>validateCampaignStatus({expectedVersion:0,status:'ACTIVE'}));assert.throws(()=>validateCampaignStatus({expectedVersion:1,status:'PUBLISHED'}));assert.throws(()=>validateCampaignWindow('2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',true));
});
test('campaign service uses fixed parameterized DB boundaries only and rejects non-human/delegated inputs before SQL',async()=>{
 const calls=[],result={campaign:{id:campaignId},replayed:false};const svc=new CampaignService({withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{calls.push([sql,args]);return {rows:[{data:result}]};}})});
 assert.deepEqual(await svc.save(ctx(),null,input()),result);assert.match(calls.at(-1)[0],/^SELECT hon.mutate_campaign/);assert.equal(calls.at(-1)[1][1],'create');
 for(const patch of [{source:'AI'},{source:'PUBLIC_API'},{principalType:'AI_EMPLOYEE'},{principalType:'INTEGRATION'},{principalType:'AUTOMATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]){const n=calls.length;await assert.rejects(async()=>svc.save(ctx(patch),null,input()),status(403));assert.equal(calls.length,n);}
 await assert.rejects(async()=>svc.save(ctx(),campaignId,input()),status(400));await assert.rejects(async()=>svc.save(ctx({idempotencyKey:''}),null,input()),status(409));
 for(const [code,http]of [['42501',403],['P0002',404],['40001',409],['23505',409],['22023',400],['57014',503]]){const broken=new CampaignService({withTenantTransaction:async()=>{throw {code};}});await assert.rejects(()=>broken.list(ctx()),status(http));}
});
test('campaign UI guard requires exact trusted origin, command and same-origin metadata; configuration absence fails closed',()=>{
 const old=process.env.HON_PUBLIC_ORIGIN,guard=new CampaignHumanUiGuard(),run=(method,headers)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})}),headers={origin:'https://hon.test','x-hon-human-command':'marketing-campaign','content-type':'application/json','sec-fetch-site':'same-origin'};
 try{delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run('POST',headers),status(503));process.env.HON_PUBLIC_ORIGIN='https://hon.test';assert(run('GET',{}));assert(run('POST',headers));for(const h of [{origin:'https://hon.test.attacker'},{origin:'https://hon.test/'},{origin:'https://attacker.test'},{'x-hon-human-command':'revenue-planning'},{'content-type':'text/plain'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'},{origin:['https://hon.test']}])assert.throws(()=>run('POST',{...headers,...h}),status(403));assert.throws(()=>run('PUT',headers),status(403));}finally{if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('input-free controller derives exact school/principal and permission from verified identity',async()=>{
 const calls=[],scope={organizationId,schoolId,principalId};const controller=new CampaignController({resolveCampaignScope:async(subject,permission)=>{calls.push([subject,permission]);return scope;}},{list:async c=>{assert.equal(c.schoolId,schoolId);assert.equal(c.externalSubject,'verified');return [];}});
 assert.deepEqual((await controller.list({honIdentity:{externalSubject:'verified'},body:{schoolId:randomUUID()}})).data,[]);assert.deepEqual(calls,[['verified','marketing.campaign.read']]);
 await assert.rejects(()=>controller.list({}),status(403));const none=new CampaignController({resolveCampaignScope:async()=>undefined},{});await assert.rejects(()=>none.list({honIdentity:{externalSubject:'verified'}}),status(403));
});
test('local HTTP campaign API enforces DTO closure, trusted origin and exact mutation validation',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 const campaign={id:campaignId,version:1,status:'DRAFT',planningOnly:true,...input()};delete campaign.expectedVersion;
 const database={resolveCampaignScope:async()=>({organizationId,schoolId,principalId}),withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>({rows:[{data:sql.startsWith('SELECT hon.mutate_campaign')?{campaign,replayed:false}:args?.[1]==='LIST'?[]:campaign}]})})};
 const module=await Test.createTestingModule({controllers:[CampaignController],providers:[CampaignService,CampaignHumanUiGuard,{provide:RuntimeDatabaseService,useValue:database}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/marketing/campaigns`,headers={origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'marketing-campaign','Idempotency-Key':'unit-retry'};
 try{const ok=await fetch(base,{method:'POST',headers,body:JSON.stringify(input())});assert.equal(ok.status,200);assert.equal((await ok.json()).data.planningOnly,true);
  for(const p of [{schoolId},{principalId},{actualSpendMinor:1},{status:'ACTIVE'},{currency:'XXX'}])assert.equal((await fetch(base,{method:'POST',headers,body:JSON.stringify(input(p))})).status,400);
  assert.equal((await fetch(base,{method:'POST',headers:{...headers,origin:'https://attacker.test'},body:JSON.stringify(input())})).status,403);assert.equal((await fetch(base,{method:'POST',headers:{...headers,'Idempotency-Key':''},body:JSON.stringify(input())})).status,409);assert.equal((await fetch(`${base}/invalid-uuid`)).status,400);assert.equal((await fetch(base)).headers.get('cache-control'),'private, no-store');
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('historic no-selector CRM fingerprints replay unchanged and canonical selectors cannot be smuggled into attribution',async()=>{
 const body={pipelineId:randomUUID(),pipelineStageId:randomUUID(),primaryContact:{givenName:'A',familyName:'B'},attribution:{campaign:'Historic label'}};
 const fp=createHash('sha256').update(JSON.stringify({pipelineId:body.pipelineId,pipelineStageId:body.pipelineStageId,primaryContact:{givenName:'A',familyName:'B',email:null,phoneE164:null},sourceId:null,programInterestCode:null,nextFollowUpAt:null,attribution:body.attribution})).digest('hex');
 const queries=[],lead={id:randomUUID(),version:1};const svc=new LeadService({withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{queries.push(sql);if(sql.includes('INSERT INTO hon.idempotency_records')){assert.equal(args[4],fp);return {rows:[],rowCount:0};}if(sql.includes('SELECT request_fingerprint'))return {rows:[{request_fingerprint:fp,status:'COMPLETED',response_body:lead}]};if(sql.includes('SELECT tier'))return {rows:[{tier:'ESSENTIAL'}]};return {rows:[]};}})});
 assert.deepEqual(await svc.create(ctx(),body),{lead,replayed:true});assert(!queries.some(q=>q.includes('INSERT INTO hon.people')));
 for(const attribution of [{campaignId:campaignId},{campaignCode:'X'},{migration:'forged'},{key:1}])await assert.rejects(async()=>svc.create(ctx(),{...body,attribution}),status(400));await assert.rejects(async()=>svc.create(ctx({source:'AI'}),{...body,campaignId}),status(403));
});
test('human campaign metadata is not an Action Engine tool; implementations cannot invoke providers, payment or communication adapters',()=>{
 assert.equal(CAMPAIGN_COMMAND_REGISTRY.length,4);for(const c of CAMPAIGN_COMMAND_REGISTRY){assert.equal(c.execution,'HUMAN_ONLY');assert.equal(c.planningOnly,true);assert(!ACTION_CATALOG.some(a=>a.code===c.code));}
 for(const file of ['campaign.service.ts','campaign.controller.ts'])assert.doesNotMatch(readFileSync(`src/marketing/${file}`,'utf8'),/ActionEngineService|Payment.*Service|Messaging.*Service|Ai.*Service|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0073_human_marketing_campaigns.sql','utf8');assert.doesNotMatch(sql,/INSERT INTO hon\.(?:memberships|invoices|payment_attempts|communication_messages|action_requests|ai_usage_ledger|work_items)/);assert.match(sql,/'marketing.campaign.human_planned'/);
});
