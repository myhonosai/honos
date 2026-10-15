require('reflect-metadata');
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {ValidationPipe}=require('@nestjs/common');
const {DocumentService}=require('../dist/documents/document.service.js');
const {DocumentController}=require('../dist/documents/document.controller.js');
const {ParentDocumentController}=require('../dist/documents/parent-document.controller.js');
const {DocumentHumanUiGuard}=require('../dist/documents/document-human-ui.guard.js');
const {CreateDocumentTemplateDto,CreateDocumentVersionDto,PublishDocumentDto,AcknowledgeDocumentDto}=require('../dist/documents/document.dto.js');
const context=()=>({organizationId:randomUUID(),schoolId:randomUUID(),principalId:randomUUID(),externalSubject:'verified-subject',principalType:'HUMAN_USER',source:'HUMAN_UI',audienceMode:'STAFF',idempotencyKey:randomUUID(),requestId:randomUUID(),correlationId:randomUUID()});
const body={title:'A bounded document',content:'Plain text\ncontent',audience:'STAFF'};
const status=n=>e=>{assert.equal(e.getStatus(),n);return true;};
test('document DTOs reject undeclared scope, evidence, legal-provider and image fields',async()=>{
 const pipe=new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true});
 await pipe.transform(body,{type:'body',metatype:CreateDocumentTemplateDto});
 for(const extra of [{organizationId:randomUUID()},{personId:randomUUID()},{signerPrincipalId:randomUUID()},{source:'AI'},{provider:'external'},{signatureImage:'raw'}]) await assert.rejects(()=>pipe.transform({...body,...extra},{type:'body',metatype:CreateDocumentTemplateDto}),status(400));
 await assert.rejects(()=>pipe.transform({...body,audience:'STUDENT'},{type:'body',metatype:CreateDocumentTemplateDto}),status(400));
 await assert.rejects(()=>pipe.transform({title:'T',content:'C',expectedVersion:0},{type:'body',metatype:CreateDocumentVersionDto}),status(400));
 await assert.rejects(()=>pipe.transform({versionId:randomUUID(),expectedVersion:1,content:'overwrite'},{type:'body',metatype:PublishDocumentDto}),status(400));
 const ack={choice:'ACKNOWLEDGE',contentHash:'a'.repeat(64)};
 await pipe.transform(ack,{type:'body',metatype:AcknowledgeDocumentDto});
 for(const extra of [{familyId:randomUUID()},{signerPrincipalId:randomUUID()},{acknowledgedAt:new Date().toISOString()},{signatureImage:'raw'},{attestationText:'x'.repeat(501)}])await assert.rejects(()=>pipe.transform({...ack,...extra},{type:'body',metatype:AcknowledgeDocumentDto}),status(400));
});
test('all document mutations reject non-human, non-UI, delegation, action requests and closed-input bypass before SQL',()=>{
 const svc=new DocumentService({withTenantTransaction:()=>{throw new Error('SQL must not run');}});
 const variants=[...['AI','AUTOMATION','INTEGRATION','PUBLIC_API','MIGRATION'].map(source=>({...context(),source})),...['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE'].map(principalType=>({...context(),principalType})),{...context(),actionRequestId:randomUUID()},{...context(),delegatedByPrincipalId:randomUUID()}];
 for(const c of variants){assert.throws(()=>svc.create(c,body),status(403));assert.throws(()=>svc.version(c,randomUUID(),{expectedVersion:1,title:'T',content:'C'}),status(403));assert.throws(()=>svc.publish(c,randomUUID(),{expectedVersion:1,versionId:randomUUID()}),status(403));assert.throws(()=>svc.acknowledge(c,randomUUID(),{choice:'ACKNOWLEDGE',contentHash:'a'.repeat(64)}),status(403));}
 assert.throws(()=>svc.create(context(),{...body,familyId:randomUUID()}),status(400));
 assert.throws(()=>svc.create(context(),{...body,title:' ' }),status(400));
 assert.throws(()=>svc.create(context(),{...body,content:'raw\u0000text'}),status(400));
 assert.throws(()=>svc.acknowledge(context(),randomUUID(),{choice:'ACKNOWLEDGE',contentHash:'a'.repeat(64),attestationText:null}),status(400));
});
test('service executes only fixed function calls and transaction-local attribution',async()=>{
 const c=context(),calls=[];const expected={record:{id:randomUUID()},replayed:false};
 const svc=new DocumentService({withTenantTransaction:async(ctx,work)=>{assert.equal(ctx,c);return work({query:async(sql,params)=>{calls.push([sql,params]);return {rows:[{data:expected}]};}});}});
 assert.deepEqual(await svc.create(c,body),expected);assert.equal(calls.length,2);assert.match(calls[0][0],/set_config/);assert.match(calls[1][0],/hon.mutate_document/);
 assert.deepEqual(calls[1][1],[c.externalSubject,'STAFF','document.template.create',null,JSON.stringify(body),c.idempotencyKey,c.requestId,c.correlationId]);
 for(const [sql] of calls)assert.doesNotMatch(sql,/INSERT|UPDATE|DELETE/);
});
test('staff controller derives actor and source from verified identity and exact permission, denies organization mismatch',async()=>{
 const c=context();let actual;
 const db={resolveAuthorizedScope:async(subject,school,permission)=>{assert.equal(subject,c.externalSubject);assert.equal(school,c.schoolId);assert.equal(permission,'document.template.create');return {organizationId:c.organizationId,schoolId:c.schoolId,principalId:c.principalId};}};
 const controller=new DocumentController(db,{create:async(ctx)=>{actual=ctx;return {record:{id:randomUUID()},replayed:false};}});
 const r=await controller.create(c.organizationId,c.schoolId,c.idempotencyKey,body,{honIdentity:{externalSubject:c.externalSubject}});
 assert.equal(actual.principalId,c.principalId);assert.equal(actual.source,'HUMAN_UI');assert.equal(actual.audienceMode,'STAFF');assert.equal(actual.actionRequestId,undefined);assert.equal(r.meta.replayed,false);
 await assert.rejects(()=>controller.create(randomUUID(),c.schoolId,c.idempotencyKey,body,{honIdentity:{externalSubject:c.externalSubject}}),status(403));
 await assert.rejects(()=>controller.create(c.organizationId,c.schoolId,c.idempotencyKey,body,{}),status(403));
});
test('parent controller accepts no client family/person/organization authority and uses only the verified family resolver',async()=>{
 const c=context();let actual;
 const db={resolveParentFamilyScopes:async(subject,school)=>{assert.equal(subject,c.externalSubject);assert.equal(school,c.schoolId);return [{organizationId:c.organizationId,schoolId:c.schoolId,principalId:c.principalId,familyId:randomUUID(),accessLevel:'VIEWER'}];},resolveAuthorizedScope:()=>{throw new Error('No staff fallback allowed');}};
 const controller=new ParentDocumentController(db,{acknowledge:async(ctx,id,input)=>{actual=ctx;return {record:{id},replayed:false};}});
 await controller.acknowledge(c.schoolId,randomUUID(),c.idempotencyKey,{choice:'ACKNOWLEDGE',contentHash:'a'.repeat(64)},{honIdentity:{externalSubject:c.externalSubject},familyId:randomUUID(),organizationId:randomUUID()});
 assert.equal(actual.organizationId,c.organizationId);assert.equal(actual.principalId,c.principalId);assert.equal(actual.familyId,undefined);assert.equal(actual.audienceMode,'PARENT');
 // The controller's VIEWER read scope alone does not confer acknowledgement:
 // the fixed SQL function re-resolves live guardian authority for the publication.
 const denied=new ParentDocumentController({resolveParentFamilyScopes:async()=>[]},{});
 await assert.rejects(()=>denied.list(c.schoolId,{honIdentity:{externalSubject:c.externalSubject}}),status(403));
});
test('same-origin UI guard fails closed without configured origin and rejects header/method bypasses',()=>{
 const guard=new DocumentHumanUiGuard(),previous=process.env.HON_PUBLIC_ORIGIN;
 const run=(method,headers)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})});
 const headers={origin:'https://hon.example','content-type':'application/json','x-hon-human-command':'document-acknowledgement','sec-fetch-site':'same-origin'};
 try{delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run('POST',headers),status(503));process.env.HON_PUBLIC_ORIGIN='https://hon.example';assert(run('POST',headers));assert(run('GET',{}));
  for(const bad of [{...headers,origin:'https://attacker.example'},{...headers,origin:undefined},{...headers,'content-type':'text/plain'},{...headers,'x-hon-human-command':undefined},{...headers,'sec-fetch-site':'cross-site'}])assert.throws(()=>run('POST',bad),status(403));
  assert.throws(()=>run('PATCH',headers),status(403));
 }finally{if(previous===undefined)delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous;}
});
test('document commands are not Action Engine proposals/tools at any tier',()=>{
 const {ACTION_CATALOG,DOCUMENT_COMMAND_REGISTRY}=require('@hon/config');const {authorizeAction}=require('@hon/domain');
 for(const command of DOCUMENT_COMMAND_REGISTRY){assert.equal(ACTION_CATALOG.some(a=>a.code===command.code),false);assert.equal(command.source,'HUMAN_UI');assert.equal(command.principalType,'HUMAN_USER');assert.throws(()=>authorizeAction({actionCode:command.code,tier:'COMPLETE',grantedPermissions:new Set([command.requiredPermission]),authoritySources:{platform:'AUTO'}}),/ACTION_NOT_REGISTERED/);}
});
