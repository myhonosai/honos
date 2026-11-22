/** 0655 "Make my shop" requests: a school with no Shopify store asks HON to make one; HON HQ settles the request by hand. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). Nothing calls Shopify. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|SHOPIFY.*|HON_SHOPIFY.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {ShopifyService}=require('./dist/commerce/shopify/shopify.service.js');
const {ShopifyController,ShopifyHumanGuard}=require('./dist/commerce/shopify/shopify.controller.js');
const {SHOPIFY_APP,shopifyAppFromEnvironment}=require('./dist/commerce/shopify/shopify-adapter.js');
const {SHOPIFY_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'shopify-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS SHOPIFY '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:shopify:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,method='POST',command=SHOPIFY_HUMAN_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['shopify_connections','shopify_store_requests'];
const counted=[...tables,'audit_events','outbox_events'];
const counts=async()=>{const o={};for(const t of counted)o[t]=(await q('SELECT count(*) n FROM hon.'+t))[0].n;return o;};
async function denied(work,status,code){
 const before=await counts();const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));
 assert.deepEqual(await counts(),before);
 assert(!('data' in r.body));assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/SQLSTATE|SELECT |external_subject|hon\.|fake_(at|rt)_/));return r;
}
async function human(identity,label){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[principal,user,label]);
 return principal;
}
async function customRole(o,code,perms){
 const id=(await q("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4) RETURNING id",[o.organizationId,o.schoolId,code,code.replace('CUSTOM_','')]))[0].id;
 for(const p of perms)await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[id,o.organizationId,p]);
 return id;
}
const grant=async(o,principal,role)=>(await q('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval \'1 minute\') RETURNING id',[o.organizationId,o.schoolId,principal,role]))[0].id;
const read=(identity,s,sub='')=>send('school/schools/'+s+'/shopify'+sub,{identity,method:'GET'});
const cmd=path=>(identity,b,o={})=>send('school/shopify/'+path,{identity,body:b,...o});
const start=cmd('connect'),complete=cmd('connect/complete');const queryOf=url=>new URL(url).search.slice(1);
const srRead=(identity,s)=>read(identity,s,'/store-request');const srAsk=cmd('store-request'),srCancel=cmd('store-request/cancel');
const hqList=identity=>send('hq/shopify/store-requests',{identity,method:'GET'});const hqSettle=(identity,b,o={})=>send('hq/shopify/store-requests/settle',{identity,body:b,...o});
let shopify;
try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. ACL.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.shopify_store_requests',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.shopify_store_requests'::regclass"))[0],{r:true,f:true,n:0});
 const entries=['read_shopify_store_request','request_shopify_store','cancel_shopify_store_request','read_hq_shopify_store_requests','settle_hq_shopify_store_request'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify_store_request%' OR (n.nspname='hon' AND p.proname='request_shopify_store')");
 assert.deepEqual(fns.map(f=>f.proname).sort(),[...entries,'shopify_store_request_json'].sort());
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(restricted.query('SELECT * FROM hon.shopify_store_requests'),/permission denied/);
 await assert.rejects(q('TRUNCATE hon.shopify_store_requests'));
 pass('store requests is a forced-RLS private table with no policy; the runtime executes the five entry points and nothing else; the helper is closed; no truncate');

 // Fixture: two schools with paid access; manager, reader, other-school manager; an HQ owner, an HQ billing operator and an HQ operator without billing.
 const hqOwner=person('hq-owner');const hqPrincipal=await human(hqOwner,'Shopify synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const hqBilling=person('hq-billing');await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OPERATOR',ARRAY['hq.billing.manage'],clock_timestamp()-interval '2 days')",[await human(hqBilling,'HQ billing')]);
 const hqOther=person('hq-other');await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OPERATOR',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[await human(hqOther,'HQ other')]);
 const provision=async name=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Shopify synthetic','Shopify synthetic',$5,$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hqOwner.externalSubject,'shopify-'+K(),K(),K(),name]))[0];
 const A=await provision('Request school A'),B=await provision('Request school B');
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager');const managerGrant=await grant(A,await human(manager,'Manager'),await customRole(A,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 const reader=person('reader');await grant(A,await human(reader,'Reader'),await customRole(A,'CUSTOM_SHOPIFY_READ',['school.view','commerce.shopify.read']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'});assert.equal(shopify.adapter.kind,'FAKE');
 const module=await Test.createTestingModule({controllers:[ShopifyController],providers:[ShopifyService,ShopifyHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const ask=(over={})=>({schoolId:A.schoolId,shopName:'Request school A Pro Shop',ownerEmail:'owner-a@example.invalid',note:'Uniforms first.\nThen belts.',...over});

 // 2. Only commerce.shopify.manage at the exact school asks, reads and cancels; inputs are closed; the command header is required.
 assert.deepEqual(ok(await srRead(manager,A.schoolId)),{schoolId:A.schoolId,request:null});
 await denied(()=>srRead(reader,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>srRead(managerB,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>srRead(undefined,A.schoolId),401);
 await denied(()=>srAsk(reader,ask()),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>srAsk(managerB,ask()),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>srAsk(hqOther,ask()),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>srAsk(manager,ask(),{command:'other'}),403,'HUMAN_UI_REQUIRED');
 for(const bad of [{shopName:''},{shopName:' padded'},{shopName:'x'.repeat(61)},{shopName:'two\nlines'},{ownerEmail:'Owner-A@example.invalid'},{ownerEmail:'not-an-email'},{note:'x'.repeat(501)},{note:''},{extra:true}])
  await denied(()=>srAsk(manager,ask(bad)),400,'SHOPIFY_INVALID');
 const first=ok(await srAsk(manager,ask())).request;
 assert.deepEqual({...first,requestId:null,requestedAt:null},{requestId:null,shopName:'Request school A Pro Shop',ownerEmail:'owner-a@example.invalid',note:'Uniforms first.\nThen belts.',status:'REQUESTED',shopDomain:null,requestedAt:null,settledAt:null,version:1});
 assert.deepEqual(ok(await srRead(manager,A.schoolId)).request,first);
 assert.deepEqual(ok(await srRead(managerB,B.schoolId)),{schoolId:B.schoolId,request:null},'another school sees nothing of it');
 await denied(()=>srAsk(manager,ask({shopName:'Second'})),409,'SHOPIFY_STORE_REQUEST_OPEN');
 pass('only a Shopify manager at the exact school reads and asks; inputs are closed; one open request per school; another school sees nothing');

 // 3. Cancel: the exact school and request, once.
 await denied(()=>srCancel(managerB,{schoolId:B.schoolId,requestId:first.requestId}),404,'SHOPIFY_NOT_FOUND');
 await denied(()=>srCancel(reader,{schoolId:A.schoolId,requestId:first.requestId}),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>srCancel(manager,{schoolId:A.schoolId,requestId:K()}),404,'SHOPIFY_NOT_FOUND');
 const cancelled=ok(await srCancel(manager,{schoolId:A.schoolId,requestId:first.requestId})).request;
 assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.version,2);assert(cancelled.settledAt);
 await denied(()=>srCancel(manager,{schoolId:A.schoolId,requestId:first.requestId}),409,'SHOPIFY_STORE_REQUEST_SETTLED');
 pass('an open request is cancelled once, by a manager of its own school');

 // 4. HQ: owner or billing operator lists and settles; nobody else. A school manager is not HQ.
 const second=ok(await srAsk(manager,ask({note:null}))).request;
 const askB=ok(await srAsk(managerB,ask({schoolId:B.schoolId,shopName:'Request school B Shop',ownerEmail:'owner-b@example.invalid',note:null}))).request;
 for(const who of [manager,reader,hqOther])await denied(()=>hqList(who),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>hqList(undefined),401);
 const list=ok(await hqList(hqBilling));
 assert.deepEqual(list.open.map(r=>[r.requestId,r.schoolId,r.schoolName]),[[second.requestId,A.schoolId,'Request school A'],[askB.requestId,B.schoolId,'Request school B']]);
 assert.deepEqual(list.settled.map(r=>[r.requestId,r.status]),[[first.requestId,'CANCELLED']]);
 const made={requestId:second.requestId,expectedVersion:1,outcome:'CREATED',shopDomain:'request-school-a.myshopify.com'};
 for(const who of [manager,hqOther])await denied(()=>hqSettle(who,made),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>hqSettle(hqOwner,made,{command:'other'}),403,'HUMAN_UI_REQUIRED');
 for(const bad of [{shopDomain:null},{shopDomain:'request-school-a.com'},{outcome:'CANCELLED'},{outcome:'DECLINED'},{expectedVersion:0},{extra:1}])await denied(()=>hqSettle(hqOwner,{...made,...bad}),400,'SHOPIFY_INVALID');
 await denied(()=>hqSettle(hqOwner,{...made,expectedVersion:2}),409,'SHOPIFY_VERSION_CONFLICT');
 await denied(()=>hqSettle(hqOwner,{...made,requestId:K()}),404,'SHOPIFY_NOT_FOUND');
 const done=ok(await hqSettle(hqOwner,made));
 assert.deepEqual([done.status,done.shopDomain,done.version,done.schoolId],['CREATED','request-school-a.myshopify.com',2,A.schoolId]);
 await denied(()=>hqSettle(hqOwner,{...made,expectedVersion:2}),409,'SHOPIFY_STORE_REQUEST_SETTLED');
 await denied(()=>srCancel(manager,{schoolId:A.schoolId,requestId:second.requestId}),409,'SHOPIFY_STORE_REQUEST_SETTLED');
 assert.deepEqual([ok(await srRead(manager,A.schoolId)).request.status,ok(await srRead(manager,A.schoolId)).request.shopDomain],['CREATED','request-school-a.myshopify.com']);
 const declined=ok(await hqSettle(hqBilling,{requestId:askB.requestId,expectedVersion:1,outcome:'DECLINED',shopDomain:null}));
 assert.deepEqual([declined.status,declined.shopDomain],['DECLINED',null]);
 assert.equal(ok(await hqList(hqOwner)).open.length,0);
 pass('HQ owner or billing operator lists every school\'s requests and settles an open one once, at its exact version, as CREATED with the store address or DECLINED; nobody else is HQ');

 // 5. Limits: five requests in thirty days; never while a store is CONNECTED.
 for(let i=0;i<3;i++){const r=ok(await srAsk(manager,ask({note:null}))).request;ok(await srCancel(manager,{schoolId:A.schoolId,requestId:r.requestId}));}
 await denied(()=>srAsk(manager,ask()),429,'SHOPIFY_STORE_REQUEST_LIMIT');
 const s=ok(await start(managerB,{schoolId:B.schoolId,shopDomain:'request-b-'+K().slice(0,8)+'.myshopify.com'}));ok(await complete(managerB,{schoolId:B.schoolId,query:queryOf(s.authorizeUrl)}));
 await denied(()=>srAsk(managerB,ask({schoolId:B.schoolId})),409,'SHOPIFY_STORE_REQUEST_CONNECTED');
 pass('at most five requests per school in thirty days; a school with a CONNECTED store cannot ask');

 // 6. Evidence carries ids and statuses, never the email, the name or the note; a revoked manager reads nothing.
 const ev=await q("SELECT action_code,next_state FROM hon.audit_events WHERE action_code LIKE 'commerce.shopify.store_request.%' ORDER BY occurred_at");
 for(const a of ['requested','cancelled','created','declined'])assert(ev.some(e=>e.action_code==='commerce.shopify.store_request.'+a),a);
 const out=await q("SELECT payload FROM hon.outbox_events WHERE event_type LIKE 'commerce.shopify.store_request.%'");
 assert.equal(JSON.stringify([ev,out]).match(/example\.invalid|Pro Shop|Uniforms|myshopify/),null,'evidence holds ids and statuses only');
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[managerGrant,hqPrincipal]);
 await denied(()=>srRead(manager,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 pass('audit and outbox carry ids and statuses only; a revoked grant reads nothing');

 // 7. The deploy check for 0655 in infra 011 passes against this database (with the fixture's runtime role).
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Shopify store requests exact verification (0655)')[1]?.split('-- End Shopify store requests exact verification.')[0];
  assert(section,'0655 verify section');await q(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime','hon_champions_runtime'));}
 pass('the infra verification for 0655 (exact bodies, closed helper, forced RLS) passes');
 console.log('PASS SHOPIFY STORE REQUESTS all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy()]);
}
