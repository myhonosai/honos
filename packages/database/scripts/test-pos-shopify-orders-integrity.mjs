/** 0614 POS creates a paid Shopify order for made-to-order items. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture); Shopify is the deterministic fake. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes} from 'node:crypto';
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
const {SchoolPosService}=require('./dist/pos/school-pos.service.js');
const {SchoolPosController,SchoolPosHumanGuard}=require('./dist/pos/school-pos.controller.js');
const {SHOPIFY_APP,shopifyAppFromEnvironment}=require('./dist/commerce/shopify/shopify-adapter.js');
const {POS_HUMAN_COMMAND,computePosTotals}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'pos-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS POS-ORDERS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:pos:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=POS_HUMAN_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests','pos_shopify_stock_tasks','pos_shopify_orders','audit_events','outbox_events'];
const counts=async()=>{const o={};for(const t of tables)o[t]=(await q('SELECT count(*) n FROM hon.'+t))[0].n;return o;};
async function denied(work,status,code){
 const before=await counts();const r=await work();
 assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.code,code,JSON.stringify(r.body));
 const after=await counts();for(const t of tables)if(t!=='pos_requests')assert.equal(after[t],before[t],t);
 assert(!('data' in r.body));assert.equal(r.headers['cache-control'],'private, no-store');assert(!JSON.stringify(r.body).match(/SQLSTATE|SELECT |external_subject|hon\./));return r;
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
const read=(identity,s)=>send('school/schools/'+s+'/pos',{identity,method:'GET'});
const sale=(identity,s,id)=>send('school/schools/'+s+'/pos/sale/'+id,{identity,method:'GET'});
const cmd=path=>(identity,b,o={})=>send('school/pos/'+path,{identity,body:b,...o});
const saveSettings=cmd('settings'),sell=cmd('sales'),refund=cmd('refunds');
const saleBody=(schoolId,lines,o={})=>({schoolId,personId:null,walkInName:null,lines,discount:null,method:'CASH',reference:null,note:null,expectedTotalMinor:0,...o});
const resend=(identity,schoolId)=>send('school/pos/shopify-stock',{identity,body:{schoolId}});
const shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'}),fake=shopify.fake;
const SHOP='pos-order-'+K().slice(0,8)+'.myshopify.com',SYNC=K();
// Shopify ids: belt (the school stocks it), hoodie and tee (a print provider makes them).
const BELT='7101',HOODIE='7102',TEE='7103';
const mirror=()=>[{id:'701',title:'Dojo gear',status:'ACTIVE',vendor:null,productType:null,handle:'dojo-gear',imageUrl:null,variants:[
  {id:BELT,title:'White belt',sku:'BELT-W',barcode:null,price:'12.50',compareAtPrice:null,unitCost:null,tracked:true,inventoryQuantity:5,fulfilledBy:null},
  {id:HOODIE,title:'Hoodie',sku:'HOOD-1',barcode:null,price:'40',compareAtPrice:null,unitCost:null,tracked:true,inventoryQuantity:9,fulfilledBy:'Sample Print Co'},
  {id:TEE,title:'Tee',sku:null,barcode:null,price:'20',compareAtPrice:null,unitCost:null,tracked:false,inventoryQuantity:null,fulfilledBy:'Sample Print Co'}]}];
const orders=async s=>q('SELECT id,ship_kind,ship_to,status,failure_code,attempts,shopify_order_id::text oid,shopify_order_name oname FROM hon.pos_shopify_orders WHERE sale_id=$1',[s]);
const total=(...l)=>computePosTotals(l.map(([unitPriceMinor,quantity])=>({unitPriceMinor,quantity,taxable:true})),null,1000).totalMinor;
const HOME={kind:'CUSTOMER',name:'Sample Parent',address1:'12 Example Road',address2:null,city:'Springfield',province:'IL',zip:'62701',country:'US'};
const {kind:_k,...HOME_ADDRESS}=HOME;

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL of what 0614 adds.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.pos_shopify_orders',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.pos_shopify_orders'::regclass"))[0],{r:true,f:true,n:0});
 const added=['guard_pos_shopify_order','pos_shopify_orders_ok','pos_ship_to_ok','pos_school_ship_to','pos_shopify_order_json','begin_pos_shopify_order','finish_pos_shopify_order'];
 for(const name of added){const f=(await q("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname=$1",[name]));assert.equal(f.length,1,name);
  assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f[0].oid]))[0].ok,name.startsWith('begin_')||name.startsWith('finish_'),name);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f[0].oid]))[0].ok,false,name);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.pos_shopify_orders'),e=>e.code==='42501');
 pass('the order table is forced-RLS private; the runtime gains exactly begin and finish');

 // Fixture: school A (manager, cashier) with a Shopify store that sells made-to-order items, school B without one.
 const hq={subject:'pos-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'POS synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'POS synthetic','POS synthetic','POS school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'pos-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');await grant(A,managerPrincipal,await customRole(A,'CUSTOM_POS_MANAGE',['school.view','pos.manage']));
 const cashier=person('cashier');const cashierGrant=await grant(A,await human(cashier,'Cashier'),await customRole(A,'CUSTOM_POS_SELL',['school.view','pos.sell']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_POS_MANAGE',['school.view','pos.manage']));
 const module=await Test.createTestingModule({controllers:[SchoolPosController],providers:[SchoolPosService,SchoolPosHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify},{provide:'SHOPIFY_CLOCK',useValue:()=>Date.now()}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 ok(await saveSettings(manager,{schoolId:A.schoolId,expectedVersion:null,currency:'USD',taxRateBps:1000}));
 const BASE=['read_products','read_inventory','read_orders','write_products','write_inventory'];
 fake.setStore(SHOP,{products:mirror(),currency:'USD',name:'Proof Dojo'});
 const connect=async scopes=>{const code=new URLSearchParams(fake.approve(SHOP,'state',undefined,scopes)).get('code');const got=await fake.exchangeCode(SHOP,code);
  return {accessToken:got.accessToken,refreshToken:got.refreshToken,accessExpiresAt:got.accessExpiresAt,refreshExpiresAt:got.refreshExpiresAt};};
 let pair=await connect(BASE);const conn=K();
 await admin.query('BEGIN');
 await q("INSERT INTO hon.shopify_connections(id,organization_id,school_id,shop_domain,shop_name,currency,scopes,status,connected_by_principal_id) VALUES($1,$2,$3,$4,'Proof Dojo','USD',$5,'CONNECTED',$6)",[conn,A.organizationId,A.schoolId,SHOP,BASE.join(),managerPrincipal]);
 await q("INSERT INTO hon.shopify_credentials(connection_id,organization_id,school_id,key_id,sealed,access_expires_at,refresh_expires_at,stored_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
  [conn,A.organizationId,A.schoolId,shopify.vault.keyId,shopify.vault.seal({connectionId:conn,shopDomain:SHOP},pair),pair.accessExpiresAt,pair.refreshExpiresAt,managerPrincipal]);
 await admin.query('COMMIT');
 for(const p of mirror()){
  await q("INSERT INTO hon.shopify_products(connection_id,shopify_id,organization_id,school_id,title,status,handle,last_sync_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[conn,p.id,A.organizationId,A.schoolId,p.title,p.status,p.handle,SYNC]);
  let pos=0;for(const v of p.variants)await q("INSERT INTO hon.shopify_variants(connection_id,shopify_id,product_shopify_id,title,sku,price,tracked,inventory_quantity,position,last_sync_id,fulfilled_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
   [conn,v.id,p.id,v.title,v.sku,v.price,v.tracked,v.inventoryQuantity,++pos,SYNC,v.fulfilledBy]);
 }

 // 2. Without the order permission the register lists only what the school stocks and says why; with it, made-to-order items appear, never counted.
 const hoodie=[{shopifyVariantId:HOODIE,quantity:1}];
 const r0=ok(await read(cashier,A.schoolId)).shopify;
 assert.deepEqual(r0.madeToOrder,{state:'NEEDS_PERMISSION',pickup:false,unsent:{waiting:0,failed:0}});assert.deepEqual(r0.items.map(i=>i.variantId),[BELT]);
 await denied(()=>sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:total([4000,1]),shipTo:HOME})),409,'POS_ITEM_UNAVAILABLE');
 // The store approves "create orders": the grant is replaced as a whole, the token with it.
 pair=await connect([...BASE,'write_orders']);
 await admin.query('BEGIN');
 await q("UPDATE hon.shopify_connections SET scopes=$2,version=version+1 WHERE id=$1",[conn,[...BASE,'write_orders'].join()]);
 await q("UPDATE hon.shopify_credentials SET sealed=$2,access_expires_at=$3,refresh_expires_at=$4,version=version+1 WHERE connection_id=$1",[conn,shopify.vault.seal({connectionId:conn,shopDomain:SHOP},pair),pair.accessExpiresAt,pair.refreshExpiresAt]);
 await admin.query('COMMIT');
 const r1=ok(await read(cashier,A.schoolId)).shopify;
 assert.deepEqual(r1.madeToOrder,{state:'READY',pickup:false,unsent:{waiting:0,failed:0}});
 assert.deepEqual(r1.items,[
  {variantId:HOODIE,productId:'701',name:'Dojo gear - Hoodie',sku:'HOOD-1',priceMinor:4000,tracked:false,stock:null,imageUrl:null,madeBy:'Sample Print Co'},
  {variantId:TEE,productId:'701',name:'Dojo gear - Tee',sku:null,priceMinor:2000,tracked:false,stock:null,imageUrl:null,madeBy:'Sample Print Co'},
  {variantId:BELT,productId:'701',name:'Dojo gear - White belt',sku:'BELT-W',priceMinor:1250,tracked:true,stock:5,imageUrl:null,madeBy:null}]);
 assert.deepEqual(ok(await read(managerB,B.schoolId)).shopify.madeToOrder,{state:'NONE',pickup:false,unsent:{waiting:0,failed:0}});
 pass('made-to-order items are listed only when the store lets HON create orders, uncounted, with who makes them');

 // 3. Where it ships: required with a made-to-order line, refused without one, checked field by field; the school only when its address is complete.
 const hoodieTotal=total([4000,1]);
 await denied(()=>sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal})),400,'POS_SHIP_TO_REQUIRED');
 await denied(()=>sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:null})),400,'POS_INVALID');
 await denied(()=>sell(cashier,saleBody(A.schoolId,[{shopifyVariantId:BELT,quantity:1}],{expectedTotalMinor:total([1250,1]),shipTo:HOME})),400,'POS_INVALID');
 for(const bad of [{kind:'SCHOOL',name:'x'},{kind:'ELSEWHERE'},{...HOME,country:'usa'},{...HOME,name:''},{...HOME,address1:null},{...HOME,extra:1},(({zip,...o})=>o)(HOME),'SCHOOL',[HOME]])
  await denied(()=>sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:bad})),400,'POS_INVALID');
 await denied(()=>sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:{kind:'SCHOOL'}})),400,'POS_SCHOOL_ADDRESS_MISSING');
 await q("INSERT INTO hon.school_locations(school_id,organization_id,country_code,region_code,city,created_by_principal_id,updated_by_principal_id) VALUES($1,$2,'US','IL','Chicago',$3,$3)",[A.schoolId,A.organizationId,managerPrincipal]);
 await denied(()=>sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:{kind:'SCHOOL'}})),400,'POS_SCHOOL_ADDRESS_MISSING');
 assert.equal(ok(await read(cashier,A.schoolId)).shopify.madeToOrder.pickup,false);
 await q("UPDATE hon.school_locations SET address_line1='500 Example Avenue',postal_code='60601',version=version+1,updated_at=clock_timestamp() WHERE school_id=$1",[A.schoolId]);
 assert.equal(ok(await read(cashier,A.schoolId)).shopify.madeToOrder.pickup,true);
 pass('a made-to-order sale needs a valid place to ship; school pickup needs the school\'s full saved address');

 // 4. One sale, one paid Shopify order with only the made-to-order lines, shipped to the school; the stocked line lowers stock as before.
 const mixed=[{shopifyVariantId:HOODIE,quantity:2},{shopifyVariantId:BELT,quantity:1},{shopifyVariantId:TEE,quantity:1}],mixedTotal=total([4000,2],[1250,1],[2000,1]);
 const key=K(),c4=fake.calls.length,s1=ok(await sell(cashier,saleBody(A.schoolId,mixed,{expectedTotalMinor:mixedTotal,shipTo:{kind:'SCHOOL'}}),{key})).sale;
 assert.deepEqual(s1.lines.map(l=>[l.shopifyVariantId,l.madeBy,l.stockTracked,l.quantity]),[[HOODIE,'Sample Print Co',false,2],[BELT,null,true,1],[TEE,'Sample Print Co',false,1]]);
 assert.deepEqual(s1.shopifyStock,{waiting:0,done:1,failed:0});assert.deepEqual(s1.shopifyOrder,{status:'DONE',shipTo:'SCHOOL',name:'#1001',failureCode:null});
 assert.deepEqual(fake.calls.slice(c4),['adjustInventory:'+SHOP,'createPosOrder:'+SHOP]);
 const o1=(await orders(s1.saleId))[0];
 assert.deepEqual({...o1,id:null,oid:null},{id:null,ship_kind:'SCHOOL',ship_to:null,status:'DONE',failure_code:null,attempts:1,oid:null,oname:'#1001'});
 const sent=fake.posOrders.get(o1.id);assert.equal(sent.orderId,o1.oid);
 assert.deepEqual(sent.input,{key:o1.id,currency:'USD',note:'Paid at the front desk. HON receipt '+s1.receiptNumber+'.',
  shipTo:{name:'POS school',address1:'500 Example Avenue',address2:null,city:'Chicago',province:'IL',zip:'60601',country:'US'},
  lines:[{variantId:HOODIE,quantity:2,unitPrice:'40.00'},{variantId:TEE,quantity:1,unitPrice:'20.00'}]});
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='pos.shopify_order.created' AND entity_id=$1",[s1.saleId]))[0].n,1);
 assert.equal((await q("SELECT count(*)::int n FROM hon.pos_shopify_stock_tasks WHERE sale_id=$1",[s1.saleId]))[0].n,1);
 // The exact replay sells nothing again and orders nothing again.
 const replay=ok(await sell(cashier,saleBody(A.schoolId,mixed,{expectedTotalMinor:mixedTotal,shipTo:{kind:'SCHOOL'}}),{key}));
 assert.equal(replay.replayed,true);assert.equal(fake.posOrders.size,1);assert.equal(fake.calls.length,c4+2);
 // To the customer's own address: sent as typed, and forgotten once Shopify has the order.
 const s2=ok(await sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME}))).sale;
 assert.deepEqual(s2.shopifyOrder,{status:'DONE',shipTo:'CUSTOMER',name:'#1002',failureCode:null});
 const o2=(await orders(s2.saleId))[0];assert.equal(o2.ship_to,null);assert.deepEqual(fake.posOrders.get(o2.id).input.shipTo,HOME_ADDRESS);
 assert(!JSON.stringify(await q("SELECT next_state FROM hon.audit_events WHERE entity_id=$1",[s2.saleId])).includes('Example Road'));
 assert(!JSON.stringify(await q("SELECT payload FROM hon.outbox_events WHERE aggregate_id=$1",[s2.saleId])).includes('Example Road'));
 pass('a sale makes one paid Shopify order of its made-to-order lines, to the school or the customer; the address is cleared once the order exists; a replay orders nothing');

 // 5. A lost answer: the order waits and is not tried again for 60 seconds; then it is found by its tag, not made twice.
 fake.writeFault='LOSE_ANSWER';
 const s3=ok(await sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME}))).sale;
 assert.deepEqual(s3.shopifyOrder,{status:'WAITING',shipTo:'CUSTOMER',name:null,failureCode:null});assert.equal(fake.posOrders.size,3);
 const o3=(await orders(s3.saleId))[0];assert.deepEqual(o3.ship_to,HOME_ADDRESS);assert.equal(o3.attempts,1);
 assert.deepEqual(ok(await read(cashier,A.schoolId)).shopify.madeToOrder.unsent,{waiting:1,failed:0});
 const s4=ok(await sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME}))).sale;
 assert.equal(s4.shopifyOrder.status,'DONE');assert.equal((await orders(s3.saleId))[0].attempts,1);assert.equal(fake.posOrders.size,4);
 await q("UPDATE hon.pos_shopify_orders SET last_attempt_at=clock_timestamp()-interval '61 seconds' WHERE id=$1",[o3.id]);
 // Any later Shopify sale at the desk sends what is waiting, even one with no made-to-order line.
 ok(await sell(cashier,saleBody(A.schoolId,[{shopifyVariantId:BELT,quantity:1}],{expectedTotalMinor:total([1250,1])})));
 const o3b=(await orders(s3.saleId))[0];assert.deepEqual([o3b.status,o3b.attempts,o3b.ship_to,o3b.oid],['DONE',2,null,fake.posOrders.get(o3.id).orderId]);
 assert.equal(fake.posOrders.size,4);
 assert.deepEqual(ok(await sale(cashier,A.schoolId,s3.saleId)).shopifyOrder,{status:'DONE',shipTo:'CUSTOMER',name:o3b.oname,failureCode:null});
 pass('an order whose answer was lost waits at least 60 seconds, then is found by its tag: Shopify holds it once');

 // 6. Shopify refuses: FAILED with its reason and the address kept; only a manager sends it again, at once.
 fake.writeFault='REJECT';
 const s6=ok(await sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME}))).sale;
 assert.deepEqual(s6.shopifyOrder,{status:'FAILED',shipTo:'CUSTOMER',name:null,failureCode:'SHOPIFY_REJECTED'});
 assert.deepEqual(ok(await read(manager,A.schoolId)).shopify.madeToOrder.unsent,{waiting:0,failed:1});
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='pos.shopify_order.failed' AND entity_id=$1",[s6.saleId]))[0].n,1);
 ok(await sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME})));assert.equal((await orders(s6.saleId))[0].status,'FAILED');
 await denied(()=>resend(cashier,A.schoolId),403,'POS_FORBIDDEN');
 await denied(()=>resend(managerB,A.schoolId),403,'POS_FORBIDDEN');
 const size6=fake.posOrders.size;
 assert.deepEqual(ok(await resend(manager,A.schoolId)).shopify.madeToOrder.unsent,{waiting:0,failed:0});
 const o6=(await orders(s6.saleId))[0];assert.deepEqual([o6.status,o6.attempts,o6.ship_to,o6.failure_code],['DONE',2,null,null]);assert.equal(fake.posOrders.size,size6+1);
 // A refund in HON does not touch the Shopify order.
 const c6=fake.calls.length,rf=ok(await refund(manager,{schoolId:A.schoolId,saleId:s6.saleId,amountMinor:hoodieTotal,method:'CASH',reason:'Changed mind',restock:[]})).sale;
 assert.equal(rf.shopifyOrder.status,'DONE');assert.equal(fake.calls.length,c6);
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[{lineId:s1.lines[0].lineId,quantity:1}]}),400,'POS_RESTOCK_INVALID');
 pass('an order Shopify refuses is FAILED with its reason, left alone by later sales, sent again only by a manager; a refund never changes the Shopify order');

 // 7. The runtime entry points decide everything again.
 fake.writeFault='LOSE_ANSWER';
 const s7=ok(await sell(cashier,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME}))).sale,o7=(await orders(s7.saleId))[0];
 const begin=(who,o)=>restricted.query('SELECT hon.begin_pos_shopify_order($1,$2::jsonb) d',[who.externalSubject,JSON.stringify(o)]);
 const finish=(who,o)=>restricted.query('SELECT hon.finish_pos_shopify_order($1,$2::jsonb) d',[who.externalSubject,JSON.stringify(o)]);
 const fin={schoolId:A.schoolId,orderTaskId:o7.id,outcome:'DONE',failureCode:null,shopifyOrderId:'12345',shopifyOrderName:'#9'};
 await assert.rejects(()=>begin(managerB,{schoolId:A.schoolId,retryFailed:false}),e=>e.code==='42501');
 await assert.rejects(()=>begin(cashier,{schoolId:A.schoolId,retryFailed:true}),e=>e.code==='42501');
 await assert.rejects(()=>begin(cashier,{schoolId:A.schoolId}),e=>e.code==='22023');
 assert.deepEqual((await begin(cashier,{schoolId:A.schoolId,retryFailed:false})).rows[0].d.orders,[]); // inside the 60 seconds
 assert.deepEqual((await begin(managerB,{schoolId:B.schoolId,retryFailed:false})).rows[0].d,{state:'NOT_CONNECTED',connectionId:null,shopDomain:null,credential:null,orders:[]});
 await assert.rejects(()=>finish(managerB,{...fin,schoolId:B.schoolId}),e=>e.message==='POS_NOT_FOUND');
 await assert.rejects(()=>finish(managerB,fin),e=>e.code==='42501');
 for(const bad of [{failureCode:'X'},{shopifyOrderId:null},{shopifyOrderId:'012'},{shopifyOrderName:''},{outcome:'FAILED'},{outcome:'FAILED',failureCode:'lower',shopifyOrderId:null,shopifyOrderName:null},
  {outcome:'RETRY',failureCode:'TRANSIENT'},{outcome:'GONE'}])await assert.rejects(()=>finish(cashier,{...fin,...bad}),e=>e.code==='22023',JSON.stringify(bad));
 assert.equal((await orders(s7.saleId))[0].status,'PENDING');
 // 8. The cap: after five uncertain tries the order is FAILED for a manager; and a revoked grant ends at once.
 await q("UPDATE hon.pos_shopify_orders SET attempts=4,last_attempt_at=NULL WHERE id=$1",[o7.id]);
 fake.posOrders.delete(o7.id);fake.writeFault='LOSE_ANSWER';
 assert.deepEqual(ok(await resend(manager,A.schoolId)).shopify.madeToOrder.unsent,{waiting:0,failed:1});
 const o7b=(await orders(s7.saleId))[0];assert.deepEqual([o7b.status,o7b.attempts,o7b.failure_code],['FAILED',5,'SHOPIFY_UNAVAILABLE']);assert.deepEqual(o7b.ship_to,HOME_ADDRESS);
 await q("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1",[cashierGrant]);
 await assert.rejects(()=>begin(cashier,{schoolId:A.schoolId,retryFailed:false}),e=>e.code==='42501');
 await assert.rejects(()=>finish(cashier,fin),e=>e.code==='42501');
 pass('begin and finish are refused across schools, to sellers for a retry, with bad input and after a revoked grant; five uncertain tries end as FAILED');

 // 9. The store takes the order permission back: nothing is sent, nothing is lost.
 await q("UPDATE hon.pos_shopify_orders SET status='PENDING',settled_at=NULL,last_attempt_at=NULL WHERE id=$1",[o7.id]);
 await q("UPDATE hon.shopify_connections SET scopes=$2,version=version+1 WHERE id=$1",[conn,BASE.join()]);
 const c9=fake.calls.length,r9=ok(await resend(manager,A.schoolId)).shopify;
 assert.deepEqual(r9.madeToOrder,{state:'NEEDS_PERMISSION',pickup:true,unsent:{waiting:1,failed:0}});assert.deepEqual(r9.items.map(i=>i.variantId),[BELT]);assert.equal(fake.calls.length,c9);
 await denied(()=>sell(manager,saleBody(A.schoolId,hoodie,{expectedTotalMinor:hoodieTotal,shipTo:HOME})),409,'POS_ITEM_UNAVAILABLE');
 assert.deepEqual(ok(await sale(manager,A.schoolId,s1.saleId)).shopifyOrder,{status:'DONE',shipTo:'SCHOOL',name:'#1001',failureCode:null});
 pass('when the store no longer lets HON create orders nothing is sent, the waiting order keeps waiting, and made-to-order items leave the register; finished orders stay on their receipts');

 // 10. Evidence: an order row keeps its identity, DONE is final, an address can only be cleared, nothing is deleted.
 for(const st of ["UPDATE hon.pos_shopify_orders SET status='PENDING',settled_at=NULL WHERE id='"+o1.id+"'","UPDATE hon.pos_shopify_orders SET shopify_order_name='#1' WHERE id='"+o1.id+"'",
  "UPDATE hon.pos_shopify_orders SET sale_id='"+s2.saleId+"' WHERE id='"+o7.id+"'","UPDATE hon.pos_shopify_orders SET ship_kind='SCHOOL' WHERE id='"+o7.id+"'",
  "UPDATE hon.pos_shopify_orders SET ship_to='{\"name\":\"x\"}' WHERE id='"+o7.id+"'","UPDATE hon.pos_shopify_orders SET attempts=0 WHERE id='"+o7.id+"'",
  "DELETE FROM hon.pos_shopify_orders","TRUNCATE hon.pos_shopify_orders","UPDATE hon.pos_sale_lines SET made_by=NULL WHERE made_by IS NOT NULL",
  "INSERT INTO hon.pos_shopify_orders(organization_id,school_id,connection_id,sale_id,ship_kind,ship_to,created_by_principal_id) SELECT organization_id,school_id,connection_id,sale_id,ship_kind,'{}',created_by_principal_id FROM hon.pos_shopify_orders WHERE id='"+o1.id+"'"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23505','23514','0A000'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('order rows and made-to-order lines refuse unguarded edits and deletes; one order per sale');
 console.log('POS made-to-order proof (0614): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
