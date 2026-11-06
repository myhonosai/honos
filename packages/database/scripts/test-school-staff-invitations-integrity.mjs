/** Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL. No provider, no email sending. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {pauseSchoolAccountAuthorityAutovacuum} from './school-account-security.mjs';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolStaffInvitationService}=require('./dist/accounts/school-staff-invitation.service.js');
const {SchoolStaffInvitationController,SchoolStaffAccountHumanGuard}=require('./dist/accounts/school-staff-invitation.controller.js');
const {STAFF_INVITATION_CONFIRMATION,STAFF_ACCOUNT_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'s2-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS S2-STAFF '+(++groups)+' '+name);
const hash=x=>createHash('sha256').update(x).digest('hex');
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=(label)=>({externalSubject:'oidc:s2:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':STAFF_ACCOUNT_HUMAN_COMMAND,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const receipt=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
const tables=['users','principals','principal_role_grants','family_access_grants','school_staff_invitations','school_account_requests','school_staff_account_events'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status){const before=await counts();const r=await work();assert.equal(r.status,status,JSON.stringify(r.body));assert.deepEqual(await counts(),before);assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/tokenHash|external_subject|SQLSTATE|SELECT /));return r;}
const tokenOf=()=>randomBytes(32).toString('base64url');
const invite=(schoolId,roleId,email,extra={})=>({schoolId,roleId,email,ttlHours:24,token:tokenOf(),...extra});
const accept=(i,token)=>({invitationId:i.invitationId,token,confirmation:STAFF_INVITATION_CONFIRMATION});

async function human(identity,label){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER',$3)",[principal,user,label]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval \'1 minute\') RETURNING id',[o.organizationId,o.schoolId,principal,role]))[0].id;
const has=async(identity,o,perm)=>(await restricted.query('SELECT * FROM hon.resolve_authorized_scope($1,$2,$3)',[identity.externalSubject,o.schoolId,perm])).rowCount===1;

let restoreAutovacuum=async()=>{};
try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect()]);
 restoreAutovacuum=await pauseSchoolAccountAuthorityAutovacuum(admin);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['school_staff_invitations','school_staff_account_events']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%school_staff%')");
 assert.equal(fns.length,11);
 for(const f of fns){const entry=['manage_school_staff_invitation','accept_school_staff_invitation','read_school_staff_invitations','read_school_staff_invitation_roles'].includes(f.proname);
  assert.equal(f.prosecdef,entry,f.proname);assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry,f.proname);}
 pass('forced deny-all RLS on new custody tables; runtime executes exactly the four fixed entry points (three from 0204, role discovery from 0207)');

 // Fixture: two HQ-provisioned schools (each bootstraps an OWNER), a dedicated staff manager, roles.
 const hq={subject:'s2-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'S2 synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'S2 synthetic','S2 synthetic','S2 school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'s2-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 // Staff provisioning follows paid access: give both synthetic organizations a live entitlement window.
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const ownerRoleA=(await q("SELECT id FROM hon.roles WHERE organization_id=$1 AND code='OWNER' AND is_system_role",[A.organizationId]))[0].id;
 const manager=person('manager'),managerPrincipal=await human(manager,'S2 manager');
 const managerRole=await customRole(A,'CUSTOM_STAFF_MANAGER',['iam.staff_role.manage','iam.staff_role.grant','school.view','family.read']);
 const managerGrant=await grant(A,managerPrincipal,managerRole);
 const frontDesk=await customRole(A,'CUSTOM_FRONT_DESK',['school.view','family.read']);
 const escalation=await customRole(A,'CUSTOM_ESCALATION',['school.view','family.member.manage']); // manager lacks family.member.manage
 const managerB=person('manager-b'),managerBPrincipal=await human(managerB,'S2 manager B');
 const managerRoleB=await customRole(B,'CUSTOM_STAFF_MANAGER',['iam.staff_role.manage','iam.staff_role.grant','school.view']);
 await grant(B,managerBPrincipal,managerRoleB);const roleB=await customRole(B,'CUSTOM_FRONT_DESK',['school.view']);
 const outsider=person('outsider');await human(outsider,'S2 outsider');
 const fam=(await q("INSERT INTO hon.families(organization_id,school_id,display_name) VALUES($1,$2,'S2 family') RETURNING id",[A.organizationId,A.schoolId]))[0].id;
 const module=await Test.createTestingModule({controllers:[SchoolStaffInvitationController],providers:[SchoolStaffInvitationService,SchoolStaffAccountHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 // organization_entitlements is edited by this proof itself (9b) and checked field by field at the end.
 const excluded=new Set([...tables,'organization_entitlements']);
 const entitlementState=async()=>q('SELECT organization_id,tier,status,effective_from,effective_until FROM hon.organization_entitlements ORDER BY organization_id');const entitlementBaseline=await entitlementState();
 const others=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).map(r=>r.tablename).filter(t=>!excluded.has(t));
 const snapshot=async()=>{const out={};for(const t of others){assert.match(t,/^[a-z_0-9]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};const baseline=await snapshot();

 // 2. Invite: exact retry, changed-key conflict, token never echoed.
 const staffA=person('staff-a'),inputA=invite(A.schoolId,frontDesk,staffA.email),key=K();
 const invA=receipt(await send('school/staff-invitations',{identity:manager,body:inputA,key}));
 assert.equal(invA.status,'PENDING');assert.equal(invA.schoolId,A.schoolId);assert.equal(invA.roleId,frontDesk);assert.equal(invA.roleName,'FRONT_DESK');
 assert(!JSON.stringify(invA).includes(inputA.token));assert.equal((await q('SELECT token_hash FROM hon.school_staff_invitations WHERE id=$1',[invA.invitationId]))[0].token_hash,hash(inputA.token));
 assert.deepEqual(receipt(await send('school/staff-invitations',{identity:manager,body:inputA,key})),invA);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:{...inputA,email:'changed-'+K()+'@example.invalid'},key}),409);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,frontDesk,staffA.email)}),409);
 pass('staff manager invites one email to one custom role at the exact school; hashed token custody, exact retry, changed-key and duplicate-pending conflicts');

 // 3. Authority and escalation refusals.
 await denied(()=>send('school/staff-invitations',{identity:outsider,body:invite(A.schoolId,frontDesk,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/staff-invitations',{identity:managerB,body:invite(A.schoolId,frontDesk,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(B.schoolId,roleB,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,roleB,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,ownerRoleA,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,escalation,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,managerRole,'x-'+K()+'@example.invalid',{ttlHours:169})}),400);
 for(const patch of [{organizationId:A.organizationId},{principalId:K()},{role:'OWNER'},{activate:true}])await denied(()=>send('school/staff-invitations',{identity:manager,body:{...invite(A.schoolId,frontDesk,'x-'+K()+'@example.invalid'),...patch}}),400);
 await assert.rejects(()=>restricted.query("SELECT hon.manage_school_staff_invitation($1,'INVITE',$2::jsonb,$3)",[manager.externalSubject,{schoolId:A.schoolId,roleId:frontDesk,email:'raw-'+K()+'@example.invalid',ttlHours:24,tokenHash:hash('x'),organizationId:B.organizationId},K()]),e=>e.code==='22023');
 pass('no grant, other-school manager, other-school role, OWNER/system role and roles holding permissions the issuer lacks are refused atomically; closed input');

 // 4. Busy envelope: valid callers get a recoverable busy; unauthorized callers are denied first.
 await blocker.query('BEGIN');
 try{
  await blocker.query('LOCK TABLE hon.principal_role_grants IN SHARE ROW EXCLUSIVE MODE');
  await denied(()=>send('school/staff-invitations',{identity:outsider,body:invite(A.schoolId,frontDesk,'busy-'+K()+'@example.invalid')}),403);
  await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,frontDesk,'busy-'+K()+'@example.invalid')}),503);
 }finally{await blocker.query('ROLLBACK');}
 pass('IAM authority envelope: unauthorized denied before contended locks; authorized callers get explicit recoverable busy, no partial writes');

 // 4b. Role discovery (0207): exactly the roles this manager may invite into at this school, nothing else, no writes.
 const rolesPath=o=>'school/schools/'+o.schoolId+'/staff-invitation-roles';
 const expectedRoles=async(principal,o)=>(await q('SELECT r.id FROM hon.roles r WHERE r.organization_id=$1 AND hon.school_staff_role_grantable($2,$1,$3,r.id) ORDER BY r.name,r.id',[o.organizationId,principal,o.schoolId])).map(r=>r.id);
 {
  const before=await counts();const found=receipt(await send(rolesPath(A),{identity:manager,method:'GET'}));assert.deepEqual(await counts(),before);
  assert.equal(found.truncated,false);assert.deepEqual(found.roles.map(r=>r.roleId),await expectedRoles(managerPrincipal,A));
  const ids=found.roles.map(r=>r.roleId);assert(ids.includes(frontDesk));for(const bad of [escalation,ownerRoleA,roleB,managerRoleB])assert(!ids.includes(bad));
  const fd=found.roles.find(r=>r.roleId===frontDesk);assert.equal(fd.roleName,'FRONT_DESK');assert.deepEqual(fd.permissionCodes,['family.read','school.view']);
  assert.deepEqual(receipt(await send(rolesPath(B),{identity:managerB,method:'GET'})).roles.map(r=>r.roleId),await expectedRoles(managerBPrincipal,B));
  await denied(()=>send(rolesPath(A),{identity:outsider,method:'GET'}),403);
  await denied(()=>send(rolesPath(A),{identity:managerB,method:'GET'}),403);
  await denied(()=>send(rolesPath(B),{identity:manager,method:'GET'}),403);
  await denied(()=>send('school/schools/not-a-uuid/staff-invitation-roles',{identity:manager,method:'GET'}),400);
  await denied(()=>send(rolesPath(A)+'?schoolId='+B.schoolId,{identity:manager,method:'GET'}),400);
  await assert.rejects(()=>restricted.query('SELECT hon.read_school_staff_invitation_roles($1,$2)',[null,A.schoolId]),e=>e.code==='42501');
  await assert.rejects(()=>restricted.query('SELECT hon.read_school_staff_invitation_roles($1,$2)',['oidc:unknown:'+K(),A.schoolId]),e=>e.code==='42501');
  // A role that gains a permission the manager lacks drops out; removing it restores the role.
  await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[frontDesk,A.organizationId,'family.member.manage']);
  assert(!receipt(await send(rolesPath(A),{identity:manager,method:'GET'})).roles.some(r=>r.roleId===frontDesk));
  await q("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='family.member.manage'",[frontDesk]);
  assert(receipt(await send(rolesPath(A),{identity:manager,method:'GET'})).roles.some(r=>r.roleId===frontDesk));
  // Paid access fails closed for discovery too.
  const ent=(await q('SELECT status FROM hon.organization_entitlements WHERE organization_id=$1',[A.organizationId]))[0];
  await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
  try{await denied(()=>send(rolesPath(A),{identity:manager,method:'GET'}),403);}finally{await q('UPDATE hon.organization_entitlements SET status=$2 WHERE organization_id=$1',[A.organizationId,ent.status]);}
  // Bounded: more than 100 eligible roles returns the first 100 by name with truncated=true.
  const bulk=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) SELECT $1,$2,'CUSTOM_BULK_'||lpad(g::text,3,'0'),'BULK '||lpad(g::text,3,'0') FROM generate_series(1,101) g RETURNING id",[B.organizationId,B.schoolId])).map(r=>r.id);
  try{
   await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT id,$2,'school.view' FROM unnest($1::uuid[]) id",[bulk,B.organizationId]);
   const big=receipt(await send(rolesPath(B),{identity:managerB,method:'GET'}));
   assert.equal(big.truncated,true);assert.equal(big.roles.length,100);assert.deepEqual(big.roles.map(r=>r.roleId),(await expectedRoles(managerBPrincipal,B)).slice(0,100));
  }finally{await q('DELETE FROM hon.role_permissions WHERE role_id=ANY($1::uuid[])',[bulk]);await q('DELETE FROM hon.roles WHERE id=ANY($1::uuid[])',[bulk]);}
 }
 pass('role discovery returns exactly the roles this manager may invite into at this exact school (same grantable rule, ordered, <=100 with truncated flag); outsiders, other-school managers, unknown subjects and suspended organizations are refused; read-only');

 // 5. Acceptance refusals.
 for(const [identity,body]of [[person('wrong-email'),accept(invA,inputA.token)],[staffA,accept(invA,tokenOf())],[{...staffA,emailVerified:undefined},accept(invA,inputA.token)]])
  await denied(()=>send('account/staff-invitations/accept',{identity,body}),403);
 await denied(()=>send('account/staff-invitations/accept',{identity:staffA,body:accept(invA,inputA.token),headers:{cookie:HON_SESSION_COOKIE+'='+issueSession(staffA,{...session,emitVerifiedEmail:false})}}),403);
 pass('acceptance requires the signed verified email and the exact token; wrong identity, token or unverified email fail closed without records');

 // 6. Acceptance creates exactly one identity + one role grant at the exact school.
 assert.equal(await has(staffA,A,'school.view'),false);
 const acceptKey=K(),bodyA=accept(invA,inputA.token);
 const acc=receipt(await send('account/staff-invitations/accept',{identity:staffA,body:bodyA,key:acceptKey}));
 assert.deepEqual(acc,{invitationId:invA.invitationId,schoolId:A.schoolId,roleId:frontDesk,accountStatus:'STAFF_ROLE_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false});
 assert.equal(await has(staffA,A,'school.view'),true);assert.equal(await has(staffA,A,'family.member.manage'),false);assert.equal(await has(staffA,B,'school.view'),false);
 const g=(await q('SELECT g.* FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1',[staffA.externalSubject]));
 assert.equal(g.length,1);assert.equal(g[0].role_id,frontDesk);assert.equal(g[0].school_id,A.schoolId);assert.equal(g[0].granted_by_principal_id,managerPrincipal);assert.equal(g[0].effective_until,null);
 assert.deepEqual(receipt(await send('account/staff-invitations/accept',{identity:staffA,body:bodyA,key:acceptKey})),acc);
 await denied(()=>send('account/staff-invitations/accept',{identity:staffA,body:bodyA}),403);
 await denied(()=>send('school/staff-invitations/revoke',{identity:manager,body:{schoolId:A.schoolId,invitationId:invA.invitationId}}),409);
 pass('verified acceptance creates one identity and exactly the invited role at the exact school (no other school, no extra permission); single use, exact replay, accepted invitations are final');

 // 7. Issuer authority is re-proven at acceptance.
 const staffC=person('staff-c'),inputC=invite(A.schoolId,frontDesk,staffC.email);const invC=receipt(await send('school/staff-invitations',{identity:manager,body:inputC}));
 await q('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp(),revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[managerGrant]);
 await denied(()=>send('account/staff-invitations/accept',{identity:staffC,body:accept(invC,inputC.token)}),403);
 const managerGrant2=await grant(A,managerPrincipal,managerRole);
 const staffD=person('staff-d'),inputD=invite(A.schoolId,frontDesk,staffD.email);const invD=receipt(await send('school/staff-invitations',{identity:manager,body:inputD}));
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'family.member.manage')",[frontDesk,A.organizationId]);
 await denied(()=>send('account/staff-invitations/accept',{identity:staffD,body:accept(invD,inputD.token)}),403);
 await q("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='family.member.manage'",[frontDesk]);
 assert.equal(receipt(await send('account/staff-invitations/accept',{identity:staffD,body:accept(invD,inputD.token)})).accountStatus,'STAFF_ROLE_BOUND');
 pass('a revoked issuer, or a role that gained a permission the issuer lacks, makes an outstanding invitation unusable; restoring authority restores it');
 void managerGrant2;

 // 8. Identity safety: never merge by email; clean existing identity reuses its principal; family/HQ identities need review.
 const collide=person('collide');await human(collide,'S2 existing');
 const inputE=invite(A.schoolId,frontDesk,collide.email);const invE=receipt(await send('school/staff-invitations',{identity:manager,body:inputE}));
 await denied(()=>send('account/staff-invitations/accept',{identity:{...collide,externalSubject:'oidc:s2:other:'+K()},body:accept(invE,inputE.token)}),409);
 const existingPrincipal=(await q('SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1',[collide.externalSubject]))[0].id;
 receipt(await send('account/staff-invitations/accept',{identity:collide,body:accept(invE,inputE.token)}));
 assert.equal((await q('SELECT count(*) n FROM hon.principal_role_grants WHERE principal_id=$1',[existingPrincipal]))[0].n,'1');
 const parent=person('parent');const parentPrincipal=await human(parent,'S2 parent');
 await q("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id) VALUES($1,$2,$3,$4,(enum_range(NULL::hon.family_access_level))[1],$5)",[A.organizationId,A.schoolId,fam,parentPrincipal,managerPrincipal]);
 const inputP=invite(A.schoolId,frontDesk,parent.email);const invP=receipt(await send('school/staff-invitations',{identity:manager,body:inputP}));
 await denied(()=>send('account/staff-invitations/accept',{identity:parent,body:accept(invP,inputP.token)}),409);
 const inputSelf=invite(A.schoolId,frontDesk,manager.email);const invSelf=receipt(await send('school/staff-invitations',{identity:manager,body:inputSelf}));
 await denied(()=>send('account/staff-invitations/accept',{identity:manager,body:accept(invSelf,inputSelf.token)}),409);
 pass('never links by email alone; a clean existing identity keeps its one principal; family, self and already-granted identities require review');

 // 9. Revoke and expiry.
 const staffR=person('staff-r'),inputR=invite(A.schoolId,frontDesk,staffR.email);const invR=receipt(await send('school/staff-invitations',{identity:manager,body:inputR}));
 await denied(()=>send('school/staff-invitations/revoke',{identity:managerB,body:{schoolId:B.schoolId,invitationId:invR.invitationId}}),404);
 const rev=receipt(await send('school/staff-invitations/revoke',{identity:manager,body:{schoolId:A.schoolId,invitationId:invR.invitationId}}));assert.equal(rev.status,'REVOKED');
 await denied(()=>send('account/staff-invitations/accept',{identity:staffR,body:accept(invR,inputR.token)}),403);
 const staffX=person('staff-x'),inputX=invite(A.schoolId,frontDesk,staffX.email,{ttlHours:1});const invX=receipt(await send('school/staff-invitations',{identity:manager,body:inputX}));
 await admin.query('BEGIN');await admin.query("ALTER TABLE hon.school_staff_invitations DISABLE TRIGGER immutable");
 await admin.query("UPDATE hon.school_staff_invitations SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours' WHERE id=$1",[invX.invitationId]);
 await admin.query("ALTER TABLE hon.school_staff_invitations ENABLE TRIGGER immutable");await admin.query('COMMIT');
 await denied(()=>send('account/staff-invitations/accept',{identity:staffX,body:accept(invX,inputX.token)}),403);
 pass('exact-school revoke (other school sees not-found), revoked and expired invitations cannot be accepted');

 // 9b. Paid access: a suspended organization cannot invite or list, and an outstanding invitation cannot be accepted.
 const staffS=person('staff-s'),inputS=invite(A.schoolId,frontDesk,staffS.email);const invS=receipt(await send('school/staff-invitations',{identity:manager,body:inputS}));
 const entitlement=(await q('SELECT status,effective_from,effective_until FROM hon.organization_entitlements WHERE organization_id=$1',[A.organizationId]))[0];
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>send('school/staff-invitations',{identity:manager,body:invite(A.schoolId,frontDesk,'susp-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/schools/'+A.schoolId+'/staff-invitations',{identity:manager,method:'GET'}),403);
 await denied(()=>send('account/staff-invitations/accept',{identity:staffS,body:accept(invS,inputS.token)}),403);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>send('account/staff-invitations/accept',{identity:staffS,body:accept(invS,inputS.token)}),403);
 await q('UPDATE hon.organization_entitlements SET status=$2,effective_from=$3,effective_until=$4 WHERE organization_id=$1',[A.organizationId,entitlement.status,entitlement.effective_from,entitlement.effective_until]);
 assert.equal(receipt(await send('account/staff-invitations/accept',{identity:staffS,body:accept(invS,inputS.token)})).accountStatus,'STAFF_ROLE_BOUND');
 pass('paid access fails closed: a suspended or lapsed organization cannot invite, list or complete an outstanding invitation; restored access completes it');

 // 9c. Authority that expires between verification and the evidence write fails closed (deterministic clock barrier).
 // Fixture-only: the evidence INSERT waits until a pinned instant T has passed. Authority is set to expire exactly at T,
 // so every pre-write check sees it live and only a check made after the evidence write can see it expired.
 await q('CREATE TABLE public.s2_clock_barrier_at(until timestamptz)');await q('INSERT INTO public.s2_clock_barrier_at VALUES(NULL)');
 await q(`CREATE FUNCTION public.s2_clock_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  DECLARE u timestamptz; BEGIN SELECT until INTO u FROM public.s2_clock_barrier_at;
  IF u IS NOT NULL THEN PERFORM pg_sleep(greatest(0,extract(epoch FROM u-clock_timestamp()))+0.02); END IF; RETURN NEW; END $$`);
 await q('CREATE TRIGGER s2_clock_barrier BEFORE INSERT ON hon.school_staff_account_events FOR EACH ROW EXECUTE FUNCTION public.s2_clock_barrier()');
 const boundary=person('boundary'),boundaryPrincipal=await human(boundary,'S2 boundary manager');const boundaryGrant=await grant(A,boundaryPrincipal,managerRole);
 const pin=async()=>{const t=(await q("SELECT clock_timestamp()+interval '1500 milliseconds' t"))[0].t;await q('UPDATE public.s2_clock_barrier_at SET until=$1',[t]);return t;};
 const unpin=()=>q('UPDATE public.s2_clock_barrier_at SET until=NULL');
 // The call must reach the barrier (evidence write) before failing: it returns only after T.
 const atBoundary=async(t,work)=>{const r=await denied(work,403);assert(Date.now()>=t.getTime(),'refused before the evidence write');return r;};
 try{
  let t=await pin();
  const ctl=receipt(await send('school/staff-invitations',{identity:boundary,body:invite(A.schoolId,frontDesk,'ctl-'+K()+'@example.invalid')}));
  assert(Date.now()>=t.getTime());assert.equal(ctl.status,'PENDING');await unpin();
  // INVITE: the manager grant expires at T.
  t=await pin();await q('UPDATE hon.principal_role_grants SET effective_until=$2 WHERE id=$1',[boundaryGrant,t]);
  const lateKey=K(),lateInput=invite(A.schoolId,frontDesk,'late-'+K()+'@example.invalid');
  await atBoundary(t,()=>send('school/staff-invitations',{identity:boundary,body:lateInput,key:lateKey}));
  await unpin();await q('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[boundaryGrant]);
  // REVOKE: the manager grant expires at T; the invitation stays PENDING.
  const staffV=person('staff-v'),inputV=invite(A.schoolId,frontDesk,staffV.email);const invV=receipt(await send('school/staff-invitations',{identity:boundary,body:inputV}));
  t=await pin();await q('UPDATE hon.principal_role_grants SET effective_until=$2 WHERE id=$1',[boundaryGrant,t]);
  await atBoundary(t,()=>send('school/staff-invitations/revoke',{identity:boundary,body:{schoolId:A.schoolId,invitationId:invV.invitationId}}));
  assert.equal((await q('SELECT status FROM hon.school_staff_invitations WHERE id=$1',[invV.invitationId]))[0].status,'PENDING');
  // ACCEPT: the issuer's grant expires at T; no identity, role grant or evidence survives.
  await atBoundary(t=await pin().then(async t=>{await q('UPDATE hon.principal_role_grants SET effective_until=$2 WHERE id=$1',[boundaryGrant,t]);return t;}),()=>send('account/staff-invitations/accept',{identity:staffV,body:accept(invV,inputV.token)}));
  await unpin();await q('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[boundaryGrant]);
  assert.equal((await q('SELECT count(*) n FROM hon.users WHERE external_subject=$1',[staffV.externalSubject]))[0].n,'0');
  // ACCEPT: the organization's paid access ends at T.
  const ent=(await q('SELECT effective_until FROM hon.organization_entitlements WHERE organization_id=$1',[A.organizationId]))[0].effective_until;
  t=await pin();await q('UPDATE hon.organization_entitlements SET effective_until=$2 WHERE organization_id=$1',[A.organizationId,t]);
  await atBoundary(t,()=>send('account/staff-invitations/accept',{identity:staffV,body:accept(invV,inputV.token)}));
  await unpin();await q('UPDATE hon.organization_entitlements SET effective_until=$2 WHERE organization_id=$1',[A.organizationId,ent]);
  // ACCEPT: the invitation itself expires at T.
  const staffW=person('staff-w'),inputW=invite(A.schoolId,frontDesk,staffW.email);const invW=receipt(await send('school/staff-invitations',{identity:boundary,body:inputW}));
  t=await pin();
  await admin.query('BEGIN');await admin.query('ALTER TABLE hon.school_staff_invitations DISABLE TRIGGER immutable');
  await admin.query('UPDATE hon.school_staff_invitations SET expires_at=$2 WHERE id=$1',[invW.invitationId,t]);
  await admin.query('ALTER TABLE hon.school_staff_invitations ENABLE TRIGGER immutable');await admin.query('COMMIT');
  await atBoundary(t,()=>send('account/staff-invitations/accept',{identity:staffW,body:accept(invW,inputW.token)}));
  await unpin();
  // Control: with authority intact the same barrier completes.
  t=await pin();assert.equal(receipt(await send('account/staff-invitations/accept',{identity:staffV,body:accept(invV,inputV.token)})).accountStatus,'STAFF_ROLE_BOUND');assert(Date.now()>=t.getTime());await unpin();
  // Replay after expiry: a stored INVITE response is not returned to a manager whose authority has ended.
  const replayKey=K(),replayInput=invite(A.schoolId,frontDesk,'replay-'+K()+'@example.invalid');receipt(await send('school/staff-invitations',{identity:boundary,body:replayInput,key:replayKey}));
  await q('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1',[boundaryGrant]);
  await denied(()=>send('school/staff-invitations',{identity:boundary,body:replayInput,key:replayKey}),403);
 }finally{
  await q('DROP TRIGGER s2_clock_barrier ON hon.school_staff_account_events');await q('DROP FUNCTION public.s2_clock_barrier()');await q('DROP TABLE public.s2_clock_barrier_at');
 }
 pass('authority (issuer grant, paid access, invitation expiry) that ends between verification and the evidence write fails closed with no identity, grant, invitation change or evidence; replay after expiry is refused');

 // 10. List and immutable evidence.
 const list=receipt(await send('school/schools/'+A.schoolId+'/staff-invitations',{identity:manager,method:'GET'}));
 assert(list.length>=6&&list.length<=50);assert(list.every(i=>i.schoolId===A.schoolId));assert(list.some(i=>i.status==='EXPIRED'));assert(list.some(i=>i.status==='REVOKED'));
 await denied(()=>send('school/schools/'+A.schoolId+'/staff-invitations',{identity:outsider,method:'GET'}),403);
 await denied(()=>send('school/schools/'+A.schoolId+'/staff-invitations',{identity:managerB,method:'GET'}),403);
 for(const sql of ['UPDATE hon.school_staff_account_events SET receipt=\'{}\'','DELETE FROM hon.school_staff_account_events','UPDATE hon.school_staff_invitations SET email=\'x@example.invalid\' WHERE status=\'ACCEPTED\'','UPDATE hon.school_staff_invitations SET status=\'PENDING\' WHERE status=\'REVOKED\''])
  await assert.rejects(()=>admin.query(sql),e=>/ACCOUNT_EVIDENCE_IMMUTABLE/.test(e.message));
 assert.equal((await q("SELECT count(*) n FROM hon.school_staff_account_events WHERE execution_allowed"))[0].n,'0');
 pass('manager-only exact-school list (<=50, derived EXPIRED); invitations and audit evidence are append-only and never dispatchable');

 assert.deepEqual(await snapshot(),baseline);assert.deepEqual(await entitlementState(),entitlementBaseline);
 pass('no entitlement, billing, credit, AI, CRM or outbox table changed: identity, role grant and private evidence only');
 console.log(`PASS: school staff invitations (${groups} groups)`);
}finally{await app?.close();await restoreAutovacuum().catch(()=>{});await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
