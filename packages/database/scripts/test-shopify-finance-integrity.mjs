/** 0557 Shopify finance (SH-F1): Shopify Payments balance, payouts and balance transactions, read-only. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). The Shopify side is the in-memory fake; nothing leaves the machine. */
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
const tables=['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products','shopify_variants','shopify_orders','shopify_order_lines','shopify_product_changes','shopify_finance'];
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
const queryOf=url=>new URL(url).search.slice(1);const financeRead=(identity,s)=>read(identity,s,'/finance');
let shopify,SHOP;
try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. ACL.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.shopify_finance',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.shopify_finance'::regclass"))[0],{r:true,f:true,n:0});
 const entries=['read_shopify','read_shopify_catalog','read_shopify_orders','start_shopify_connect','claim_shopify_connect','record_shopify_connection',
  'begin_shopify_sync','rotate_shopify_credential','record_shopify_sync_page','finish_shopify_sync','disconnect_shopify',
  'read_shopify_product_changes','propose_shopify_product_change','cancel_shopify_product_change','approve_shopify_product_change',
  'rotate_shopify_change_credential','record_shopify_product_change_result','read_shopify_finance','record_shopify_finance'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify%'");
 for(const e of [...entries,'record_shopify_background_finance','shopify_apply_finance','shopify_finance_ok','shopify_finance_on_end'])assert(fns.some(f=>f.proname===e),e);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 pass('the finance snapshot is a forced-RLS private table; the runtime executes the 19 Shopify entry points and nothing else; the background write and helpers are closed to it and to PUBLIC');

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
 SHOP='ima-finance-'+K().slice(0,8)+'.myshopify.com';
 const connectWith=async(who,extra={})=>{const s=ok(await start(who,{schoolId:A.schoolId,shopDomain:SHOP,...extra}));return ok(await complete(who,{schoolId:A.schoolId,query:queryOf(s.authorizeUrl)}));};
 const financeRows=async()=>(await q('SELECT count(*)::int n FROM hon.shopify_finance f JOIN hon.shopify_connections c ON c.id=f.connection_id WHERE c.shop_domain=$1',[SHOP]))[0].n;

 // 2. Only commerce.shopify.manage reads finance; a store connected without Allow finance has none and is never asked.
 assert.deepEqual(ok(await financeRead(manager,A.schoolId)),{schoolId:A.schoolId,connected:false,financeAllowed:false,currency:null,finance:null});
 const first=await connectWith(manager);
 assert.equal(first.firstSync.outcome,'SUCCEEDED');
 assert.deepEqual(ok(await financeRead(manager,A.schoolId)),{schoolId:A.schoolId,connected:true,financeAllowed:false,currency:'USD',finance:null});
 assert.equal(await financeRows(),0);
 await denied(()=>financeRead(reader,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>financeRead(managerB,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>financeRead(manager,'not-a-school'),400,'SHOPIFY_INVALID');
 pass('only commerce.shopify.manage at the exact school reads finance; readers and other schools are refused; a store without the finance scope has no snapshot and its sync still succeeds');

 // 3. Allow finance re-approves the same store with the finance scope (editing kept when asked for too); the sync reads it.
 const allowed=await connectWith(manager,{allowEditing:true,allowFinance:true});
 assert.equal(allowed.connection.connectionId,first.connection.connectionId,'Allow finance reconnects the same store');
 assert.equal(allowed.firstSync.outcome,'SUCCEEDED');
 assert.equal((await q('SELECT scopes FROM hon.shopify_connections WHERE shop_domain=$1',[SHOP]))[0].scopes,'read_products,read_inventory,read_orders,write_products,write_inventory,read_shopify_payments_accounts');
 let view=ok(await financeRead(manager,A.schoolId));
 assert.deepEqual([view.connected,view.financeAllowed,view.currency],[true,true,'USD']);
 assert.deepEqual(view.finance.balances,[{currency:'USD',amount:'245.18'}]);
 assert.deepEqual(view.finance.payouts.map(p=>[p.id,p.status,p.net]),[['9400000002','SCHEDULED','136.04'],['9400000001','PAID','128.31']]);
 assert.deepEqual(view.finance.transactions.map(t=>[t.id,t.type,t.amount,t.fee,t.net,t.payoutId]),[['9450000003','CHARGE','140.73','4.38','136.35','9400000002'],
  ['9450000002','REFUND','-0.31','0','-0.31','9400000002'],['9450000001','CHARGE','150.00','4.65','145.35',null]]);
 assert.match(view.finance.readAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
 assert.equal(JSON.stringify(view).includes('fake_'),false);
 pass('Allow finance re-approves the same store with read_shopify_payments_accounts; the sync records the balance, latest payouts and balance transactions as Shopify has them');

 // 4. Each sync replaces the snapshot whole; a store without Shopify Payments reads as payments off.
 shopify.fake.setStore(SHOP,{finance:{paymentsActive:false,balances:[],payouts:[],transactions:[]}});
 assert.equal(ok(await sync(manager,{schoolId:A.schoolId})).outcome,'SUCCEEDED');
 view=ok(await financeRead(manager,A.schoolId));
 assert.deepEqual([view.finance.paymentsActive,view.finance.balances,view.finance.payouts,view.finance.transactions],[false,[],[],[]]);
 assert.equal(await financeRows(),1);
 pass('each sync replaces the one snapshot of the store; a store without Shopify Payments reads as payments off with nothing listed');

 // 5. The database takes only a closed snapshot, only during the person's own running sync, only with the scope.
 const direct=(fn,who,input)=>restricted.query(`SELECT hon.${fn}($1,$2::jsonb) d`,[who.externalSubject,JSON.stringify(input)]);
 const begun=(await direct('begin_shopify_sync',manager,{schoolId:A.schoolId})).rows[0].d;
 const good={paymentsActive:true,balances:[{currency:'USD',amount:'-12.5'}],payouts:[{id:'1',status:'PAID',direction:'WITHDRAWAL',issuedAt:'2026-11-18T00:00:00.000Z',currency:'USD',net:'-12.50'}],
  transactions:[{id:'2',type:'ADJUSTMENT',at:'2026-11-18T00:00:00.000Z',currency:'USD',amount:'-12.5',fee:'0',net:'-12.5',test:false,payoutId:'1'}]};
 const input=finance=>({schoolId:A.schoolId,syncId:begun.syncId,finance});
 for(const [why,bad] of [['extra key',{...good,bank:'x'}],['payments off with payouts',{...good,paymentsActive:false}],['bad currency',{...good,balances:[{currency:'usd',amount:'1'}]}],
  ['two balances in one currency',{...good,balances:[good.balances[0],good.balances[0]]}],['five decimals',{...good,payouts:[{...good.payouts[0],net:'1.00001'}]}],
  ['unknown payout status',{...good,payouts:[{...good.payouts[0],status:'LOST'}]}],['more than 20 payouts',{...good,payouts:Array.from({length:21},(_,i)=>({...good.payouts[0],id:String(i+1)}))}],
  ['repeated transaction',{...good,transactions:[good.transactions[0],good.transactions[0]]}],['gid instead of id',{...good,transactions:[{...good.transactions[0],id:'gid://shopify/X/2'}]}],
  ['not an instant',{...good,transactions:[{...good.transactions[0],at:'2026-11-18'}]}]])
  await assert.rejects(()=>direct('record_shopify_finance',manager,input(bad)),e=>e.message==='SHOPIFY_INVALID',why);
 await assert.rejects(()=>direct('record_shopify_finance',reader,input(good)),e=>e.message==='SHOPIFY_FORBIDDEN');
 await assert.rejects(()=>direct('record_shopify_finance',managerB,{...input(good),schoolId:B.schoolId}),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 await assert.rejects(()=>direct('record_shopify_finance',manager,{...input(good),syncId:K()}),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING');
 await assert.rejects(()=>q('SELECT hon.record_shopify_background_finance($1::jsonb)',[JSON.stringify({syncId:begun.syncId,leaseToken:K(),finance:good})]),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING','a person\'s run has no lease');
 assert.deepEqual((await direct('record_shopify_finance',manager,input(good))).rows[0].d,{syncId:begun.syncId,paymentsActive:true,payouts:1,transactions:1});
 assert.deepEqual(ok(await financeRead(manager,A.schoolId)).finance.balances,[{currency:'USD',amount:'-12.5'}],'a negative balance is kept as Shopify sends it');
 await direct('finish_shopify_sync',manager,{schoolId:A.schoolId,syncId:begun.syncId,outcome:'SUCCEEDED',failureCode:null});
 await assert.rejects(()=>direct('record_shopify_finance',manager,input(good)),e=>e.message==='SHOPIFY_SYNC_NOT_RUNNING','a finished run takes nothing');
 // Without the scope the database refuses even a well-formed snapshot.
 const readOnly=await connectWith(manager);assert.equal(readOnly.firstSync.outcome,'SUCCEEDED');
 const again=(await direct('begin_shopify_sync',manager,{schoolId:A.schoolId})).rows[0].d;
 await assert.rejects(()=>direct('record_shopify_finance',manager,{schoolId:A.schoolId,syncId:again.syncId,finance:good}),e=>e.message==='SHOPIFY_FINANCE_NOT_ALLOWED');
 await direct('finish_shopify_sync',manager,{schoolId:A.schoolId,syncId:again.syncId,outcome:'SUCCEEDED',failureCode:null});
 view=ok(await financeRead(manager,A.schoolId));
 assert.deepEqual([view.financeAllowed,view.finance.balances],[false,[{currency:'USD',amount:'-12.5'}]],'the last snapshot stays visible until the store ends');
 pass('the database takes a closed snapshot only during the person\'s own running sync with the finance scope; negative amounts kept; shapes, other schools, other runs, finished runs and a person\'s run through the worker function are refused');

 // 6. A revoked manager reads nothing; a store that ends loses its snapshot.
 const live=(await connectWith(manager,{allowFinance:true})).connection;
 assert.equal(await financeRows(),1);
 const gone=ok(await disconnect(manager,{schoolId:A.schoolId,connectionId:live.connectionId,expectedVersion:live.version}));
 assert.equal(gone.connection.status,'DISCONNECTED');
 assert.equal(await financeRows(),0,'disconnecting deletes the snapshot');
 assert.deepEqual(ok(await financeRead(manager,A.schoolId)),{schoolId:A.schoolId,connected:false,financeAllowed:false,currency:null,finance:null});
 await assert.rejects(()=>q('TRUNCATE hon.shopify_finance'),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.shopify_finance'),e=>e.code==='42501');
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[managerGrant,hqPrincipal]);
 await denied(()=>financeRead(manager,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 pass('a store that stops being CONNECTED loses its snapshot; the table is never truncated or read by the runtime; a revoked grant reads nothing');

 // 7. The deploy check for 0557 in infra 011 passes against this database (with the fixture's runtime role).
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Shopify finance exact verification (0557, SH-F1)')[1]?.split('-- End Shopify finance exact verification.')[0];
  assert(section,'0557 verify section');await q(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime','hon_champions_runtime'));}
 pass('the infra verification for 0557 (exact bodies, closed helpers, forced RLS, triggers) passes');
 console.log('PASS SHOPIFY FINANCE all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy()]);
}
