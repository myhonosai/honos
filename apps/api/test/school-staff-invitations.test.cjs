const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto');
const {SchoolStaffInvitationService}=require('../dist/accounts/school-staff-invitation.service.js');
const {SchoolStaffAccountHumanGuard}=require('../dist/accounts/school-staff-invitation.controller.js');
const c=require('@hon/contracts'),auth=require('@hon/auth');
const ids={invitationId:randomUUID(),schoolId:randomUUID(),roleId:randomUUID()},t=randomBytes(32).toString('base64url');
const receipt={...ids,accountStatus:'STAFF_ROLE_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false};
const invitation={...ids,roleName:'Front desk',email:'staff@example.invalid',expiresAt:new Date().toISOString(),status:'PENDING'};
test('closed staff request/response: no organization, principal, permission list or financial effect can be supplied',()=>{
 const input={schoolId:ids.schoolId,roleId:ids.roleId,email:'staff@example.invalid',ttlHours:24,token:t};
 assert.deepEqual(c.validateStaffInvitationInput(input),input);
 for(const patch of [{organizationId:randomUUID()},{role:'OWNER'},{permissionCodes:['iam.staff_role.grant']},{principalId:randomUUID()},{ttlHours:169},{ttlHours:0},{token:'short'},{email:' Staff@example.invalid'},{roleId:'OWNER'}])
  assert.throws(()=>c.validateStaffInvitationInput({...input,...patch}));
 assert.deepEqual(c.validateStaffInvitationRevoke({schoolId:ids.schoolId,invitationId:ids.invitationId}),{schoolId:ids.schoolId,invitationId:ids.invitationId});
 assert.throws(()=>c.validateStaffInvitationRevoke({invitationId:ids.invitationId}));
 assert.deepEqual(c.validateStaffAccountReceipt(receipt),receipt);
 for(const k of ['accessGranted','billingActivated','aiCreditsGranted'])assert.throws(()=>c.validateStaffAccountReceipt({...receipt,[k]:true}));
 assert.throws(()=>c.validateStaffAccountReceipt({...receipt,accountStatus:'OWNER_BOUND'}));
 assert.deepEqual(c.validateStaffInvitation(invitation),invitation);
 for(const patch of [{status:'ACTIVE'},{tokenHash:'x'},{roleName:''},{expiresAt:'soon'}])assert.throws(()=>c.validateStaffInvitation({...invitation,...patch}));
 assert.throws(()=>c.validateStaffInvitationAcceptance({invitationId:ids.invitationId,token:t,confirmation:c.OWNER_INVITATION_CONFIRMATION}));
});
test('staff acceptance takes subject and verified email only from the signed OIDC cookie; token hashed before SQL',async()=>{
 const saved={...process.env};try{
 Object.assign(process.env,{HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:'s2-unit',HON_SESSION_JWT_SECRET:randomBytes(32).toString('hex'),HON_SESSION_VERIFIED_EMAIL_ENABLED:'true'});
 const config=auth.sessionConfig(),calls=[],service=new SchoolStaffInvitationService({callSchoolStaffAccount:async(...args)=>{calls.push(args);return receipt;}});
 const identity={externalSubject:'oidc:fixture:staff',email:'staff@example.invalid'};
 const req=proof=>({honIdentity:identity,headers:{cookie:auth.HON_SESSION_COOKIE+'='+auth.issueSession({...identity,...proof},config)}});
 const body={invitationId:ids.invitationId,token:t,confirmation:c.STAFF_INVITATION_CONFIRMATION};
 await assert.rejects(()=>service.command(req({}),'accept',body,randomUUID()),e=>e.status===403);assert.equal(calls.length,0);
 await service.command(req({emailVerified:true}),'accept',body,randomUUID());
 assert.equal(calls[0][0],'accept');assert.equal(calls[0][1][0],identity.externalSubject);assert.equal(calls[0][1][1],identity.email);
 const sent=JSON.parse(calls[0][1][2]);assert.equal(sent.tokenHash,createHash('sha256').update(t).digest('hex'));assert(!JSON.stringify(calls).includes(t));
 }finally{process.env=saved;}
});
test('staff human guard requires its own command header and denies forged context, cross-origin, authority headers and queries',()=>{
 const saved={...process.env};process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const guard=new SchoolStaffAccountHumanGuard(),headers={origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','content-type':'application/json','x-hon-human-command':c.STAFF_ACCOUNT_HUMAN_COMMAND};
 const check=patch=>{const set={};const r={method:'POST',headers:{...headers},query:{},originalUrl:'/v1/school/staff-invitations',...patch};assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>r,getResponse:()=>({setHeader:(k,v)=>set[k]=v})})}),true);assert.equal(set['Cache-Control'],'private, no-store');};
 try{check({});for(const patch of [{source:'AI'},{schoolId:ids.schoolId},{headers:{...headers,origin:'https://evil.invalid'}},{headers:{...headers,'x-hon-human-command':'school-owner-account'}},{headers:{...headers,'x-hon-school-id':ids.schoolId}},{headers:{...headers,authorization:'Bearer x'}},{originalUrl:'/?x=1'},{honIdentity:{externalSubject:'x',role:'OWNER'}}])assert.throws(()=>check(patch));}finally{process.env=saved;}
});
test('database denials map to closed codes and redact SQL; busy is recoverable',async()=>{
 for(const [code,status]of [['42501',403],['P0002',404],['23505',409],['23514',409],['55P03',503],['22023',400],['XX000',503]]){let calls=0;const service=new SchoolStaffInvitationService({callSchoolStaffAccount:async()=>{calls++;throw Object.assign(new Error('SECRET SQL'),{code});}});
 await assert.rejects(()=>service.command({honIdentity:{externalSubject:'manager'}},'revoke',{schoolId:ids.schoolId,invitationId:ids.invitationId},randomUUID()),e=>e.status===status&&!JSON.stringify(e).includes('SECRET'));assert.equal(calls,1);}
 const service=new SchoolStaffInvitationService({callSchoolStaffAccount:async()=>Array.from({length:51},()=>invitation)});
 await assert.rejects(()=>service.list({honIdentity:{externalSubject:'manager'}},ids.schoolId),e=>e.status===503);
});
