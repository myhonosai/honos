/** Staff qualification and role lists (0406). Real signed HON sessions -> Nest -> runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {InstructorQualificationsService:QS}=require('./dist/instructor-qualifications/instructor-qualifications.service.js'),{InstructorQualificationsController:QC}=require('./dist/instructor-qualifications/instructor-qualifications.controller.js'),{InstructorQualificationsHumanUiGuard:QG}=require('./dist/instructor-qualifications/instructor-qualifications.dto.js');
const {StaffRoleService:RS}=require('./dist/staff-roles/staff-role.service.js'),{StaffRoleController:RC}=require('./dist/staff-roles/staff-role.controller.js'),{StaffRoleHumanUiGuard:RG}=require('./dist/staff-roles/staff-role-human-ui.guard.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'staff-lists-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS STAFF-LISTS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:stafflists:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function get(path,identity){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method:'GET',headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',accept:'application/json'}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{let body;try{body=JSON.parse(t);}catch{body=t;}resolve({status:res.statusCode,headers:res.headers,body});});});req.on('error',reject);req.end();});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
async function human(identity,label,active=true){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,$4)",[principal,user,label,active]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day') RETURNING id",[o.organizationId,o.schoolId,principal,role]))[0].id;
async function post(path,identity,body){
 const cookie=HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)),data=JSON.stringify(body);
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','content-length':Buffer.byteLength(data),'x-hon-human-command':'instructor-qualifications','idempotency-key':K(),'sec-fetch-site':'same-origin',accept:'application/json'}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{let b;try{b=JSON.parse(t);}catch{b=t;}resolve({status:res.statusCode,body:b});});});req.on('error',reject);req.end(data);});
}
const roles=o=>'organizations/'+o.organizationId+'/schools/'+o.schoolId+'/staff-roles/lists';

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL: both 0406 lists are definer functions the runtime may only execute; they refuse a call with no tenant HUMAN_UI context.
 for(const [name,call] of [['list_instructor_qualifications',"SELECT hon.list_instructor_qualifications('x','DEFINITIONS',NULL)"],['list_staff_roles',"SELECT hon.list_staff_roles('x')"]]){
  const fn=(await q("SELECT p.oid,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname=$1",[name]))[0];
  assert.equal(fn.prosecdef,true,name);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,fn.oid]))[0].ok,true,name);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[fn.oid]))[0].ok,false,name);
  await assert.rejects(()=>restricted.query(call),e=>e.code==='42501',name);
 }
 for(const t of ['instructor_qualifications','instructor_qualification_evidence','instructor_qualification_evidence_reviews','roles','principal_role_grants','principals','users'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,'SELECT']))[0].ok,false,t);
 pass('both lists are EXECUTE-only definer entry points that refuse calls outside a tenant HUMAN_UI session; their tables stay unreadable to the runtime');

 const hq={subject:'stafflists-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Lists synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Lists synthetic','Lists synthetic','Lists school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'stafflists-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager');const managerPrincipal=await human(manager,'Morgan Manager');
 const managerRole=await customRole(A,'CUSTOM_LIST_MANAGE',['school.view','staff.instructor_qualification.manage','iam.staff_role.manage']);const managerGrant=await grant(A,managerPrincipal,managerRole);
 const teacher=person('teacher');const teacherPrincipal=await human(teacher,'Coach Teacher');const teachRole=await customRole(A,'CUSTOM_LIST_TEACH',['school.view','staff.instructor_qualification.read']);const teacherGrant=await grant(A,teacherPrincipal,teachRole);
 const gone=person('gone');const gonePrincipal=await human(gone,'Revoked Person');const goneGrant=await grant(A,gonePrincipal,await customRole(A,'CUSTOM_LIST_GONE',['school.view']));
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[goneGrant]);
 const managerB=person('manager-b');await grant(B,await human(managerB,'Other School'),await customRole(B,'CUSTOM_LIST_MANAGE',['school.view','staff.instructor_qualification.manage','iam.staff_role.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const module=await Test.createTestingModule({controllers:[QC,RC],providers:[QS,QG,RS,RG,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Qualification lists: definitions (active first), eligible staff with evidence counts, one person's redacted evidence.
 const made=async(code,title)=>{const r=await post('staff/instructor-qualifications/qualifications',manager,{code,title,kind:'QUALIFICATION',courseProgramId:null});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;};
 const firstAid=await made('FIRST_AID','First aid'),kids=await made('KIDS_COACH','Kids coach'),old=await made('OLD_CERT','Old certificate');
 const QI='staff/instructor-qualifications/';
 assert.equal((await post(QI+'qualifications/'+old.id+'/retire',manager,{expectedVersion:old.version})).status,200);
 for(const qual of [firstAid,kids]){const r=await post(QI+'staff/'+teacherPrincipal+'/evidence',manager,{qualificationId:qual.id,expectedQualificationVersion:qual.version,attainedOn:'2026-01-10',expiresOn:null,evidenceReference:'Private reference '+qual.code});assert.equal(r.status,201,JSON.stringify(r.body));}
 const defs=ok(await get(QI+'qualifications',teacher));
 assert.deepEqual(defs.map(d=>[d.code,d.status]),[['FIRST_AID','ACTIVE'],['KIDS_COACH','ACTIVE'],['OLD_CERT','RETIRED']]);
 const people=ok(await get(QI+'staff',teacher));
 assert.deepEqual(people.map(p=>[p.displayName,p.evidenceCount]),[['Coach Teacher',2],['Morgan Manager',0]]);
 for(const p of people){assert.deepEqual(Object.keys(p).sort(),['displayName','evidenceCount','principalId']);assert(![gonePrincipal,hqPrincipal].includes(p.principalId));}
 const records=ok(await get(QI+'staff/'+teacherPrincipal+'/evidence',teacher));
 assert.deepEqual(records.map(e=>e.qualificationId).sort(),[firstAid.id,kids.id].sort());
 assert(!JSON.stringify(records).includes('Private reference'),'evidence references stay redacted');
 assert.deepEqual(ok(await get(QI+'staff/'+managerPrincipal+'/evidence',teacher)),[]);
 pass('qualification definitions, eligible staff with evidence counts, and one person’s redacted evidence list only this school, by name');

 // 3. Role lists: custom roles at this school and current grants by name; no system/owner/HQ roles, no revoked grants, no external subjects.
 const lists=ok(await get(roles(A),manager));
 assert.deepEqual(lists.roles.map(r=>r.code).sort(),['CUSTOM_LIST_GONE','CUSTOM_LIST_MANAGE','CUSTOM_LIST_TEACH']);
 assert(lists.roles.every(r=>!/^(OWNER|HON_|HQ)/.test(r.code)));
 assert.deepEqual(lists.roles.find(r=>r.id===teachRole).permissionCodes,['school.view','staff.instructor_qualification.read']);
 assert.deepEqual(lists.grants.map(g=>[g.displayName,g.roleName]),[['Coach Teacher','LIST_TEACH'],['Morgan Manager','LIST_MANAGE']]);
 assert.deepEqual(lists.grants.map(g=>g.id).sort(),[managerGrant,teacherGrant].sort());
 assert(!JSON.stringify(lists).includes('oidc:'),'no external subjects');
 pass('role lists return this school’s custom roles and current grants by name, never system roles, revoked grants or sign-in subjects');

 // 4. Refusals.
 for(const [path,who,expect] of [[roles(A),teacher,[403]],[roles(A),managerB,[403]],[roles(B),manager,[403]],[roles(A),outsider,[401,403]],[QI+'qualifications',outsider,[401,403]],[QI+'staff/'+gonePrincipal+'/evidence',teacher,[403]],[QI+'staff/not-a-uuid/evidence',teacher,[400]]]){
  const r=await get(path,who);assert(expect.includes(r.status),path+' '+r.status+' '+JSON.stringify(r.body));assert(!('data' in r.body));
 }
 assert([401,403].includes((await get(roles(A))).status));
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[teacherGrant]);
 assert([401,403].includes((await get(QI+'qualifications',teacher)).status));
 pass('readers without the permission, other schools, outsiders, signed-out and revoked callers, and ineligible staff get nothing');

 // 5. A lapsed school lists nothing.
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 assert.equal((await get(QI+'qualifications',manager)).status,403);
 pass('a school without an active subscription lists no qualifications');
 console.log('Staff list proof: '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
