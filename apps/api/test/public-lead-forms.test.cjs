const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { gzipSync } = require('node:zlib');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { json } = require('express');
const { validateLeadIntakeMonitorForm, validatePublicFormConfig, validatePublicFormSubmission } = require('@hon/contracts');
const { PublicFormService } = require('../dist/marketing/public-form.service.js');
const { StaffPublicFormController, PublishedFormController, PublicFormHumanUiGuard } = require('../dist/marketing/public-form.controller.js');
const { parsePublicFormJson, publicFormTransport } = require('../dist/marketing/public-form-transport.js');
const { RuntimeDatabaseService } = require('../dist/foundation/runtime-database.service.js');
const { HonIdentityGuard } = require('../dist/foundation/hon-identity.guard.js');
const id = randomUUID(), org = randomUUID(), school = randomUUID(), actor = randomUUID(), publicId = 'a'.repeat(48);
const scope = { organizationId:org, schoolId:school, principalId:actor };
const context = (patch={}) => ({...scope,externalSubject:'verified',principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),...patch});
const config = (patch={}) => ({expectedVersion:0,title:'School enquiries',description:'Enquiry only',optionalFields:['ageBand'],pipelineId:randomUUID(),pipelineStageId:randomUUID(),campaignId:null,...patch});
const body = (patch={}) => ({name:'PRIVATE_NAME',email:'private@example.test',mobile:'',interest:'Private interest',source:'Referral',website:'',acknowledged:false,ageBand:'ADULT',...patch});
const published = {publicId,title:'School enquiries',description:'Enquiry only',optionalFields:['ageBand']};
const staffForm = {id,...published,version:1,status:'DRAFT',pipelineId:randomUUID(),pipelineStageId:randomUUID(),campaignId:null,acceptedCount:0,updatedAt:'2026-10-01T00:00:00.000Z'};
const status = n => e => e.getStatus?.()===n;
test('intake monitor response is a server-side minimal projection with no identifiers or private configuration',async()=>{
 const queries=[];const svc=new PublicFormService({withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{queries.push([sql,args]);return {rows:[{data:[staffForm]}]};}})});
 const expected=[{title:'School enquiries',status:'DRAFT',acceptedCount:0,hasCampaignAssociation:false}];
 assert.deepEqual(await svc.intakeMonitor(context()),expected);const fixed=queries.find(([sql])=>sql.startsWith('SELECT hon.read_public_forms'));assert.match(fixed[0],/^SELECT hon\.read_public_forms\(\$1\) data$/);assert.equal(fixed[1][0],'verified');
 validateLeadIntakeMonitorForm(expected[0]);
 for(const patch of [{id:staffForm.id},{publicId:publicId},{description:'PRIVATE'},{pipelineId:staffForm.pipelineId},{campaignId:null},{version:1},{updatedAt:'2026-10-01T00:00:00.000Z'},{hasCampaignAssociation:'false'}])assert.throws(()=>validateLeadIntakeMonitorForm({...expected[0],...patch}));
 const controller=new StaffPublicFormController({resolvePublicFormScope:async()=>scope},{intakeMonitor:async c=>{assert.equal(c.source,'HUMAN_UI');return expected;}});
 assert.deepEqual(await controller.intakeMonitor({honIdentity:{externalSubject:'verified'}}),{data:expected});
});
test('closed config and public schemas reject authority, nested payloads, unconfigured choices and bounded unsafe fields',()=>{
 validatePublicFormConfig(config());validatePublicFormSubmission(body(),['ageBand']);validatePublicFormSubmission(body({acknowledged:true}),['ageBand']);
 for(const patch of [{actorId:actor},{schoolId:school},{campaignId:id},{consent:'OPTED_IN'},{message:'send'},{name:{}},{name:'x'.repeat(121)},{email:'x'.repeat(255)},{mobile:'+123'},{interest:'x'.repeat(81)},{source:' +SUM(1)'},{name:'unsafe\ntext'},{name:'unsafe\u202e'},{acknowledged:'true'},{website:'bot'},{ageBand:'custom'},{experience:'NEW'},{email:'',mobile:''}])assert.throws(()=>validatePublicFormSubmission(body(patch),['ageBand']));
 for(const patch of [{pipelineId:{toString:()=>staffForm.pipelineId}},{optionalFields:['ageBand','ageBand']},{optionalFields:['medicalNotes']},{title:'=FORMULA'},{title:' padded '},{description:'multi\nline'},{expectedVersion:1.5},{actorId:actor}])assert.throws(()=>validatePublicFormConfig(config(patch)));
});
test('public JSON transport validates grammar, fatal UTF-8, duplicate decoded keys, scalar closure and byte caps',()=>{
 assert.deepEqual(parsePublicFormJson(Buffer.from('{"name":"a","nested":{"x":1},"array":["x","x"]}')).name,'a');
 for(const text of ['', 'null','[]','true','1','"scalar"','{"name":"a","name":"b"}','{"name":"a","na\\u006de":"b"}','{"x":{"a":1,"a":2}}','{"x":[{"a":1,"a":2}]}','{"x":1,}','{"x":NaN}'])assert.throws(()=>parsePublicFormJson(Buffer.from(text)));
 assert.throws(()=>parsePublicFormJson(Buffer.from([0xc3,0x28])));assert.throws(()=>parsePublicFormJson(Buffer.alloc(8193,32)));
});
test('service staff writes are fixed parameterized human-only commands and errors are sanitized',async()=>{
 const queries=[];const svc = new PublicFormService({withTenantTransaction:async(c,work)=>work({query:async(sql,args)=>{queries.push([sql,args]);return {rows:[{data:{form:staffForm,replayed:false}}]};}})});
 await svc.mutate(context(),'configure',null,config());assert.match(queries.at(-1)[0],/^SELECT hon.mutate_public_form\(\$1/);assert.equal(queries.at(-1)[1][0],'verified');
 for(const patch of [{source:'PUBLIC_API'},{source:'AI'},{principalType:'SYSTEM_SERVICE'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{actionRequestId:id},{delegatedByPrincipalId:actor}]){const count=queries.length;await assert.rejects(async()=>svc.list(context(patch)),status(403));assert.equal(queries.length,count);}
 await assert.rejects(async()=>svc.mutate(context({idempotencyKey:''}),'publish',id,{expectedVersion:1}),status(400));
 for(const [code,http]of [['42501',403],['P0002',404],['40001',409],['23505',409],['22023',400],['22P02',400],['57014',503]]){const broken=new PublicFormService({withTenantTransaction:async()=>{throw {code,detail:'PRIVATE_NAME private@example.test'};}});await assert.rejects(()=>broken.list(context()),e=>{assert.equal(e.getStatus(),http);assert.doesNotMatch(JSON.stringify(e.getResponse()),/PRIVATE/);return true;});}
});
test('public service returns only generic results and never forwards invalid schemas or leaks database state',async()=>{
 const calls=[];let result='ACCEPTED';const svc=new PublicFormService({submitPublishedLeadForm:async(...args)=>{calls.push(args);if(result==='THROW')throw {detail:'PRIVATE_NAME private@example.test'};return result;},readPublishedLeadForm:async()=>published});
 assert.deepEqual(await svc.published(publicId),published);
 assert.equal(await svc.submit(publicId,body(),randomUUID()),'accepted');assert.equal(calls[0][0],publicId);assert.equal(calls[0][1].acknowledged,false);
 for(const [sql,expected]of [['INVALID','invalid'],['RATE_LIMITED','rate-limited'],['PRIVATE_NAME','unavailable'],['THROW','unavailable']]){result=sql;assert.equal(await svc.submit(publicId,body(),randomUUID()),expected);}
 for(const [pid,input,key]of [['bad',body(),randomUUID()],[publicId,body(),['duplicate','header']],[publicId,body({schoolId:school}),randomUUID()],[publicId,null,randomUUID()]]){const n=calls.length;assert.equal(await svc.submit(pid,input,key),'invalid');assert.equal(calls.length,n);}
 const unsafe=new PublicFormService({readPublishedLeadForm:async()=>({...published,hashSecret:'PRIVATE'})});await assert.rejects(()=>unsafe.published(publicId),e=>{assert.deepEqual(e.getResponse(),{result:'unavailable'});return true;});
});
test('runtime ingress issues sequential fixed SQL only, rolls back safely and releases each dedicated pool client',async()=>{
 const db=new RuntimeDatabaseService(),calls=[];let broken=false,released=0;
 db.assertRuntimePosture=async()=>{};db.getPool=()=>({connect:async()=>({query:async(sql,args)=>{calls.push([sql,args]);if(broken&&sql.startsWith('SELECT hon.submit'))throw Error('private');return {rows:[{result:'ACCEPTED'}]};},release:()=>released++})});
 assert.equal(await db.submitPublishedLeadForm(publicId,body(),randomUUID()),'ACCEPTED');assert.deepEqual(calls.map(c=>c[0]),['BEGIN',"SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'",'SELECT hon.submit_public_form($1,$2::jsonb,$3) result','COMMIT']);assert.equal(released,1);
 calls.length=0;broken=true;await assert.rejects(()=>db.submitPublishedLeadForm(publicId,body(),randomUUID()));assert.equal(calls.at(-1)[0],'ROLLBACK');assert.equal(released,2);
});
test('staff controller derives exact permissions from verified identity and public guard fails closed on origin/command/revocation metadata',async()=>{
 const calls=[];const controller=new StaffPublicFormController({resolvePublicFormScope:async(subject,permission)=>{calls.push([subject,permission]);return scope;}},{list:async c=>{assert.equal(c.principalId,actor);return [];},mutate:async()=>({form:staffForm,replayed:false})});
 await controller.list({honIdentity:{externalSubject:'verified'},body:{schoolId:id}});await controller.publish(id,{honIdentity:{externalSubject:'verified'}},randomUUID(),{expectedVersion:1});assert.deepEqual(calls,[['verified','marketing.form.read'],['verified','marketing.form.publish']]);await assert.rejects(()=>controller.list({}),status(403));
 const old=process.env.HON_PUBLIC_ORIGIN,guard=new PublicFormHumanUiGuard(),run=(headers,method='POST')=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})}),headers={origin:'https://hon.test','x-hon-human-command':'public-lead-form','content-type':'application/json','sec-fetch-site':'same-origin'};
 try{delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run(headers),status(503));process.env.HON_PUBLIC_ORIGIN='https://hon.test';assert(run(headers));assert(run({},'GET'));for(const patch of [{origin:'https://hon.test.attacker'},{origin:'https://hon.test/'},{origin:['https://hon.test']},{'x-hon-human-command':'marketing-campaign'},{'content-type':'text/plain'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'cross-site'}])assert.throws(()=>run({...headers,...patch}),status(403));assert.throws(()=>run(headers,'PUT'),status(403));}finally{if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('real public and staff loopback HTTP enforces raw transport, generic unknown/inactive output, schema, human origin and rate limits',async()=>{
 const old=process.env.HON_PUBLIC_ORIGIN;process.env.HON_PUBLIC_ORIGIN='https://hon.test';let submissions=0,permission=true;
 const database={readPublishedLeadForm:async pid=>pid===publicId?published:null,submitPublishedLeadForm:async(pid,input)=>{submissions++;try{validatePublicFormSubmission(input,['ageBand']);}catch{return 'INVALID';}return pid===publicId?'ACCEPTED':'INVALID';},resolvePublicFormScope:async()=>permission?scope:undefined,withTenantTransaction:async(c,work)=>work({query:async(sql)=>({rows:[{data:sql.startsWith('SELECT hon.mutate_public_form')?{form:staffForm,replayed:false}:sql.startsWith('SELECT hon.read_public_forms')?[staffForm]:[]}]})})};
 const module=await Test.createTestingModule({controllers:[PublishedFormController,StaffPublicFormController],providers:[PublicFormService,PublicFormHumanUiGuard,{provide:RuntimeDatabaseService,useValue:database}]}).overrideGuard(HonIdentityGuard).useValue({canActivate(c){c.switchToHttp().getRequest().honIdentity={externalSubject:'verified'};return true;}}).compile();
 const app=module.createNestApplication({bodyParser:false});app.use(publicFormTransport());app.use(json({limit:'2mb',strict:true}));app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');
 const base=`http://127.0.0.1:${app.getHttpServer().address().port}/v1`,post=`${base}/public/forms/${publicId}/submissions`,headers={'Content-Type':'application/json','Idempotency-Key':randomUUID()};
 const send=(url=post,text=JSON.stringify(body()),h=headers,method='POST')=>fetch(url,{method,headers:h,body:text});
 try{
  const get=await fetch(`${base}/public/forms/${publicId}`);assert.equal(get.status,200);assert.deepEqual(await get.json(),{data:published});assert.equal(get.headers.get('cache-control'),'no-store');
  for(const pid of ['b'.repeat(48),'c'.repeat(48)]){const absent=await fetch(`${base}/public/forms/${pid}`);assert.equal(absent.status,404);assert.deepEqual(await absent.json(),{result:'invalid'});const invalid=await send(`${base}/public/forms/${pid}/submissions`);assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{result:'invalid'});}
  const accepted=await send();assert.equal(accepted.status,202);assert.deepEqual(await accepted.json(),{result:'accepted'});
  const transportCases=[['{"name":"a","name":"b"}',headers],['{"name":"a","na\\u006de":"b"}',headers],['{}',{'Content-Type':'text/plain','Idempotency-Key':randomUUID()}],['{}',{'Content-Type':'application/json; charset=iso-8859-1','Idempotency-Key':randomUUID()}],[gzipSync(JSON.stringify(body())),{...headers,'Content-Encoding':'gzip'}],[Buffer.from([0xc3,0x28]),headers],[' '.repeat(8193),headers],['[]',headers],['null',headers],['{"x":1,}',headers]];
  for(const [text,h] of transportCases){const n=submissions;const response=await send(post,text,h);assert.equal(response.status,400);assert.deepEqual(await response.json(),{result:'invalid'});assert.equal(submissions,n);}
  for(const patch of [{schoolId:school},{campaignId:id},{consent:'OPTED_IN'},{acknowledged:'true'},{name:'=IMPORTXML(1)'},{website:'bot'},{name:'x'.repeat(121)},{experience:'NEW'}]){const response=await send(post,JSON.stringify(body(patch)));assert.equal(response.status,400);assert.deepEqual(await response.json(),{result:'invalid'});}
  for(const path of [`${post}?schoolId=${school}`,post.replace('/v1/','/V1/'),post.replace('/public/','/PUBLIC/'),`${post}/`]){const n=submissions;const response=await send(path);assert.equal(response.status,400);assert.deepEqual(await response.json(),{result:'invalid'});assert.equal(submissions,n);}
  for(const h of [{...headers,'Idempotency-Key':''},{...headers,'Idempotency-Key':'x'},{...headers,'Idempotency-Key':'a'.repeat(101)},{...headers,'Idempotency-Key':'a'.repeat(16)+', '+ 'b'.repeat(16)}])assert.equal((await send(post,JSON.stringify(body()),h)).status,400);
  const staffHeaders={...headers,origin:'https://hon.test','X-HON-Human-Command':'public-lead-form','Sec-Fetch-Site':'same-origin'};
  const monitor=await fetch(`${base}/marketing/forms/intake-monitor`);assert.equal(monitor.status,200);assert.equal(monitor.headers.get('cache-control'),'private, no-store');assert.deepEqual(await monitor.json(),{data:[{title:'School enquiries',status:'DRAFT',acceptedCount:0,hasCampaignAssociation:false}]});
  assert.equal((await send(`${base}/marketing/forms`,JSON.stringify(config()),staffHeaders)).status,200);
  for(const patch of [{schoolId:school},{actorId:actor},{optionalFields:['medicalNotes']}])assert.equal((await send(`${base}/marketing/forms`,JSON.stringify(config(patch)),staffHeaders)).status,400);
  assert.equal((await send(`${base}/marketing/forms`,JSON.stringify(config()),{...staffHeaders,origin:'https://evil.test'})).status,403);assert.equal((await send(`${base}/marketing/forms/${id}/publish`,JSON.stringify({expectedVersion:1,actorId:actor}),staffHeaders)).status,400);
  permission=false;assert.equal((await fetch(`${base}/marketing/forms`)).status,403);assert.equal((await fetch(`${base}/marketing/forms/intake-monitor`)).status,403);
  let limited=false;for(let n=0;n<305;n++){const response=await send();if(response.status===429){assert.deepEqual(await response.json(),{result:'rate-limited'});assert.equal(response.headers.get('retry-after'),'60');limited=true;break;}await response.text();}assert(limited);
 }finally{await app.close();if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('form source imports no downstream adapters and public SQL boundary cannot communicate, spend, invoke AI or execute actions',()=>{
 for(const file of ['public-form.service.ts','public-form.controller.ts'])assert.doesNotMatch(readFileSync(`src/marketing/${file}`,'utf8'),/ActionEngineService|Payment.*Service|Messaging.*Service|Ai.*Service|fetch\(|invokeProvider/);
 const sql=readFileSync('../../packages/database/migrations/0075_public_lead_forms.sql','utf8');assert.doesNotMatch(sql,/INSERT INTO hon\.(?:memberships|invoices|payment_attempts|communication_consents|communication_messages|crm_appointments|action_requests|action_approvals|ai_usage_ledger|ai_invocation_plans|work_items)/);assert.match(sql,/'marketing.form.lead_received'/);assert.match(sql,/REVOKE ALL ON FUNCTION %s FROM PUBLIC/);assert.doesNotMatch(sql,/GRANT .* TO PUBLIC/);
});

test('BOM and identifier newline normalization cannot bypass public schema boundaries',async()=>{
 assert.throws(()=>parsePublicFormJson(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{}')])));
 const svc=new PublicFormService({readPublishedLeadForm:async()=>{throw Error('must not query');},submitPublishedLeadForm:async()=>{throw Error('must not query');}});
 assert.equal(await svc.published(publicId+'\n'),null);assert.equal(await svc.submit(publicId+'\n',body(),randomUUID()),'invalid');assert.equal(await svc.submit(publicId,body(),randomUUID()+'\n'),'invalid');
});
