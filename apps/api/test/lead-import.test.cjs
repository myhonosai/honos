require('reflect-metadata');
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {PATH_METADATA,GUARDS_METADATA}=require('@nestjs/common/constants');
const {parseLeadCsv}=require('../dist/migration/lead-import-csv.js');
const {LeadImportService}=require('../dist/migration/lead-import.service.js');
const {LeadImportController}=require('../dist/migration/lead-import.controller.js');
const {LeadImportHumanUiGuard}=require('../dist/migration/lead-import-human-ui.guard.js');
const {HonIdentityGuard}=require('../dist/foundation/hon-identity.guard.js');
const {LEAD_IMPORT_COMMAND_REGISTRY,ACTION_CATALOG}=require('@hon/config');
const {authorizeAction}=require('@hon/domain');
const body=()=>({csv:'First,Last,Email\r\n"Ada, A","O""Neil",ada@example.test\r\n',mapping:{First:'givenName',Last:'familyName',Email:'email'},pipelineStageId:randomUUID()});
const c=()=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:randomUUID(),externalSubject:'verified',source:'HUMAN_UI',principalType:'HUMAN_USER'});
const status=n=>e=>{assert.equal(e.getStatus(),n);return true;};
test('strict RFC CSV accepts quoted commas/doubled quotes, BOM and exact mappings',()=>{
 const p=parseLeadCsv(body());assert.deepEqual(p.rows, [['Ada, A','O"Neil','ada@example.test']]);assert.equal(parseLeadCsv({...body(),csv:'\uFEFF'+body().csv}).headers[0],'First');
 const multiline=parseLeadCsv({...body(),csv:'First,Last,Email\n"Ada\nA",Lee,ada@example.test\n'});assert.equal(multiline.rows[0][0],'Ada\nA');
});
test('malformed, invalid encoding, record/file/row/column caps and mapping failures are closed',()=>{
 for(const csv of ['','First,Last,Email\n"unterminated,Lee,x','First,Last,Email\nA,B','First,Last,Email\nA,B,x,extra','First,Last,Email\nA,B,\ud800','First,Last,Email\nA,B,\ufffd','x'.repeat(262145),'First,Last,Email\n'+('A,B,x\n'.repeat(1001)),'First,Last,Email\n'+('x'.repeat(16385))+',B,x','First,First,Email\nA,B,x','=First,Last,Email\nA,B,x'])assert.throws(()=>parseLeadCsv({...body(),csv}),status(400));
 const mappings=[{First:'givenName',Last:'familyName'},{First:'givenName',Last:'familyName',Email:'payment'},{First:'givenName',Last:'givenName',Email:'email'},{First:'familyName',Last:'note',Email:'email'},{...body().mapping,Other:'source'},null];
 for(const mapping of mappings)assert.throws(()=>parseLeadCsv({...body(),mapping}),status(400));
 assert.throws(()=>parseLeadCsv({...body(),schoolId:randomUUID()}),status(400));
});
test('only direct human contexts and closed version/selection contracts reach database',async()=>{
 const svc=new LeadImportService({withTenantTransaction:async()=>assert.fail('must not query')});
 for(const source of ['AI','AUTOMATION','INTEGRATION','MIGRATION','PUBLIC_API'])await assert.rejects(()=>svc.upload({...c(),source},body()),status(403));
 for(const principalType of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE'])await assert.rejects(()=>svc.upload({...c(),principalType},body()),status(403));
 for(const extra of [{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}])await assert.rejects(()=>svc.upload({...c(),...extra},body()),status(403));
 assert.throws(()=>svc.finalize(c(),randomUUID(),{expectedVersion:1,reviewToken:randomUUID(),selectedIndices:[1,1]}),status(400));
 assert.throws(()=>svc.decide(c(),randomUUID(),{expectedVersion:1,reviewToken:randomUUID(),decisions:[{index:1,choice:'MERGE'}]}),status(400));
 assert.throws(()=>svc.open(c(),randomUUID(),{expectedVersion:1,schoolId:randomUUID()}),status(400));
 await assert.rejects(()=>svc.read(c(),'BATCH',randomUUID(),randomUUID()),status(400));
});
test('controller derives school and actor exclusively from verified session, no client scope selection',async()=>{
 assert.equal(Reflect.getMetadata(PATH_METADATA,LeadImportController),'staff/migration/leads');assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA,LeadImportController),[HonIdentityGuard,LeadImportHumanUiGuard]);
 const scope=c(),calls=[];const controller=new LeadImportController({resolveLeadImportScope:async(...args)=>{calls.push(args);return scope;}},{upload:async(actual,input)=>{assert.equal(actual.organizationId,scope.organizationId);assert.equal(actual.schoolId,scope.schoolId);assert.equal(actual.principalId,scope.principalId);assert.equal(actual.source,'HUMAN_UI');return {record:{id:'batch'},replayed:false};}});
 await controller.upload('key',body(),{honIdentity:{externalSubject:'verified'},schoolId:randomUUID(),principalId:randomUUID()});assert.deepEqual(calls,[['verified','migration.lead_import.upload']]);
 await assert.rejects(()=>controller.list({}),status(403));const denied=new LeadImportController({resolveLeadImportScope:async()=>undefined},{});await assert.rejects(()=>denied.list({honIdentity:{externalSubject:'verified'}}),status(403));
});
test('trusted origin guard fails closed and permits only conventional human JSON POSTs',()=>{
 const guard=new LeadImportHumanUiGuard(),old=process.env.HON_PUBLIC_ORIGIN;
 const run=(method,headers)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})});const h={origin:'https://hon.example','content-type':'application/json','x-hon-human-command':'lead-import','sec-fetch-site':'same-origin'};
 try{delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run('POST',h),status(503));process.env.HON_PUBLIC_ORIGIN='https://hon.example';assert(run('GET',{}));assert(run('POST',h));
 for(const bad of [{...h,origin:'https://evil.example'},{...h,origin:undefined},{...h,'x-hon-human-command':undefined},{...h,'content-type':'text/csv'},{...h,'sec-fetch-site':'cross-site'}])assert.throws(()=>run('POST',bad),status(403));assert.throws(()=>run('PUT',h),status(403));
 }finally{if(old===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=old;}
});
test('Essential migration registry cannot be proposed/executed by Action Engine at any tier',()=>{
 for(const cmd of LEAD_IMPORT_COMMAND_REGISTRY){assert.equal(cmd.minimumTier,'ESSENTIAL');assert.equal(cmd.execution,'HUMAN_ONLY');assert.equal(cmd.requiredPermission,cmd.code);assert.equal(ACTION_CATALOG.some(a=>a.code===cmd.code),false);for(const tier of ['ESSENTIAL','CORE','COMPLETE'])assert.throws(()=>authorizeAction({actionCode:cmd.code,tier,grantedPermissions:new Set([cmd.code]),authoritySources:{platform:'AUTO'}}),/ACTION_NOT_REGISTERED/);}
});
