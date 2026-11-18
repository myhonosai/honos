/** 0405 Shopify connection (SH1). Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). The Shopify side is the in-memory fake; nothing leaves the machine. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {request} from 'node:http';
import pg from 'pg';
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
const tables=['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products','shopify_variants','shopify_orders','shopify_order_lines'];
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
const start=cmd('connect'),complete=cmd('connect/complete'),sync=cmd('sync'),disconnect=cmd('disconnect');
const queryOf=url=>new URL(url).search.slice(1);

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL.
 for(const t of tables)for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+' '+p);
 for(const t of tables)assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]))[0],{r:true,f:true,n:0});
 const entries=['read_shopify','read_shopify_catalog','read_shopify_orders','start_shopify_connect','claim_shopify_connect','record_shopify_connection',
  'begin_shopify_sync','rotate_shopify_credential','record_shopify_sync_page','finish_shopify_sync','disconnect_shopify',
  // 0496 product changes (SH4a).
  'read_shopify_product_changes','propose_shopify_product_change','cancel_shopify_product_change','approve_shopify_product_change',
  'rotate_shopify_change_credential','record_shopify_product_change_result',
  // 0528 Marcus merch ideas (CS-M2).
  'begin_shopify_merch_ideas','plan_shopify_merch_ideas','prepare_shopify_merch_ideas','fail_shopify_merch_ideas','record_shopify_merch_ideas',
  'read_shopify_merch_ideas','close_shopify_merch_ideas'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE '%shopify%')");
 for(const e of entries)assert(fns.some(f=>f.proname===e),e);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.shopify_credentials'),e=>e.code==='42501');
 assert.deepEqual(await q("SELECT code,is_sensitive,is_staff_assignable FROM hon.permissions WHERE code LIKE 'commerce.shopify.%' ORDER BY code"),
  [{code:'commerce.shopify.manage',is_sensitive:true,is_staff_assignable:true},{code:'commerce.shopify.read',is_sensitive:false,is_staff_assignable:true}]);
 pass('Shopify tables are forced-RLS private; the runtime executes only the eleven entry points; commerce.shopify.read and .manage exist');

 // Fixture: two schools with paid access; manager, reader, no-Shopify staff, other-school manager, outsider.
 const hq={subject:'shopify-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Shopify synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Shopify synthetic','Shopify synthetic','Shopify school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'shopify-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.role_permissions rp JOIN hon.roles r ON r.id=rp.role_id WHERE r.organization_id=$1 AND r.is_system_role AND r.code='OWNER' AND rp.permission_code LIKE 'commerce.shopify.%'",[A.organizationId]))[0].n,2,
  'a school owner holds both Shopify permissions');
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,await customRole(A,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 const second=person('second-manager');await grant(A,await human(second,'Second manager'),await customRole(A,'CUSTOM_SHOPIFY_MANAGE_2',['school.view','commerce.shopify.manage']));
 const reader=person('reader');await grant(A,await human(reader,'Reader'),await customRole(A,'CUSTOM_SHOPIFY_READ',['school.view','commerce.shopify.read']));
 const staff=person('staff');await grant(A,await human(staff,'Staff'),await customRole(A,'CUSTOM_PEOPLE',['school.view','people.read']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 let clock=Date.now();
 const shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'});assert.equal(shopify.adapter.kind,'FAKE');shopify.fake.now=()=>clock;
 const module=await Test.createTestingModule({controllers:[ShopifyController],providers:[ShopifyService,ShopifyHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify},{provide:'SHOPIFY_CLOCK',useValue:()=>clock}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 const SHOP='ima-proof-'+K().slice(0,8)+'.myshopify.com';

 // 2. Before connecting: permissions and scope.
 assert.deepEqual(ok(await read(reader,A.schoolId)),{schoolId:A.schoolId,canManage:false,connectEnabled:true,autoSync:false,connection:null,counts:null,summary:null});
 assert.equal(ok(await read(manager,A.schoolId)).canManage,true);
 assert.deepEqual(ok(await read(reader,A.schoolId,'/catalog')),{schoolId:A.schoolId,currency:null,products:[]});
 for(const who of [staff,outsider,managerB])await denied(()=>read(who,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 for(const who of [reader,staff,managerB])await denied(()=>start(who,{schoolId:A.schoolId,shopDomain:SHOP}),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>start(manager,{schoolId:A.schoolId,shopDomain:SHOP},{command:'school-pos'}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>start(manager,{schoolId:A.schoolId,shopDomain:'shop.example.com'}),400,'SHOPIFY_INVALID');
 await denied(()=>start(manager,{schoolId:A.schoolId,shopDomain:SHOP,extra:1}),400,'SHOPIFY_INVALID');
 await denied(()=>sync(manager,{schoolId:A.schoolId}),409,'SHOPIFY_NOT_CONNECTED');
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>read(manager,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>start(manager,{schoolId:A.schoolId,shopDomain:SHOP}),403,'SHOPIFY_FORBIDDEN');
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 pass('read needs commerce.shopify.read or .manage at that school; connecting needs .manage; other schools, outsiders, suspended access, wrong transport and bad input are refused and write nothing');

 // 3. Connect: only the state hash is stored; the approval is single-use and bound to the person, school and shop.
 const s1=ok(await start(manager,{schoolId:A.schoolId,shopDomain:SHOP.replace('.myshopify.com','').toUpperCase()}));
 assert.equal(s1.shopDomain,SHOP);assert(s1.authorizeUrl.startsWith(origin+'/staff/billing/shopify/return?'));
 const state=new URL(s1.authorizeUrl).searchParams.get('state');
 const intent=(await q('SELECT * FROM hon.shopify_connect_intents WHERE school_id=$1',[A.schoolId]))[0];
 assert.equal(intent.state_hash,(await q("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') h",[state]))[0].h);
 assert.equal(JSON.stringify(await q('SELECT * FROM hon.shopify_connect_intents')).includes(state),false);
 const query=queryOf(s1.authorizeUrl);
 await denied(()=>complete(second,{schoolId:A.schoolId,query}),400,'SHOPIFY_CONNECT_STATE_INVALID');
 await denied(()=>complete(managerB,{schoolId:B.schoolId,query}),400,'SHOPIFY_CONNECT_STATE_INVALID');
 const tampered=new URLSearchParams(query);tampered.set('state','x'.repeat(43));
 await denied(()=>complete(manager,{schoolId:A.schoolId,query:tampered.toString()}),400,'SHOPIFY_CONNECT_STATE_INVALID');
 const c0=await counts();
 const connected=ok(await complete(manager,{schoolId:A.schoolId,query}));
 assert.equal(connected.connection.status,'CONNECTED');assert.equal(connected.connection.shopDomain,SHOP);
 assert.deepEqual([connected.firstSync.outcome,connected.firstSync.productsSeen,connected.firstSync.variantsSeen,connected.firstSync.ordersSeen],['SUCCEEDED',3,6,3]);
 await denied(()=>complete(manager,{schoolId:A.schoolId,query}),400,'SHOPIFY_CONNECT_STATE_INVALID');
 const c1=await counts();
 for(const [t,d] of Object.entries({shopify_connections:1,shopify_credentials:1,shopify_syncs:1,shopify_products:3,shopify_variants:6,shopify_orders:3,shopify_order_lines:4,audit_events:2,outbox_events:2}))
  assert.equal(Number(c1[t]),Number(c0[t])+d,t);
 const cred=(await q('SELECT k.* FROM hon.shopify_credentials k JOIN hon.shopify_connections c ON c.id=k.connection_id WHERE c.shop_domain=$1',[SHOP]))[0];
 assert.match(cred.sealed,/^v1\./);assert.equal(cred.key_id,'fake-ephemeral');
 const dump=[];for(const t of counted)dump.push(await q('SELECT * FROM hon.'+t+(t.startsWith('shopify')?'':' WHERE school_id=$1'),t.startsWith('shopify')?[]:[A.schoolId]));const everything=JSON.stringify(dump);
 assert.equal(/fake_(at|rt)_/.test(everything),false,'no token in clear anywhere in the database');
 const events=await q("SELECT a.action_code,a.next_state,o.payload FROM hon.audit_events a JOIN hon.outbox_events o ON o.aggregate_id=a.entity_id AND o.event_type=a.action_code WHERE a.school_id=$1 AND a.action_code LIKE 'commerce.shopify.%' ORDER BY a.occurred_at",[A.schoolId]);
 assert.deepEqual(events.map(e=>e.action_code),['commerce.shopify.connect.started','commerce.shopify.connected','commerce.shopify.synced']);
 assert.deepEqual(Object.keys(events[1].payload).sort(),['intentId','internalOnly','reconnected','shopDomain']);
 for(const e of events)assert.equal(JSON.stringify(e).includes(state),false);
 assert.deepEqual(Object.keys(events[2].payload).sort(),['failureCode','internalOnly','orders','outcome','products','removedProducts','removedVariants','syncId','variants']);
 pass('connect stores only the SHA-256 of the state; the approval works once, for the person, school and shop that started it; tokens reach the database only sealed; the first sync mirrors 3 products, 6 variants, 3 orders; evidence carries ids and counts');

 // 4. Reads: counts, 30-day summary (the 40-day-old order is outside it), margins, orders.
 const view=ok(await read(reader,A.schoolId));
 assert.deepEqual(view.counts,{products:3,variants:6,lowStock:2,orders:3});
 assert.deepEqual({...view.summary,topProducts:view.summary.topProducts.length},{days:30,orders:2,sales:290.73,averageOrder:145.37,itemsSold:4,lineSales:310,coveredSales:175,
  estimatedGrossProfit:99.75,topProducts:3});
 const catalog=ok(await read(reader,A.schoolId,'/catalog'));
 assert.deepEqual(catalog.products.map(p=>p.title),['School hoodie','Sparring gear set','Student uniform']);
 const uni=catalog.products[2].variants;
 assert.deepEqual(uni.map(v=>[v.sku,v.price,v.unitCost,v.margin,v.marginPercent,v.inventoryQuantity,v.lowStock]),
  [['UNI-1',65,28,37,56.9,8,false],['UNI-2',65,28,37,56.9,2,true],['UNI-3',70,30,40,57.1,0,true]]);
 assert.equal(catalog.products[0].variants[0].tracked,false);assert.equal(catalog.products[0].variants[0].lowStock,false);
 const orders=ok(await read(reader,A.schoolId,'/orders'));
 assert.deepEqual(orders.orders.map(o=>o.name),['#1001','#1002','#1003']);assert.equal(orders.orders[1].lines.length,2);
 for(const who of [staff,managerB])await denied(()=>read(who,A.schoolId,'/catalog'),403,'SHOPIFY_FORBIDDEN');
 pass('the page reads counts, a 30-day sales summary with estimated gross profit only where cost is known, catalog margins and low stock (3 or fewer), and orders');

 // 5. Another school cannot take the store; this school cannot add a second store.
 await denied(()=>start(managerB,{schoolId:B.schoolId,shopDomain:SHOP}),409,'SHOPIFY_SHOP_TAKEN');
 await denied(()=>start(manager,{schoolId:A.schoolId,shopDomain:'other-'+SHOP}),409,'SHOPIFY_OTHER_STORE_CONNECTED');
 pass('one store belongs to one school; a school has one live store');

 // 6. Resync: removed products are marked removed, changed stock lands; a refresh near expiry rotates the sealed pair.
 const store=JSON.parse(JSON.stringify((await shopify.adapter.catalog(SHOP,shopify.vault.open({connectionId:connected.connection.connectionId,shopDomain:SHOP},cred.key_id,cred.sealed).accessToken)).products));
 store[0].variants[1].inventoryQuantity=40;shopify.fake.setStore(SHOP,{products:store.slice(0,2)});
 clock+=58*60_000;
 const r2=ok(await sync(second,{schoolId:A.schoolId}));
 assert.deepEqual([r2.outcome,r2.productsSeen,r2.removedProducts,r2.removedVariants],['SUCCEEDED',2,1,1]);
 assert(shopify.fake.calls.includes('refresh:'+SHOP));
 const cred2=(await q('SELECT version,sealed,rotated_at FROM hon.shopify_credentials WHERE connection_id=$1',[connected.connection.connectionId]))[0];
 assert.equal(cred2.version,2);assert.notEqual(cred2.sealed,cred.sealed);assert(cred2.rotated_at);
 const after=ok(await read(reader,A.schoolId,'/catalog'));
 assert.deepEqual(after.products.map(p=>p.title),['Sparring gear set','Student uniform']);
 assert.equal(after.products[1].variants[1].inventoryQuantity,40);
 assert.equal(ok(await read(reader,A.schoolId)).counts.orders,3,'orders are kept');
 await denied(()=>sync(reader,{schoolId:A.schoolId}),403,'SHOPIFY_FORBIDDEN');
 pass('a resync marks products Shopify no longer has as removed and updates stock; a token about to expire is refreshed and the sealed pair rotated under its version');

 // 7. One running sync per store; a stale one is abandoned after 15 minutes.
 const begun=await database.callShopify('beginSync',[manager.externalSubject,JSON.stringify({schoolId:A.schoolId})]);
 await denied(()=>sync(manager,{schoolId:A.schoolId}),409,'SHOPIFY_SYNC_RUNNING');
 assert.equal(ok(await read(reader,A.schoolId)).connection.syncRunning,true);
 await assert.rejects(()=>database.callShopify('page',[second.externalSubject,JSON.stringify({schoolId:A.schoolId,syncId:begun.syncId,kind:'ORDERS',orders:[]})]),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 await assert.rejects(()=>database.callShopify('rotate',[manager.externalSubject,JSON.stringify({schoolId:A.schoolId,syncId:begun.syncId,expectedVersion:1,
  credential:{keyId:'fake-ephemeral',sealed:cred2.sealed,accessExpiresAt:new Date(Date.now()+3600_000).toISOString(),refreshExpiresAt:new Date(Date.now()+86400_000).toISOString()}})]),e=>e.message==='SHOPIFY_VERSION_CONFLICT');
 await q("ALTER TABLE hon.shopify_syncs DISABLE TRIGGER shopify_syncs_guard");
 await q("UPDATE hon.shopify_syncs SET started_at=clock_timestamp()-interval '16 minutes' WHERE id=$1",[begun.syncId]);
 await q("ALTER TABLE hon.shopify_syncs ENABLE TRIGGER shopify_syncs_guard");
 assert.equal(ok(await sync(manager,{schoolId:A.schoolId})).outcome,'SUCCEEDED');
 assert.equal((await q('SELECT outcome FROM hon.shopify_syncs WHERE id=$1',[begun.syncId]))[0].outcome,'ABANDONED');
 pass('a second sync is refused while one runs; only the person who started a run can write to it; a stale credential version is refused; a run older than 15 minutes is abandoned');

 // 8. Shopify refusing the token: NEEDS_RECONNECT, and the sealed pair is destroyed in the same transaction.
 shopify.fake.rejectTokens(SHOP);
 const r3=ok(await sync(manager,{schoolId:A.schoolId}));
 assert.deepEqual([r3.outcome,r3.failureCode,r3.connection.status],['NEEDS_RECONNECT','TOKEN_REJECTED','NEEDS_RECONNECT']);
 assert.deepEqual((await q('SELECT sealed,destroyed_at IS NOT NULL d FROM hon.shopify_credentials WHERE connection_id=$1',[connected.connection.connectionId]))[0],{sealed:null,d:true});
 await denied(()=>sync(manager,{schoolId:A.schoolId}),409,'SHOPIFY_NOT_CONNECTED');
 assert.equal(ok(await read(reader,A.schoolId,'/catalog')).products.length,2,'the mirror stays readable');
 shopify.fake.rejectTokens(SHOP,false);
 const s2=ok(await start(manager,{schoolId:A.schoolId,shopDomain:SHOP}));
 const back=ok(await complete(manager,{schoolId:A.schoolId,query:queryOf(s2.authorizeUrl)}));
 assert.equal(back.connection.connectionId,connected.connection.connectionId,'reconnecting continues the same store record');
 assert.equal(back.connection.status,'CONNECTED');assert.equal(back.firstSync.outcome,'SUCCEEDED');
 pass('a refused token moves the store to Needs reconnect and destroys the sealed pair; the mirror stays; reconnecting revives the same record');

 // 9. Disconnect: version-checked; the pair is destroyed; the database refuses a CONNECTED row without one.
 const live=ok(await read(reader,A.schoolId)).connection;
 await denied(()=>disconnect(manager,{schoolId:A.schoolId,connectionId:live.connectionId,expectedVersion:live.version-1}),409,'SHOPIFY_VERSION_CONFLICT');
 await denied(()=>disconnect(reader,{schoolId:A.schoolId,connectionId:live.connectionId,expectedVersion:live.version}),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>disconnect(managerB,{schoolId:B.schoolId,connectionId:live.connectionId,expectedVersion:live.version}),404,'SHOPIFY_NOT_FOUND');
 const gone=ok(await disconnect(manager,{schoolId:A.schoolId,connectionId:live.connectionId,expectedVersion:live.version}));
 assert.equal(gone.connection.status,'DISCONNECTED');
 assert.deepEqual((await q('SELECT sealed,destroyed_at IS NOT NULL d FROM hon.shopify_credentials WHERE connection_id=$1',[live.connectionId]))[0],{sealed:null,d:true});
 await assert.rejects(()=>q("UPDATE hon.shopify_connections SET status='CONNECTED',ended_at=NULL,version=version+1 WHERE id=$1",[live.connectionId]),e=>e.message==='SHOPIFY_CREDENTIAL_STATE');
 await assert.rejects(()=>q("UPDATE hon.shopify_connections SET school_id=$2,version=version+1 WHERE id=$1",[live.connectionId,B.schoolId]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q('DELETE FROM hon.shopify_credentials WHERE connection_id=$1',[live.connectionId]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q("UPDATE hon.shopify_credentials SET version=version+1,destroyed_at=NULL WHERE connection_id=$1",[live.connectionId]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q('TRUNCATE hon.shopify_orders CASCADE'),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 assert.equal(ok(await read(reader,A.schoolId)).connection.status,'DISCONNECTED');
 pass('disconnect is version-checked, refused to readers and other schools, and destroys the sealed pair; the database refuses CONNECTED without a live pair, moving a store, deleting or reviving a pair, and truncation');

 // 10. Authority ends mid-flow: the manager loses the grant between start and complete.
 const s3=ok(await start(second,{schoolId:A.schoolId,shopDomain:SHOP}));
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[managerGrant,hqPrincipal]);
 await denied(()=>sync(manager,{schoolId:A.schoolId}),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>start(manager,{schoolId:A.schoolId,shopDomain:SHOP}),403,'SHOPIFY_FORBIDDEN');
 const s3done=ok(await complete(second,{schoolId:A.schoolId,query:queryOf(s3.authorizeUrl)}));
 assert.equal(s3done.connection.status,'CONNECTED');
 // Rate limit: at most 10 connect attempts per school per hour (this school has made 3).
 for(let i=0;i<7;i++)ok(await start(second,{schoolId:A.schoolId,shopDomain:SHOP}));
 await denied(()=>start(second,{schoolId:A.schoolId,shopDomain:SHOP}),429,'SHOPIFY_RATE_LIMITED');
 pass('a revoked grant stops sync and connect at once; another manager can still reconnect; connect attempts are limited to 10 per school per hour');
 console.log('PASS SHOPIFY all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy()]);
}
