const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto');
const {SchoolOwnerInvitationService}=require('../dist/accounts/school-owner-invitation.service.js');
const {SchoolAccountHumanGuard}=require('../dist/accounts/school-owner-invitation.controller.js');
const c=require('@hon/contracts'),auth=require('@hon/auth');
const ids={invitationId:randomUUID(),organizationId:randomUUID(),schoolId:randomUUID()},t=randomBytes(32).toString('base64url');
const receipt={...ids,accountStatus:'OWNER_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false};
test('closed request/response never accept authority, financial effects or raw server tokens',()=>{
 const input={organizationId:ids.organizationId,schoolId:ids.schoolId,email:'owner@example.invalid',ttlHours:24,token:t};
 assert.deepEqual(c.validateOwnerInvitationInput(input),input);
 for(const patch of [{role:'OWNER'},{externalSubject:'other'},{ttlHours:169},{token:'short'},{email:' OWNER@example.invalid'}])assert.throws(()=>c.validateOwnerInvitationInput({...input,...patch}));
 assert.deepEqual(c.validateOwnerAccountReceipt(receipt),receipt);
 for(const k of ['accessGranted','billingActivated','aiCreditsGranted'])assert.throws(()=>c.validateOwnerAccountReceipt({...receipt,[k]:true}));
});
test('owner acceptance gets subject and verified email only from signed OIDC cookie; hashes token before SQL',async()=>{
 const saved={...process.env};try{
 Object.assign(process.env,{HON_AUTH_MODE:'OIDC',HON_SESSION_AUDIENCE:'p0-unit',HON_SESSION_JWT_SECRET:randomBytes(32).toString('hex')});
 const config=auth.sessionConfig(),calls=[],service=new SchoolOwnerInvitationService({callSchoolAccount:async(...args)=>{calls.push(args);return receipt;}});
 const identity={externalSubject:'oidc:fixture:owner',email:'owner@example.invalid'};
 const req=proof=>({honIdentity:identity,headers:{cookie:auth.HON_SESSION_COOKIE+'='+auth.issueSession({...identity,...proof},config)}});
 const body={invitationId:ids.invitationId,token:t,confirmation:c.OWNER_INVITATION_CONFIRMATION};
 await assert.rejects(()=>service.command(req({}),'accept',body,randomUUID()),e=>e.status===403);assert.equal(calls.length,0);
 await service.command(req({emailVerified:true}),'accept',body,randomUUID());
 assert.equal(calls[0][0],'accept');assert.equal(calls[0][1][0],identity.externalSubject);assert.equal(calls[0][1][1],identity.email);
 const sent=JSON.parse(calls[0][1][2]);assert.equal(sent.tokenHash,createHash('sha256').update(t).digest('hex'));assert(!JSON.stringify(calls).includes(t));
 }finally{process.env=saved;}
});
test('human guard denies forged context, cross-origin, authority headers and queries; no-store before identity guard',()=>{
 const saved={...process.env};process.env.HON_PUBLIC_ORIGIN='https://hon.example';
 const guard=new SchoolAccountHumanGuard(),headers={origin:'https://hon.example','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','content-type':'application/json','x-hon-human-command':'school-owner-account'};
 const check=patch=>{const set={};const r={method:'POST',headers:{...headers},query:{},originalUrl:'/v1/account/school-owner-invitations/accept',...patch};assert.equal(guard.canActivate({switchToHttp:()=>({getRequest:()=>r,getResponse:()=>({setHeader:(k,v)=>set[k]=v})})}),true);assert.equal(set['Cache-Control'],'private, no-store');};
 try{check({});for(const patch of [{source:'AI'},{headers:{...headers,origin:'https://evil.invalid'}},{headers:{...headers,'x-hon-school-id':ids.schoolId}},{originalUrl:'/?x=1'},{honIdentity:{externalSubject:'x',role:'OWNER'}}])assert.throws(()=>check(patch));}finally{process.env=saved;}
});
test('database denials redact internal SQL and token details; no fallback writes',async()=>{
 for(const [code,status]of [['42501',403],['23505',409],['55P03',503]]){let calls=0;const service=new SchoolOwnerInvitationService({callSchoolAccount:async()=>{calls++;throw Object.assign(new Error('SECRET SQL'),{code});}});
 await assert.rejects(()=>service.command({honIdentity:{externalSubject:'owner'}},'revoke',{invitationId:ids.invitationId},randomUUID()),e=>e.status===status&&!JSON.stringify(e).includes('SECRET'));assert.equal(calls,1);}
});

test('disposable proof loads actual built API classes from its API-anchored require independent of working directory',()=>{
 const {readFileSync}=require('node:fs'),{createRequire}=require('node:module'),{resolve}=require('node:path');
 const apiRoot=resolve(__dirname,'..'),apiRequire=createRequire(resolve(apiRoot,'package.json'));
 const source=readFileSync(resolve(apiRoot,'../../packages/database/scripts/test-school-owner-invitations-integrity.mjs'),'utf8');
 const specifiers=[...source.matchAll(/require\('([^']*dist\/[^']+)'\)/g)].map(m=>m[1]);
 assert.equal(specifiers.length,4);
 for(const specifier of specifiers){const file=apiRequire.resolve(specifier);assert(file.startsWith(apiRoot+'/dist/'));assert.equal(typeof apiRequire(specifier),'object');}
});
