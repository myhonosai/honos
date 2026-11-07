const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {SchoolPersonRecordService}=require('../dist/people/school-person-record.service.js');
const {SchoolPersonRecordHumanGuard}=require('../dist/people/school-person-record.controller.js');
const c=require('@hon/contracts');
const ids={schoolId:randomUUID(),personId:randomUUID()};
const record={...ids,givenName:'Ana',familyName:'Rivera',email:'ana@example.invalid',phoneE164:'+15555550100',version:2,updatedAt:new Date().toISOString(),
 student:{birthDate:'2015-04-02',status:'ACTIVE'},consents:{EMAIL:'OPTED_IN',SMS:'NOT_RECORDED'},canEdit:true};
const input={...ids,expectedVersion:1,givenName:'Ana',familyName:'Rivera',email:'ana@example.invalid',phoneE164:null};
test('closed person update body: no organization, principal, consent, birth date or family can be supplied; values normalized',()=>{
 assert.deepEqual(c.validatePersonRecordUpdateInput({...input,givenName:'  Ana ',email:' ANA@Example.invalid ',phoneE164:' +15555550100 '}),{...input,email:'ana@example.invalid',phoneE164:'+15555550100'});
 for(const patch of [{organizationId:randomUUID()},{principalId:randomUUID()},{birthDate:'2015-01-01'},{consents:{}},{familyId:randomUUID()},{expectedVersion:0},{expectedVersion:1.5},{expectedVersion:'1'},
   {givenName:''},{givenName:'   '},{givenName:'x'.repeat(121)},{familyName:'A\u0000B'},{email:'no-at'},{email:5},{phoneE164:'5551234'},{phoneE164:'+0123'},{schoolId:'x'}])
  assert.throws(()=>c.validatePersonRecordUpdateInput({...input,...patch}),/PERSON_INPUT_INVALID/);
 const {email,...missing}=input;assert.throws(()=>c.validatePersonRecordUpdateInput(missing));
});
test('closed person record and update result responses',()=>{
 assert.deepEqual(c.validatePersonRecord(record),record);
 assert.deepEqual(c.validatePersonRecord({...record,student:null,email:null,phoneE164:null}),{...record,student:null,email:null,phoneE164:null});
 for(const patch of [{organizationId:randomUUID()},{canEdit:'yes'},{version:0},{updatedAt:'soon'},{consents:{EMAIL:'YES',SMS:'NOT_RECORDED'}},{consents:{EMAIL:'OPTED_IN'}},
   {student:{birthDate:'2015/04/02',status:'ACTIVE'}},{student:{status:'ACTIVE'}},{givenName:''},{email:''},{phoneE164:''},{phoneE164:'+1'.repeat(20)}])
  assert.throws(()=>c.validatePersonRecord({...record,...patch}),/PERSON_RESPONSE_INVALID/);
 assert.deepEqual(c.validatePersonRecord({...record,email:'Mia.Chen@Example.invalid',givenName:' legacy '}).email,'Mia.Chen@Example.invalid');
 assert.deepEqual(c.validatePersonRecordUpdateResult({person:record,changedFields:['familyName']}),{person:record,changedFields:['familyName']});
 for(const changedFields of [[],['birthDate'],['email','email'],'email'])assert.throws(()=>c.validatePersonRecordUpdateResult({person:record,changedFields}));
});
test('subject only from the session; body re-validated before SQL; response validated',async()=>{
 const calls=[];const svc=new SchoolPersonRecordService({callSchoolPersonRecord:async(op,args)=>{calls.push([op,args]);return op==='read'?record:{person:record,changedFields:['givenName']};}});
 const req={honIdentity:{externalSubject:'oidc:fixture:editor'}},key=randomUUID();
 await svc.update(req,{...input,givenName:' Ana '},key);
 assert.equal(calls[0][0],'update');assert.equal(calls[0][1][0],'oidc:fixture:editor');assert.deepEqual(JSON.parse(calls[0][1][1]),input);assert.equal(calls[0][1][2],key);
 for(const [b,k] of [[{...input,organizationId:randomUUID()},key],[input,'not-a-uuid'],[input,undefined]])await assert.rejects(()=>svc.update(req,b,k),e=>e.status===400&&e.response.code==='PERSON_INPUT_INVALID');
 assert.equal(calls.length,1);
 assert.deepEqual(await svc.read(req,ids.schoolId,ids.personId),record);assert.deepEqual(calls[1],['read',['oidc:fixture:editor',ids.schoolId,ids.personId]]);
 await assert.rejects(()=>svc.read(req,'x',ids.personId),e=>e.status===400);assert.equal(calls.length,2);
 const bad=new SchoolPersonRecordService({callSchoolPersonRecord:async()=>({...record,tokenHash:'x'})});await assert.rejects(()=>bad.read(req,ids.schoolId,ids.personId),/PERSON_RESPONSE_INVALID/);
});
test('database denials map to closed codes and never leak SQL',async()=>{
 for(const [code,message,status,closedCode] of [['42501','PERSON_FORBIDDEN',403,'PERSON_FORBIDDEN'],['P0002','x',404,'PERSON_UNAVAILABLE'],['40001','x',409,'PERSON_VERSION_CONFLICT'],
   ['23514','x',409,'PERSON_CONTACT_CONSENT_REVIEW_REQUIRED'],['23505','x',409,'PERSON_IDEMPOTENCY_CONFLICT'],['55P03','x',503,'PERSON_BUSY'],['22023','PERSON_UNCHANGED',400,'PERSON_UNCHANGED'],
   ['22023','SECRET SQL',400,'PERSON_INPUT_INVALID'],['XX000','SECRET SQL',503,'PERSON_UNAVAILABLE']]){
  const svc=new SchoolPersonRecordService({callSchoolPersonRecord:async()=>{throw Object.assign(new Error(message),{code});}});
  await assert.rejects(()=>svc.update({honIdentity:{externalSubject:'s'}},input,randomUUID()),e=>e.status===status&&e.response.code===closedCode&&!JSON.stringify(e.response).includes('SECRET'));
 }
});
test('person human guard: own command header for the edit, same-origin, no authority headers or query selectors',()=>{
 const saved={...process.env};process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const guard=new SchoolPersonRecordHumanGuard(),headers={origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','content-type':'application/json','x-hon-human-command':c.PERSON_RECORD_HUMAN_COMMAND};
 const check=patch=>{const set={};const r={method:'POST',headers:{...headers},query:{},originalUrl:'/v1/school/people/update',...patch};assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>r,getResponse:()=>({setHeader:(k,v)=>set[k]=v})})}),true);assert.equal(set['Cache-Control'],'private, no-store');};
 try{check({});check({method:'GET',headers:{'sec-fetch-site':'same-origin'},originalUrl:'/v1/school/schools/x/people/y'});
  for(const patch of [{headers:{...headers,origin:'https://evil.invalid'}},{headers:{...headers,'x-hon-human-command':c.FAMILY_ACCOUNT_HUMAN_COMMAND}},{headers:{...headers,'x-hon-school-id':ids.schoolId}},
    {headers:{...headers,authorization:'Bearer x'}},{originalUrl:'/v1/school/people/update?schoolId=x'},{method:'PUT'},{method:'GET',headers:{'sec-fetch-site':'cross-site'}}])assert.throws(()=>check(patch));
 }finally{process.env=saved;}
});
