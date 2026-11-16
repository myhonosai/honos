/** School pick lists (Teaching studio students/ranks; 0404 staff). Real signed HON sessions -> Nest -> runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
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
const {SchoolPickersService,SchoolPickersController}=require('./dist/school-pickers/school-pickers.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'school-pickers-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS SCHOOL-PICKERS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:pickers:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
async function student(o,given,family,status='ACTIVE'){
 const p=(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[o.organizationId,o.schoolId,given,family]))[0].id;
 return (await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,status) VALUES($1,$2,$3,$4) RETURNING id',[o.organizationId,o.schoolId,p,status]))[0].id;
}
const base=o=>'organizations/'+o.organizationId+'/schools/'+o.schoolId+'/pickers/';

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL: the 0404 list is a definer function the runtime may execute; principals/users stay unreadable to it.
 const fn=(await q("SELECT p.oid,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname='list_school_staff_for_picker'"))[0];
 assert.equal(fn.prosecdef,true);
 assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,fn.oid]))[0].ok,true);
 assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[fn.oid]))[0].ok,false);
 for(const t of ['principals','users'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,'SELECT']))[0].ok,false,t);
 await assert.rejects(()=>restricted.query("SELECT hon.list_school_staff_for_picker('x','work_item.manage')"),e=>e.code==='42501');
 pass('the staff list is an EXECUTE-only definer entry point; it refuses a call with no tenant HUMAN_UI context');

 const hq={subject:'pickers-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Pickers synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Pickers synthetic','Pickers synthetic','Pickers school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'pickers-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const teacher=person('teacher');const teacherPrincipal=await human(teacher,'Coach Teacher');await grant(A,teacherPrincipal,await customRole(A,'CUSTOM_PICK_TEACH',['school.view','teaching.studio.read']));
 const manager=person('manager');const managerPrincipal=await human(manager,'Morgan Manager');const managerGrant=await grant(A,managerPrincipal,await customRole(A,'CUSTOM_PICK_MANAGE',['school.view','work_item.manage','crm.follow_up.manage']));
 const quiet=person('quiet');const quietPrincipal=await human(quiet,'  ');await grant(A,quietPrincipal,await customRole(A,'CUSTOM_PICK_VIEW',['school.view']));
 const gone=person('gone');const gonePrincipal=await human(gone,'Revoked Person');const goneGrant=await grant(A,gonePrincipal,await customRole(A,'CUSTOM_PICK_GONE',['school.view']));
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[goneGrant]);
 const inactive=person('inactive');await grant(A,await human(inactive,'Inactive Person',false),await customRole(A,'CUSTOM_PICK_OFF',['school.view']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Other School'),await customRole(B,'CUSTOM_PICK_MANAGE',['school.view','work_item.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const mina=await student(A,'Mina','Park'),leo=await student(A,'Leo','Kim');await student(A,'Old','Student','ARCHIVED');await student(B,'Other','Child');
 const cur=(await q("INSERT INTO hon.curricula(organization_id,school_id,name,lifecycle,model_code) VALUES($1,$2,'Kids Karate','PUBLISHED','LINEAR') RETURNING id",[A.organizationId,A.schoolId]))[0].id;
 const old=(await q("INSERT INTO hon.curricula(organization_id,school_id,name,lifecycle,model_code) VALUES($1,$2,'Retired','ARCHIVED','LINEAR') RETURNING id",[A.organizationId,A.schoolId]))[0].id;
 for(const [c,n,i] of [[cur,'Yellow',2],[cur,'White',1],[old,'Gold',1]])await q('INSERT INTO hon.curriculum_ranks(organization_id,school_id,curriculum_id,name,progression_order) VALUES($1,$2,$3,$4,$5)',[A.organizationId,A.schoolId,c,n,i]);
 const module=await Test.createTestingModule({controllers:[SchoolPickersController],providers:[SchoolPickersService,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Teaching studio students and ranks: exact school, active only, names only, search is plain text.
 assert.deepEqual(ok(await get(base(A)+'students?for=teaching',teacher)),[{studentProfileId:leo,givenName:'Leo',familyName:'Kim'},{studentProfileId:mina,givenName:'Mina',familyName:'Park'}]);
 assert.deepEqual(ok(await get(base(A)+'students?for=teaching&search=min',teacher)).map(r=>r.givenName),['Mina']);
 assert.deepEqual(ok(await get(base(A)+'students?for=teaching&search=%25',teacher)),[]);
 const ranks=ok(await get(base(A)+'ranks?for=teaching',teacher));
 assert.deepEqual(ranks.map(r=>[r.curriculumId,r.curriculumName,r.rankName,r.progressionOrder]),[[cur,'Kids Karate','White',1],[cur,'Kids Karate','Yellow',2]]);
 pass('teaching students and belts list only this school’s active students and non-archived curricula, by name');

 // 3. Staff list: active role holders at this school only, display names only, blank names shown as Staff member.
 const staff=ok(await get(base(A)+'staff?for=work',manager));
 // The provisioning HQ principal holds a role at the new school but is an HQ operator, so it is not listed as staff.
 assert.deepEqual(staff.map(r=>r.displayName),['Coach Teacher','Morgan Manager','Staff member']);
 for(const r of staff){assert.deepEqual(Object.keys(r).sort(),['displayName','principalId']);assert(r.principalId!==gonePrincipal);}
 assert.deepEqual(ok(await get(base(A)+'staff?for=followups',manager)).map(r=>r.principalId).sort(),[teacherPrincipal,managerPrincipal,quietPrincipal].sort());
 assert(!staff.some(r=>r.principalId===hqPrincipal),'HQ operators are not school staff');
 pass('the staff list returns eligible staff at the exact school (no HQ operators), by display name only');

 // 4. Refusals: wrong permission, other school, outsider, unknown purpose, signed out.
 for(const [path,who] of [[base(A)+'staff?for=work',teacher],[base(A)+'staff?for=roles',manager],[base(A)+'students?for=teaching',manager],[base(A)+'staff?for=work',managerB],[base(A)+'staff?for=work',outsider],[base(B)+'students?for=teaching',teacher]]){
  const r=await get(path,who);assert(r.status===403||(who===outsider&&r.status===401),path+' '+r.status+' '+JSON.stringify(r.body));assert(!('data' in r.body));
 }
 assert.equal((await get(base(A)+'staff?for=admin',manager)).status,400);
 assert([401,403].includes((await get(base(A)+'staff?for=work')).status));
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]);
 assert.equal((await get(base(A)+'staff?for=work',manager)).status,403);
 pass('wrong permission, another school, outsiders, unknown purposes, signed-out and revoked callers get nothing');

 // 5. A lapsed school lists nothing.
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 const lapsed=await get(base(A)+'students?for=teaching',teacher);assert.equal(lapsed.status,403);assert.equal(lapsed.body.code,'TIER_ENTITLEMENT_REQUIRED');
 pass('a school without an active subscription lists nothing');
 console.log('School pick list proof: '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
