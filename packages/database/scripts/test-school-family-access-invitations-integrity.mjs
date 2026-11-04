/** S2 parent/guardian linking. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL. No provider, no email sending. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {SchoolFamilyAccessInvitationService}=require('./dist/accounts/school-family-access-invitation.service.js');
const {SchoolFamilyAccessInvitationController,SchoolFamilyAccountHumanGuard}=require('./dist/accounts/school-family-access-invitation.controller.js');
const {FAMILY_ACCESS_INVITATION_CONFIRMATION,FAMILY_ACCESS_END_CONFIRMATION,FAMILY_ACCOUNT_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),blocker=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'s2-family-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS S2-FAMILY '+(++groups)+' '+name);
const hash=x=>createHash('sha256').update(x).digest('hex');
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=(label)=>({externalSubject:'oidc:s2f:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':FAMILY_ACCOUNT_HUMAN_COMMAND,'idempotency-key':key}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const receipt=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
const tables=['users','principals','principal_role_grants','family_access_grants','school_family_access_invitations','school_account_requests','school_family_account_events'];
const counts=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,(await q('SELECT count(*) n FROM hon.'+t))[0].n])));
async function denied(work,status){const before=await counts();const r=await work();assert.equal(r.status,status,JSON.stringify(r.body));assert.deepEqual(await counts(),before);assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/tokenHash|external_subject|SQLSTATE|SELECT /));return r;}
const tokenOf=()=>randomBytes(32).toString('base64url');
const invite=(schoolId,familyId,email,extra={})=>({schoolId,familyId,accessLevel:'SECONDARY_GUARDIAN',email,ttlHours:24,token:tokenOf(),...extra});
const accept=(i,token)=>({invitationId:i.invitationId,token,confirmation:FAMILY_ACCESS_INVITATION_CONFIRMATION});
const end=(schoolId,i)=>({schoolId,invitationId:i.invitationId,confirmation:FAMILY_ACCESS_END_CONFIRMATION});

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
const scope=async(identity,o)=>(await restricted.query('SELECT family_id::text f,access_level::text a FROM hon.resolve_parent_family_scope($1,$2) ORDER BY 1',[identity.externalSubject,o.schoolId])).rows;
const has=async(identity,o,perm)=>(await restricted.query('SELECT * FROM hon.resolve_authorized_scope($1,$2,$3)',[identity.externalSubject,o.schoolId,perm])).rowCount===1;

try{
 await Promise.all([admin.connect(),restricted.connect(),blocker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Custody and exact runtime ACL.
 for(const t of ['school_family_access_invitations','school_family_account_events']){
  const c=(await q('SELECT relrowsecurity rls,relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['hon.'+t]))[0];assert(c.rls&&c.forced);
  assert.equal((await q("SELECT count(*) n FROM pg_policies WHERE schemaname='hon' AND tablename=$1",[t]))[0].n,'0');
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+':'+p);
 }
 const fns=await q("SELECT p.oid,p.proname,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%school_family%')");
 assert.equal(fns.length,9);
 for(const f of fns){const entry=['manage_school_family_access_invitation','accept_school_family_access_invitation','read_school_family_access_invitations'].includes(f.proname);
  assert.equal(f.prosecdef,entry,f.proname);assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entry,f.proname);}
 pass('forced deny-all RLS on new custody tables; runtime executes exactly the three fixed entry points');

 // Fixture: two HQ-provisioned schools, a family manager per school, front-desk staff without family authority, families.
 const hq={subject:'s2f-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'S2F synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'S2F synthetic','S2F synthetic','S2F school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'s2f-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager'),managerPrincipal=await human(manager,'S2F manager');
 const managerRole=await customRole(A,'CUSTOM_FAMILY_MANAGER',['school.view','family.read','family.member.manage']);
 const managerGrant=await grant(A,managerPrincipal,managerRole);
 const desk=person('desk'),deskPrincipal=await human(desk,'S2F desk');
 const deskRole=await customRole(A,'CUSTOM_FRONT_DESK',['school.view','family.read']);await grant(A,deskPrincipal,deskRole);
 const managerB=person('manager-b'),managerBPrincipal=await human(managerB,'S2F manager B');
 await grant(B,managerBPrincipal,await customRole(B,'CUSTOM_FAMILY_MANAGER',['school.view','family.read','family.member.manage']));
 const outsider=person('outsider');await human(outsider,'S2F outsider');
 const family=async(o,name,status='ACTIVE')=>(await q("INSERT INTO hon.families(organization_id,school_id,display_name,status) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,name,status]))[0].id;
 const famA=await family(A,'S2F Rivera family'),famA2=await family(A,'S2F Okafor family'),famArchived=await family(A,'S2F archived family','ARCHIVED'),famB=await family(B,'S2F other school family');
 const module=await Test.createTestingModule({controllers:[SchoolFamilyAccessInvitationController],providers:[SchoolFamilyAccessInvitationService,SchoolFamilyAccountHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 // organization_entitlements (9b) and families (7) are edited by this proof itself and checked field by field at the end.
 const excluded=new Set([...tables,'organization_entitlements','families']);
 const entitlementState=async()=>q('SELECT organization_id,tier,status,effective_from,effective_until FROM hon.organization_entitlements ORDER BY organization_id');const entitlementBaseline=await entitlementState();
 const familyState=async()=>q('SELECT id,organization_id,school_id,display_name,status FROM hon.families ORDER BY id');const familyBaseline=await familyState();
 const others=(await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).map(r=>r.tablename).filter(t=>!excluded.has(t));
 const snapshot=async()=>{const out={};for(const t of others){assert.match(t,/^[a-z_0-9]+$/);out[t]=hash(JSON.stringify(await q('SELECT to_jsonb(t)::text r FROM hon.'+t+' t ORDER BY 1')));}return out;};const baseline=await snapshot();

 // 2. Invite: exact retry, changed-key conflict, duplicate pending, token never echoed.
 const parentA=person('parent-a'),inputA=invite(A.schoolId,famA,parentA.email),key=K();
 const invA=receipt(await send('school/family-access-invitations',{identity:manager,body:inputA,key}));
 assert.deepEqual({...invA,invitationId:undefined,expiresAt:undefined},{invitationId:undefined,expiresAt:undefined,schoolId:A.schoolId,familyId:famA,familyName:'S2F Rivera family',accessLevel:'SECONDARY_GUARDIAN',email:parentA.email,status:'PENDING'});
 assert(!JSON.stringify(invA).includes(inputA.token));assert.equal((await q('SELECT token_hash FROM hon.school_family_access_invitations WHERE id=$1',[invA.invitationId]))[0].token_hash,hash(inputA.token));
 assert.deepEqual(receipt(await send('school/family-access-invitations',{identity:manager,body:inputA,key})),invA);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:{...inputA,email:'changed-'+K()+'@example.invalid'},key}),409);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(A.schoolId,famA,parentA.email)}),409);
 pass('family manager invites one email to one active family at the exact school; hashed token custody, exact retry, changed-key and duplicate-pending conflicts');

 // 3. Authority and scope refusals.
 await denied(()=>send('school/family-access-invitations',{identity:outsider,body:invite(A.schoolId,famA,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/family-access-invitations',{identity:desk,body:invite(A.schoolId,famA,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/family-access-invitations',{identity:managerB,body:invite(A.schoolId,famA,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(B.schoolId,famB,'x-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(A.schoolId,famB,'x-'+K()+'@example.invalid')}),404);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(A.schoolId,famArchived,'x-'+K()+'@example.invalid')}),404);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(A.schoolId,K(),'x-'+K()+'@example.invalid')}),404);
 for(const patch of [{accessLevel:'OWNER'},{ttlHours:169},{organizationId:A.organizationId},{principalId:K()},{studentId:K()},{role:'OWNER'}])
  await denied(()=>send('school/family-access-invitations',{identity:manager,body:{...invite(A.schoolId,famA2,'x-'+K()+'@example.invalid'),...patch}}),400);
 await assert.rejects(()=>restricted.query("SELECT hon.manage_school_family_access_invitation($1,'INVITE',$2::jsonb,$3)",[manager.externalSubject,{schoolId:A.schoolId,familyId:famA2,accessLevel:'VIEWER',email:'raw-'+K()+'@example.invalid',ttlHours:24,tokenHash:hash('x'),organizationId:B.organizationId},K()]),e=>e.code==='22023');
 pass('no grant, staff without family.member.manage, other-school manager, other-school/archived/missing family refused atomically; closed input and access levels');

 // 4. Busy envelope.
 await blocker.query('BEGIN');
 try{
  await blocker.query('LOCK TABLE hon.family_access_grants IN SHARE ROW EXCLUSIVE MODE');
  await denied(()=>send('school/family-access-invitations',{identity:outsider,body:invite(A.schoolId,famA2,'busy-'+K()+'@example.invalid')}),403);
  await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(A.schoolId,famA2,'busy-'+K()+'@example.invalid')}),503);
 }finally{await blocker.query('ROLLBACK');}
 pass('IAM authority envelope: unauthorized denied before contended locks; authorized callers get explicit recoverable busy, no partial writes');

 // 5. Acceptance refusals.
 for(const [identity,body]of [[person('wrong-email'),accept(invA,inputA.token)],[parentA,accept(invA,tokenOf())],[{...parentA,emailVerified:undefined},accept(invA,inputA.token)]])
  await denied(()=>send('account/family-access-invitations/accept',{identity,body}),403);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentA,body:accept(invA,inputA.token),headers:{cookie:HON_SESSION_COOKIE+'='+issueSession(parentA,{...session,emitVerifiedEmail:false})}}),403);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentA,body:{...accept(invA,inputA.token),confirmation:'ACCEPT_SCHOOL_STAFF_INVITATION'}}),400);
 pass('acceptance requires the signed verified email, exact token and its own confirmation; failures leave no records');

 // 6. Acceptance creates exactly one identity + one family grant for the exact family.
 assert.deepEqual(await scope(parentA,A),[]);
 const acceptKey=K(),bodyA=accept(invA,inputA.token);
 const acc=receipt(await send('account/family-access-invitations/accept',{identity:parentA,body:bodyA,key:acceptKey}));
 assert.deepEqual(acc,{invitationId:invA.invitationId,schoolId:A.schoolId,familyId:famA,accessLevel:'SECONDARY_GUARDIAN',accountStatus:'FAMILY_ACCESS_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false});
 assert.deepEqual(await scope(parentA,A),[{f:famA,a:'SECONDARY_GUARDIAN'}]);assert.deepEqual(await scope(parentA,B),[]);
 assert.equal(await has(parentA,A,'school.view'),false);assert.equal(await has(parentA,A,'family.read'),false);
 const g=await q('SELECT g.* FROM hon.family_access_grants g JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1',[parentA.externalSubject]);
 assert.equal(g.length,1);assert.equal(g[0].family_id,famA);assert.equal(g[0].school_id,A.schoolId);assert.equal(g[0].granted_by_principal_id,managerPrincipal);assert.equal(g[0].effective_until,null);
 assert.equal((await q('SELECT count(*) n FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id WHERE p.id=$1',[g[0].principal_id]))[0].n,'0');
 assert.deepEqual(receipt(await send('account/family-access-invitations/accept',{identity:parentA,body:bodyA,key:acceptKey})),acc);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentA,body:bodyA}),403);
 await denied(()=>send('school/family-access-invitations/revoke',{identity:manager,body:{schoolId:A.schoolId,invitationId:invA.invitationId}}),409);
 pass('verified acceptance creates one identity and exactly one grant to the invited family (parent scope only, no staff permission, no other school); single use, exact replay; accepted invitations are not revoked');

 // 7. Issuer authority and family state are re-proven at acceptance.
 const parentC=person('parent-c'),inputC=invite(A.schoolId,famA2,parentC.email);const invC=receipt(await send('school/family-access-invitations',{identity:manager,body:inputC}));
 await q('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp(),revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1',[managerGrant]);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentC,body:accept(invC,inputC.token)}),403);
 await grant(A,managerPrincipal,managerRole);
 await q("UPDATE hon.families SET status='ARCHIVED' WHERE id=$1",[famA2]);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentC,body:accept(invC,inputC.token)}),403);
 await q("UPDATE hon.families SET status='ACTIVE' WHERE id=$1",[famA2]);
 assert.equal(receipt(await send('account/family-access-invitations/accept',{identity:parentC,body:accept(invC,inputC.token)})).accountStatus,'FAMILY_ACCESS_BOUND');
 pass('a revoked issuer or an archived family makes an outstanding invitation unusable; restoring both restores it');

 // 8. Identity safety.
 const collide=person('collide');await human(collide,'S2F existing');
 const inputE=invite(A.schoolId,famA2,collide.email,{accessLevel:'VIEWER'});const invE=receipt(await send('school/family-access-invitations',{identity:manager,body:inputE}));
 await denied(()=>send('account/family-access-invitations/accept',{identity:{...collide,externalSubject:'oidc:s2f:other:'+K()},body:accept(invE,inputE.token)}),409);
 const existingPrincipal=(await q('SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1',[collide.externalSubject]))[0].id;
 assert.equal(receipt(await send('account/family-access-invitations/accept',{identity:collide,body:accept(invE,inputE.token)})).accessLevel,'VIEWER');
 assert.equal((await q('SELECT count(*) n FROM hon.family_access_grants WHERE principal_id=$1',[existingPrincipal]))[0].n,'1');
 // An already-linked parent can be linked to a second family of the same organization, never twice to the same family.
 const inputSecond=invite(A.schoolId,famA2,parentA.email);const invSecond=receipt(await send('school/family-access-invitations',{identity:manager,body:inputSecond}));
 receipt(await send('account/family-access-invitations/accept',{identity:parentA,body:accept(invSecond,inputSecond.token)}));
 assert.deepEqual(await scope(parentA,A),[{f:famA,a:'SECONDARY_GUARDIAN'},{f:famA2,a:'SECONDARY_GUARDIAN'}].sort((x,y)=>x.f<y.f?-1:1));
 const inputTwice=invite(A.schoolId,famA,parentA.email,{accessLevel:'PRIMARY_GUARDIAN'});const invTwice=receipt(await send('school/family-access-invitations',{identity:manager,body:inputTwice}));
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentA,body:accept(invTwice,inputTwice.token)}),409);
 for(const [identity,label]of [[desk,'staff'],[manager,'self']]){
  const input=invite(A.schoolId,famA,identity.email);const inv=receipt(await send('school/family-access-invitations',{identity:manager,body:input}));
  await denied(()=>send('account/family-access-invitations/accept',{identity,body:accept(inv,input.token)}),409);void label;
 }
 pass('never links by email alone; a clean identity keeps its one principal; a second family in the same organization is allowed; same family twice, staff and self identities require review');

 // 9. Revoke and expiry.
 const parentR=person('parent-r'),inputR=invite(A.schoolId,famA2,parentR.email);const invR=receipt(await send('school/family-access-invitations',{identity:manager,body:inputR}));
 await denied(()=>send('school/family-access-invitations/revoke',{identity:managerB,body:{schoolId:B.schoolId,invitationId:invR.invitationId}}),404);
 await denied(()=>send('school/family-access-invitations/end',{identity:manager,body:end(A.schoolId,invR)}),409);
 const rev=receipt(await send('school/family-access-invitations/revoke',{identity:manager,body:{schoolId:A.schoolId,invitationId:invR.invitationId}}));assert.equal(rev.status,'REVOKED');
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentR,body:accept(invR,inputR.token)}),403);
 const parentX=person('parent-x'),inputX=invite(A.schoolId,famA2,parentX.email,{ttlHours:1});const invX=receipt(await send('school/family-access-invitations',{identity:manager,body:inputX}));
 await admin.query('BEGIN');await admin.query("ALTER TABLE hon.school_family_access_invitations DISABLE TRIGGER immutable");
 await admin.query("UPDATE hon.school_family_access_invitations SET created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours' WHERE id=$1",[invX.invitationId]);
 await admin.query("ALTER TABLE hon.school_family_access_invitations ENABLE TRIGGER immutable");await admin.query('COMMIT');
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentX,body:accept(invX,inputX.token)}),403);
 pass('exact-school revoke (other school sees not-found), pending invitations cannot be ended, revoked and expired invitations cannot be accepted');

 // 9b. Paid access fails closed.
 const parentS=person('parent-s'),inputS=invite(A.schoolId,famA2,parentS.email);const invS=receipt(await send('school/family-access-invitations',{identity:manager,body:inputS}));
 const entitlement=(await q('SELECT status,effective_from,effective_until FROM hon.organization_entitlements WHERE organization_id=$1',[A.organizationId]))[0];
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>send('school/family-access-invitations',{identity:manager,body:invite(A.schoolId,famA2,'susp-'+K()+'@example.invalid')}),403);
 await denied(()=>send('school/schools/'+A.schoolId+'/family-access-invitations',{identity:manager,method:'GET'}),403);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentS,body:accept(invS,inputS.token)}),403);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_until=clock_timestamp()-interval '1 minute' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentS,body:accept(invS,inputS.token)}),403);
 await q('UPDATE hon.organization_entitlements SET status=$2,effective_from=$3,effective_until=$4 WHERE organization_id=$1',[A.organizationId,entitlement.status,entitlement.effective_from,entitlement.effective_until]);
 assert.equal(receipt(await send('account/family-access-invitations/accept',{identity:parentS,body:accept(invS,inputS.token)})).accountStatus,'FAMILY_ACCESS_BOUND');
 pass('paid access fails closed: a suspended or lapsed organization cannot invite, list or complete an outstanding invitation; restored access completes it');

 // 10. Ending accepted access.
 await denied(()=>send('school/family-access-invitations/end',{identity:managerB,body:end(B.schoolId,invC)}),404);
 await denied(()=>send('school/family-access-invitations/end',{identity:desk,body:end(A.schoolId,invC)}),403);
 await denied(()=>send('school/family-access-invitations/end',{identity:manager,body:{schoolId:A.schoolId,invitationId:invC.invitationId}}),400);
 assert.deepEqual(await scope(parentC,A),[{f:famA2,a:'SECONDARY_GUARDIAN'}]);
 const endKey=K(),ended=receipt(await send('school/family-access-invitations/end',{identity:manager,body:end(A.schoolId,invC),key:endKey}));
 assert.equal(ended.status,'ENDED');assert.deepEqual(await scope(parentC,A),[]);
 assert.deepEqual(receipt(await send('school/family-access-invitations/end',{identity:manager,body:end(A.schoolId,invC),key:endKey})),ended);
 assert.equal(receipt(await send('school/family-access-invitations/end',{identity:manager,body:end(A.schoolId,invC)})).status,'ENDED');
 assert.equal((await q("SELECT count(*) n FROM hon.family_access_grants g JOIN hon.school_family_access_invitations i ON i.access_grant_id=g.id WHERE i.id=$1 AND g.effective_until=i.ended_at",[invC.invitationId]))[0].n,'1');
 await denied(()=>send('account/family-access-invitations/accept',{identity:parentC,body:accept(invC,inputC.token)}),403);
 const inputC2=invite(A.schoolId,famA2,parentC.email,{accessLevel:'VIEWER'});const invC2=receipt(await send('school/family-access-invitations',{identity:manager,body:inputC2}));
 receipt(await send('account/family-access-invitations/accept',{identity:parentC,body:accept(invC2,inputC2.token)}));
 assert.deepEqual(await scope(parentC,A),[{f:famA2,a:'VIEWER'}]);
 pass('a manager ends exactly the grant an invitation created (exact school, explicit confirmation, idempotent); ended access is never revived by replay; a fresh invitation can relink');

 // 11. List and immutable evidence.
 const list=receipt(await send('school/schools/'+A.schoolId+'/family-access-invitations',{identity:manager,method:'GET'}));
 assert(list.length>=8&&list.length<=50);assert(list.every(i=>i.schoolId===A.schoolId));
 for(const s of ['EXPIRED','REVOKED','ENDED','ACCEPTED','PENDING'])assert(list.some(i=>i.status===s),s);
 await denied(()=>send('school/schools/'+A.schoolId+'/family-access-invitations',{identity:outsider,method:'GET'}),403);
 await denied(()=>send('school/schools/'+A.schoolId+'/family-access-invitations',{identity:desk,method:'GET'}),403);
 await denied(()=>send('school/schools/'+A.schoolId+'/family-access-invitations',{identity:managerB,method:'GET'}),403);
 for(const sql of ['UPDATE hon.school_family_account_events SET receipt=\'{}\'','DELETE FROM hon.school_family_account_events',
  'UPDATE hon.school_family_access_invitations SET email=\'x@example.invalid\' WHERE status=\'ACCEPTED\'','UPDATE hon.school_family_access_invitations SET status=\'PENDING\' WHERE status=\'REVOKED\'',
  'UPDATE hon.school_family_access_invitations SET status=\'ACCEPTED\',ended_at=NULL,ended_by=NULL WHERE status=\'ENDED\'','DELETE FROM hon.school_family_access_invitations'])
  await assert.rejects(()=>admin.query(sql),e=>/ACCOUNT_EVIDENCE_IMMUTABLE/.test(e.message),sql);
 assert.equal((await q("SELECT count(*) n FROM hon.school_family_account_events WHERE execution_allowed"))[0].n,'0');
 pass('manager-only exact-school list (<=50, derived EXPIRED, ENDED); invitations and audit evidence are append-only and never dispatchable');

 assert.deepEqual(await snapshot(),baseline);assert.deepEqual(await entitlementState(),entitlementBaseline);assert.deepEqual(await familyState(),familyBaseline);
 pass('no entitlement, billing, credit, AI, CRM, student or outbox table changed: identity, family grant and private evidence only');
 console.log(`PASS: school family access invitations (${groups} groups)`);
}finally{await app?.close();await Promise.allSettled([admin.end(),restricted.end(),blocker.end()]);}
