/** 0496 Shopify product changes with owner approval (SH4a). Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). The Shopify side is the in-memory fake; nothing leaves the machine. */
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
const tables=['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products','shopify_variants','shopify_orders','shopify_order_lines','shopify_product_changes'];
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
const queryOf=url=>new URL(url).search.slice(1);const changesRead=(identity,s)=>read(identity,s,'/changes');
const propose=cmd('changes'),cancel=cmd('changes/cancel'),approve=cmd('changes/approve');
const fakeProduct=id=>shopify.fake.stores?.get?.(SHOP)?.products.find(p=>p.id===id);
let shopify,SHOP;

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. ACL.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.shopify_product_changes',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.shopify_product_changes'::regclass"))[0],{r:true,f:true,n:0});
 const entries=['read_shopify','read_shopify_catalog','read_shopify_orders','start_shopify_connect','claim_shopify_connect','record_shopify_connection',
  'begin_shopify_sync','rotate_shopify_credential','record_shopify_sync_page','finish_shopify_sync','disconnect_shopify',
  'read_shopify_product_changes','propose_shopify_product_change','cancel_shopify_product_change','approve_shopify_product_change',
  'rotate_shopify_change_credential','record_shopify_product_change_result','read_shopify_finance','record_shopify_finance',
  'read_shopify_storefront','save_shopify_storefront','begin_shopify_storefront_publish','rotate_shopify_storefront_credential','finish_shopify_storefront_publish',
  // 0613 POS sells Shopify products (SH2).
  'begin_pos_shopify_stock','rotate_pos_shopify_credential','finish_pos_shopify_stock',
  // 0614 POS Shopify orders for made-to-order items (SH2b).
  'begin_pos_shopify_order','finish_pos_shopify_order',
  // 0615 Marcus commerce review (CA1).
  'begin_shopify_commerce_review','plan_shopify_commerce_review','prepare_shopify_commerce_review','fail_shopify_commerce_review','record_shopify_commerce_review',
  'read_shopify_commerce_reviews','close_shopify_commerce_review',
  // 0596 Marcus merch ideas (CS-M2).
  'begin_shopify_merch_ideas','plan_shopify_merch_ideas','prepare_shopify_merch_ideas','fail_shopify_merch_ideas','record_shopify_merch_ideas',
  'read_shopify_merch_ideas','close_shopify_merch_ideas'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify%'");
 for(const e of entries)assert(fns.some(f=>f.proname===e),e);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 pass('product changes are a forced-RLS private table; the runtime executes the 24 Shopify entry points (31 with the 0596 merch ideas) and nothing else; helpers and the guard are closed to it and to PUBLIC');

 // Fixture: two schools with paid access; manager, second manager, reader, other-school manager.
 const hq={subject:'shopify-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'Shopify synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Shopify synthetic','Shopify synthetic','Shopify school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'shopify-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager');const managerGrant=await grant(A,await human(manager,'Manager'),await customRole(A,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 const second=person('second-manager');await grant(A,await human(second,'Second manager'),await customRole(A,'CUSTOM_SHOPIFY_MANAGE_2',['school.view','commerce.shopify.manage']));
 const reader=person('reader');await grant(A,await human(reader,'Reader'),await customRole(A,'CUSTOM_SHOPIFY_READ',['school.view','commerce.shopify.read']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_SHOPIFY_MANAGE',['school.view','commerce.shopify.manage']));
 let clock=Date.now();
 shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'});assert.equal(shopify.adapter.kind,'FAKE');shopify.fake.now=()=>clock;
 const module=await Test.createTestingModule({controllers:[ShopifyController],providers:[ShopifyService,ShopifyHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify},{provide:'SHOPIFY_CLOCK',useValue:()=>clock}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 SHOP='ima-edit-'+K().slice(0,8)+'.myshopify.com';
 const connectWith=async(who,extra={})=>{const s=ok(await start(who,{schoolId:A.schoolId,shopDomain:SHOP,...extra}));return ok(await complete(who,{schoolId:A.schoolId,query:queryOf(s.authorizeUrl)}));};
 const first=await connectWith(manager);
 assert.equal(first.firstSync.outcome,'SUCCEEDED');
 const writes=()=>shopify.fake.calls.filter(c=>/^(createDraft|updateProduct|updateVariants):/.test(c)).length;
 const UNIFORM='9100000001',SIZE1='9200000011',HOODIE='9100000003',HOOD_V='9200000031',GEAR='9100000002',GEAR_A='9200000022';
 const mirrorVariant=async id=>(await q('SELECT price::text,compare_at_price::text cap,unit_cost::text cost FROM hon.shopify_variants v JOIN hon.shopify_connections c ON c.id=v.connection_id WHERE c.shop_domain=$1 AND v.shopify_id=$2',[SHOP,id]))[0];
 const mirrorProduct=async id=>(await q('SELECT p.title,p.status,p.product_type,p.vendor,p.handle,p.removed FROM hon.shopify_products p JOIN hon.shopify_connections c ON c.id=p.connection_id WHERE c.shop_domain=$1 AND p.shopify_id=$2',[SHOP,id]))[0];

 // 2. Proposing: managers only, this school's mirrored product only, real changes only; nothing reaches Shopify.
 let view=ok(await changesRead(reader,A.schoolId));
 assert.deepEqual(view,{schoolId:A.schoolId,canManage:false,editProducts:false,editCosts:false,changes:[]});
 const priceChange={schoolId:A.schoolId,kind:'UPDATE',productId:UNIFORM,changes:{title:'Student uniform (white)',variants:[{variantId:SIZE1,price:'69.50',unitCost:'29'}]}};
 await denied(()=>propose(reader,priceChange),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>propose(managerB,{...priceChange,schoolId:B.schoolId}),409,'SHOPIFY_NOT_CONNECTED');
 await denied(()=>propose(managerB,priceChange),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>propose(manager,priceChange,{command:'school-pos'}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>propose(manager,{...priceChange,changes:{title:'Student uniform'}}),400,'SHOPIFY_INVALID');
 await denied(()=>propose(manager,{...priceChange,changes:{variants:[{variantId:SIZE1,price:'65'}]}}),400,'SHOPIFY_INVALID');
 await denied(()=>propose(manager,{...priceChange,changes:{variants:[{variantId:GEAR_A,price:'1'}]}}),404,'SHOPIFY_NOT_FOUND');
 await denied(()=>propose(manager,{...priceChange,productId:'9100009999'}),404,'SHOPIFY_NOT_FOUND');
 await denied(()=>propose(manager,{...priceChange,changes:{status:'UNLISTED'}}),400,'SHOPIFY_INVALID');
 await denied(()=>propose(manager,{...priceChange,changes:{title:'x\u0007'}}),400,'SHOPIFY_INVALID');
 const proposed=ok(await propose(manager,priceChange)).change;
 assert.deepEqual([proposed.status,proposed.kind,proposed.productId,proposed.version,proposed.proposedByMe],['PENDING','UPDATE',UNIFORM,1,true]);
 assert.deepEqual(proposed.base,{title:'Student uniform',variants:[{variantId:SIZE1,price:'65.0000',unitCost:'28.0000'}]});
 await denied(()=>propose(second,{...priceChange,changes:{vendor:'Other'}}),409,'SHOPIFY_CHANGE_OPEN');
 assert.equal(writes(),0);
 view=ok(await changesRead(reader,A.schoolId));
 assert.deepEqual([view.changes.length,view.changes[0].changeId,view.changes[0].proposedByMe],[1,proposed.changeId,false]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.shopify_product_changes WHERE school_id=$1",[B.schoolId]))[0].n,0);
 pass('only commerce.shopify.manage at the school proposes; no-op, unknown, other-product, UNLISTED and control-character changes are refused; one open change per product; the base keeps the mirror values; nothing reaches Shopify');

 let direct;
 // 3. Approving needs the store to have allowed editing; Allow editing asks Shopify for the edit scopes.
 const cmdOf=c=>({schoolId:A.schoolId,changeId:c.changeId,expectedVersion:c.version});
 await denied(()=>approve(reader,cmdOf(proposed)),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>approve(managerB,{...cmdOf(proposed),schoolId:B.schoolId}),404,'SHOPIFY_NOT_FOUND');
 await denied(()=>approve(manager,cmdOf(proposed)),409,'SHOPIFY_EDIT_NOT_ALLOWED');
 assert.equal(writes(),0);
 const editing=await connectWith(manager,{allowEditing:true});
 assert.equal(editing.connection.connectionId,first.connection.connectionId,'Allow editing reconnects the same store');
 assert.equal((await q('SELECT scopes FROM hon.shopify_connections WHERE shop_domain=$1',[SHOP]))[0].scopes,'read_products,read_inventory,read_orders,write_products,write_inventory');
 view=ok(await changesRead(manager,A.schoolId));
 assert.deepEqual([view.canManage,view.editProducts,view.editCosts],[true,true,true]);
 await denied(()=>approve(manager,{...cmdOf(proposed),expectedVersion:2}),409,'SHOPIFY_VERSION_CONFLICT');
 pass('approving is refused until the store grants write_products (and write_inventory for costs); Allow editing re-approves the same store with the edit scopes; readers and other schools cannot approve');

 // 4. Approve: checked live, written, read back, mirrored, recorded once.
 const before=await counts();
 const applied=ok(await approve(second,cmdOf(proposed))).change;
 assert.deepEqual([applied.status,applied.failureCode,applied.attempts,applied.version],['APPLIED',null,1,3]);
 assert.deepEqual(await mirrorVariant(SIZE1),{price:'69.5000',cap:null,cost:'29.0000'});
 assert.equal((await mirrorProduct(UNIFORM)).title,'Student uniform (white)');
 const after=await counts();
 assert.equal(Number(after.shopify_product_changes),Number(before.shopify_product_changes));
 assert.equal(Number(after.audit_events)-Number(before.audit_events),2);
 assert.equal(writes(),2);
 await denied(()=>approve(second,cmdOf(applied)),409,'SHOPIFY_CHANGE_NOT_PENDING');
 await denied(()=>cancel(second,cmdOf(applied)),409,'SHOPIFY_CHANGE_NOT_PENDING');
 const ev=await q("SELECT action_code,next_state,actor_principal_id FROM hon.audit_events WHERE entity_id=$1 ORDER BY occurred_at",[proposed.changeId]);
 assert.deepEqual(ev.map(e=>e.action_code),['commerce.shopify.product_change.proposed','commerce.shopify.product_change.approved','commerce.shopify.product_change.applied']);
 assert.deepEqual(ev[0].next_state,{kind:'UPDATE',productId:UNIFORM,fields:['title','variants']});
 assert.notEqual(ev[0].actor_principal_id,ev[1].actor_principal_id,'the approver is recorded as who approved');
 assert.equal(/69\.5|white|fake_(at|rt)_/.test(JSON.stringify(ev)),false,'evidence carries ids, kinds and field names only');
 pass('an approved change is checked against Shopify, written, read back and mirrored; it cannot be approved or cancelled twice; evidence names the fields, never the values');

 // 5. Stale: a mirror that moved refuses the approval; Shopify that moved without HON knowing is FAILED and refreshes the mirror.
 const staleMirror=ok(await propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:HOODIE,changes:{vendor:'Dojo Supply'}})).change;
 fakeProduct(HOODIE).vendor='Changed in Shopify';
 assert.equal(ok(await sync(manager,{schoolId:A.schoolId})).outcome,'SUCCEEDED');
 await denied(()=>approve(manager,cmdOf(staleMirror)),409,'SHOPIFY_CHANGE_STALE');
 const cancelled=ok(await cancel(manager,cmdOf(staleMirror))).change;
 assert.equal(cancelled.status,'CANCELLED');
 const staleLive=ok(await propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:HOODIE,changes:{status:'ARCHIVED'}})).change;
 fakeProduct(HOODIE).status='DRAFT';
 const failed=ok(await approve(manager,cmdOf(staleLive))).change;
 assert.deepEqual([failed.status,failed.failureCode],['FAILED','CHANGED_IN_SHOPIFY']);
 assert.equal((await mirrorProduct(HOODIE)).status,'DRAFT','the mirror took what Shopify has');
 assert.equal(fakeProduct(HOODIE).status,'DRAFT','nothing was written');
 pass('a change whose base no longer matches the mirror is refused and can be cancelled; one whose base no longer matches Shopify is FAILED without writing and refreshes the mirror');

 // 6. A lost answer is UNKNOWN; approving again only checks, and never writes twice.
 const lost=ok(await propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:GEAR,changes:{productType:null}})).change;
 shopify.fake.writeFault='LOSE_ANSWER';
 const unknown=ok(await approve(manager,cmdOf(lost))).change;
 assert.deepEqual([unknown.status,unknown.failureCode],['UNKNOWN','SHOPIFY_UNAVAILABLE']);
 await denied(()=>propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:GEAR,changes:{vendor:'X'}}),409,'SHOPIFY_CHANGE_OPEN');
 const w0=writes();
 const checked=ok(await approve(second,cmdOf(unknown))).change;
 assert.deepEqual([checked.status,checked.attempts],['APPLIED',2]);
 assert.equal(writes(),w0,'checking reads Shopify and writes nothing');
 assert.equal((await mirrorProduct(GEAR)).product_type,null);
 pass('a write whose answer was lost is UNKNOWN (still blocks new edits); approving it again checks Shopify without writing and records APPLIED');

 // 7. Leases: a result needs the exact lease of the person who approved; a lease that runs out reads UNKNOWN and is checked.
 const leased=ok(await propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:GEAR,changes:{title:'Sparring set'}})).change;
 direct=async(fn,who,input)=>restricted.query(`SELECT hon.${fn}($1,$2::jsonb) d`,[who.externalSubject,JSON.stringify(input)]);
 const lease=(await direct('approve_shopify_product_change',manager,cmdOf(leased))).rows[0].d;
 assert.equal(lease.mode,'APPLY');assert.match(lease.credential.sealed,/^v1\./);
 const result={schoolId:A.schoolId,changeId:leased.changeId,leaseToken:lease.leaseToken,outcome:'UNKNOWN',failureCode:'X',product:null};
 await assert.rejects(()=>direct('record_shopify_product_change_result',second,result),e=>e.message==='SHOPIFY_CHANGE_NOT_LEASED');
 await assert.rejects(()=>direct('record_shopify_product_change_result',manager,{...result,leaseToken:K()}),e=>e.message==='SHOPIFY_CHANGE_NOT_LEASED');
 const wrongProduct={id:GEAR,title:'Not the proposal',status:'ACTIVE',vendor:null,productType:null,handle:'sparring-gear-set',imageUrl:null,
  variants:[{id:GEAR_A,title:'Adult',sku:null,barcode:null,price:'1',compareAtPrice:null,unitCost:null,tracked:false,inventoryQuantity:null}]};
 await assert.rejects(()=>direct('record_shopify_product_change_result',manager,{...result,outcome:'APPLIED',failureCode:null,product:wrongProduct}),e=>e.message==='SHOPIFY_INVALID');
 await assert.rejects(()=>direct('record_shopify_product_change_result',manager,{...result,outcome:'APPLIED',failureCode:null,product:{...wrongProduct,id:UNIFORM,title:'Sparring set'}}),e=>e.message==='SHOPIFY_INVALID');
 // Time passes: the lease runs out with no result (the disposable fixture moves the clock on this one row).
 await q('ALTER TABLE hon.shopify_product_changes DISABLE TRIGGER shopify_product_changes_guard');
 await q("UPDATE hon.shopify_product_changes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[leased.changeId]);
 await q('ALTER TABLE hon.shopify_product_changes ENABLE TRIGGER shopify_product_changes_guard');
 const expired=ok(await changesRead(reader,A.schoolId)).changes.find(c=>c.changeId===leased.changeId);
 assert.deepEqual([expired.status,expired.failureCode],['UNKNOWN','LEASE_EXPIRED']);
 const recheck=ok(await approve(second,cmdOf(expired))).change;
 assert.deepEqual([recheck.status,recheck.failureCode,recheck.attempts],['FAILED','NOT_APPLIED',2],'never written, so checking finds it not applied');
 await assert.rejects(()=>direct('record_shopify_product_change_result',manager,{...result,outcome:'FAILED',failureCode:'LATE'}),e=>e.message==='SHOPIFY_CHANGE_NOT_LEASED');
 pass('a result is accepted only under the approving person\'s lease token and must show the proposal; a lease that ran out reads UNKNOWN and approving it again checks Shopify; a late result after that is refused');

 // 8. New drafts: always DRAFT, under HON's handle, priced and costed; found again by handle.
 const draft={title:'Rash guard',description:'Long sleeve.\n\nFor sparring.',productType:'Apparel',vendor:null,price:'39.99',compareAtPrice:'49.99',unitCost:'14',sku:'RASH-1'};
 await denied(()=>propose(manager,{schoolId:A.schoolId,kind:'CREATE_DRAFT',productId:UNIFORM,changes:draft}),400,'SHOPIFY_INVALID');
 await denied(()=>propose(manager,{schoolId:A.schoolId,kind:'CREATE_DRAFT',productId:null,changes:{...draft,description:'a\tb'}}),400,'SHOPIFY_INVALID');
 const nd=ok(await propose(manager,{schoolId:A.schoolId,kind:'CREATE_DRAFT',productId:null,changes:draft})).change;
 assert.match(nd.handle,/^rash-guard-[0-9a-f]{10}$/);assert.equal(nd.productId,null);assert.deepEqual(nd.base,{});
 const korean=ok(await propose(manager,{schoolId:A.schoolId,kind:'CREATE_DRAFT',productId:null,changes:{...draft,title:'도복'}})).change;
 assert.match(korean.handle,/^product-[0-9a-f]{10}$/);
 const made=ok(await approve(manager,cmdOf(nd))).change;
 assert.equal(made.status,'APPLIED');assert.match(made.productId,/^[1-9][0-9]*$/);
 assert.deepEqual(await mirrorProduct(made.productId),{title:'Rash guard',status:'DRAFT',product_type:'Apparel',vendor:null,handle:nd.handle,removed:false});
 const newVariant=(await q('SELECT shopify_id::text id FROM hon.shopify_variants v JOIN hon.shopify_connections c ON c.id=v.connection_id WHERE c.shop_domain=$1 AND v.product_shopify_id=$2',[SHOP,made.productId]))[0].id;
 assert.deepEqual(await mirrorVariant(newVariant),{price:'39.9900',cap:'49.9900',cost:'14.0000'});
 assert.equal(ok(await sync(manager,{schoolId:A.schoolId})).outcome,'SUCCEEDED');
 assert.equal((await mirrorProduct(made.productId)).removed,false,'the next sync keeps it');
 ok(await cancel(manager,cmdOf(korean)));
 pass('a new product is created only as DRAFT under the handle HON gave it, priced and costed, mirrored and kept by the next sync; a draft never names a product');

 // 9. The table refuses anything but the guarded transitions.
 const row=proposed.changeId;
 await assert.rejects(()=>q("UPDATE hon.shopify_product_changes SET changes='{}',version=version+1 WHERE id=$1",[row]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q("UPDATE hon.shopify_product_changes SET status='PENDING',version=version+1 WHERE id=$1",[row]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q('DELETE FROM hon.shopify_product_changes WHERE id=$1',[row]),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>q('TRUNCATE hon.shopify_product_changes'),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.shopify_product_changes'),e=>e.code==='42501');
 pass('a change never loses what was proposed, never goes back to PENDING, and is never deleted or truncated; the runtime cannot read the table');

 // 10. Authority ends: a revoked manager can neither propose nor approve.
 const late=ok(await propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:HOODIE,changes:{vendor:'Late'}})).change;
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[managerGrant,hqPrincipal]);
 await denied(()=>approve(manager,cmdOf(late)),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>propose(manager,{schoolId:A.schoolId,kind:'UPDATE',productId:UNIFORM,changes:{vendor:'Late'}}),403,'SHOPIFY_FORBIDDEN');
 assert.equal(ok(await cancel(second,cmdOf(late))).change.status,'CANCELLED','another manager can still cancel it');
 pass('a revoked grant stops proposing and approving at once; another manager can still cancel');
 // 11. An UNKNOWN change that reached five attempts can be closed as unresolved, freeing the product for a new edit.
 const stuck=ok(await propose(second,{schoolId:A.schoolId,kind:'UPDATE',productId:HOODIE,changes:{vendor:'Stuck'}})).change;
 const current=async()=>ok(await changesRead(second,A.schoolId)).changes.find(c=>c.changeId===stuck.changeId);
 for(let i=0;i<5;i++){
  await direct('approve_shopify_product_change',second,cmdOf(await current()));
  await q('ALTER TABLE hon.shopify_product_changes DISABLE TRIGGER shopify_product_changes_guard');
  await q("UPDATE hon.shopify_product_changes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[stuck.changeId]);
  await q('ALTER TABLE hon.shopify_product_changes ENABLE TRIGGER shopify_product_changes_guard');
 }
 const five=await current();
 assert.deepEqual([five.status,five.failureCode,five.attempts],['UNKNOWN','LEASE_EXPIRED',5]);
 await denied(()=>approve(second,cmdOf(five)),409,'SHOPIFY_CHANGE_ATTEMPTS');
 await denied(()=>propose(second,{schoolId:A.schoolId,kind:'UPDATE',productId:HOODIE,changes:{vendor:'Next'}}),409,'SHOPIFY_CHANGE_OPEN');
 await denied(()=>cancel(reader,cmdOf(five)),403,'SHOPIFY_FORBIDDEN');
 const closed=ok(await cancel(second,cmdOf(five))).change;
 assert.deepEqual([closed.status,closed.failureCode,closed.attempts,closed.version>five.version,!!closed.finishedAt],['FAILED','CLOSED_UNRESOLVED',5,true,true]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE entity_id=$1 AND action_code='commerce.shopify.product_change.closed_unresolved'",[stuck.changeId]))[0].n,1);
 await denied(()=>cancel(second,cmdOf(closed)),409,'SHOPIFY_CHANGE_NOT_PENDING');
 assert.equal(ok(await propose(second,{schoolId:A.schoolId,kind:'UPDATE',productId:HOODIE,changes:{vendor:'Next'}})).change.status,'PENDING');
 pass('an UNKNOWN change at five attempts cannot be approved again; a manager closes it as FAILED CLOSED_UNRESOLVED (with evidence) and a new edit of the product is accepted');
 // 11. The deploy check for 0496 in infra 011 passes against this database (with the fixture's runtime role).
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Shopify product changes exact verification (0496, SH4a)')[1]?.split('-- End Shopify product changes exact verification.')[0];
  assert(section,'0496 verify section');await q(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime','hon_champions_runtime'));}
 pass('the infra verification for 0496 (exact bodies, closed helpers, forced RLS, guards) passes');
 console.log('PASS SHOPIFY CHANGES all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy()]);
}
