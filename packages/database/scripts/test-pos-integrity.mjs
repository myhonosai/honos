/** 0612 front-desk Point of Sale. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). */
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
const {POS_HUMAN_COMMAND,computePosTotals}=require('@hon/contracts');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const database=new RuntimeDatabaseService();let app,groups=0,origin;
const session={mode:'OIDC',audience:'pos-disposable',secret:randomBytes(32).toString('hex'),emitVerifiedEmail:true};
Object.assign(process.env,{HON_AUTH_MODE:session.mode,HON_SESSION_AUDIENCE:session.audience,HON_SESSION_JWT_SECRET:session.secret});
const pass=name=>console.log('PASS POS '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const person=label=>({externalSubject:'oidc:pos:'+label+':'+K(),email:label+'-'+K()+'@example.invalid',emailVerified:true});
async function send(path,{identity,body,key=K(),method='POST',command=POS_HUMAN_COMMAND,headers={}}={}){
 const cookie=identity?HON_SESSION_COOKIE+'='+issueSession(identity,session,Math.floor(Date.now()/1000)):undefined;
 return new Promise((resolve,reject)=>{const req=request(origin+'/v1/'+path,{method,headers:{...(cookie?{cookie}:{}),origin,'sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty',...(method==='POST'?{'content-type':'application/json','x-hon-human-command':command,...(key?{'idempotency-key':key}:{})}:{}),...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}'),headers:res.headers}));});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.headers['cache-control'],'private, no-store');return r.body.data;};
const tables=['pos_settings','pos_items','pos_sales','pos_sale_lines','pos_refunds','pos_stock_moves','pos_requests','audit_events','outbox_events'];
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

try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. Runtime ACL.
 const posTables=tables.slice(0,7);
 for(const t of posTables)for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])
  assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.'+t,p]))[0].ok,false,t+' '+p);
 for(const t of posTables)assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=('hon.'||$1)::regclass",[t]))[0],{r:true,f:true,n:0});
 const entries=['read_pos','read_pos_sales','read_pos_sale','save_pos_settings','save_pos_item','adjust_pos_stock','record_pos_sale','refund_pos_sale'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND (p.proname LIKE 'pos\\_%' OR p.proname LIKE '%\\_pos' OR p.proname LIKE '%\\_pos\\_%')");
 for(const e of entries)assert(fns.some(f=>f.proname===e),e);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.pos_sales'),e=>e.code==='42501');
 assert.deepEqual((await q("SELECT code,is_sensitive,is_staff_assignable FROM hon.permissions WHERE code LIKE 'pos.%' ORDER BY code")),[{code:'pos.manage',is_sensitive:true,is_staff_assignable:true},{code:'pos.sell',is_sensitive:false,is_staff_assignable:true}]);
 pass('POS tables are forced-RLS private; the runtime executes only the eight entry points; pos.sell and pos.manage exist');

 // Fixture: two schools with paid access; manager, cashier, no-POS staff, other-school manager, outsider.
 const hq={subject:'pos-hq-'+K()};const hqPrincipal=await human({externalSubject:hq.subject,email:K()+'@example.invalid'},'POS synthetic HQ');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[hqPrincipal]);
 const provision=async()=>(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'POS synthetic','POS synthetic','POS school',$2,'America/Los_Angeles','COMPLETE',$3,$3,$4,$4)",[hq.subject,'pos-'+K(),K(),K()]))[0];
 const A=await provision(),B=await provision();
 for(const o of [A,B])await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[o.organizationId]);
 const manager=person('manager'),managerPrincipal=await human(manager,'Manager');const managerGrant=await grant(A,managerPrincipal,await customRole(A,'CUSTOM_POS_MANAGE',['school.view','pos.manage']));
 const cashier=person('cashier');await grant(A,await human(cashier,'Cashier'),await customRole(A,'CUSTOM_POS_SELL',['school.view','pos.sell']));
 const staff=person('staff');await grant(A,await human(staff,'Staff'),await customRole(A,'CUSTOM_PEOPLE',['school.view','people.read']));
 const managerB=person('manager-b');await grant(B,await human(managerB,'Manager B'),await customRole(B,'CUSTOM_POS_MANAGE',['school.view','pos.manage']));
 const outsider=person('outsider');await human(outsider,'Outsider');
 const kid=await addPerson(A,'Mina','Park'),personB=await addPerson(B,'Other','School');
 const module=await Test.createTestingModule({controllers:[SchoolPosController],providers:[SchoolPosService,SchoolPosHumanGuard,HonIdentityService,{provide:RuntimeDatabaseService,useValue:database}]}).compile();
 app=module.createNestApplication({logger:false});app.setGlobalPrefix('v1');await app.listen(0,'127.0.0.1');origin=await app.getUrl();process.env.HON_PUBLIC_ORIGIN=origin;

 // 2. Empty register read, permissions and scope.
 const r0=ok(await read(cashier,A.schoolId));
 assert.deepEqual({...r0,today:'x'},{schoolId:A.schoolId,timezone:'America/Los_Angeles',today:'x',canManage:false,settings:{currency:'USD',taxRateBps:0,version:null},items:[],todaySales:{count:0,totalMinor:0}});
 assert.equal(ok(await read(manager,A.schoolId)).canManage,true);
 for(const who of [staff,outsider,managerB])await denied(()=>read(who,A.schoolId),403,'POS_FORBIDDEN');
 // Staff only: an HQ operator or a family-coded role holding pos.manage at this school is still refused.
 const hqop=person('hq-operator'),hqopPrincipal=await human(hqop,'HQ operator');
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_SUPPORT',ARRAY[]::text[],clock_timestamp()-interval '1 day')",[hqopPrincipal]);
 await grant(A,hqopPrincipal,await customRole(A,'CUSTOM_HQ_POS',['school.view','pos.manage']));
 await denied(()=>read(hqop,A.schoolId),403,'POS_FORBIDDEN');
 const parent=person('parent');await grant(A,await human(parent,'Parent'),await customRole(A,'FAMILY_POS',['pos.manage']));
 await denied(()=>read(parent,A.schoolId),403,'POS_FORBIDDEN');
 for(const who of [cashier,staff])await denied(()=>saveItem(who,newItem(A.schoolId)),403,'POS_FORBIDDEN');
 await denied(()=>saveSettings(cashier,{schoolId:A.schoolId,expectedVersion:null,currency:'USD',taxRateBps:800}),403,'POS_FORBIDDEN');
 await denied(()=>saveItem(manager,newItem(A.schoolId),{command:'school-person-photo'}),403,'HUMAN_UI_REQUIRED');
 await denied(()=>saveItem(manager,newItem(A.schoolId),{key:null}),400,'POS_INVALID');
 await denied(()=>saveItem(manager,{...newItem(A.schoolId),extra:1}),400,'POS_INVALID');
 await denied(()=>saveItem(manager,newItem(A.schoolId,{trackStock:false})),400,'POS_INVALID');
 await q("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[A.organizationId]);
 await denied(()=>read(manager,A.schoolId),403,'POS_FORBIDDEN');
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[A.organizationId]);
 pass('pos.sell reads and sells, pos.manage manages; no POS permission, another school, outsiders, suspended access and non-human transport are refused and write nothing');

 // 3. Settings and catalog.
 const st=ok(await saveSettings(manager,{schoolId:A.schoolId,expectedVersion:null,currency:'USD',taxRateBps:825}));
 assert.deepEqual(st,{settings:{currency:'USD',taxRateBps:825,version:1},replayed:false});
 await denied(()=>saveSettings(manager,{schoolId:A.schoolId,expectedVersion:null,currency:'USD',taxRateBps:0}),409,'POS_VERSION_CONFLICT');
 const uniform=ok(await saveItem(manager,newItem(A.schoolId,{sku:'EQ-BU'}))).item;
 assert.deepEqual({...uniform,itemId:'x'},{itemId:'x',name:'Black uniform',sku:'EQ-BU',category:'UNIFORMS',priceMinor:10000,taxable:true,trackStock:true,stock:5,lowStockAt:2,lowStock:false,active:true,version:1});
 const test=ok(await saveItem(manager,newItem(A.schoolId,{name:'Color belt test',category:'TESTING',priceMinor:7500,taxable:false,trackStock:false,lowStockAt:null,startingStock:0}))).item;
 await denied(()=>saveItem(manager,newItem(A.schoolId,{sku:'eq-bu',name:'Copy'})),409,'POS_SKU_TAKEN');
 const shirtKey=K(),shirt=ok(await saveItem(manager,newItem(A.schoolId,{name:'T-shirt',category:'APPAREL',priceMinor:2000,startingStock:3,lowStockAt:null}),{key:shirtKey})).item;
 assert.equal(ok(await saveItem(manager,newItem(A.schoolId,{name:'T-shirt',category:'APPAREL',priceMinor:2000,startingStock:3,lowStockAt:null}),{key:shirtKey})).replayed,true);
 await denied(()=>saveItem(manager,newItem(A.schoolId,{name:'Other'}),{key:shirtKey}),409,'POS_KEY_REUSED');
 assert.deepEqual((await q("SELECT kind,change,stock_after FROM hon.pos_stock_moves WHERE item_id=$1",[uniform.itemId])),[{kind:'STARTING',change:5,stock_after:5}]);
 await denied(()=>saveItem(managerB,{...newItem(B.schoolId),itemId:uniform.itemId,expectedVersion:1,startingStock:0}),404,'POS_NOT_FOUND');
 pass('managers set the tax rate and add items (SKU unique per school, starting stock recorded, exact replay, key reuse refused); another school cannot touch them');

 // 4. A sale: server totals equal the shared arithmetic; stock goes down; receipt numbered.
 const lines=[{itemId:uniform.itemId,quantity:2},{itemId:test.itemId,quantity:1},{description:'Parents night',unitPriceMinor:1500,quantity:1}];
 const discount={kind:'PERCENT',value:10,reason:'Family discount'};
 const expect=computePosTotals([{unitPriceMinor:10000,quantity:2,taxable:true},{unitPriceMinor:7500,quantity:1,taxable:false},{unitPriceMinor:1500,quantity:1,taxable:false}],discount,825);
 assert.deepEqual(expect,{subtotalMinor:29000,discountMinor:2900,taxMinor:1485,totalMinor:27585});
 await denied(()=>sell(cashier,saleBody(A.schoolId,lines,{discount,personId:kid,expectedTotalMinor:expect.totalMinor+1})),409,'POS_TOTAL_CHANGED');
 await denied(()=>sell(cashier,saleBody(A.schoolId,lines,{discount,personId:personB,expectedTotalMinor:expect.totalMinor})),404,'POS_NOT_FOUND');
 await denied(()=>sell(cashier,saleBody(A.schoolId,[{itemId:uniform.itemId,quantity:3},{itemId:uniform.itemId,quantity:3}],{expectedTotalMinor:computePosTotals([{unitPriceMinor:10000,quantity:6,taxable:true}],null,825).totalMinor})),409,'POS_OUT_OF_STOCK');
 await denied(()=>sell(cashier,saleBody(A.schoolId,[{itemId:test.itemId,quantity:1}],{discount:{kind:'AMOUNT',value:8000,reason:'x'},expectedTotalMinor:0})),400,'POS_DISCOUNT_TOO_LARGE');
 await denied(()=>sell(managerB,saleBody(B.schoolId,[{itemId:uniform.itemId,quantity:1}],{expectedTotalMinor:10825})),409,'POS_ITEM_UNAVAILABLE');
 const saleKey=K(),c0=await counts();
 const s1=ok(await sell(cashier,saleBody(A.schoolId,lines,{discount,personId:kid,expectedTotalMinor:expect.totalMinor}),{key:saleKey})).sale;
 assert.match(s1.receiptNumber,/^POS-\d{8}-0001$/);assert.equal(s1.totalMinor,27585);assert.equal(s1.taxMinor,1485);assert.equal(s1.subtotalMinor,29000);
 assert.deepEqual(s1.discount,{kind:'PERCENT',value:10,reason:'Family discount',amountMinor:2900});assert.deepEqual(s1.customer,{personId:kid,name:'Mina Park'});
 assert.equal(s1.status,'PAID');assert.equal(s1.lines.length,3);assert.equal(s1.lines[2].category,'QUICK');assert.equal(s1.soldBy,'Cashier');
 const c1=await counts();
 for(const [t,d] of Object.entries({pos_sales:1,pos_sale_lines:3,pos_stock_moves:1,audit_events:1,outbox_events:1}))assert.equal(Number(c1[t]),Number(c0[t])+d,t);
 assert.equal((await q('SELECT stock FROM hon.pos_items WHERE id=$1',[uniform.itemId]))[0].stock,3);
 const ob=(await q("SELECT event_type,payload FROM hon.outbox_events WHERE aggregate_id=$1",[s1.saleId]))[0];
 assert.equal(ob.event_type,'pos.sale.recorded');assert.deepEqual(Object.keys(ob.payload).sort(),['currency','discountMinor','lineCount','method','personId','receiptNumber','saleId','taxMinor','totalMinor']);
 const again=ok(await sell(cashier,saleBody(A.schoolId,lines,{discount,personId:kid,expectedTotalMinor:expect.totalMinor}),{key:saleKey}));
 assert.equal(again.replayed,true);assert.equal(again.sale.saleId,s1.saleId);assert.deepEqual(await counts(),c1);
 // Rounding parity on awkward numbers: tax on a discounted mixed cart, both ways.
 for(const [price,qty,pct,bps] of [[333,3,7,725],[999,1,33,1000],[1,1,50,2500],[4999,7,1,875]]){
  const lt=[{itemId:shirt.itemId,quantity:1},{description:'Odd',unitPriceMinor:price,quantity:qty}];
  await q('UPDATE hon.pos_settings SET tax_rate_bps=$1,version=version+1 WHERE school_id=$2',[bps,A.schoolId]);
  const want=computePosTotals([{unitPriceMinor:2000,quantity:1,taxable:true},{unitPriceMinor:price,quantity:qty,taxable:false}],{kind:'PERCENT',value:pct},bps);
  const got=ok(await sell(cashier,saleBody(A.schoolId,lt,{discount:{kind:'PERCENT',value:pct,reason:'r'},expectedTotalMinor:want.totalMinor}))).sale;
  assert.deepEqual([got.subtotalMinor,got.discount.amountMinor,got.taxMinor,got.totalMinor],[want.subtotalMinor,want.discountMinor,want.taxMinor,want.totalMinor]);
  await stock(manager,{schoolId:A.schoolId,itemId:shirt.itemId,expectedVersion:(await q('SELECT version FROM hon.pos_items WHERE id=$1',[shirt.itemId]))[0].version,change:1,reason:'Recount'});
 }
 await q('UPDATE hon.pos_settings SET tax_rate_bps=825,version=version+1 WHERE school_id=$1',[A.schoolId]);
 pass('a sale is priced by the database (same arithmetic as the register), refuses a changed total, other-school people or items, overselling and oversized discounts, takes stock off, numbers the receipt, replays exactly');

 // 5. Walk-in sale and stock adjustments.
 const walk=ok(await sell(cashier,saleBody(A.schoolId,[{itemId:test.itemId,quantity:1}],{walkInName:'Guest',method:'CARD_TERMINAL',reference:'1234',expectedTotalMinor:7500}))).sale;
 assert.deepEqual(walk.customer,{personId:null,name:'Guest'});assert.equal(walk.method,'CARD_TERMINAL');
 await denied(()=>sell(cashier,saleBody(A.schoolId,[{itemId:test.itemId,quantity:1}],{walkInName:'Guest',personId:kid,expectedTotalMinor:7500})),400,'POS_INVALID');
 const u1=(await q('SELECT version,stock FROM hon.pos_items WHERE id=$1',[uniform.itemId]))[0];
 await denied(()=>stock(manager,{schoolId:A.schoolId,itemId:uniform.itemId,expectedVersion:u1.version,change:-(u1.stock+1),reason:'Lost'}),400,'POS_STOCK_OUT_OF_RANGE');
 await denied(()=>stock(manager,{schoolId:A.schoolId,itemId:test.itemId,expectedVersion:1,change:1,reason:'x'}),400,'POS_STOCK_NOT_TRACKED');
 await denied(()=>stock(cashier,{schoolId:A.schoolId,itemId:uniform.itemId,expectedVersion:u1.version,change:1,reason:'x'}),403,'POS_FORBIDDEN');
 const adj=ok(await stock(manager,{schoolId:A.schoolId,itemId:uniform.itemId,expectedVersion:u1.version,change:-2,reason:'Damaged'})).item;
 assert.equal(adj.stock,u1.stock-2);assert.equal(adj.lowStock,true);
 assert.equal(ok(await read(cashier,A.schoolId)).items.find(i=>i.itemId===uniform.itemId).lowStock,true);
 pass('walk-in and card-terminal sales are recorded; stock adjustments need pos.manage, a reason and never go below zero; low stock is flagged');

 // 6. Refunds: manual, reasoned, limited, restock.
 const line=s1.lines[0];
 await denied(()=>refund(cashier,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[]}),403,'POS_FORBIDDEN');
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:27586,method:'CASH',reason:'Too much',restock:[]}),400,'POS_REFUND_TOO_LARGE');
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[{lineId:s1.lines[1].lineId,quantity:1}]}),400,'POS_RESTOCK_INVALID');
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[{lineId:line.lineId,quantity:3}]}),400,'POS_RESTOCK_INVALID');
 await denied(()=>refund(managerB,{schoolId:B.schoolId,saleId:s1.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[]}),404,'POS_NOT_FOUND');
 const before=(await q('SELECT stock FROM hon.pos_items WHERE id=$1',[uniform.itemId]))[0].stock;
 const rf1=ok(await refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:10000,method:'CASH',reason:'Wrong size',restock:[{lineId:line.lineId,quantity:1}]})).sale;
 assert.equal(rf1.status,'PARTLY_REFUNDED');assert.equal(rf1.refundedMinor,10000);assert.equal(rf1.refunds.length,1);assert.equal(rf1.lines[0].restockedQuantity,1);
 assert.equal((await q('SELECT stock FROM hon.pos_items WHERE id=$1',[uniform.itemId]))[0].stock,before+1);
 const rf2=ok(await refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:17585,method:'CHECK',reason:'Left the school',restock:[]})).sale;
 assert.equal(rf2.status,'REFUNDED');
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:s1.saleId,amountMinor:1,method:'CASH',reason:'x',restock:[]}),400,'POS_REFUND_TOO_LARGE');
 assert.deepEqual(ok(await sale(cashier,A.schoolId,s1.saleId)).refunds.map(r=>[r.amountMinor,r.method,r.reason]),[[10000,'CASH','Wrong size'],[17585,'CHECK','Left the school']]);
 await denied(()=>sale(managerB,B.schoolId,s1.saleId),404,'POS_NOT_FOUND');
 pass('refunds need pos.manage and a reason, cannot exceed what is left, restock only sold tracked items, and show on the receipt');

 // 7. History and report.
 const today=ok(await read(cashier,A.schoolId)).today;
 const h=ok(await sales(manager,A.schoolId,today,today));
 assert.equal(h.sales.length,6);assert.equal(h.sales.at(-1).saleId,s1.saleId);
 const all=(await q('SELECT coalesce(sum(total_minor),0)::bigint t,coalesce(sum(subtotal_minor),0)::bigint g,coalesce(sum(tax_minor),0)::bigint x,coalesce(sum(discount_minor),0)::bigint d FROM hon.pos_sales WHERE school_id=$1',[A.schoolId]))[0];
 assert.equal(h.report.salesCount,6);assert.equal(h.report.collectedMinor,Number(all.t));assert.equal(h.report.grossMinor,Number(all.g));assert.equal(h.report.taxMinor,Number(all.x));assert.equal(h.report.discountMinor,Number(all.d));
 assert.equal(h.report.refundedMinor,27585);assert.equal(h.report.netMinor,Number(all.t)-27585);assert.equal(h.report.refundsCount,2);
 assert.deepEqual(h.report.byMethod.map(m=>m.method),['CARD_TERMINAL','CASH','CHECK']);
 assert.equal(h.report.byMethod.find(m=>m.method==='CHECK').refundedMinor,17585);
 assert.equal(ok(await sales(cashier,A.schoolId,today,today)).report,null);
 assert.equal(ok(await read(cashier,A.schoolId)).todaySales.count,6);
 await denied(()=>sales(manager,A.schoolId,'2026-01-01','2027-06-01'),400,'POS_INVALID');
 await denied(()=>sales(managerB,A.schoolId,today,today),403,'POS_FORBIDDEN');
 pass('history lists the day newest first for sellers; the report (managers only) sums sales, discounts, tax, refunds, net and per method');
 // An item that stopped tracking stock after the sale cannot be restocked (no stock move could record it).
 const belt=ok(await saveItem(manager,newItem(A.schoolId,{name:'Belt',sku:'BT-1',startingStock:1,lowStockAt:null}))).item;
 const bs=ok(await sell(cashier,saleBody(A.schoolId,[{itemId:belt.itemId,quantity:1}],{expectedTotalMinor:computePosTotals([{unitPriceMinor:10000,quantity:1,taxable:true}],null,825).totalMinor}))).sale;
 ok(await saveItem(manager,newItem(A.schoolId,{itemId:belt.itemId,expectedVersion:(await q('SELECT version FROM hon.pos_items WHERE id=$1',[belt.itemId]))[0].version,name:'Belt',sku:'BT-1',trackStock:false,lowStockAt:null,startingStock:0})));
 await denied(()=>refund(manager,{schoolId:A.schoolId,saleId:bs.saleId,amountMinor:100,method:'CASH',reason:'x',restock:[{lineId:bs.lines[0].lineId,quantity:1}]}),400,'POS_RESTOCK_INVALID');

 // 8. Evidence cannot be changed even by the owner.
 for(const st of ["UPDATE hon.pos_sales SET total_minor=1 WHERE id='"+s1.saleId+"'","UPDATE hon.pos_sales SET refunded_minor=0 WHERE id='"+s1.saleId+"'",
  "DELETE FROM hon.pos_sales","UPDATE hon.pos_sale_lines SET unit_price_minor=1","UPDATE hon.pos_refunds SET amount_minor=1","DELETE FROM hon.pos_stock_moves",
  "UPDATE hon.pos_items SET price_minor=1","UPDATE hon.pos_settings SET receipt_seq=0","TRUNCATE hon.pos_sales CASCADE","UPDATE hon.pos_requests SET response='{}'::jsonb"]){
  await admin.query('BEGIN');await assert.rejects(()=>admin.query(st),e=>['42501','23503','23514','0A000'].includes(e.code),st);await admin.query('ROLLBACK');}
 pass('sales, lines, refunds, stock moves, items, settings and receipts refuse unguarded edits and deletes');

 // 9. Authority decided again after the last write.
 {const blocker=new pg.Client({connectionString:owner.toString(),ssl:false});await blocker.connect();
  try{await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM hon.pos_settings WHERE school_id=$1 FOR UPDATE',[A.schoolId]);
   const c=await counts();const pending=sell(manager,saleBody(A.schoolId,[{itemId:test.itemId,quantity:1}],{expectedTotalMinor:7500}));
   for(let i=0;i<300;i++){if((await q("SELECT count(*) n FROM pg_locks WHERE locktype='transactionid' AND NOT granted"))[0].n!=='0')break;await new Promise(r=>setTimeout(r,10));}
   await q("UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE id=$1",[managerGrant]);
   await blocker.query('ROLLBACK');const res=await pending;assert.equal(res.status,403,JSON.stringify(res.body));
   const after=await counts();assert.equal(after.pos_sales,c.pos_sales);assert.equal(after.audit_events,c.audit_events);}
  finally{await blocker.end();}}
 pass('a grant revoked while the sale waited commits nothing');
 console.log('Point of Sale proof (0612): '+groups+' groups passed');
}finally{
 await app?.close();
 await Promise.allSettled([admin.end(),restricted.end()]);
}
