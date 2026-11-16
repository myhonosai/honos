/** Staff assignable permissions list (0412). Real signed HON sessions -> Nest -> runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
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
const {StaffRoleService:RS}=require('./dist/staff-roles/staff-role.service.js'),{StaffRoleController:RC}=require('./dist/staff-roles/staff-role.controller.js'),{StaffRoleHumanUiGuard:RG}=require('./dist/staff-roles/staff-role-human-ui.guard.js');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'staff-permissions-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS STAFF-PERMISSIONS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:staffperms:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
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
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method:'POST',headers:{cookie,origin,'content-type':'application/json','content-length':Buffer.byteLength(data),'x-hon-human-command':'staff-role-admin','idempotency-key':K(),'sec-fetch-site':'same-origin',accept:'application/json'}},res=>{let t='';res.on('data',c=>t+=c);res.on('end',()=>{let b;try{b=JSON.parse(t);}catch{b=t;}resolve({status:res.statusCode,body:b});});});req.on('error',reject);req.end(data);});
}
const base=o=>'organizations/'+o.organizationId+'/schools/'+o.schoolId+'/staff-roles/';

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL: the 0412 list is a definer function the runtime may only execute; it refuses a call with no tenant HUMAN_UI context.
 const fn=(await q("SELECT p.oid,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname='list_assignable_staff_permissions'"))[0];
 assert.equal(fn.prosecdef,true);
 assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,fn.oid]))[0].ok,true);
 assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[fn.oid]))[0].ok,false);
 await assert.rejects(()=>restricted.query("SELECT hon.list_assignable_staff_permissions('x')"),e=>e.code==='42501');
 for(const t of ['permissions','role_permissions','roles','principal_role_grants'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,'SELECT']))[0].ok,false,t);
 pass('the list is an EXECUTE-only definer entry point that refuses calls outside a tenant HUMAN_UI session; permission tables stay unreadable to the runtime');

 const hq={subject:'staffperms-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Perms synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Perms synthetic','Perms synthetic','Perms school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'staffperms-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 // A manager with a few permissions, one of them not staff-assignable on purpose (if such a code exists), and a second role adding card management.
 const unassignable=(await q("SELECT code FROM hon.permissions WHERE NOT is_staff_assignable AND code !~ '^(hq|platform|system)\\.' ORDER BY code LIMIT 1"))[0]?.code;
 const held=['school.view','iam.staff_role.manage','iam.custom_role.create','attendance.record',...(unassignable?[unassignable]:[])];
 const manager=person('manager');const managerPrincipal=await human(manager,'Morgan Manager');
 const managerGrant=await grant(A,managerPrincipal,await customRole(A,'CUSTOM_PERM_MANAGE',held));
 const cards=person('cards');const cardsPrincipal=await human(cards,'Casey Cards');
 await grant(A,cardsPrincipal,await customRole(A,'CUSTOM_PERM_CARDS',['school.view','iam.staff_role.manage','attendance.cards.manage']));
 const teacher=person('teacher');await grant(A,await human(teacher,'Coach Teacher'),await customRole(A,'CUSTOM_PERM_TEACH',['school.view','attendance.record']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Other School'),await customRole(B,'CUSTOM_PERM_MANAGE',['school.view','iam.staff_role.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const module=await Test.createTestingModule({controllers:[RC],providers:[RS,RG,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. The list is exactly the staff-assignable codes the caller holds at this school, with stored descriptions.
 const expected=(await q("SELECT code,description,is_sensitive FROM hon.permissions WHERE is_staff_assignable AND code !~ '^(hq|platform|system)\\.' AND code=ANY($1) ORDER BY code",[held]));
 const list=ok(await get(base(A)+'permissions',manager));
 assert.deepEqual(list,expected.map(r=>({code:r.code,description:r.description,sensitive:r.is_sensitive})));
 assert(list.some(p=>p.code==='attendance.record'));assert(!list.some(p=>p.code==='attendance.cards.manage'),'not held, not offered');
 if(unassignable)assert(!list.some(p=>p.code===unassignable),'held but not staff-assignable is never offered');
 for(const p of list)assert.deepEqual(Object.keys(p).sort(),['code','description','sensitive']);
 const cardList=ok(await get(base(A)+'permissions',cards));
 const cardEntry=cardList.find(p=>p.code==='attendance.cards.manage');
 assert(cardEntry&&cardEntry.sensitive===true&&/attendance cards/i.test(cardEntry.description),'cards permission offered to someone who holds it, marked sensitive');
 pass('the list is exactly the staff-assignable permissions the caller holds at this school, with stored descriptions; unheld and non-assignable codes are left out');

 // 3. The list agrees with the write path: a role made from the whole list is accepted; adding an unlisted code is refused.
 const made=await post(base(A)+'custom',manager,{code:'CUSTOM_FROM_LIST',name:'From the list',permissionCodes:list.map(p=>p.code)});
 assert.equal(made.status,200,JSON.stringify(made.body));
 const refused=await post(base(A)+'custom',manager,{code:'CUSTOM_TOO_MUCH',name:'Too much',permissionCodes:[...list.map(p=>p.code),'attendance.cards.manage']});
 assert.notEqual(refused.status,200,JSON.stringify(refused.body));assert(!('data' in refused.body));
 pass('a custom role built from the whole list is accepted, and one code beyond the list is refused by the unchanged write path');

 // 4. Refusals: no iam.staff_role.manage, another school, outsider, signed out, revoked.
 for(const [path,who,expect] of [[base(A)+'permissions',teacher,[403]],[base(A)+'permissions',managerB,[403]],[base(B)+'permissions',manager,[403]],[base(A)+'permissions',outsider,[401,403]]]){
  const r=await get(path,who);assert(expect.includes(r.status),path+' '+r.status+' '+JSON.stringify(r.body));assert(!('data' in r.body));
 }
 assert([401,403].includes((await get(base(A)+'permissions')).status));
 await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]);
 assert.equal((await get(base(A)+'permissions',manager)).status,403);
 pass('callers without staff role management, other schools, outsiders, signed-out and revoked callers get nothing');
 console.log('Staff permissions list proof: '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
