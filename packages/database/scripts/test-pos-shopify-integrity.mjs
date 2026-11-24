/** 0613 POS sells Shopify products. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture); Shopify is the deterministic fake. */
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
const pass=name=>console.log('PASS POS-SHOPIFY '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:pos:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=POS_HUMAN_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests','pos_shopify_stock_tasks','audit_events','outbox_events'];
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
const addPerson=async(o,given,family)=>(await q('INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4) RETURNING id',[o.organizationId,o.schoolId,given,family]))[0].id;
const read=(identity,s)=>send('school/schools/'+s+'/pos',{identity,method:'GET'});
const sales=(identity,s,f,t)=>send('school/schools/'+s+'/pos/sales/'+f+'/'+t,{identity,method:'GET'});
const sale=(identity,s,id)=>send('school/schools/'+s+'/pos/sale/'+id,{identity,method:'GET'});
const cmd=path=>(identity,b,o={})=>send('school/pos/'+path,{identity,body:b,...o});
const saveSettings=cmd('settings'),saveItem=cmd('items'),stock=cmd('stock'),sell=cmd('sales'),refund=cmd('refunds');
const newItem=(schoolId,o={})=>({schoolId,itemId:null,expectedVersion:null,name:'Black uniform',sku:null,category:'UNIFORMS',priceMinor:10000,taxable:true,trackStock:true,lowStockAt:2,startingStock:5,active:true,...o});
const saleBody=(schoolId,lines,o={})=>({schoolId,personId:null,walkInName:null,lines,discount:null,method:'CASH',reference:null,note:null,expectedTotalMinor:0,...o});

const resend=(identity,schoolId)=>send('school/pos/shopify-stock',{identity,body:{schoolId}});
const shopify=shopifyAppFromEnvironment({HON_SHOPIFY_FAKE:'1'}),fake=shopify.fake;let skew=0;
const SHOP='pos-proof-'+K().slice(0,8)+'.myshopify.com',SYNC=K();
// Shopify ids: product 1 (ACTIVE: belt counted, sticker not counted, hoodie made by a provider), product 2 (DRAFT).
const BELT='7001',STICKER='7002',HOODIE='7003',DRAFTV='7004';
const mirror=()=>[{id:'601',title:'Dojo gear',status:'ACTIVE',vendor:null,productType:null,handle:'dojo-gear',imageUrl:null,variants:[
  {id:BELT,title:'White belt',sku:'BELT-W',barcode:null,price:'12.50',compareAtPrice:null,unitCost:null,tracked:true,inventoryQuantity:5,fulfilledBy:null},
  {id:STICKER,title:'Sticker',sku:null,barcode:null,price:'3',compareAtPrice:null,unitCost:null,tracked:false,inventoryQuantity:null,fulfilledBy:null},
  {id:HOODIE,title:'Hoodie',sku:'HOOD-1',barcode:null,price:'40',compareAtPrice:null,unitCost:null,tracked:true,inventoryQuantity:9,fulfilledBy:'Sample Print Co'}]},
 {id:'602',title:'Coming soon',status:'DRAFT',vendor:null,productType:null,handle:'soon',imageUrl:null,variants:[
  {id:DRAFTV,title:'Default Title',sku:null,barcode:null,price:'9.99',compareAtPrice:null,unitCost:null,tracked:true,inventoryQuantity:2,fulfilledBy:null}]}];
const fakeQty=id=>fake.store(SHOP).products.flatMap(p=>p.variants).find(v=>v.id===id).inventoryQuantity;
const mirrorQty=async(conn,id)=>(await q('SELECT inventory_quantity n FROM hon.shopify_variants WHERE connection_id=$1 AND shopify_id=$2',[conn,id]))[0].n;
const tasks=async sale=>q('SELECT change,status,failure_code,attempts,(refund_id IS NOT NULL) refund FROM hon.pos_shopify_stock_tasks WHERE sale_id=$1 ORDER BY created_at,id',[sale]);

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL of what 0613 adds.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.pos_shopify_stock_tasks',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.pos_shopify_stock_tasks'::regclass"))[0],{r:true,f:true,n:0});
 const entries=['begin_pos_shopify_stock','rotate_pos_shopify_credential','finish_pos_shopify_stock','begin_pos_shopify_order','finish_pos_shopify_order'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%pos\\_shopify%'");
 assert.equal(fns.length,13,fns.map(f=>f.proname).join()); // 8 from 0613, 5 from 0614
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.pos_shopify_stock_tasks'),e=>e.code==='42501');
 pass('the stock task table is forced-RLS private; the runtime gains exactly begin, rotate and finish');

 // Fixture: school A (manager, cashier) with a Shopify store, school B without one.
 const hq={subject:'pos-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'POS synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'POS synthetic','POS synthetic','POS school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'pos-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,await customRole(A,'CUSTOM_POS_MANAGE',['school.view','pos.manage']));
 const cashier=person('cashier');await grant(A,await human(cashier,'Cashier'),await customRole(A,'CUSTOM_POS_SELL',['school.view','pos.sell']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_POS_MANAGE',['school.view','pos.manage']));
 const module=await Test.createTestingModule({controllers:[SchoolPosController],providers:[SchoolPosService,SchoolPosHumanGuard,HonIdentityService,
  {provide:RuntimeDatabaseService,useValue:database},{provide:SHOPIFY_APP,useValue:shopify},{provide:'SHOPIFY_CLOCK',useValue:()=>Date.now()+skew}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;
 ok(await saveSettings(manager,{schoolId:A.schoolId,expectedVersion:null,currency:'USD',taxRateBps:1000}));
 const MTO={madeToOrder:{state:'NONE',pickup:false,unsent:{waiting:0,failed:0}}};
 const NONE={state:'NOT_CONNECTED',shopName:null,items:[],unsent:{waiting:0,failed:0},...MTO};
 assert.deepEqual(ok(await read(cashier,A.schoolId)).shopify,NONE);

 // 2. Connect a store (read-only first, in another currency), mirror its catalog.
 fake.setStore(SHOP,{products:mirror(),currency:'USD',name:'Proof Dojo'});
 const code=new URLSearchParams(fake.approve(SHOP,'state',undefined,['read_products','read_inventory','read_orders','write_products','write_inventory'])).get('code');
 const got=await fake.exchangeCode(SHOP,code),pair={accessToken:got.accessToken,refreshToken:got.refreshToken,accessExpiresAt:got.accessExpiresAt,refreshExpiresAt:got.refreshExpiresAt},conn=K();
 await admin.query('BEGIN');
 await q("INSERT INTO hon.shopify_connections(id,organization_id,school_id,shop_domain,shop_name,currency,scopes,status,connected_by_principal_id) VALUES($1,$2,$3,$4,'Proof Dojo','CAD','read_products,read_inventory,read_orders','CONNECTED',$5)",[conn,A.organizationId,A.schoolId,SHOP,managerPrincipal]);
 await q("INSERT INTO hon.shopify_credentials(connection_id,organization_id,school_id,key_id,sealed,access_expires_at,refresh_expires_at,stored_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
  [conn,A.organizationId,A.schoolId,shopify.vault.keyId,shopify.vault.seal({connectionId:conn,shopDomain:SHOP},pair),pair.accessExpiresAt,pair.refreshExpiresAt,managerPrincipal]);
 await admin.query('COMMIT');
 for(const p of mirror()){
  await q("INSERT INTO hon.shopify_products(connection_id,shopify_id,organization_id,school_id,title,status,handle,last_sync_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[conn,p.id,A.organizationId,A.schoolId,p.title,p.status,p.handle,SYNC]);
  let pos=0;for(const v of p.variants)await q("INSERT INTO hon.shopify_variants(connection_id,shopify_id,product_shopify_id,title,sku,price,tracked,inventory_quantity,position,last_sync_id,fulfilled_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
   [conn,v.id,p.id,v.title,v.sku,v.price,v.tracked,v.inventoryQuantity,++pos,SYNC,v.fulfilledBy]);
 }
 assert.deepEqual(ok(await read(cashier,A.schoolId)).shopify,{...NONE,state:'NEEDS_EDITING',shopName:'Proof Dojo'});
 const beltLine=[{shopifyVariantId:BELT,quantity:1}],beltTotal=n=>computePosTotals([{unitPriceMinor:1250,quantity:n,taxable:true}],null,1000).totalMinor;
 await denied(()=>sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)})),409,'POS_ITEM_UNAVAILABLE');
 await q("UPDATE hon.shopify_connections SET scopes='read_orders,write_products,write_inventory',version=version+1 WHERE id=$1",[conn]);
 assert.deepEqual(ok(await read(cashier,A.schoolId)).shopify,{...NONE,state:'CURRENCY_MISMATCH',shopName:'Proof Dojo'});
 await denied(()=>sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)})),409,'POS_ITEM_UNAVAILABLE');
 await q("UPDATE hon.shopify_connections SET currency='USD',version=version+1 WHERE id=$1",[conn]);
 const r1=ok(await read(cashier,A.schoolId)).shopify;
 assert.deepEqual(r1,{state:'READY',shopName:'Proof Dojo',unsent:{waiting:0,failed:0},madeToOrder:{state:'NEEDS_PERMISSION',pickup:false,unsent:{waiting:0,failed:0}},items:[
  {variantId:STICKER,productId:'601',name:'Dojo gear - Sticker',sku:null,priceMinor:300,tracked:false,stock:null,imageUrl:null,madeBy:null},
  {variantId:BELT,productId:'601',name:'Dojo gear - White belt',sku:'BELT-W',priceMinor:1250,tracked:true,stock:5,imageUrl:null,madeBy:null}]});
 assert.deepEqual(ok(await read(managerB,B.schoolId)).shopify,NONE);
 pass('the register lists a connected store only when editing is allowed and the currency matches: ACTIVE products the school stocks itself, never a provider-made or draft one');

 // 3. A sale with a Shopify line: mirror price, taxable, sent to Shopify in the same request.
 const item=ok(await saveItem(manager,newItem(A.schoolId,{name:'Board',category:'EQUIPMENT',priceMinor:500,taxable:false,trackStock:false,lowStockAt:null,startingStock:0}))).item;
 const lines=[{shopifyVariantId:BELT,quantity:2},{itemId:item.itemId,quantity:1},{shopifyVariantId:STICKER,quantity:3}];
 const expect=computePosTotals([{unitPriceMinor:1250,quantity:2,taxable:true},{unitPriceMinor:500,quantity:1,taxable:false},{unitPriceMinor:300,quantity:3,taxable:true}],null,1000);
 assert.deepEqual(expect,{subtotalMinor:3900,discountMinor:0,taxMinor:340,totalMinor:4240});
 await denied(()=>sell(cashier,saleBody(A.schoolId,lines,{expectedTotalMinor:expect.totalMinor-1})),409,'POS_TOTAL_CHANGED');
 for(const bad of [HOODIE,DRAFTV,'999999'])await denied(()=>sell(cashier,saleBody(A.schoolId,[{shopifyVariantId:bad,quantity:1}],{expectedTotalMinor:0})),409,'POS_ITEM_UNAVAILABLE');
 for(const bad of [{shopifyVariantId:7001,quantity:1},{shopifyVariantId:'07001',quantity:1},{shopifyVariantId:BELT,itemId:item.itemId,quantity:1}])
  await denied(()=>sell(cashier,saleBody(A.schoolId,[bad],{expectedTotalMinor:0})),400,'POS_INVALID');
 await denied(()=>sell(managerB,saleBody(B.schoolId,beltLine,{expectedTotalMinor:1250})),409,'POS_ITEM_UNAVAILABLE');
 const key=K(),calls0=fake.calls.length,s1=ok(await sell(cashier,saleBody(A.schoolId,lines,{expectedTotalMinor:expect.totalMinor}),{key})).sale;
 assert.deepEqual(s1.lines.map(l=>[l.name,l.category,l.shopifyVariantId,l.itemId===null,l.unitPriceMinor,l.quantity,l.taxable,l.stockTracked,l.sku]),[
  ['Dojo gear - White belt','SHOPIFY',BELT,true,1250,2,true,true,'BELT-W'],['Board','EQUIPMENT',null,false,500,1,false,false,null],['Dojo gear - Sticker','SHOPIFY',STICKER,true,300,3,true,false,null]]);
 assert.equal(s1.totalMinor,4240);assert.deepEqual(s1.shopifyStock,{waiting:0,done:1,failed:0});
 assert.equal(fakeQty(BELT),3);assert.equal(await mirrorQty(conn,BELT),3);
 assert.deepEqual(await tasks(s1.saleId),[{change:-2,status:'DONE',failure_code:null,attempts:1,refund:false}]);
 assert.deepEqual(fake.calls.slice(calls0),['adjustInventory:'+SHOP]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='pos.shopify_stock.sent' AND entity_id=$1",[s1.saleId]))[0].n,1);
 // The exact replay sells nothing again and sends nothing again.
 const replay=ok(await sell(cashier,saleBody(A.schoolId,lines,{expectedTotalMinor:expect.totalMinor}),{key}));
 assert.equal(replay.replayed,true);assert.equal(fakeQty(BELT),3);assert.equal(fake.calls.length,calls0+1);
 assert.equal(ok(await read(cashier,A.schoolId)).shopify.items.find(i=>i.variantId===BELT).stock,3);
 // More than Shopify counts is still sold: the item is in the customer's hand.
 const s2=ok(await sell(cashier,saleBody(A.schoolId,[{shopifyVariantId:BELT,quantity:4}],{expectedTotalMinor:beltTotal(4)}))).sale;
 assert.deepEqual(s2.shopifyStock,{waiting:0,done:1,failed:0});assert.equal(fakeQty(BELT),-1);assert.equal(await mirrorQty(conn,BELT),-1);
 pass('a Shopify line sells at the mirror price with tax, lowers Shopify and the mirror once, is never refused for stock, and replays without sending again');

 // 4. A lost answer: the change waits, is shown in the count, and the next send settles it without changing Shopify twice.
 fake.writeFault='LOSE_ANSWER';
 const s3=ok(await sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)}))).sale;
 assert.deepEqual(s3.shopifyStock,{waiting:1,done:0,failed:0});assert.equal(fakeQty(BELT),-2);assert.equal(await mirrorQty(conn,BELT),-1);
 const r3=ok(await read(cashier,A.schoolId)).shopify;assert.deepEqual(r3.unsent,{waiting:1,failed:0});assert.equal(r3.items.find(i=>i.variantId===BELT).stock,-2);
 const s4=ok(await sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)}))).sale;
 assert.deepEqual(s4.shopifyStock,{waiting:0,done:1,failed:0});assert.equal(fakeQty(BELT),-3);assert.equal(await mirrorQty(conn,BELT),-3);
 assert.deepEqual(await tasks(s3.saleId),[{change:-1,status:'DONE',failure_code:null,attempts:2,refund:false}]);
 assert.deepEqual(ok(await sale(cashier,A.schoolId,s3.saleId)).shopifyStock,{waiting:0,done:1,failed:0});
 pass('a change whose answer was lost waits, shows in the register count, and is sent again with the same key: Shopify changes once');

 // 5. Shopify refuses: FAILED, visible; only a manager sends it again.
 fake.writeFault='REJECT';
 const s5=ok(await sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)}))).sale;
 assert.deepEqual(s5.shopifyStock,{waiting:0,done:0,failed:1});assert.equal(fakeQty(BELT),-3);
 assert.deepEqual(await tasks(s5.saleId),[{change:-1,status:'FAILED',failure_code:'SHOPIFY_REJECTED',attempts:1,refund:false}]);
 assert.deepEqual(ok(await read(manager,A.schoolId)).shopify.unsent,{waiting:0,failed:1});
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='pos.shopify_stock.failed' AND entity_id=$1",[s5.saleId]))[0].n,1);
 // A failed change is not picked up by the next sale...
 ok(await sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)})));assert.equal(fakeQty(BELT),-4);
 assert.equal((await tasks(s5.saleId))[0].status,'FAILED');
 // ...and a seller cannot send it again; a manager can.
 await denied(()=>resend(cashier,A.schoolId),403,'POS_FORBIDDEN');
 await denied(()=>resend(managerB,A.schoolId),403,'POS_FORBIDDEN');
 await denied(()=>send('school/pos/shopify-stock',{identity:manager,body:{schoolId:A.schoolId,extra:1}}),400,'POS_INVALID');
 assert.deepEqual(ok(await resend(manager,A.schoolId)).shopify.unsent,{waiting:0,failed:0});
 assert.equal(fakeQty(BELT),-5);assert.equal(await mirrorQty(conn,BELT),-5);
 assert.deepEqual(await tasks(s5.saleId),[{change:-1,status:'DONE',failure_code:null,attempts:2,refund:false}]);
 pass('a change Shopify refuses is FAILED with its reason, left alone by later sales, and sent again only by a manager');

 // 6. A refund that puts Shopify units back raises Shopify's count; not more than was sold, never the uncounted line.
 const belt1=s1.lines[0],sticker1=s1.lines[2];
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[{lineId:belt1.lineId,quantity:3}]}),400,'POS_RESTOCK_INVALID');
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[{lineId:sticker1.lineId,quantity:1}]}),400,'POS_RESTOCK_INVALID');
 const rf=ok(await refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:1375,method:'CASH',reason:'Wrong size',restock:[{lineId:belt1.lineId,quantity:1}]})).sale;
 assert.deepEqual(rf.shopifyStock,{waiting:0,done:2,failed:0});assert.equal(rf.lines[0].restockedQuantity,1);assert.equal(fakeQty(BELT),-4);assert.equal(await mirrorQty(conn,BELT),-4);
 assert.deepEqual(await tasks(s1.saleId),[{change:-2,status:'DONE',failure_code:null,attempts:1,refund:false},{change:1,status:'DONE',failure_code:null,attempts:1,refund:true}]);
 assert.equal((await q('SELECT count(*)::int n FROM hon.pos_stock_moves WHERE sale_id=$1',[s1.saleId]))[0].n,0);
 pass('a refund restock of a Shopify line raises Shopify by that quantity; over-restock and uncounted lines are refused');

 // 7. The token is refreshed under the stored version when it is about to run out.
 const v0=(await q('SELECT version FROM hon.shopify_credentials WHERE connection_id=$1',[conn]))[0].version;
 skew=58*60_000;const c7=fake.calls.length;
 const s7=ok(await sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)}))).sale;skew=0;
 assert.deepEqual(s7.shopifyStock,{waiting:0,done:1,failed:0});assert.deepEqual(fake.calls.slice(c7),['refresh:'+SHOP,'adjustInventory:'+SHOP]);
 assert.equal((await q('SELECT version FROM hon.shopify_credentials WHERE connection_id=$1',[conn]))[0].version,v0+1);
 // The runtime cannot rotate without a waiting change, with a stale version, or from another school.
 const cred={keyId:shopify.vault.keyId,sealed:shopify.vault.seal({connectionId:conn,shopDomain:SHOP},pair),accessExpiresAt:new Date(Date.now()+3600_000).toISOString(),refreshExpiresAt:new Date(Date.now()+86400_000).toISOString()};
 const rotate=(who,o)=>restricted.query('SELECT hon.rotate_pos_shopify_credential($1,$2::jsonb)',[who.externalSubject,JSON.stringify(o)]);
 await assert.rejects(()=>rotate(cashier,{schoolId:A.schoolId,expectedVersion:v0+1,credential:cred}),e=>e.code==='P0002'&&e.message==='POS_NOT_FOUND');
 await assert.rejects(()=>rotate(managerB,{schoolId:A.schoolId,expectedVersion:v0+1,credential:cred}),e=>e.code==='42501');
 assert.equal((await q('SELECT version FROM hon.shopify_credentials WHERE connection_id=$1',[conn]))[0].version,v0+1);
 pass('an expiring token is refreshed and rotated under the handed version; rotation needs a waiting change at that school');

 // 8. The runtime entry points decide everything again: finish only this school's waiting change, once.
 fake.writeFault='LOSE_ANSWER';
 const s8=ok(await sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)}))).sale;
 const t8=(await q('SELECT id FROM hon.pos_shopify_stock_tasks WHERE sale_id=$1',[s8.saleId]))[0].id;
 const finish=(who,o)=>restricted.query('SELECT hon.finish_pos_shopify_stock($1,$2::jsonb) d',[who.externalSubject,JSON.stringify(o)]);
 await assert.rejects(()=>finish(managerB,{schoolId:B.schoolId,taskId:t8,outcome:'DONE',failureCode:null}),e=>e.message==='POS_NOT_FOUND');
 await assert.rejects(()=>finish(managerB,{schoolId:A.schoolId,taskId:t8,outcome:'DONE',failureCode:null}),e=>e.code==='42501');
 for(const bad of [{outcome:'DONE',failureCode:'X'},{outcome:'FAILED',failureCode:null},{outcome:'FAILED',failureCode:'lower'},{outcome:'GONE',failureCode:null}])
  await assert.rejects(()=>finish(cashier,{schoolId:A.schoolId,taskId:t8,...bad}),e=>e.code==='22023');
 await assert.rejects(()=>rotate(cashier,{schoolId:A.schoolId,expectedVersion:v0,credential:cred}),e=>e.code==='40001');
 // 9. A store that stops being the school's sellable store: the waiting change settles as FAILED, and nothing more is sold from it.
 await q("UPDATE hon.shopify_connections SET status='DISCONNECTED',ended_at=clock_timestamp(),version=version+1 WHERE id=$1",[conn]);
 await denied(()=>sell(cashier,saleBody(A.schoolId,beltLine,{expectedTotalMinor:beltTotal(1)})),409,'POS_ITEM_UNAVAILABLE');
 const c9=fake.calls.length;
 assert.deepEqual(ok(await resend(manager,A.schoolId)).shopify,{...NONE,unsent:{waiting:0,failed:1}});
 assert.deepEqual(await tasks(s8.saleId),[{change:-1,status:'FAILED',failure_code:'NOT_CONNECTED',attempts:1,refund:false}]);assert.equal(fake.calls.length,c9);
 assert.deepEqual((await finish(cashier,{schoolId:A.schoolId,taskId:t8,outcome:'DONE',failureCode:null})).rows[0].d,{status:'FAILED',changed:false});
 // The Shopify line stays on the receipt after the store is gone.
 assert.equal(ok(await sale(cashier,A.schoolId,s1.saleId)).lines[0].shopifyVariantId,BELT);
 pass('finish and rotate are refused across schools and with stale versions; a disconnected store sells nothing and its waiting change is settled as FAILED');

 // 10. Evidence: a task keeps its identity, DONE is final, nothing is deleted.
 const done=(await q("SELECT id FROM hon.pos_shopify_stock_tasks WHERE status='DONE' LIMIT 1"))[0].id;
 for(const st of ["UPDATE hon.pos_shopify_stock_tasks SET status='PENDING',settled_at=NULL WHERE id='"+done+"'","UPDATE hon.pos_shopify_stock_tasks SET change=5 WHERE id='"+t8+"'",
  "UPDATE hon.pos_shopify_stock_tasks SET attempts=0 WHERE id='"+t8+"'","DELETE FROM hon.pos_shopify_stock_tasks","TRUNCATE hon.pos_shopify_stock_tasks",
  "UPDATE hon.pos_sale_lines SET shopify_variant_id=1 WHERE shopify_variant_id IS NOT NULL","UPDATE hon.pos_sale_lines SET category='QUICK' WHERE category='SHOPIFY'"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23514','0A000'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('stock tasks and Shopify lines refuse unguarded edits and deletes');
 console.log('POS sells Shopify proof (0613): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
