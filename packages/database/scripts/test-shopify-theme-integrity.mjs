/** 0600 Shopify theme drafts (TB1): ready-made theme changes written only to HON's UNPUBLISHED copy of the live theme. Real signed HON sessions -> Nest/guard -> fixed runtime SQL -> marked disposable PostgreSQL (Champions Club fixture). The Shopify side is the in-memory fake; nothing leaves the machine. */
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
const tables=['shopify_connections','shopify_credentials','shopify_connect_intents','shopify_syncs','shopify_products','shopify_variants','shopify_orders','shopify_order_lines','shopify_product_changes','shopify_finance','shopify_theme_drafts','shopify_theme_edits'];
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
const queryOf=url=>new URL(url).search.slice(1);const themeRead=(identity,s)=>read(identity,s,'/theme');const themeWork=cmd('theme');
let shopify,SHOP;
const LIVE='140000000001';
try{
 await Promise.all([admin.connect(),restricted.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');
 // 1. ACL.
 for(const t of ['hon.shopify_theme_drafts','hon.shopify_theme_edits']){
  for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,t,p]))[0].ok,false,t+' '+p);
  assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid=$1::regclass",[t]))[0],{r:true,f:true,n:0},t);
 }
 const entries=['read_shopify','read_shopify_catalog','read_shopify_orders','start_shopify_connect','claim_shopify_connect','record_shopify_connection',
  'begin_shopify_sync','rotate_shopify_credential','record_shopify_sync_page','finish_shopify_sync','disconnect_shopify',
  'read_shopify_product_changes','propose_shopify_product_change','cancel_shopify_product_change','approve_shopify_product_change',
  'rotate_shopify_change_credential','record_shopify_product_change_result','read_shopify_finance','record_shopify_finance',
  'read_shopify_theme_workspace','begin_shopify_theme_work','rotate_shopify_theme_credential','finish_shopify_theme_work'];
 const fns=await q("SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hon' AND p.proname LIKE '%shopify%'");
 for(const e of [...entries,'guard_shopify_theme_edit','shopify_theme_on_end','shopify_theme_recipe_ok','shopify_theme_files_ok','shopify_theme_name_ok',
  'shopify_theme_edit_json','shopify_theme_locked','shopify_theme_leased'])assert(fns.some(f=>f.proname===e),e);
 for(const f of fns){assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[runtime.username,f.oid]))[0].ok,entries.includes(f.proname),f.proname);
  assert.equal((await q("SELECT has_function_privilege('public',$1,'EXECUTE') ok",[f.oid]))[0].ok,false,f.proname);}
 pass('theme drafts and edits are forced-RLS private tables; the runtime executes the 23 Shopify entry points and nothing else; the guard and helpers are closed to it and to PUBLIC');

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
 SHOP='ima-theme-'+K().slice(0,8)+'.myshopify.com';
 const connectWith=async(who,extra={})=>{const s=ok(await start(who,{schoolId:A.schoolId,shopDomain:SHOP,...extra}));return ok(await complete(who,{schoolId:A.schoolId,query:queryOf(s.authorizeUrl)}));};
 const file=(id,name)=>shopify.fake.themeFile(SHOP,id,name);
 const writes=()=>shopify.fake.calls.filter(c=>/^theme(Duplicate|FilesUpsert):/.test(c)).length;
 const pickup={schoolId:A.schoolId,purpose:'APPLY',recipe:'PICKUP_NOTE',inputs:{text:'Pick up at the front desk after class.'},undoOf:null};
 const rows=async()=>(await q('SELECT kind,recipe,status,failure_code f,jsonb_array_length(coalesce(files,\'[]\')) n FROM hon.shopify_theme_edits WHERE school_id=$1 ORDER BY requested_at',[A.schoolId]));

 // 2. Only commerce.shopify.manage at the exact school; a store connected without Allow theme editing is never written to.
 assert.deepEqual(ok(await themeRead(manager,A.schoolId)),{schoolId:A.schoolId,connected:false,themesAllowed:false,baseTheme:null,draftTheme:null,busy:false,edits:[]});
 const first=await connectWith(manager,{allowEditing:true});assert.equal(first.firstSync.outcome,'SUCCEEDED');
 assert.equal(ok(await themeRead(manager,A.schoolId)).themesAllowed,false);
 await denied(()=>themeWork(manager,{...pickup,purpose:'PREVIEW'}),409,'SHOPIFY_THEMES_NOT_ALLOWED');
 await denied(()=>themeRead(reader,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>themeRead(managerB,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>themeWork(managerB,{...pickup,schoolId:A.schoolId}),403,'SHOPIFY_FORBIDDEN');
 await denied(()=>themeWork(manager,{...pickup,purpose:'PUBLISH'}),400,'SHOPIFY_INVALID');
 await denied(()=>themeWork(manager,{...pickup,inputs:{text:'x',filename:'layout/theme.liquid'}}),400,'SHOPIFY_INVALID');
 await denied(()=>themeWork(manager,{...pickup,purpose:'PREVIEW'},{command:'wrong'}),403);
 assert.equal(writes(),0);
 pass('only commerce.shopify.manage at the exact school reads or changes the theme; without write_themes nothing is begun; purposes, recipes and inputs are closed; the command header is required');

 // 3. Allow theme editing re-approves the same store with read_themes and write_themes (editing kept).
 const allowed=await connectWith(manager,{allowEditing:true,allowThemes:true});
 assert.equal(allowed.connection.connectionId,first.connection.connectionId);
 assert.equal((await q('SELECT scopes FROM hon.shopify_connections WHERE shop_domain=$1',[SHOP]))[0].scopes,'read_products,read_inventory,read_orders,write_products,write_inventory,read_themes,write_themes');
 assert.equal(ok(await themeRead(manager,A.schoolId)).themesAllowed,true);
 pass('Allow theme editing re-approves the same store with read_themes and write_themes, keeping editing');

 // 4. Preview reads the live theme (no copy yet), writes nothing and records no edit; it learns the live theme.
 const liveCart=file(LIVE,'templates/cart.json');
 const pv=ok(await themeWork(manager,{...pickup,purpose:'PREVIEW'}));
 assert.deepEqual([pv.outcome,pv.failureCode,pv.preview.target],['DONE',null,{id:LIVE,name:'Dawn'}]);
 assert.equal(pv.preview.files.length,1);assert.equal(pv.preview.files[0].filename,'templates/cart.json');assert.equal(pv.preview.files[0].before,liveCart);
 assert.match(pv.preview.files[0].after,/hon-pickup-note/);
 assert.deepEqual([pv.workspace.baseTheme,pv.workspace.draftTheme,pv.workspace.edits.length,pv.workspace.busy],[{id:LIVE,name:'Dawn'},null,0,false]);
 assert.equal(writes(),0);assert.equal(file(LIVE,'templates/cart.json'),liveCart);
 pass('preview reads the live theme, shows each file before and after, writes nothing, records no edit and learns the live theme');

 // 5. Apply makes one UNPUBLISHED copy and writes there; the live theme is never written; a second change reuses the copy.
 const ap=ok(await themeWork(manager,pickup));
 assert.equal(ap.outcome,'APPLIED');const draft=ap.workspace.draftTheme;
 assert.equal(draft.name,'HON draft - Dawn');assert.notEqual(draft.id,LIVE);
 assert.equal(file(LIVE,'templates/cart.json'),liveCart,'the live theme is untouched');
 assert.match(file(draft.id,'templates/cart.json'),/Pick up at the front desk after class\./);
 const firstEdit=ap.workspace.edits[0];
 assert.deepEqual([firstEdit.kind,firstEdit.status,firstEdit.files,firstEdit.undoable,firstEdit.draftThemeId],['APPLY','APPLIED',['templates/cart.json'],true,draft.id]);
 const stored=(await q('SELECT files FROM hon.shopify_theme_edits WHERE id=$1',[firstEdit.id]))[0].files;
 assert.deepEqual(stored.map(f=>[f.filename,f.before===liveCart]),[['templates/cart.json',true]],'the previous contents are kept for undo');
 const size=ok(await themeWork(manager,{...pickup,recipe:'SIZE_GUIDE',inputs:{text:'Youth S 110-120 cm, Youth M 120-130 cm.'}}));
 assert.equal(size.outcome,'APPLIED');assert.deepEqual(size.workspace.draftTheme,draft);
 assert.equal(shopify.fake.calls.filter(c=>c.startsWith('themeDuplicate:')).length,1,'one copy only');
 assert.match(file(draft.id,'templates/product.json'),/hon_size_guide/);
 // The same change again is already there: nothing is written, the edit records the files unchanged.
 const n=writes();const same=ok(await themeWork(manager,pickup));assert.equal(same.outcome,'APPLIED');assert.equal(writes(),n);
 pass('apply copies the live theme once as an UNPUBLISHED theme and writes only there; the live theme is untouched; the previous contents are kept; a repeat writes nothing');

 // 6. Undo writes the recorded contents back only while the copy still has what that edit wrote; then it is no longer undoable.
 const un=ok(await themeWork(manager,{schoolId:A.schoolId,purpose:'UNDO',recipe:null,inputs:null,undoOf:size.workspace.edits[0].id}));
 assert.equal(un.outcome,'APPLIED');
 assert.doesNotMatch(file(draft.id,'templates/product.json'),/hon_size_guide/);
 assert.equal(un.workspace.edits.find(e=>e.id===size.workspace.edits[0].id).status,'UNDONE');
 await denied(()=>themeWork(manager,{schoolId:A.schoolId,purpose:'UNDO',recipe:null,inputs:null,undoOf:size.workspace.edits[0].id}),409,'SHOPIFY_THEME_NOT_UNDOABLE');
 await denied(()=>themeWork(manager,{schoolId:A.schoolId,purpose:'UNDO',recipe:null,inputs:null,undoOf:K()}),404,'SHOPIFY_NOT_FOUND');
 // Someone changed the copy in the theme editor since the first edit: undo refuses to overwrite it.
 shopify.fake.setThemeFile(SHOP,draft.id,'templates/cart.json',file(draft.id,'templates/cart.json').replace('front desk','office'));
 const stale=ok(await themeWork(manager,{schoolId:A.schoolId,purpose:'UNDO',recipe:null,inputs:null,undoOf:firstEdit.id}));
 assert.deepEqual([stale.outcome,stale.failureCode],['FAILED','CHANGED_SINCE']);assert.match(file(draft.id,'templates/cart.json'),/office/);
 pass('undo restores the recorded contents only while the copy still holds what that edit wrote; an undone or unknown edit is not undoable again');

 // 7. A refused write is FAILED with nothing recorded; a lost answer is UNKNOWN and stays open; a published or deleted copy stops the work.
 shopify.fake.writeFault='REJECT';
 const rej=ok(await themeWork(manager,{...pickup,recipe:'SCHOOL_COLORS',inputs:{primary:'#C8102E',secondary:null}}));
 assert.deepEqual([rej.outcome,rej.failureCode],['FAILED','SHOPIFY_REJECTED']);
 shopify.fake.writeFault='LOSE_ANSWER';
 const lost=ok(await themeWork(manager,{...pickup,recipe:'SCHOOL_COLORS',inputs:{primary:'#C8102E',secondary:null}}));
 assert.equal(lost.outcome,'UNKNOWN');assert.equal(lost.workspace.edits[0].finishedAt,null);assert.equal(lost.workspace.edits[0].undoable,false);
 shopify.fake.publishTheme(SHOP,draft.id);
 const pub=ok(await themeWork(manager,pickup));assert.deepEqual([pub.outcome,pub.failureCode],['FAILED','DRAFT_THEME_MISSING']);
 assert.equal(file(LIVE,'templates/cart.json'),liveCart,'the live theme is still untouched');
 assert.deepEqual((await rows()).map(r=>[r.kind,r.recipe,r.status,r.f,r.n]),[['APPLY','PICKUP_NOTE','APPLIED',null,1],['APPLY','SIZE_GUIDE','UNDONE',null,1],
  ['APPLY','PICKUP_NOTE','APPLIED',null,1],['UNDO','SIZE_GUIDE','APPLIED',null,1],['UNDO','PICKUP_NOTE','FAILED','CHANGED_SINCE',0],
  ['APPLY','SCHOOL_COLORS','FAILED','SHOPIFY_REJECTED',0],['APPLY','SCHOOL_COLORS','UNKNOWN','SHOPIFY_UNAVAILABLE',0],['APPLY','PICKUP_NOTE','FAILED','DRAFT_THEME_MISSING',0]]);
 pass('a refused write is FAILED and records no files; a lost answer is UNKNOWN, unfinished and not undoable; a copy that was published in Shopify stops the work before any write');

 // 8. The database: one lease per store, results only under the exact lease, a recorded copy never swapped, edits immutable.
 const direct=(fn,who,input)=>restricted.query(`SELECT hon.${fn}($1,$2::jsonb) d`,[who.externalSubject,JSON.stringify(input)]);
 const b1=(await direct('begin_shopify_theme_work',manager,{...pickup,purpose:'PREVIEW'})).rows[0].d;
 assert.equal(b1.editId,null);assert.equal(typeof b1.credential.sealed,'string');assert.equal(JSON.stringify(b1).includes('fake_at_'),false);
 await assert.rejects(()=>direct('begin_shopify_theme_work',manager,pickup),e=>e.message==='SHOPIFY_THEME_BUSY');
 await assert.rejects(()=>direct('finish_shopify_theme_work',manager,{schoolId:A.schoolId,leaseToken:K(),outcome:'DONE',failureCode:null,baseTheme:null,draftTheme:null,files:null}),e=>e.message==='SHOPIFY_THEME_NOT_LEASED');
 await assert.rejects(()=>direct('finish_shopify_theme_work',reader,{schoolId:A.schoolId,leaseToken:b1.leaseToken,outcome:'DONE',failureCode:null,baseTheme:null,draftTheme:null,files:null}),e=>e.message==='SHOPIFY_FORBIDDEN');
 await assert.rejects(()=>direct('finish_shopify_theme_work',manager,{schoolId:A.schoolId,leaseToken:b1.leaseToken,outcome:'APPLIED',failureCode:null,baseTheme:null,draftTheme:null,files:null}),e=>e.message==='SHOPIFY_INVALID','a preview never applies');
 await direct('finish_shopify_theme_work',manager,{schoolId:A.schoolId,leaseToken:b1.leaseToken,outcome:'DONE',failureCode:null,baseTheme:null,draftTheme:null,files:null});
 const b2=(await direct('begin_shopify_theme_work',manager,pickup)).rows[0].d;
 const good=[{filename:'templates/cart.json',before:'{}',after:'{"a":1}'}];
 for(const [why,over] of [['another copy',{draftTheme:{id:'999',name:'Other'}}],['a non-JSON template',{files:[{...good[0],filename:'layout/theme.liquid'}]}],
  ['six files',{files:Array.from({length:6},(_,i)=>({...good[0],filename:`templates/p${i}.json`}))}],['a file over 256 KB',{files:[{...good[0],after:'x'.repeat(262145)}]}],
  ['applied without files',{files:null}]])
  await assert.rejects(()=>direct('finish_shopify_theme_work',manager,{schoolId:A.schoolId,leaseToken:b2.leaseToken,outcome:'APPLIED',failureCode:null,baseTheme:null,draftTheme:draft,files:good,...over}),e=>e.message==='SHOPIFY_INVALID',why);
 await direct('finish_shopify_theme_work',manager,{schoolId:A.schoolId,leaseToken:b2.leaseToken,outcome:'FAILED',failureCode:'SHOPIFY_REJECTED',baseTheme:null,draftTheme:null,files:null});
 // An expired lease settles its edit as UNKNOWN the next time someone begins.
 const b3=(await direct('begin_shopify_theme_work',manager,pickup)).rows[0].d;
 await q("UPDATE hon.shopify_theme_drafts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lease_token=$1",[b3.leaseToken]);
 const b4=(await direct('begin_shopify_theme_work',manager,{...pickup,purpose:'PREVIEW'})).rows[0].d;
 assert.deepEqual((await q('SELECT status,failure_code f FROM hon.shopify_theme_edits WHERE id=$1',[b3.editId]))[0],{status:'UNKNOWN',f:'LEASE_EXPIRED'});
 await direct('finish_shopify_theme_work',manager,{schoolId:A.schoolId,leaseToken:b4.leaseToken,outcome:'DONE',failureCode:null,baseTheme:null,draftTheme:null,files:null});
 await assert.rejects(()=>q("UPDATE hon.shopify_theme_edits SET files='[]'::jsonb WHERE id=$1",[firstEdit.id]),e=>e.message==='SHOPIFY_THEME_EDIT_IMMUTABLE');
 await assert.rejects(()=>q("UPDATE hon.shopify_theme_edits SET status='APPLIED' WHERE id=$1",[rej.workspace.edits[0].id]),e=>e.message==='SHOPIFY_THEME_EDIT_IMMUTABLE');
 await assert.rejects(()=>q('DELETE FROM hon.shopify_theme_edits WHERE id=$1',[firstEdit.id]),e=>e.message==='SHOPIFY_THEME_EDIT_IMMUTABLE');
 await assert.rejects(()=>q('TRUNCATE hon.shopify_theme_edits'),e=>e.message==='SHOPIFY_RECORD_IMMUTABLE');
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.shopify_theme_edits'),e=>e.code==='42501');
 const ev=await q("SELECT action_code,next_state FROM hon.audit_events WHERE school_id=$1 AND action_code LIKE 'commerce.shopify.theme_edit.%' ORDER BY occurred_at",[A.schoolId]);
 assert(ev.length>=4);assert.equal(JSON.stringify(ev).includes('front desk'),false,'evidence holds file names, never contents');
 pass('one lease per store; results only under the exact lease and person; a preview never applies; a recorded copy is never swapped; file names and sizes are closed; an expired lease settles as UNKNOWN; edits are immutable, never deleted or truncated while connected; evidence carries names only');

 // 9. A store that stops being CONNECTED loses its theme work; a revoked manager reads nothing.
 const live=(await connectWith(manager,{allowThemes:true})).connection;
 assert((await q('SELECT count(*)::int n FROM hon.shopify_theme_edits WHERE school_id=$1',[A.schoolId]))[0].n>0);
 ok(await disconnect(manager,{schoolId:A.schoolId,connectionId:live.connectionId,expectedVersion:live.version}));
 assert.deepEqual((await q('SELECT (SELECT count(*) FROM hon.shopify_theme_drafts WHERE school_id=$1)::int d,(SELECT count(*) FROM hon.shopify_theme_edits WHERE school_id=$1)::int e',[A.schoolId]))[0],{d:0,e:0});
 await q('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE id=$1',[managerGrant,hqPrincipal]);
 await denied(()=>themeRead(manager,A.schoolId),403,'SHOPIFY_FORBIDDEN');
 pass('a store that stops being CONNECTED loses its draft record and edits; a revoked grant reads nothing');

 // 10. The deploy check for 0600 in infra 011 passes against this database (with the fixture's runtime role).
 {const verify=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Shopify theme drafts exact verification (0600, TB1)')[1]?.split('-- End Shopify theme drafts exact verification.')[0];
  assert(section,'0600 verify section');await q(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime','hon_champions_runtime'));}
 pass('the infra verification for 0600 (exact bodies, closed helpers, forced RLS, triggers) passes');
 console.log('PASS SHOPIFY THEME all '+groups+' groups');
}finally{
 await app?.close();await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy()]);
}
