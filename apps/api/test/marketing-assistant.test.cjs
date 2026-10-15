const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {OpenRouterRuntime,ProviderRuntimeError}=require('../dist/ai/provider-runtime.js');
const {validateMarketingRequest,validateMarketingDraft}=require('@hon/contracts');
const id='11111111-1111-4111-8111-111111111111';
const input={providerId:'OPENROUTER',modelId:'approved/test',providerRequestId:id,request:'Create a friendly beginner classes draft with placeholders.',inputBudget:4096,outputBudget:1024,maxCostMicrounits:100000};
const result={model:input.modelId,choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'Beginner classes',content:'Discover a welcoming introduction to martial arts. Contact [school] for [class times].'})}}],usage:{prompt_tokens:120,completion_tokens:80,cost:0.00042}};
const response=v=>new Response(JSON.stringify(v),{status:200,headers:{'Content-Type':'application/json'}});
test('server guard requires both configured key and explicit paid approval, independent of HQ health',async()=>{
 for(const env of [{},{OPENROUTER_PAID_CALL_APPROVED:'true'},{OPENROUTER_API_KEY:'unit-only-not-a-secret'},{OPENROUTER_API_KEY:' ',OPENROUTER_PAID_CALL_APPROVED:'true'}]){
  let calls=0;const runtime=new OpenRouterRuntime(()=>env,async()=>{calls++;throw Error('NO NETWORK');});assert.equal(runtime.readiness('OPENROUTER'),'CONFIGURATION_REQUIRED');await assert.rejects(runtime.generate(input),e=>e.outcome==='PRE_SEND'&&e.reason==='CONFIGURATION_REQUIRED');assert.equal(calls,0);
 }
});
test('fixed OpenAI-compatible fetch request uses config selected model and stable request ID, not services',async()=>{
 let calls=0;const runtime=new OpenRouterRuntime(()=>({OPENROUTER_API_KEY:'unit-only-not-a-secret',OPENROUTER_PAID_CALL_APPROVED:'true'}),async(url,options)=>{calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options.redirect,'error');assert.equal(options.headers['X-Request-Id'],id);assert.equal(options.headers['Idempotency-Key'],id);const body=JSON.parse(options.body);assert.equal(body.model,input.modelId);assert.equal(body.max_tokens,1024);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.tools,undefined);return response(result);});
 assert.deepEqual(await runtime.generate(input),{draft:JSON.parse(result.choices[0].message.content),inputTokens:120,outputTokens:80,providerCostMicrounits:420});assert.equal(calls,1);
});
test('timeouts/network/5xx/invalid result are UNKNOWN, never retried; known rejection is FAILED',async()=>{
 for(const transport of [async()=>{throw Error('socket includes confidential material');},async()=>new Response('error',{status:503}),async()=>response({...result,model:'swapped'}),async()=>response({...result,usage:{...result.usage,cost:undefined}}),async()=>response({...result,choices:[{finish_reason:'length',message:{content:'partial'}}]}),async()=>new Response('x'.repeat(33000))]){
  let calls=0;const runtime=new OpenRouterRuntime(()=>({OPENROUTER_API_KEY:'unit-only-not-a-secret',OPENROUTER_PAID_CALL_APPROVED:'true'}),async(...a)=>{calls++;return transport(...a);});await assert.rejects(runtime.generate(input),e=>e instanceof ProviderRuntimeError&&e.outcome==='UNKNOWN'&&e.message==='PROVIDER_UNKNOWN');assert.equal(calls,1);
 }
 const runtime=new OpenRouterRuntime(()=>({OPENROUTER_API_KEY:'unit-only-not-a-secret',OPENROUTER_PAID_CALL_APPROVED:'true'}),async()=>new Response('',{status:429}));await assert.rejects(runtime.generate(input),e=>e.outcome==='FAILED');
});
test('closed schema rejects authority, tenant/provider controls, unsafe content and bounded input overage',()=>{
 for(const field of ['organizationId','schoolId','modelId','providerId','tier','authority','tools','apiKey']) assert.throws(()=>validateMarketingRequest({campaignId:id,request:'Safe brief', [field]:'no'}));
 for(const request of ['', 'a'.repeat(2001),'Bearer confidential','sk-or-v1-confidential','apiKey=confidential','bad\u0001']) assert.throws(()=>validateMarketingRequest({campaignId:id,request}));
 assert.throws(()=>validateMarketingDraft({title:'Good',content:'Hello',action:'publish'}));assert.throws(()=>validateMarketingDraft({title:'Good',content:'sk-or-v1-confidential'}));
});
test('runtime source has no inference service imports, SDK dependency or production fake selector',()=>{
 for(const file of ['src/ai/provider-runtime.ts','src/marketing/marketing-assistant.service.ts','src/marketing/marketing-assistant.controller.ts']) {const s=fs.readFileSync(path.join(__dirname,'..',file),'utf8');assert(!/invokeLLM|manus|generateText|openai\/|@openrouter/i.test(s));assert(!/console\.|logger\./.test(s));}
 const module=fs.readFileSync(path.join(__dirname,'../src/app.module.ts'),'utf8');assert.match(module,/useFactory: \(\) => new OpenRouterRuntime\(\)/);assert(!/FakeMarketing|FakeProvider|MARKETING_TEST_PROVIDER/.test(module));
 const dependencies=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8')).dependencies;assert(!Object.keys(dependencies).some(k=>/manus|openrouter|openai/.test(k)));
});

