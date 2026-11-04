const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto');
const {SchoolFamilyAccessInvitationService}=require('../dist/accounts/school-family-access-invitation.service.js');
const {SchoolFamilyAccountHumanGuard}=require('../dist/accounts/school-family-access-invitation.controller.js');
const c=require('@hon/contracts'),auth=require('@hon/auth');
const ids={invitationId:randomUUID(),schoolId:randomUUID(),familyId:randomUUID()},t=randomBytes(32).toString('base64url');
const receipt={...ids,accessLevel:'SECONDARY_GUARDIAN',accountStatus:'FAMILY_ACCESS_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false};
const invitation={...ids,familyName:'Rivera family',accessLevel:'VIEWER',email:'parent@example.invalid',expiresAt:new Date().toISOString(),status:'ENDED'};
test('closed family request/response: no organization, principal, student, role or financial effect can be supplied',()=>{
 const input={schoolId:ids.schoolId,familyId:ids.familyId,accessLevel:'PRIMARY_GUARDIAN',email:'parent@example.invalid',ttlHours:24,token:t};
 assert.deepEqual(c.validateFamilyAccessInvitationInput(input),input);
 for(const patch of [{organizationId:randomUUID()},{principalId:randomUUID()},{studentId:randomUUID()},{role:'OWNER'},{accessLevel:'OWNER'},{accessLevel:'primary_guardian'},{ttlHours:169},{ttlHours:0},{token:'short'},{email:'Parent@example.invalid'},{familyId:'x'}])
  assert.throws(()=>c.validateFamilyAccessInvitationInput({...input,...patch}));
 assert.deepEqual(c.validateFamilyAccessInvitationRevoke({schoolId:ids.schoolId,invitationId:ids.invitationId}),{schoolId:ids.schoolId,invitationId:ids.invitationId});
 const end={schoolId:ids.schoolId,invitationId:ids.invitationId,confirmation:c.FAMILY_ACCESS_END_CONFIRMATION};
 assert.deepEqual(c.validateFamilyAccessEnd(end),end);
 assert.throws(()=>c.validateFamilyAccessEnd({schoolId:ids.schoolId,invitationId:ids.invitationId}));assert.throws(()=>c.validateFamilyAccessEnd({...end,confirmation:'END'}));
 assert.deepEqual(c.validateFamilyAccountReceipt(receipt),receipt);
 for(const k of ['accessGranted','billingActivated','aiCreditsGranted'])assert.throws(()=>c.validateFamilyAccountReceipt({...receipt,[k]:true}));
 assert.throws(()=>c.validateFamilyAccountReceipt({...receipt,accountStatus:'STAFF_ROLE_BOUND'}));
 assert.deepEqual(c.validateFamilyAccessInvitation(invitation),invitation);
 for(const patch of [{status:'ACTIVE'},{tokenHash:'x'},{familyName:''},{expiresAt:'soon'},{accessLevel:'OWNER'}])assert.throws(()=>c.validateFamilyAccessInvitation({...invitation,...patch}));
 assert.throws(()=>c.validateFamilyAccessInvitationAcceptance({invitationId:ids.invitationId,token:t,confirmation:c.STAFF_INVITATION_CONFIRMATION}));
});
test('family acceptance takes subject and verified email only from the signed OIDC cookie; token hashed before SQL',async()=>{
 const saved={...process.env};try{
 Object.assign(process.env,{HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:'s2f-unit',HON_SESSION_JWT_SECRET:randomBytes(32).toString('hex'),HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
 const config=auth.sessionConfig(),calls=[],service=new SchoolFamilyAccessInvitationService({callSchoolFamilyAccount:async(...args)=>{calls.push(args);return receipt;}});
 const identity={externalSubject:'oidc:fixture:parent',email:'parent@example.invalid'};
 const req=proof=>({honIdentity:identity,headers:{cookie:auth.HON_SESSION_COOKIE+'='+auth.issueSession({...identity,...proof},config)}});
 const body={invitationId:ids.invitationId,token:t,confirmation:c.FAMILY_ACCESS_INVITATION_CONFIRMATION};
 await assert.rejects(()=>service.command(req({}),'accept',body,randomUUID()),e=>e.status===403);assert.equal(calls.length,0);
 await service.command(req({emailVerified:true}),'accept',body,randomUUID());
 assert.equal(calls[0][0],'accept');assert.equal(calls[0][1][0],identity.externalSubject);assert.equal(calls[0][1][1],identity.email);
 const sent=JSON.parse(calls[0][1][2]);assert.equal(sent.tokenHash,createHash('sha256').update(t).digest('hex'));assert(!JSON.stringify(calls).includes(t));
 }finally{process.env=saved;}
});
test('family human guard requires its own command header and denies forged context, cross-origin, authority headers and queries',()=>{
 const saved={...process.env};process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const guard=new SchoolFamilyAccountHumanGuard(),headers={origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','content-type':'application/json','x-hon-human-command':c.FAMILY_ACCOUNT_HUMAN_COMMAND};
 const check=patch=>{const set={};const r={method:'POST',headers:{...headers},query:{},originalUrl:'/v1/school/family-access-invitations',...patch};assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>r,getResponse:()=>({setHeader:(k,v)=>set[k]=v})})}),true);assert.equal(set['Cache-Control'],'private, no-store');};
 try{check({});for(const patch of [{source:'AI'},{schoolId:ids.schoolId},{headers:{...headers,origin:'https://evil.invalid'}},{headers:{...headers,'x-hon-human-command':c.STAFF_ACCOUNT_HUMAN_COMMAND}},{headers:{...headers,'x-hon-school-id':ids.schoolId}},{headers:{...headers,authorization:'Bearer x'}},{originalUrl:'/?x=1'},{honIdentity:{externalSubject:'x',role:'OWNER'}}])assert.throws(()=>check(patch));}finally{process.env=saved;}
});
test('family database denials map to closed codes and redact SQL; busy is recoverable; end uses its own SQL operation',async()=>{
 for(const [code,status]of [['42501',403],['P0002',404],['23505',409],['23514',409],['55P03',503],['22023',400],['XX000',503]]){let calls=0;const service=new SchoolFamilyAccessInvitationService({callSchoolFamilyAccount:async()=>{calls++;throw Object.assign(new Error('SECRET SQL'),{code});}});
 await assert.rejects(()=>service.command({honIdentity:{externalSubject:'manager'}},'revoke',{schoolId:ids.schoolId,invitationId:ids.invitationId},randomUUID()),e=>e.status===status&&!JSON.stringify(e).includes('SECRET'));assert.equal(calls,1);}
 const ops=[];const svc=new SchoolFamilyAccessInvitationService({callSchoolFamilyAccount:async(op)=>{ops.push(op);return invitation;}});
 await svc.command({honIdentity:{externalSubject:'manager'}},'end',{schoolId:ids.schoolId,invitationId:ids.invitationId,confirmation:c.FAMILY_ACCESS_END_CONFIRMATION},randomUUID());
 await assert.rejects(()=>svc.command({honIdentity:{externalSubject:'manager'}},'end',{schoolId:ids.schoolId,invitationId:ids.invitationId},randomUUID()),e=>e.status===400);
 assert.deepEqual(ops,['end']);
 const service=new SchoolFamilyAccessInvitationService({callSchoolFamilyAccount:async()=>Array.from({length:51},()=>invitation)});
 await assert.rejects(()=>service.list({honIdentity:{externalSubject:'manager'}},ids.schoolId),e=>e.status===503);
});
