/** 0609 Shopify storefront blocks (TB2): settings HON keeps and publishes to its own app-data metafield for its theme app extension; no theme access. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). The Shopify side is the in-memory fake; nothing leaves the machine. */
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
const tables=['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products','shopify_variants','shopify_orders','shopify_order_lines','shopify_product_changes','shopify_finance','shopify_storefronts'];
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
const queryOf=url=>new URL(url).search.slice(1);const sfRead=(identity,s)=>read(identity,s,'/storefront');const sfSave=cmd('storefront'),sfPublish=cmd('storefront/publish');
let shopify,SHOP;
try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. ACL; TB1 (0600) is gone.
 assert.deepEqual((await q("SELECT to_regclass('hon.shopify_theme_drafts') d,to_regclass('hon.shopify_theme_edits') e"))[0],{d:null,e:null});
 assert.equal((await q("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify_theme%'"))[0].n,0);
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.shopify_storefronts',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.shopify_storefronts'::regclass"))[0],{r:true,f:true,n:0});
 const entries=['read_shopify','read_shopify_catalog','read_shopify_orders','start_shopify_connect','claim_shopify_connect','record_shopify_connection',
  'begin_shopify_sync','rotate_shopify_credential','record_shopify_sync_page','finish_shopify_sync','disconnect_shopify',
  'read_shopify_product_changes','propose_shopify_product_change','cancel_shopify_product_change','approve_shopify_product_change',
  'rotate_shopify_change_credential','record_shopify_product_change_result','read_shopify_finance','record_shopify_finance',
  'read_shopify_storefront','save_shopify_storefront','begin_shopify_storefront_publish','rotate_shopify_storefront_credential','finish_shopify_storefront_publish',
  // 0613 POS sells Shopify products (SH2).
  'begin_pos_shopify_stock','rotate_pos_shopify_credential','finish_pos_shopify_stock',
  // 0596 Marcus merch ideas (CS-M2).
  'begin_shopify_merch_ideas','plan_shopify_merch_ideas','prepare_shopify_merch_ideas','fail_shopify_merch_ideas','record_shopify_merch_ideas',
  'read_shopify_merch_ideas','close_shopify_merch_ideas'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify%'");
 for(const e of [...entries,'shopify_storefront_on_end','shopify_storefront_settings_ok','shopify_storefront_locked','shopify_storefront_leased'])assert(fns.some(f=>f.proname===e),e);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 pass('TB1 theme tables and functions are gone; storefronts is a forced-RLS private table; the runtime executes the 24 Shopify entry points (31 with the 0596 merch ideas) and nothing else; helpers are closed to it and to PUBLIC');

 // Fixture: two schools with paid access; manager, reader, other-school manager.
 const hq={subject:'shopify-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Shopify synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Shopify synthetic','Shopify synthetic','Shopify school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'shopify-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager');const managerGrant=await grant(A,await human(manager,'Manager'),await customRole(A,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 const reader=person('reader');await grant(A,await human(reader,'Reader'),await customRole(A,'CUSTOM_SHOPIFY_READ',['school.view','commerce.shopify.read']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 let clock=Date.now();
 shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'});assert.equal(shopify.adapter.kind,'FAKE');shopify.fake.now=()=>clock;
 const module=await Test.createTestingModule({controllers:[ShopifyController],providers:[ShopifyService,ShopifyHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify},{provide:'SHOPIFY_CLOCK',useValue:()=>clock}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 SHOP='ima-sf-'+K().slice(0,8)+'.myshopify.com';
 const connectWith=async(who,extra={})=>{const s=ok(await start(who,{schoolId:A.schoolId,shopDomain:SHOP,...extra}));return ok(await complete(who,{schoolId:A.schoolId,query:queryOf(s.authorizeUrl)}));};
 const writes=()=>shopify.fake.calls.filter(c=>c.startsWith('storefrontSettings:')).length;
 const settings={primaryColor:'#C8102E',accentColor:'#FFD100',sizeGuideTitle:'Uniform sizes',sizeGuideText:'Youth S 110-120 cm\nYouth M 120-130 cm',pickupNote:'Pick up at the front desk after class.'};

 // 2. Only commerce.shopify.manage at the exact school; settings are closed; the command header is required.
 assert.deepEqual(ok(await sfRead(manager,A.schoolId)),{schoolId:A.schoolId,connected:false,shopDomain:null,settings:null,settingsVersion:null,savedAt:null,
  publishedVersion:null,publishedAt:null,publishStatus:'NEVER',failureCode:null,busy:false,links:null});
 await denied(()=>sfSave(manager,{schoolId:A.schoolId,expectedVersion:null,settings}),409,'SHOPIFY_NOT_CONNECTED');
 const first=await connectWith(manager);assert.equal(first.firstSync.outcome,'SUCCEEDED');
 assert.equal((await q('SELECT scopes FROM hon.shopify_connections WHERE shop_domain=$1',[SHOP]))[0].scopes,'read_products,read_inventory,read_orders','no theme scope is ever asked for');
 await denied(()=>sfRead(reader,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>sfRead(managerB,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>sfSave(managerB,{schoolId:A.schoolId,expectedVersion:null,settings}),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>sfSave(reader,{schoolId:A.schoolId,expectedVersion:null,settings}),403,'SHOPIFY_FORBIDDEN');
 for(const bad of [{...settings,primaryColor:'#c8102e'},{...settings,primaryColor:'red;}body{display:none'},{...settings,script:'<script>'},{...settings,sizeGuideText:null},{...settings,pickupNote:'x'.repeat(501)}])
  await denied(()=>sfSave(manager,{schoolId:A.schoolId,expectedVersion:null,settings:bad}),400,'SHOPIFY_INVALID');
 await denied(()=>sfSave(manager,{schoolId:A.schoolId,expectedVersion:null,settings},{command:'wrong'}),403);
 await denied(()=>sfPublish(manager,{schoolId:A.schoolId,settingsVersion:1}),404,'SHOPIFY_NOT_FOUND');
 assert.equal(writes(),0);
 pass('only commerce.shopify.manage at the exact school reads, saves or publishes; connecting asks for no theme scope; settings are closed and colors strict; the command header is required; nothing to publish before a save');

 // 3. Saving keeps the settings in HON only, versioned; a stale version is refused.
 const s1=ok(await sfSave(manager,{schoolId:A.schoolId,expectedVersion:null,settings}));
 assert.deepEqual([s1.connected,s1.shopDomain,s1.settingsVersion,s1.publishStatus,s1.publishedVersion,s1.busy],[true,SHOP,1,'NEVER',null,false]);
 assert.deepEqual(s1.settings,settings);
 assert.match(s1.links.sizeGuide,new RegExp('^https://'+SHOP.replace(/\./g,'\\.')+'/admin/themes/current/editor\\?template=product&addAppBlockId=hon-fake-shopify-app/size-guide&target=mainSection$'));
 await denied(()=>sfSave(manager,{schoolId:A.schoolId,expectedVersion:null,settings}),409,'SHOPIFY_VERSION_CONFLICT');
 const s2=ok(await sfSave(manager,{schoolId:A.schoolId,expectedVersion:1,settings:{...settings,accentColor:null}}));assert.equal(s2.settingsVersion,2);
 await denied(()=>sfSave(manager,{schoolId:A.schoolId,expectedVersion:1,settings}),409,'SHOPIFY_VERSION_CONFLICT');
 assert.equal(writes(),0,'saving never reaches Shopify');
 pass('saving keeps the settings in HON only, versioned (null only for the first save); a stale version is refused; nothing reaches Shopify');

 // 4. Publishing writes exactly the saved version to HON's metafield; a stale version is refused.
 await denied(()=>sfPublish(manager,{schoolId:A.schoolId,settingsVersion:1}),409,'SHOPIFY_VERSION_CONFLICT');
 const p1=ok(await sfPublish(manager,{schoolId:A.schoolId,settingsVersion:2}));
 assert.deepEqual([p1.outcome,p1.failureCode,p1.storefront.publishStatus,p1.storefront.publishedVersion,p1.storefront.busy],['PUBLISHED',null,'PUBLISHED',2,false]);
 assert.deepEqual(JSON.parse(shopify.fake.storefrontSettings(SHOP)),{...settings,accentColor:null});
 assert.equal(writes(),1);
 pass('publishing writes exactly the saved version to HON\'s app-data metafield and records it as live; a stale version is refused');

 // 5. A refused write is FAILED and leaves the live version; a lost answer is UNKNOWN; publishing again settles it.
 const s3=ok(await sfSave(manager,{schoolId:A.schoolId,expectedVersion:2,settings}));
 shopify.fake.writeFault='REJECT';
 const rej=ok(await sfPublish(manager,{schoolId:A.schoolId,settingsVersion:s3.settingsVersion}));
 assert.deepEqual([rej.outcome,rej.failureCode,rej.storefront.publishStatus,rej.storefront.publishedVersion],['FAILED','SHOPIFY_REJECTED','FAILED',2]);
 shopify.fake.writeFault='LOSE_ANSWER';
 const lost=ok(await sfPublish(manager,{schoolId:A.schoolId,settingsVersion:3}));
 assert.deepEqual([lost.outcome,lost.storefront.publishStatus,lost.storefront.publishedVersion],['UNKNOWN','UNKNOWN',2]);
 const again=ok(await sfPublish(manager,{schoolId:A.schoolId,settingsVersion:3}));
 assert.deepEqual([again.outcome,again.storefront.publishedVersion],['PUBLISHED',3]);
 assert.deepEqual(JSON.parse(shopify.fake.storefrontSettings(SHOP)),settings);
 pass('a refused write is FAILED and keeps the live version; a lost answer is UNKNOWN; publishing again settles it');

 // 6. The database: one lease per store, results only under the exact lease and person, an expired lease settles UNKNOWN, 100 a day.
 const direct=(fn,who,input)=>restricted.query(`SELECT hon.${fn}($1,$2::jsonb) d`,[who.externalSubject,JSON.stringify(input)]);
 const b1=(await direct('begin_shopify_storefront_publish',manager,{schoolId:A.schoolId,settingsVersion:3})).rows[0].d;
 assert.equal(typeof b1.credential.sealed,'string');assert.equal(JSON.stringify(b1).includes('fake_at_'),false);assert.deepEqual(b1.settings,settings);
 assert.equal(ok(await sfRead(manager,A.schoolId)).busy,true);
 await assert.rejects(()=>direct('begin_shopify_storefront_publish',manager,{schoolId:A.schoolId,settingsVersion:3}),e=>e.message==='SHOPIFY_STOREFRONT_BUSY');
 await denied(()=>sfPublish(manager,{schoolId:A.schoolId,settingsVersion:3}),409,'SHOPIFY_STOREFRONT_BUSY');
 const fin=(who,over)=>direct('finish_shopify_storefront_publish',who,{schoolId:A.schoolId,leaseToken:b1.leaseToken,outcome:'PUBLISHED',failureCode:null,...over});
 await assert.rejects(()=>fin(manager,{leaseToken:K()}),e=>e.message==='SHOPIFY_STOREFRONT_NOT_LEASED');
 await assert.rejects(()=>fin(reader,{}),e=>e.message==='SHOPIFY_FORBIDDEN');
 await assert.rejects(()=>fin(manager,{outcome:'PUBLISHED',failureCode:'X'}),e=>e.message==='SHOPIFY_INVALID');
 await assert.rejects(()=>fin(manager,{outcome:'FAILED',failureCode:null}),e=>e.message==='SHOPIFY_INVALID');
 await assert.rejects(()=>fin(manager,{outcome:'DONE'}),e=>e.message==='SHOPIFY_INVALID');
 await fin(manager,{outcome:'FAILED',failureCode:'SHOPIFY_REJECTED'});
 await assert.rejects(()=>fin(manager,{}),e=>e.message==='SHOPIFY_STOREFRONT_NOT_LEASED','a lease is used once');
 const b2=(await direct('begin_shopify_storefront_publish',manager,{schoolId:A.schoolId,settingsVersion:3})).rows[0].d;
 await q("UPDATE hon.shopify_storefronts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lease_token=$1",[b2.leaseToken]);
 const expired=ok(await sfRead(manager,A.schoolId));assert.deepEqual([expired.publishStatus,expired.failureCode,expired.busy],['UNKNOWN','LEASE_EXPIRED',false]);
 await assert.rejects(()=>direct('finish_shopify_storefront_publish',manager,{schoolId:A.schoolId,leaseToken:b2.leaseToken,outcome:'PUBLISHED',failureCode:null}),e=>e.message==='SHOPIFY_STOREFRONT_NOT_LEASED');
 const b3=(await direct('begin_shopify_storefront_publish',manager,{schoolId:A.schoolId,settingsVersion:3})).rows[0].d;
 assert.notEqual(b3.leaseToken,b2.leaseToken);
 await direct('finish_shopify_storefront_publish',manager,{schoolId:A.schoolId,leaseToken:b3.leaseToken,outcome:'PUBLISHED',failureCode:null});
 await q("UPDATE hon.shopify_storefronts SET publishes_that_day=100 WHERE school_id=$1",[A.schoolId]);
 await denied(()=>sfPublish(manager,{schoolId:A.schoolId,settingsVersion:3}),429,'SHOPIFY_STOREFRONT_LIMIT');
 await q("UPDATE hon.shopify_storefronts SET publish_day=publish_day-1 WHERE school_id=$1",[A.schoolId]);
 assert.equal(ok(await sfPublish(manager,{schoolId:A.schoolId,settingsVersion:3})).outcome,'PUBLISHED','a new UTC day resets the count');
 assert.equal((await q('SELECT publishes_that_day n FROM hon.shopify_storefronts WHERE school_id=$1',[A.schoolId]))[0].n,1);
 await assert.rejects(()=>q('TRUNCATE hon.shopify_storefronts'),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.shopify_storefronts'),e=>e.code==='42501');
 const ev=await q("SELECT action_code,next_state FROM hon.audit_events WHERE school_id=$1 AND action_code LIKE 'commerce.shopify.storefront.%' ORDER BY occurred_at",[A.schoolId]);
 for(const a of ['saved','publish_started','published','failed','unknown'])assert(ev.some(e=>e.action_code==='commerce.shopify.storefront.'+a),a);
 assert.equal(JSON.stringify(ev).match(/front desk|Uniform|#C8102E/),null,'evidence holds versions and outcomes, never the text');
 pass('one lease per store; results only under the exact lease and person, used once; outcomes and codes are closed; an expired lease reads and settles as UNKNOWN; at most 100 publishes a UTC day; no truncate, no runtime table access; evidence carries no text');

 // 7. A store that stops being CONNECTED loses its storefront row; a revoked manager reads nothing.
 const live=(await connectWith(manager)).connection;
 assert.equal((await q('SELECT count(*)::int n FROM hon.shopify_storefronts WHERE school_id=$1',[A.schoolId]))[0].n,1,'reconnecting the same store keeps the settings');
 ok(await disconnect(manager,{schoolId:A.schoolId,connectionId:live.connectionId,expectedVersion:live.version}));
 assert.equal((await q('SELECT count(*)::int n FROM hon.shopify_storefronts WHERE school_id=$1',[A.schoolId]))[0].n,0);
 assert.equal(ok(await sfRead(manager,A.schoolId)).publishStatus,'NEVER');
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[managerGrant,hqPrincipal]);
 await denied(()=>sfRead(manager,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 pass('a store that stops being CONNECTED loses its storefront settings; a revoked grant reads nothing');

 // 8. The deploy check for 0609 in infra 011 passes against this database (with the fixture's runtime role).
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Shopify storefront blocks exact verification (0609, TB2)')[1]?.split('-- End Shopify storefront blocks exact verification.')[0];
  assert(section,'0609 verify section');await q(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime','hon_champions_runtime'));}
 pass('the infra verification for 0609 (TB1 objects absent, exact bodies, closed helpers, forced RLS, triggers) passes');
 console.log('PASS SHOPIFY STOREFRONT all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy()]);
}