test('Marketing Assistant services reject nonhuman/delegated contexts and authority input before SQL or provider transport', async () => {
 const {MarketingAssistantService}=require('../dist/marketing/marketing-assistant.service.js');
 let touched=0;const database={withTenantTransaction:async()=>{touched++;throw Error('Unexpected SQL');}};
 const svc=new MarketingAssistantService(database,{}, {}, {readiness:()=>{touched++;throw Error('Unexpected provider');}});
 const c={organizationId:id,schoolId:id,principalId:id,externalSubject:'verified-unit-subject',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:id,correlationId:id,idempotencyKey:id};
 for(const patch of [{source:'AI'},{source:'AUTOMATION'},{principalType:'AI_EMPLOYEE'},{delegatedByPrincipalId:id},{actionRequestId:id},{externalSubject:''}]) await assert.rejects(svc.submit({...c,...patch},{campaignId:id,request:'Safe brief'}),e=>e.getStatus?.()===403);
 for(const extra of ['schoolId','organizationId','principalId','providerId','apiKey']) await assert.rejects(svc.submit(c,{campaignId:id,request:'Safe brief',[extra]:id}),e=>e.getStatus?.()===400);
 assert.equal(touched,0);
});

test('loopback Marketing Assistant HTTP derives subject-only scope, closes mutations/queries and enforces trusted human commands', async () => {
 require('reflect-metadata');
 const {Test}=require('@nestjs/testing');
 const {MarketingAssistantController,MarketingAssistantHumanUiGuard}=require('../dist/marketing/marketing-assistant.controller.js');
 const {MarketingAssistantService}=require('../dist/marketing/marketing-assistant.service.js');
 const {HonIdentityGuard}=require('../dist/foundation/hon-identity.guard.js');
 const {RuntimeDatabaseService}=require('../dist/foundation/runtime-database.service.js');
 const {AiInvocationPlanService}=require('../dist/ai/ai-invocation-plan.service.js');
 const {ActionEngineService}=require('../dist/action/action-engine.service.js');
 const {MARKETING_PROVIDER_RUNTIME}=require('../dist/ai/provider-runtime.js');
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';
 let allowed=true,scopeAvailable=true,sqlCalls=0,providerCalls=0;
 const view={id,schoolId:id,campaignId:id,workItemId:id,status:'CONFIGURATION_REQUIRED',reason:'CONFIGURATION_REQUIRED',actionRequestId:null,draft:null,inputTokens:null,outputTokens:null,providerCostMicrounits:null,customerCredits:null};
 const database={resolveCampaignScope:async(subject,permission)=>{assert.equal(subject,'verified-unit-subject');assert.equal(permission,'marketing.campaign.read');return scopeAvailable?{organizationId:id,schoolId:id,principalId:id}:undefined;},withTenantTransaction:async(c,work)=>{assert.equal(c.externalSubject,'verified-unit-subject');return work({query:async(sql)=>{sqlCalls++;return {rows:[{data:sql.includes('read_marketing_campaign_content')?[]:view}]};}});}};
 const module=await Test.createTestingModule({controllers:[MarketingAssistantController],providers:[MarketingAssistantService,MarketingAssistantHumanUiGuard,{provide:RuntimeDatabaseService,useValue:database},{provide:AiInvocationPlanService,useValue:{}},{provide:ActionEngineService,useValue:{}},{provide:MARKETING_PROVIDER_RUNTIME,useValue:{readiness:()=>{providerCalls++;throw Error('No provider permitted');},generate:async()=>{providerCalls++;throw Error('No provider permitted');}}}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){if(!allowed)return false;c.switchToHttp().getRequest().honIdentity={externalSubject:'verified-unit-subject'};return true;}}).compile();
 const app=module.createNestApplication();app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1/marketing/assistant`,headers={origin:'https://hon.test','Content-Type':'application/json','X-HON-Human-Command':'marketing-assistant','Idempotency-Key':id},body={campaignId:id,request:'Safe brief with placeholders'};
 const post=(url,input,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(input)});
 try {
  const r=await post(base,body);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.deepEqual((await r.json()).data,view);
  assert.equal((await fetch(`${base}/${id}`)).status,200);assert.deepEqual((await (await fetch(`${base}/campaigns/${id}/content`)).json()).data,[]);
  for(const input of [{...body,schoolId:id},{...body,providerId:'OPENROUTER'},{...body,apiKey:'unit-not-secret'}])assert.equal((await post(base,input)).status,400);
  for(const url of [`${base}?schoolId=${id}`,`${base}/${id}/retry?modelId=other`])assert.equal((await post(url,{})).status,400);
  assert.equal((await fetch(`${base}/${id}?actorId=${id}`)).status,400);
  assert.equal((await post(`${base}/${id}/save-approved`,{content:'swapped'})).status,400);
  assert.equal((await post(`${base}/${id}/retry`,{providerId:'OPENROUTER'})).status,400);
  for(const patch of [{origin:'https://attacker.test'},{'X-HON-Human-Command':'marketing-campaign'},{'Content-Type':'text/plain'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await post(base,body,{...headers,...patch})).status,403);
  assert.equal((await post(base,body,{...headers,'Idempotency-Key':''})).status,400);
  assert.equal((await fetch(`${base}/invalid-uuid`)).status,400);assert.equal((await post(`${base}/${id}/publish`,{})).status,404);
  scopeAvailable=false;const before=sqlCalls;assert.equal((await fetch(`${base}/${id}`)).status,403);assert.equal(sqlCalls,before);
  allowed=false;assert.equal((await fetch(`${base}/${id}`)).status,403);assert.equal(sqlCalls,before);
  assert.equal(providerCalls,0);
 } finally {await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
