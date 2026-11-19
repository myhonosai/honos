/** 0449 Shopify background sync and webhooks (SH1b). Signed deliveries over real HTTP -> Nest webhook controller -> the 0449 worker functions; background sync through the real worker code; human commands through signed HON sessions -> fixed runtime SQL. Marked disposable PostgreSQL (Champions Club fixture). The Shopify side is the in-memory fake; nothing leaves the machine. The fixture has no worker login, so the five worker functions run over the owner connection, mapped exactly like ShopifyWorkerDatabase. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|SHOPIFY.*|HON_SHOPIFY.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*|HON_COMMUNICATION_WORKER.*)$/i.test(key),key);
const require=createRequire(new URL('../../../apps/api/package.json',import.meta.url));require('reflect-metadata');
const {Test}=require('@nestjs/testing'),{issueSession,HON_SESSION_COOKIE}=require('@hon/auth'),express=require('express');
const {RuntimeDatabaseService}=require('./dist/foundation/runtime-database.service.js');
const {HonIdentityService}=require('./dist/foundation/hon-identity.service.js');
const {ShopifyService}=require('./dist/commerce/shopify/shopify.service.js');
const {ShopifyController,ShopifyHumanGuard}=require('./dist/commerce/shopify/shopify.controller.js');
const {ShopifyWebhookController}=require('./dist/commerce/shopify/shopify-webhook.controller.js');
const {shopifyWebhookTransport}=require('./dist/commerce/shopify/shopify-webhook.js');
const {SHOPIFY_WORKER_STORE,ShopifyWorkerSql,ShopifyBackgroundSync}=require('./dist/commerce/shopify/shopify-worker.js');
const {SHOPIFY_APP,shopifyAppFromEnvironment}=require('./dist/commerce/shopify/shopify-adapter.js');
const {SHOPIFY_HUMAN_COMMAND}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),workerConn=new pg.Client({connectionString:owner.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const SYSTEM='00000000-0000-4000-8000-000000000408';
const session={mode:'OIDC',audience:'shopify-bg-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS SHOPIFY-BG '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const one=async(sql,args=[])=>(await q(sql,args))[0];
const person=label=>({externalSubject:'oidc:shopify-bg:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
function http(path,{method='POST',headers={},body}){
 return new Promise((resolve,reject)=>{const req=request(origin+path,{method,headers},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body);});
}
async function send(path,{identity,body,method='POST'}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return http('/v1/'+path,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',
  ...(method==='POST'?{'content-type':'application/json','x-hon-human-command':SHOPIFY_HUMAN_COMMAND}:{})}});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;};
const tables=['shopify_connections','shopify_credentials','shopify_syncs','shopify_products','shopify_variants','shopify_orders','shopify_order_lines','shopify_sync_requests','shopify_webhook_receipts','audit_events','outbox_events'];
const counts=async()=>{const o={};for(const t of tables)o[t]=(await one('SELECT count(*)::int n FROM hon.'+t)).n;return o;};
async function human(identity,label){
 const user=K(),principal=K();
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[user,identity.externalSubject,identity.email,label]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[principal,user,label]);
 return principal;
}
async function manage(o,identity,label){
 const role=(await one("INSERT INTO hon.roles(organization_id,management_school_id,code,name) VALUES($1,$2,$3,$3) RETURNING id",[o.organizationId,o.schoolId,'CUSTOM_SHOPIFY_BG_'+K().slice(0,8)])).id;
 for(const p of ['school.view','commerce.shopify.manage'])await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,o.organizationId,p]);
 const principal=await human(identity,label);
 await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 minute')",[o.organizationId,o.schoolId,principal,role]);
}
const cmd=path=>(identity,b)=>send('school/shopify/'+path,{identity,body:b});
const start=cmd('connect'),complete=cmd('connect/complete'),sync=cmd('sync');
const read=(identity,s)=>send('school/schools/'+s+'/shopify',{identity,method:'GET'});
// Test-only time travel: a store's runs and its change report move back together (the guard keeps started_at fixed, so it is lifted for that statement).
async function age(connectionId,minutes){
 await q('ALTER TABLE hon.shopify_syncs DISABLE TRIGGER shopify_syncs_guard');
 try{await q(`UPDATE hon.shopify_syncs SET started_at=started_at-make_interval(mins=>$2) WHERE connection_id=$1`,[connectionId,minutes]);}
 finally{await q('ALTER TABLE hon.shopify_syncs ENABLE TRIGGER shopify_syncs_guard');}
 await q('UPDATE hon.shopify_sync_requests SET requested_at=requested_at-make_interval(mins=>$2) WHERE connection_id=$1',[connectionId,minutes]);
}
const lastSyncAgo=(connectionId,hours)=>q("UPDATE hon.shopify_connections SET last_sync_at=clock_timestamp()-make_interval(hours=>$2),version=version+1 WHERE id=$1",[connectionId,hours]);

try{
 await Promise.all([admin.connect(),workerConn.connect()]);
 assert.equal((await one("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).m,'HON disposable Champions Club validation');
 const store=new ShopifyWorkerSql(async(sql,values)=>(await workerConn.query(sql,values)).rows);

 // 1. ACL: two new private tables; the runtime gains nothing; the code-owned principal holds no role.
 for(const t of ['shopify_sync_requests','shopify_webhook_receipts']){
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await one('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p])).ok,false,t+' '+p);
  assert.deepEqual(await one("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]),{r:true,f:true,n:0});
 }
 const workerFns=['record_shopify_webhook','claim_shopify_background_sync','rotate_shopify_background_credential','record_shopify_background_page','finish_shopify_background_sync'];
 const runtimeEntry=['read_shopify','read_shopify_catalog','read_shopify_orders','start_shopify_connect','claim_shopify_connect','record_shopify_connection',
  'begin_shopify_sync','rotate_shopify_credential','record_shopify_sync_page','finish_shopify_sync','disconnect_shopify',
  // 0496 product changes (SH4a).
  'read_shopify_product_changes','propose_shopify_product_change','cancel_shopify_product_change','approve_shopify_product_change',
  'rotate_shopify_change_credential','record_shopify_product_change_result',
  // 0596 Marcus merch ideas (CS-M2).
  'begin_shopify_merch_ideas','plan_shopify_merch_ideas','prepare_shopify_merch_ideas','fail_shopify_merch_ideas','record_shopify_merch_ideas',
  'read_shopify_merch_ideas','close_shopify_merch_ideas'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify%'");
 for(const f of workerFns)assert(fns.some(x=>x.proname===f),f);
 for(const f of fns){
  assert.equal((await one("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid])).ok,runtimeEntry.includes(f.proname),f.proname);
  assert.equal((await one("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid])).ok,false,f.proname);
 }
 if((await one("SELECT count(*)::int n FROM pg_roles WHERE rolname='hon_communication_worker'")).n)
  for(const f of fns)assert.equal((await one("SELECT has_function_privilege('hon_communication_worker',$1,'EXECUTE') ok",[f.oid])).ok,workerFns.includes(f.proname),f.proname);
 assert.deepEqual(await one("SELECT principal_type::text t,user_id,is_active FROM hon.principals WHERE id=$1",[SYSTEM]),{t:'SYSTEM_SERVICE',user_id:null,is_active:true});
 assert.equal((await one('SELECT count(*)::int n FROM hon.principal_role_grants WHERE principal_id=$1',[SYSTEM])).n,0);
 pass('webhook receipts and sync requests are forced-RLS private; the runtime still executes only its eleven entry points; the five worker functions and every helper are closed to it and to PUBLIC; the code-owned principal has no role');

 // Fixture: a paid school with a manager; HTTP app with the webhook transport before the JSON parser, as main.ts mounts it.
 const hq={subject:'shopify-bg-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Shopify bg HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>one("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Shopify bg','Shopify bg','Shopify bg school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'shopify-bg-'+K(),K(),K()]);
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager');await manage(A,manager,'Manager');
 const managerB=person('manager-b');await manage(B,managerB,'Manager B');
 let clock=Date.now();
 const shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'});assert.equal(shopify.adapter.kind,'FAKE');shopify.fake.now=()=>clock;
 const worker=new ShopifyBackgroundSync(store,shopify,()=>clock);
 const module=await Test.createTestingModule({controllers:[ShopifyController,ShopifyWebhookController],providers:[ShopifyService,ShopifyHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify},{provide:'SHOPIFY_CLOCK',useValue:()=>clock},{provide:SHOPIFY_WORKER_STORE,useValue:store}]}).compile();
 app=module.createNestApplication({logger:false,bodyParser:false});app.use(shopifyWebhookTransport());app.use(express.json({limit:'2mb'}));app.setGlobalPrefix('v1');
 await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const connect=async(identity,o,shop)=>{const s=ok(await start(identity,{schoolId:o.schoolId,shopDomain:shop}));return ok(await complete(identity,{schoolId:o.schoolId,query:new URL(s.authorizeUrl).search.slice(1)}));};
 const SHOP='ima-bg-'+K().slice(0,8)+'.myshopify.com',SHOP_B='ima-bg-b-'+K().slice(0,8)+'.myshopify.com';
 const a=await connect(manager,A,SHOP),b=await connect(managerB,B,SHOP_B);
 assert.equal(a.firstSync.outcome,'SUCCEEDED');assert.equal(b.firstSync.outcome,'SUCCEEDED');
 const CA=a.connection.connectionId,CB=b.connection.connectionId;
 // Stores left by other proofs in this disposable database are not this proof's: mark them recently synced.
 await q("UPDATE hon.shopify_connections SET last_sync_at=clock_timestamp(),version=version+1 WHERE status='CONNECTED' AND id NOT IN ($1,$2)",[CA,CB]);
 await q('DELETE FROM hon.shopify_sync_requests WHERE connection_id NOT IN ($1,$2)',[CA,CB]);
 const deliver=(topic,shop,id=K(),change={})=>{const d=shopify.fake.webhook(topic,shop,id);return http('/v1/commerce/webhooks/shopify',{body:d.body,headers:{...d.headers,...change}});};

 // 2. Webhooks: verified first, recorded once, no payload.
 let before=await counts();
 const w1=K(),r1=await deliver('products/update',SHOP,w1);
 assert.deepEqual([r1.status,r1.body],[200,{received:true,outcome:'SYNC_REQUESTED',replayed:false}]);
 assert.equal(r1.headers['cache-control'],'no-store');
 let after=await counts();
 assert.deepEqual([after.shopify_webhook_receipts-before.shopify_webhook_receipts,after.shopify_sync_requests-before.shopify_sync_requests],[1,1]);
 assert.deepEqual(Object.keys(await one('SELECT * FROM hon.shopify_webhook_receipts WHERE webhook_id=$1',[w1])).sort(),
  ['connection_id','outcome','received_at','shop_domain','topic','triggered_at','webhook_id']);
 const again=await deliver('products/update',SHOP,w1);
 assert.deepEqual(again.body,{received:true,outcome:'SYNC_REQUESTED',replayed:true});
 assert.deepEqual(await counts(),after,'a repeated delivery changes nothing');
 assert.equal((await deliver('inventory_levels/update',SHOP)).body.outcome,'SYNC_REQUESTED');
 assert.equal((await one('SELECT request_count FROM hon.shopify_sync_requests WHERE connection_id=$1',[CA])).request_count,2);
 before=await counts();
 const forged=shopify.fake.webhook('app/uninstalled',SHOP);
 for(const [why,r] of [
  ['bad signature',await http('/v1/commerce/webhooks/shopify',{body:forged.body,headers:{...forged.headers,'x-shopify-hmac-sha256':'A'.repeat(43)+'='}})],
  ['changed body',await http('/v1/commerce/webhooks/shopify',{body:Buffer.concat([forged.body,Buffer.from(' ')]),headers:forged.headers})],
 ])assert.equal(r.status,401,why);
 assert.equal((await http('/v1/commerce/webhooks/shopify?x=1',{body:forged.body,headers:forged.headers})).status,400);
 assert.equal((await http('/v1/commerce/webhooks/shopify',{body:forged.body,headers:{...forged.headers,cookie:'a=b'}})).status,400);
 assert.deepEqual((await deliver('themes/publish',SHOP)).body,{received:true,outcome:'IGNORED',replayed:false});
 assert.deepEqual(await counts(),before,'a refused or unknown delivery writes nothing');
 assert.equal((await one('SELECT status FROM hon.shopify_connections WHERE id=$1',[CA])).status,'CONNECTED');
 const unknownShop=await deliver('orders/create','nobody-'+K().slice(0,8)+'.myshopify.com');
 assert.equal(unknownShop.body.outcome,'IGNORED');
 for(const topic of ['customers/redact','customers/data_request'])assert.equal((await deliver(topic,SHOP)).body.outcome,'NO_CUSTOMER_DATA');
 after=await counts();
 for(const t of tables)assert.equal(after[t]-before[t],t==='shopify_webhook_receipts'?3:0,t);
 pass('a delivery is checked against the app secret over the exact body before anything is written; each delivery id is recorded once, without payload; change topics mark the store for a sync; unknown shops and topics are ignored; customer privacy topics hold nothing to send or erase');

 // 3. Background sync claims the store Shopify reported, under a lease, by the code-owned principal.
 assert.equal(await store.claim(),null,'never more than one sync per store every two minutes');
 await age(CA,3);
 before=await counts();
 assert.deepEqual(await worker.runOnce(),{claimed:1,succeeded:1,failed:0,needsReconnect:0,errors:0,purgedOrders:0});
 const bg=await one("SELECT * FROM hon.shopify_syncs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1",[CA]);
 assert.deepEqual([bg.source,bg.started_by_principal_id,bg.outcome,bg.products_seen,bg.orders_seen],['WEBHOOK',SYSTEM,'SUCCEEDED',3,3]);
 assert.match(bg.lease_token,/^[0-9a-f-]{36}$/);
 const ev=await one("SELECT a.actor_principal_id,a.source,a.school_id,o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id AND o.event_type=a.action_code AND o.correlation_id=a.correlation_id WHERE a.entity_id=$1 AND a.action_code='commerce.shopify.synced' ORDER BY a.occurred_at DESC LIMIT 1",[CA]);
 assert.deepEqual([ev.actor_principal_id,ev.source,ev.school_id],[SYSTEM,'INTEGRATION',A.schoolId]);
 assert.deepEqual(Object.keys(ev.payload).sort(),['failureCode','internalOnly','orders','outcome','products','removedProducts','removedVariants','source','syncId','variants']);
 after=await counts();
 assert.deepEqual([after.shopify_syncs-before.shopify_syncs,after.audit_events-before.audit_events,after.outbox_events-before.outbox_events],[1,1,1]);
 assert.equal(/fake_(at|rt)_/.test(JSON.stringify(await q('SELECT * FROM hon.shopify_credentials WHERE connection_id=$1',[CA]))),false);
 await age(CA,3);
 assert.equal(await store.claim(),null,'the report was answered by that sync; nothing is due until the next report or six hours');
 // Six hours without a finished sync: SCHEDULED. Store B is due too; the reported or oldest goes first, one at a time.
 await lastSyncAgo(CA,7);await age(CA,3);
 const claimed=await store.claim();
 assert.deepEqual([claimed.source,claimed.schoolId,claimed.connectionId,claimed.shopDomain],['SCHEDULED',A.schoolId,CA,SHOP]);
 assert.deepEqual(Object.keys(claimed.credential).sort(),['accessExpiresAt','keyId','refreshExpiresAt','sealed','version']);
 assert.equal(await store.claim(),null,'a store with a running sync is not claimed again');
 // A person's commands cannot touch it, and it cannot be driven without its lease.
 assert.equal((await sync(manager,{schoolId:A.schoolId})).body.code,'SHOPIFY_SYNC_RUNNING');
 await assert.rejects(()=>database.callShopify('page',[manager.externalSubject,JSON.stringify({schoolId:A.schoolId,syncId:claimed.syncId,kind:'ORDERS',orders:[]})]),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 await assert.rejects(()=>database.callShopify('finishSync',[manager.externalSubject,JSON.stringify({schoolId:A.schoolId,syncId:claimed.syncId,outcome:'SUCCEEDED',failureCode:null})]),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 await assert.rejects(()=>store.page({syncId:claimed.syncId,leaseToken:K(),kind:'ORDERS',orders:[]}),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 await assert.rejects(()=>store.page({syncId:claimed.syncId,kind:'ORDERS',orders:[]}),e=>e.message==='SHOPIFY_INVALID');
 await assert.rejects(()=>store.page({syncId:claimed.syncId,leaseToken:claimed.leaseToken,kind:'ORDERS',orders:[{id:'1'}]}),e=>e.message==='SHOPIFY_INVALID');
 await assert.rejects(()=>store.rotate({syncId:claimed.syncId,leaseToken:claimed.leaseToken,expectedVersion:claimed.credential.version+5,credential:{keyId:'fake-ephemeral',sealed:claimed.credential.sealed,
  accessExpiresAt:new Date(Date.now()+3600_000).toISOString(),refreshExpiresAt:new Date(Date.now()+86400_000).toISOString()}}),e=>e.message==='SHOPIFY_VERSION_CONFLICT');
 assert.deepEqual(await store.page({syncId:claimed.syncId,leaseToken:claimed.leaseToken,kind:'ORDERS',orders:[]}),{syncId:claimed.syncId,productsSeen:0,variantsSeen:0,ordersSeen:0});
 const f=await store.finish({syncId:claimed.syncId,leaseToken:claimed.leaseToken,outcome:'FAILED',failureCode:'SHOPIFY_UNAVAILABLE'});
 assert.deepEqual([f.outcome,f.failureCode,f.connectionStatus],['FAILED','SHOPIFY_UNAVAILABLE','CONNECTED']);
 await assert.rejects(()=>store.finish({syncId:claimed.syncId,leaseToken:claimed.leaseToken,outcome:'SUCCEEDED',failureCode:null}),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 assert.equal((await one('SELECT count(*)::int n FROM hon.shopify_products WHERE connection_id=$1 AND removed',[CA])).n,0,'a failed run removes nothing');
 // The token near expiry is refreshed by the background run and rotated under its version.
 const v0=(await one('SELECT version FROM hon.shopify_credentials WHERE connection_id=$1',[CA])).version;
 clock+=58*60_000;await lastSyncAgo(CA,7);await lastSyncAgo(CB,1);await age(CA,3);
 assert.equal((await worker.runOnce()).succeeded,1);
 assert.equal((await one('SELECT version FROM hon.shopify_credentials WHERE connection_id=$1',[CA])).version,v0+1);
 assert(shopify.fake.calls.includes('refresh:'+SHOP));
 // A school without live HON access is never synced in the background.
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await lastSyncAgo(CA,7);await age(CA,3);
 assert.equal(await store.claim(),null);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 await lastSyncAgo(CA,1);
 // A school busy with a person's command is skipped, not waited for: the next due store is claimed instead.
 await lastSyncAgo(CA,9);await lastSyncAgo(CB,7);await age(CA,3);await age(CB,3);
 const holder=new pg.Client({connectionString:owner.toString(),ssl:false});await holder.connect();
 try{
  await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('shopify-school:'||$1::text,0))",[A.schoolId]);
  const next=await store.claim();assert.equal(next.connectionId,CB,'the busy school is skipped for the next due store');
  assert.equal(await store.claim(),null,'store B is running and A is still busy');
  assert.equal((await store.finish({syncId:next.syncId,leaseToken:next.leaseToken,outcome:'FAILED',failureCode:'SHOPIFY_UNAVAILABLE'})).connectionStatus,'CONNECTED');
  await holder.query('ROLLBACK');
 }finally{await holder.end();}
 const freed=await store.claim();assert.equal(freed.connectionId,CA,'once free, the busy school is claimed on the next run');
 await store.finish({syncId:freed.syncId,leaseToken:freed.leaseToken,outcome:'FAILED',failureCode:'SHOPIFY_UNAVAILABLE'});
 await age(CA,3);await age(CB,3);await lastSyncAgo(CA,1);await lastSyncAgo(CB,1);
 // The guard keeps a run's source and lease, and receipts are never changed or deleted.
 await assert.rejects(()=>q("UPDATE hon.shopify_syncs SET lease_token=gen_random_uuid() WHERE connection_id=$1",[CA]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q("UPDATE hon.shopify_webhook_receipts SET outcome='IGNORED' WHERE webhook_id=$1",[w1]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q('DELETE FROM hon.shopify_webhook_receipts WHERE webhook_id=$1',[w1]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q('TRUNCATE hon.shopify_webhook_receipts'),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 for(const [why,sql,args] of [['a background run needs a lease',"INSERT INTO hon.shopify_syncs(connection_id,organization_id,school_id,started_by_principal_id,source) VALUES($1,$2,$3,$4,'SCHEDULED')",[CA,A.organizationId,A.schoolId,SYSTEM]],
  ['a background run is started by the code-owned principal only',"INSERT INTO hon.shopify_syncs(connection_id,organization_id,school_id,started_by_principal_id,source,lease_token) VALUES($1,$2,$3,$4,'SCHEDULED',gen_random_uuid())",[CA,A.organizationId,A.schoolId,hqPrincipal]],
  ['a person\'s run carries no lease',"INSERT INTO hon.shopify_syncs(connection_id,organization_id,school_id,started_by_principal_id,lease_token) VALUES($1,$2,$3,$4,gen_random_uuid())",[CA,A.organizationId,A.schoolId,hqPrincipal]]])
  await assert.rejects(()=>q(sql,args),e=>e.code==='23514',why);
 pass('the worker claims a store Shopify reported, or one not synced in six hours, one at a time and never twice in two minutes; it runs under a lease as the code-owned principal with INTEGRATION evidence; a person cannot write to it; a wrong or missing lease, bad page or stale version is refused; it refreshes the token; a school without live access is skipped; a school busy with a person\'s command is skipped for the next due store, never waited for');

 // 4. shop/redact for a store still connected changes nothing; app/uninstalled disconnects at once, even mid-run.
 before=await counts();
 assert.equal((await deliver('shop/redact',SHOP_B)).body.outcome,'IGNORED');
 after=await counts();
 for(const t of tables)assert.equal(after[t]-before[t],t==='shopify_webhook_receipts'?1:0,t);
 await lastSyncAgo(CB,7);await age(CB,3);
 const running=await store.claim();assert.equal(running.connectionId,CB);
 const u=await deliver('app/uninstalled',SHOP_B);
 assert.deepEqual(u.body,{received:true,outcome:'UNINSTALLED',replayed:false});
 assert.deepEqual(await one('SELECT status,ended_at IS NOT NULL ended FROM hon.shopify_connections WHERE id=$1',[CB]),{status:'DISCONNECTED',ended:true});
 assert.deepEqual(await one('SELECT sealed,destroyed_at IS NOT NULL d FROM hon.shopify_credentials WHERE connection_id=$1',[CB]),{sealed:null,d:true});
 assert.deepEqual(await one('SELECT outcome,failure_code FROM hon.shopify_syncs WHERE id=$1',[running.syncId]),{outcome:'FAILED',failure_code:'UNINSTALLED'});
 await assert.rejects(()=>store.page({syncId:running.syncId,leaseToken:running.leaseToken,kind:'ORDERS',orders:[]}),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 const uev=await one("SELECT actor_principal_id,source,next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='commerce.shopify.uninstalled'",[CB]);
 assert.deepEqual([uev.actor_principal_id,uev.source,Object.keys(uev.next_state).sort()],[SYSTEM,'INTEGRATION',['shopDomain','webhookId']]);
 assert.equal((await deliver('app/uninstalled',SHOP_B)).body.outcome,'IGNORED','already disconnected');
 assert.equal((await deliver('orders/create',SHOP_B)).body.outcome,'IGNORED','a disconnected store is not marked for sync');
 assert.equal((await one('SELECT count(*)::int n FROM hon.shopify_sync_requests WHERE connection_id=$1',[CB])).n,0);
 assert.equal(ok(await read(managerB,B.schoolId)).connection.status,'DISCONNECTED');
 pass('shop/redact never erases a connected store; app/uninstalled disconnects the store, destroys the sealed pair and ends a running background sync in one transaction, with evidence by the code-owned principal; later change reports for it are ignored');

 // 5. shop/redact after uninstalling erases the store's mirror; the store record (one shop, one school) stays.
 const mirror=async c=>({products:(await one('SELECT count(*)::int n FROM hon.shopify_products WHERE connection_id=$1',[c])).n,
  variants:(await one('SELECT count(*)::int n FROM hon.shopify_variants WHERE connection_id=$1',[c])).n,
  orders:(await one('SELECT count(*)::int n FROM hon.shopify_orders WHERE connection_id=$1',[c])).n,
  lines:(await one('SELECT count(*)::int n FROM hon.shopify_order_lines WHERE connection_id=$1',[c])).n});
 assert.deepEqual(await mirror(CB),{products:3,variants:6,orders:3,lines:4});
 const keepA=await mirror(CA);
 const red=await deliver('shop/redact',SHOP_B);
 assert.equal(red.body.outcome,'SHOP_ERASED');
 assert.deepEqual(await mirror(CB),{products:0,variants:0,orders:0,lines:0});
 assert.deepEqual(await mirror(CA),keepA,'another store is untouched');
 assert.deepEqual(await one('SELECT shop_domain,shop_name,status FROM hon.shopify_connections WHERE id=$1',[CB]),{shop_domain:SHOP_B,shop_name:null,status:'DISCONNECTED'});
 const rev=await one("SELECT next_state FROM hon.audit_events WHERE entity_id=$1 AND action_code='commerce.shopify.shop_erased'",[CB]);
 const {webhookId:_w,...erased}=rev.next_state;assert.match(_w,/^[0-9a-f-]{36}$/);
 assert.deepEqual(erased,{shopDomain:SHOP_B,products:3,variants:6,orders:3,orderLines:4});
 assert.equal((await deliver('shop/redact',SHOP_B,K())).body.outcome,'SHOP_ERASED','a second erase request is answered the same way and finds nothing');
 const back=await connect(managerB,B,SHOP_B);
 assert.deepEqual([back.connection.connectionId,back.connection.status,back.firstSync.outcome,back.firstSync.productsSeen],[CB,'CONNECTED','SUCCEEDED',3]);
 pass('shop/redact after the store left erases its products, variants, orders and lines and its shop name, with counts-only evidence; other stores are untouched; the same school can connect the store again');

 // 6. Shopify refusing the token in a background run: Needs reconnect, sealed pair destroyed.
 shopify.fake.rejectTokens(SHOP);
 await lastSyncAgo(CA,7);await age(CA,3);await lastSyncAgo(CB,1);
 assert.deepEqual(await worker.runOnce(),{claimed:1,succeeded:0,failed:0,needsReconnect:1,errors:0,purgedOrders:0});
 assert.deepEqual(await one('SELECT c.status,k.sealed FROM hon.shopify_connections c JOIN hon.shopify_credentials k ON k.connection_id=c.id WHERE c.id=$1',[CA]),{status:'NEEDS_RECONNECT',sealed:null});
 assert.equal((await deliver('products/update',SHOP)).body.outcome,'IGNORED','a store waiting to reconnect is not marked for sync');
 assert.equal(await store.claim(),null);
 pass('a background run Shopify refuses moves the store to Needs reconnect and destroys the sealed pair; such a store is neither marked nor claimed');
 // 7. Retention (0470): a mirrored order placed more than 60 days ago is deleted with its lines.
 const oldOrder=async(c,o,id,days)=>{
  const last=(await one('SELECT id FROM hon.shopify_syncs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1',[c])).id;
  await q("INSERT INTO hon.shopify_orders(connection_id,shopify_id,organization_id,school_id,name,placed_at,currency,subtotal,discounts,tax,total,last_sync_id) VALUES($1,$2::bigint,$3,$4,'#R'||$2::text,clock_timestamp()-make_interval(days=>$5),'USD',10,0,0,10,$6)",[c,id,o.organizationId,o.schoolId,days,last]);
  await q("INSERT INTO hon.shopify_order_lines(connection_id,order_shopify_id,line_no,title,quantity,unit_price) VALUES($1,$2,1,'Old line',1,10)",[c,id]);
 };
 const has=async(c,id)=>(await one('SELECT count(*)::int n FROM hon.shopify_orders WHERE connection_id=$1 AND shopify_id=$2',[c,id])).n;
 // A successful sync (here a person's Sync now on store B) deletes that store's expired orders and keeps recent ones.
 await oldOrder(CB,B,9000000001,61);await oldOrder(CB,B,9000000002,59);
 const keepB=(await mirror(CB)).orders;
 await age(CB,3);
 assert.equal(ok(await sync(managerB,{schoolId:B.schoolId})).outcome,'SUCCEEDED');
 assert.deepEqual([await has(CB,9000000001),await has(CB,9000000002),(await mirror(CB)).orders],[0,1,keepB-1]);
 assert.equal((await one('SELECT count(*)::int n FROM hon.shopify_order_lines WHERE connection_id=$1 AND order_shopify_id=9000000001',[CB])).n,0);
 // A failed run deletes nothing.
 await oldOrder(CB,B,9000000003,90);await age(CB,3);await lastSyncAgo(CB,7);
 const run=await store.claim();assert.equal(run.connectionId,CB);
 await store.finish({syncId:run.syncId,leaseToken:run.leaseToken,outcome:'FAILED',failureCode:'SHOPIFY_UNAVAILABLE'});
 assert.equal(await has(CB,9000000003),1,'a failed run keeps everything');
 // The worker sweep reaches stores that no longer sync (A waits to reconnect) and runs before any claim.
 await oldOrder(CA,A,9000000004,70);await lastSyncAgo(CB,1);await age(CB,3);
 const swept=await worker.runOnce();
 assert.deepEqual([swept.claimed,swept.purgedOrders>=2],[0,true]);
 assert.deepEqual([await has(CA,9000000004),await has(CB,9000000003),await has(CB,9000000002)],[0,0,1]);
 assert.deepEqual(await store.purgeExpiredOrders(),{orders:0,lines:0,more:false});
 assert.equal((await one("SELECT count(*)::int n FROM hon.shopify_orders WHERE placed_at<clock_timestamp()-interval '60 days'")).n,0);
 for(const f of ['hon.purge_expired_shopify_orders()','hon.shopify_purge_expired_orders_on_success()']){
  assert.equal((await one("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') ok",[runtime.username,f])).ok,false,f);
  assert.equal((await one("SELECT has_function_privilege('public',$1::regprocedure,'EXECUTE') ok",[f])).ok,false,f);
 }
 pass('retention: a successful sync deletes that store\'s orders placed more than 60 days ago and their lines, keeps recent ones, and a failed run deletes nothing; the worker sweep also clears stores that no longer sync; the runtime cannot call either');
 console.log('PASS SHOPIFY-BG all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),workerConn.end(),database.onModuleDestroy()]);
}
