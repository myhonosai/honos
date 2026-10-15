require('reflect-metadata');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ValidationPipe } = require('@nestjs/common');
const { StaffRoleService } = require('../dist/staff-roles/staff-role.service.js');
const { StaffRoleController } = require('../dist/staff-roles/staff-role.controller.js');
const { CreateCustomRoleDto, GrantStaffRoleDto, RevokeStaffRoleDto } = require('../dist/staff-roles/staff-role.dto.js');
const context = () => ({ organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID(), externalSubject: 'verified-subject', principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID() });
const input = { code: 'CUSTOM_DESK', name: 'Desk', permissionCodes: ['school.view'] };
const status = n => e => { assert.equal(e.getStatus(),n);return true; };

test('closed DTOs reject caller identity/scope/contact/source fields', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  for(const extra of ['organizationId','schoolId','principalId','source','actionRequestId','isSystemRole','email','phone']) {
    await assert.rejects(()=>pipe.transform({...input,[extra]:'untrusted'},{type:'body',metatype:CreateCustomRoleDto}),status(400));
  }
  for(const code of ['OWNER','HQ_OWNER','PLATFORM_ADMIN','SYSTEM_ADMIN']) await assert.rejects(()=>pipe.transform({...input,code},{type:'body',metatype:CreateCustomRoleDto}),status(400));
  await assert.rejects(()=>pipe.transform({...input,permissionCodes:['school.view','school.view']},{type:'body',metatype:CreateCustomRoleDto}),status(400));
  await assert.rejects(()=>pipe.transform({roleId:randomUUID(),email:'x@example.test'},{type:'body',metatype:GrantStaffRoleDto}),status(400));
  await assert.rejects(()=>pipe.transform({expectedVersion:0},{type:'body',metatype:RevokeStaffRoleDto}),status(400));
});
test('only direct HUMAN_UI/HUMAN_USER reaches a tenant transaction', async () => {
  const service=new StaffRoleService({withTenantTransaction:()=>{throw new Error('must not reach database');}});
  for(const source of ['AI','AUTOMATION','INTEGRATION','PUBLIC_API']) assert.throws(()=>service.create({...context(),source},input),status(403));
  for(const principalType of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE']) assert.throws(()=>service.create({...context(),principalType},input),status(403));
  for(const field of ['actionRequestId','delegatedByPrincipalId']) assert.throws(()=>service.create({...context(),[field]:randomUUID()},input),status(403));
  const c=context();assert.throws(()=>service.grant(c,{roleId:randomUUID(),targetPrincipalId:c.principalId,targetExternalSubject:c.externalSubject}),status(403));
  assert.throws(()=>service.create(context(),{...input,permissionCodes:['hq.onboarding.manage']}),status(400));
});
test('service calls only the fixed IAM boundary with locally bounded attribution', async () => {
  const calls=[];const record={id:randomUUID(),code:'CUSTOM_DESK',name:'Desk',permissionCodes:['school.view'],version:1};const c=context();
  const service=new StaffRoleService({withTenantTransaction:async(ctx,work)=>{assert.equal(ctx,c);return work({query:async(sql,params)=>{calls.push([sql,params]);return {rows:[{data:{record,replayed:false}}]};}});}});
  assert.deepEqual(await service.create(c,input),{record,replayed:false});
  assert.equal(calls.length,2);assert.match(calls[0][0],/set_config.*HUMAN_UI/);assert.match(calls[1][0],/hon.mutate_staff_role/);
  assert.deepEqual(calls[1][1],[c.externalSubject,'iam.custom_role.create',null,JSON.stringify(input),c.idempotencyKey,c.requestId,c.correlationId]);
});
test('controller derives scope, actor and source from verified session; rejects cross org and missing identity', async()=>{
  const c=context();let command;
  const db={resolveAuthorizedScope:async(subject,school,permission)=>{assert.equal(subject,c.externalSubject);assert.equal(school,c.schoolId);assert.equal(permission,'iam.custom_role.create');return {organizationId:c.organizationId,schoolId:c.schoolId,principalId:c.principalId};}};
  const controller=new StaffRoleController(db,{create:async(ctx)=>{command=ctx;return {record:{id:randomUUID()},replayed:false};}});
  await controller.create(c.organizationId,c.schoolId,c.idempotencyKey,input,{honIdentity:{externalSubject:c.externalSubject}});
  assert.equal(command.principalId,c.principalId);assert.equal(command.source,'HUMAN_UI');assert.equal(command.externalSubject,c.externalSubject);assert.equal(command.actionRequestId,undefined);
  await assert.rejects(()=>controller.create(randomUUID(),c.schoolId,c.idempotencyKey,input,{honIdentity:{externalSubject:c.externalSubject}}),status(403));
  await assert.rejects(()=>controller.create(c.organizationId,c.schoolId,c.idempotencyKey,input,{}),status(403));
});
test('IAM actions are deliberately absent from the Action Engine catalog',()=>{
  const { ACTION_CATALOG } = require('@hon/config');
  assert.equal(ACTION_CATALOG.some(a=>a.code.startsWith('iam.')),false);
});

test('human UI guard requires configured trusted origin, JSON and custom header',()=>{
  const { StaffRoleHumanUiGuard }=require('../dist/staff-roles/staff-role-human-ui.guard.js');
  const guard=new StaffRoleHumanUiGuard();const previous=process.env.HON_PUBLIC_ORIGIN;
  const run=(method,headers)=>guard.canActivate({switchToHttp:()=>({getRequest:()=>({method,headers})})});
  const headers={origin:'https://hon.example','content-type':'application/json','x-hon-human-command':'staff-role-admin','sec-fetch-site':'same-origin'};
  try {
    delete process.env.HON_PUBLIC_ORIGIN;assert.throws(()=>run('POST',headers),status(503));
    process.env.HON_PUBLIC_ORIGIN='https://hon.example';assert.equal(run('POST',headers),true);assert.equal(run('GET',{}),true);
    for(const bad of [{...headers,origin:'https://attacker.example'},{...headers,origin:undefined},{...headers,'content-type':'text/plain'},{...headers,'x-hon-human-command':undefined},{...headers,'sec-fetch-site':'cross-site'}]) assert.throws(()=>run('POST',bad),status(403));
  } finally { if(previous===undefined) delete process.env.HON_PUBLIC_ORIGIN;else process.env.HON_PUBLIC_ORIGIN=previous; }
});
