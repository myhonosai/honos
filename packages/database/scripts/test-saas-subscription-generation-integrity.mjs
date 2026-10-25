import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { generationInput } from './subscription-generation-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';
// Canonical DISPOSABLE credentials only; never permit URL/PG override paths or provider credentials.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&u.search===''&&u.hash===''&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^(?:STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPriceAcceptanceService}=await import('../../../apps/api/dist/saas-pricing/saas-price-acceptance.service.js');
const {SaasSubscriptionGenerationService}=await import('../../../apps/api/dist/saas-pricing/saas-subscription-generation.service.js');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing),generations=new SaasSubscriptionGenerationService(billing);
const callDatabase=database.callSaasBilling.bind(database);
database.callSaasBilling=async(...args)=>{try{return await callDatabase(...args);}catch(e){
 if(!['42501','P0002','40001','23505','55P03','57014','22023','22P02','23514'].includes(e.code))
  console.error('B1 disposable SQL diagnostic',JSON.stringify({operation:args[0],code:e.code,message:e.message,position:e.position,where:e.where}));
 throw e;
}};
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url)),c=apiRequire('@hon/contracts');
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false});
const admin=client(owner),a=client(runtime),b=client(runtime);
const humans=Object.fromEntries(['hq','operator','school','other','staff','expired','ai'].map(k=>[k,{id:K(),user:K(),subject:'b1-'+K()}]));
const H=k=>humans[k].subject,org={id:K(),school:K(),second:K(),role:K()},foreign={id:K(),school:K(),role:K()};
const tables=['saas_subscription_generations','saas_price_acceptances','saas_price_schedules'];let groups=0;
const passed=x=>console.log('PASS B1 '+(++groups)+': '+x);
const row=async(q,p)=>(await admin.query(q,p)).rows[0];
const settled=p=>p.then(value=>({value}),error=>({error}));
const footprint=async()=>{const result={};for(const t of [...tables,'saas_requests','saas_audit','saas_outbox'])result[t]=(await row('SELECT count(*)::int n FROM hon.'+t)).n;return result;};
const deny=(p,status,code)=>assert.rejects(p,e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
async function nothing(fn,status,code){const before=await footprint();await deny(Promise.resolve().then(fn),status,code);assert.deepEqual(await footprint(),before,'refused command leaked evidence or claim');}
async function waitFor(pid){for(const until=Date.now()+6000;Date.now()<until;await sleep(10))if((await row('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) waiting',[pid])).waiting)return;throw Error('Expected actual PostgreSQL lock wait');}
const sqlRecord=(connection,input,key=K(),who='hq')=>connection.query('SELECT hon.record_saas_price_schedule($1,$2,$3,$4,$5) data',[H(who),input,key,K(),K()]);
const sqlAccept=(connection,input,key=K(),who='school',school=org.school)=>connection.query('SELECT hon.accept_saas_price_schedule($1,$2,$3,$4,$5,$6) data',[H(who),school,input,key,K(),K()]);
const record=(offer,renewal,version=0,key=K(),who='hq')=>pricing.record(H(who),scheduleInput(offer,renewal,version),key);
const preview=(s,who='school',school=org.school)=>pricing.preview(H(who),school,s.scheduleId);
const accept=(p,key=K(),who='school',school=org.school)=>pricing.accept(H(who),school,acceptanceInput(p),key);
async function gates(){
 assert.deepEqual(await row('SELECT (SELECT status FROM hon.saas_access_program) access,(SELECT status FROM hon.saas_credit_program) credits,(SELECT status FROM hon.saas_payment_program) payments'),{access:'INACTIVE',credits:'INACTIVE',payments:'DISABLED'});
 assert.deepEqual(await row('SELECT status,signup_enabled,enrollment_enabled,promotional_issuance_enabled FROM hon.saas_trial_program'),{status:'INACTIVE',signup_enabled:false,enrollment_enabled:false,promotional_issuance_enabled:false});
 for(const t of ['saas_credit_allowances','saas_credit_reservations','saas_credit_ledger','ai_usage_ledger'])assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0);
}
async function cleanup(){
 await admin.query('ROLLBACK');await admin.query('BEGIN');
 try{
  for(const t of [...tables,'saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets','saas_outbox','saas_audit','saas_requests']){
   await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
   if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[Object.values(humans).map(h=>h.id)]);
   else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
   else await admin.query('DELETE FROM hon.'+t);
   await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
  }
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin,a,b].map(x=>x.connect()));
try{
 assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
 for(const t of [...tables,'saas_offer_sets'])assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0,'dedicated empty commercial fixture required');
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');await gates();passed('private ACLs/forced RLS/security registry; empty B1/A2 tables; all activation gates closed');
 await admin.query('BEGIN');
 for(const[k,h]of Object.entries(humans)){
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'B1 SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'B1 SYNTHETIC',true)",[h.id,k==='ai'?null:h.user,k==='ai'?'AI_EMPLOYEE':'HUMAN_USER']);
 }
 for(const[k,role]of [['hq','HON_HQ_OWNER'],['operator','HON_HQ_OPERATOR'],['ai','HON_HQ_OWNER']])await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[k].id,role,k==='operator'?['hq.billing.manage']:[]]);
 for(const o of [org,foreign]){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'B1 SYNTHETIC','B1 SYNTHETIC')",[o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'B1 SYNTHETIC',$3,'UTC')",[o.school,o.id,'b1-'+o.school]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','SUSPENDED')",[o.id]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','B1 synthetic owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
 }
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'B1 second school',$3,'UTC')",[org.second,org.id,'b1-'+org.second]);
 for(const[k,o]of [['school',org],['expired',org],['staff',org],['other',foreign]])await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day',CASE WHEN $5 THEN clock_timestamp()-interval '1 hour' ELSE NULL END)",[o.id,o.school,humans[k].id,o.role,k==='expired']);
 await admin.query('COMMIT');
 // Snapshot all pre-existing business tables; excludes only explicit synthetic offer/evidence/IAM rows.
 const excluded=[...tables,'saas_offer_sets','saas_offer_set_offers','saas_offer_sales_stops','saas_requests','saas_audit','saas_outbox','users','principals','hq_operator_grants','principal_role_grants'];
 const domainTables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='hon' AND NOT(tablename=ANY($1::text[])) ORDER BY tablename",[excluded])).rows.map(r=>r.tablename);
 async function snapshot(){const result={};for(const t of domainTables){assert(/^[a-z_]+$/.test(t));result[t]=createHash('sha256').update(JSON.stringify((await admin.query('SELECT to_jsonb(t)::text data FROM hon.'+t+' t ORDER BY 1')).rows)).digest('hex');}return result;}
 const before=await snapshot();
 async function publish(offers=pricingOffers()){
  const d=await billing.createOfferSetDraft(H('hq'),{basedOnSetId:null,termsReference:'SYNTHETIC_A2_TERMS_V1',founderTotalLimit:50,offers},K());
  return (await billing.publishOfferSet(H('hq'),d.set.setId,{expectedRevision:d.set.revision,previewDigest:d.preview.previewDigest,approval:c.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
 }
 const set=await publish(),offers=Object.fromEntries(set.offers.map(o=>[o.offerKind,o])),versions={};
 const generation=(a,key=K(),who='school',school=org.school)=>generations.record(H(who),school,generationInput(a),key);
 const sqlGeneration=(connection,a,key=K(),who='school')=>connection.query('SELECT hon.record_saas_subscription_generation($1,$2,$3,$4,$5,$6) data',[H(who),org.school,generationInput(a),key,K(),K()]);
 async function fresh(kind='REGULAR_MONTHLY',who='school'){
  const schedule=(await record(offers[kind],offers[kind],versions[kind]??0)).schedule;versions[kind]=schedule.version;
  return (await accept(await preview(schedule,who),K(),who)).acceptance;
 }
 for(const kind of c.SAAS_SCHEDULED_OFFER_KINDS){
  const s=(await record(offers[kind],offers[kind.endsWith('MONTHLY')?'REGULAR_MONTHLY':'REGULAR_ANNUAL'])).schedule;versions[kind]=s.version;
  assert.deepEqual(s.terms,c.proposedHonOsLaunchPriceSchedule(kind));
  if(kind.startsWith('FOUNDER_')){const p=await preview(s);assert(p.blockers.includes('FOUNDER_ALLOCATION_CONTRACT_UNAVAILABLE'));await nothing(()=>accept(p),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');}
 }
 passed('all four immutable pricing schedules preserved; founder acknowledgement blocked pending C');
 const accepted=await fresh(),key=K(),g=(await generation(accepted,key)).generation;
 assert.deepEqual(g.acceptance,accepted);assert.equal(g.organizationId,org.id);assert.equal(g.schoolId,org.school);
 assert.equal(g.provider.identity,'UNCONFIGURED');assert.equal(g.provider.generationReference,g.generationId);
 assert.equal(g.provider.bindingStatus,'NOT_BOUND');assert.equal(g.provider.scheduleReference,null);
 assert.equal(g.checkoutAvailable,false);assert.equal(g.billingEnabled,false);assert.equal(g.accessGranted,false);
 assert.deepEqual(await generations.read(H('staff'),org.school,g.generationId),g);
 assert.deepEqual(await generations.readHq(H('operator'),g.generationId),g);
 const content=(await row('SELECT hon.saas_generation_content($1,$2) data',[g.generationId,accepted.acceptanceId])).data;
 assert.equal(g.generationDigest,(await row('SELECT hon.saas_hon_os_digest($1::jsonb) digest',[content])).digest);
 passed('exact-school immutable A2 acceptance, all financial/disclosure/offer lineage and server-owned inert generation digest');
 for(const patch of [{initialPriceMinor:1},{renewalPriceMinor:1},{discountPercent:20},{provider:'STRIPE'},
  {providerMode:'LIVE'},{founderAllocationId:K()},{phase:2},{paidPeriods:12},{activate:true},{aiCredits:1},{organizationId:foreign.id}])
  await nothing(()=>generations.record(H('school'),org.school,{...generationInput(accepted),...patch},K()),400,'INVALID_SAAS_INPUT');
 await nothing(()=>generations.record(H('school'),org.school,{...generationInput(accepted),acceptanceId:K()},K()),404,'SAAS_UNAVAILABLE');
 await nothing(()=>generations.record(H('school'),org.school,{...generationInput(accepted),acceptanceDigest:'0'.repeat(64)},K()),409,'SAAS_GENERATION_ACCEPTANCE_STALE');
 passed('missing evidence, stale digest and client financial/provider/activation/tenant overrides rejected without any evidence or claim');
 for(const who of ['hq','operator','other','expired','ai'])await nothing(()=>generation(accepted,K(),who),403,'SAAS_FORBIDDEN');
 await nothing(()=>generation(accepted,K(),'school',org.second),403,'SAAS_FORBIDDEN');
 await nothing(()=>generation(accepted,K(),'other',foreign.school),404,'SAAS_UNAVAILABLE');
 await nothing(()=>generations.read(H('other'),foreign.school,g.generationId),404,'SAAS_UNAVAILABLE');
 await nothing(()=>generations.readHq(H('school'),g.generationId),403,'SAAS_FORBIDDEN');
 passed('exact-school independent human purchase authority; cross-childless school/org, HQ-plane, expired, AI and unauthorized HQ reads refused');
 assert.deepEqual((await generation(accepted,key)).generation,g);assert.equal((await generation(accepted,key)).replayed,true);
 await nothing(()=>generations.record(H('school'),org.school,{...generationInput(accepted),acceptanceDigest:'1'.repeat(64)},key),409,'IDEMPOTENCY_KEY_REUSED');
 await nothing(()=>generation(accepted),409,'SAAS_GENERATION_EXISTS');
 passed('exact-request replay returns original generation; changed request and duplicate different key cannot duplicate generation');
 const concurrent=await fresh('REGULAR_ANNUAL'),beforeConcurrent=await footprint();
 const results=await Promise.all(['school','staff'].map(who=>settled(generation(concurrent,K(),who))));
 assert.equal(results.filter(x=>x.value).length,1);assert.equal(results.find(x=>x.error).error.getResponse().code,'SAAS_GENERATION_EXISTS');
 const afterConcurrent=await footprint();for(const t of ['saas_subscription_generations','saas_requests','saas_audit','saas_outbox'])assert.equal(afterConcurrent[t],beforeConcurrent[t]+1);
 passed('concurrent different-key staff requests have exactly one complete generation and no loser-side audit/outbox/idempotency leakage');
 const uncertain=await fresh(),unknownKey=K();await a.query('BEGIN');await sqlGeneration(a,uncertain,unknownKey);
 await nothing(()=>generation(uncertain,unknownKey),409,'SAAS_OUTCOME_UNKNOWN');await a.query('COMMIT');
 assert.equal((await generation(uncertain,unknownKey)).replayed,true);
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_subscription_generations WHERE acceptance_id=$1',[uncertain.acceptanceId])).n,1);
 passed('uncertain in-flight duplicate refuses; explicit exact-key retry after settlement recovers one immutable generation');
 const authAcceptance=await fresh();
 await admin.query('BEGIN');await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1',[humans.staff.id]);
 let pid=(await row('SELECT pg_backend_pid() p')).p,pending=settled(generation(authAcceptance,K(),'staff'));await waitFor(pid);await admin.query('COMMIT');assert.equal((await pending).error.getStatus(),403);
 await nothing(()=>generation(accepted,key,'staff'),403,'SAAS_FORBIDDEN');
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL,effective_until=clock_timestamp()+interval \'1 second\' WHERE principal_id=$1',[humans.staff.id]);
 await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('saas.offer_sets',0))");pid=(await row('SELECT pg_backend_pid() p')).p;
 const expiryBefore=await footprint();pending=settled(generation(authAcceptance,K(),'staff'));await waitFor(pid);await sleep(1100);await admin.query('COMMIT');assert.equal((await pending).error.getStatus(),403);assert.deepEqual(await footprint(),expiryBefore);
 await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.staff.id]);
 passed('live authority revoked during IAM waits or expired during offer lock wait refuses; replay independently reauthorizes');
 await admin.query('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval \'1 second\' WHERE principal_id=$1',[humans.staff.id]);
 const beforeAbort=await footprint();await a.query('BEGIN');await sqlGeneration(a,authAcceptance,K(),'staff');await sleep(1100);await sqlDeny(a.query('COMMIT'),'42501');assert.deepEqual(await footprint(),beforeAbort);
 await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.staff.id]);
 passed('deferred authority expiry rolls back generation, canonical request, audit and inert outbox together');
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){await a.query('BEGIN ISOLATION LEVEL '+isolation);await sqlDeny(sqlGeneration(a,authAcceptance),'22023');await a.query('ROLLBACK');}
 passed('unsupported snapshot transaction isolation cannot retain stale authorization');
 // A privileged incomplete insert cannot commit even with an otherwise genuine request and snapshot.
 await a.query('BEGIN');const noAuditKey=K();await sqlGeneration(a,authAcceptance,noAuditKey);await a.query('ROLLBACK');
 assert.deepEqual(await footprint(),beforeAbort);
 // Remove only the synthetic completed evidence before COMMIT to prove deferred enforcement.
 const tamperBefore=await footprint();await admin.query('BEGIN');const tamperKey=K();await sqlGeneration(admin,authAcceptance,tamperKey);
 await admin.query('ALTER TABLE hon.saas_outbox DISABLE TRIGGER USER');
 await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=$1 AND idempotency_key=$2)',[humans.school.id,tamperKey]);
 await admin.query('ALTER TABLE hon.saas_outbox ENABLE TRIGGER USER');await sqlDeny(admin.query('COMMIT'),'23514');assert.deepEqual(await footprint(),tamperBefore);
 passed('explicit rollback and missing inert-outbox evidence leave no partial generation or command effects');
 for(const q of ['SELECT * FROM hon.saas_subscription_generations','DELETE FROM hon.saas_subscription_generations',
  'UPDATE hon.saas_subscription_generations SET id=id','TRUNCATE hon.saas_subscription_generations',
  'INSERT INTO hon.saas_subscription_generations SELECT * FROM hon.saas_subscription_generations LIMIT 1'])await sqlDeny(b.query(q),'42501');
 await b.query("SELECT set_config('hon.saas.owner','true',false)");await sqlDeny(b.query('SELECT hon.saas_generation_content($1,$2)',[K(),accepted.acceptanceId]),'42501');
 for(const q of ['UPDATE hon.saas_subscription_generations SET id=id','DELETE FROM hon.saas_subscription_generations','TRUNCATE hon.saas_subscription_generations'])await sqlDeny(admin.query(q),'42501');
 passed('private table/column/helper privileges, forced RLS, immutable history and no forgeable setting bypass');
 if(!process.env.HON_STAGING_NETWORK_AUDIT){
  const {Test}=apiRequire('@nestjs/testing'),{issueSession,sessionConfig,HON_SESSION_COOKIE}=apiRequire('@hon/auth'),{request}=apiRequire('node:http'),{json}=apiRequire('express');
  const {SaasSubscriptionGenerationSchoolController,SaasSubscriptionGenerationHqController}=await import('../../../apps/api/dist/saas-pricing/saas-subscription-generation.controller.js');
  const {HonIdentityGuard}=await import('../../../apps/api/dist/foundation/hon-identity.guard.js');const {HonIdentityService}=await import('../../../apps/api/dist/foundation/hon-identity.service.js');
  const {SaasReadGuard,SaasCommandGuard}=await import('../../../apps/api/dist/saas-billing/saas-billing.guards.js');
  const saved={...process.env};Object.assign(process.env,{HON_AUTH_MODE:'OIDC',HON_SESSION_JWT_SECRET:'B1_TEST_ONLY_SIGNED_SESSION_SECRET_123456789012345',HON_SESSION_AUDIENCE:'b1-disposable-test',HON_PUBLIC_ORIGIN:'https://hon.example'});
  const mod=await Test.createTestingModule({controllers:[SaasSubscriptionGenerationSchoolController,SaasSubscriptionGenerationHqController],providers:[SaasSubscriptionGenerationService,SaasBillingService,RuntimeDatabaseService,HonIdentityGuard,HonIdentityService,SaasReadGuard,SaasCommandGuard]}).compile();
  const app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');
  try{
   await app.listen(0,'127.0.0.1');const base='http://127.0.0.1:'+app.getHttpServer().address().port+'/v1';
   const cookie=(who,now)=>HON_SESSION_COOKIE+'='+issueSession({externalSubject:H(who),displayName:'SYNTHETIC',email:'synthetic@example.test'},sessionConfig(),now);
   const path=base+'/schools/'+org.school+'/hon-os-subscription-generations';
   for(const headers of [{},{cookie:HON_SESSION_COOKIE+'=invalid'},{cookie:cookie('school',Math.floor(Date.now()/1000)-50000)}])assert.equal((await fetch(path+'/'+g.generationId,{headers})).status,401);
   const acceptedHttp=await fresh('REGULAR_ANNUAL'),headers={cookie:cookie('school'),origin:'https://hon.example','content-type':'application/json','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':c.SAAS_COMMANDS.recordSubscriptionGeneration,'idempotency-key':K()};
   const send=()=>new Promise((yes,nope)=>{const q=request(path,{method:'POST',headers},r=>{let text='';r.on('data',v=>text+=v);r.on('end',()=>yes({status:r.statusCode,data:JSON.parse(text)}));});q.on('error',nope);q.end(JSON.stringify(generationInput(acceptedHttp)));});
   const receipt=await send();assert.equal(receipt.status,200,JSON.stringify(receipt));assert.equal(receipt.data.data.generation.billingEnabled,false);assert.equal((await send()).data.data.replayed,true);
   assert.equal((await fetch(path+'/'+g.generationId,{headers:{cookie:cookie('other')}})).status,403);
   assert.equal((await fetch(base+'/schools/'+org.second+'/hon-os-subscription-generations/'+g.generationId,{headers:{cookie:cookie('school')}})).status,403);
   assert.equal((await fetch(base+'/hq/saas/subscription-generations/'+g.generationId,{headers:{cookie:cookie('operator')}})).status,200);
   assert.equal((await fetch(base+'/hq/saas/subscription-generations/'+g.generationId,{headers:{cookie:cookie('school')}})).status,403);
   await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1',[humans.school.id]);assert.equal((await send()).status,403);
   await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1',[humans.school.id]);
   passed('real signed-session HTTP/API/restricted PostgreSQL generation, replay, invalid/expired sessions, cross-school and HQ-plane isolation and permission revocation');
  }finally{await app.close();process.env=saved;}
 }
 // Generation and sales stop in both actual PostgreSQL lock arrival orders.
 const first=await fresh(),firstKey=K();await a.query('BEGIN');const firstGeneration=(await sqlGeneration(a,first,firstKey)).rows[0].data.generation;
 let pidStop=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;
 pending=settled(billing.stopOfferSales(H('hq'),offers.REGULAR_MONTHLY.offerId,{reasonCode:'OWNER_DISABLED'},K()));await waitFor(pidStop);await a.query('COMMIT');assert((await pending).value);
 assert.deepEqual((await generation(first,firstKey)).generation,firstGeneration);await nothing(()=>generation(authAcceptance),422,'SAAS_OFFER_NOT_AVAILABLE');
 const reverse=await fresh('REGULAR_ANNUAL');await a.query('BEGIN');await a.query('SELECT hon.stop_saas_offer_sales($1,$2,$3,$4,$5,$6)',[H('hq'),offers.REGULAR_ANNUAL.offerId,{reasonCode:'OWNER_DISABLED'},K(),K(),K()]);pidStop=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;
 pending=settled(generation(reverse));await waitFor(pidStop);await a.query('COMMIT');assert.equal((await pending).error.getStatus(),422);
 passed('both generation/stop-sales lock arrival orders, original historical retry survives and new intent after stop is refused');
 // Later HQ prices never rewrite A2 or B1 records; stopped old receipts remain historical evidence only.
 await publish(pricingOffers({REGULAR_MONTHLY:{priceMinor:35000},REGULAR_ANNUAL:{priceMinor:300000}}));
 assert.deepEqual(await generations.read(H('school'),org.school,g.generationId),g);assert.equal((await generation(accepted,key)).generation.acceptance.schedule.terms.initialPriceMinor,24900);
 passed('HQ price changes preserve existing accepted prices/disclosures and immutable generation history without repricing');
 await admin.query('CREATE TEMP TABLE b1_provider_probe(hon_os_offer_id uuid); CREATE TRIGGER guard BEFORE INSERT ON b1_provider_probe FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_price_provider_boundary()');
 await sqlDeny(admin.query('INSERT INTO b1_provider_probe VALUES($1)',[offers.REGULAR_MONTHLY.offerId]),'23514');
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');assert.deepEqual(await snapshot(),before);await gates();
 passed('A2 checkout guard unchanged; all legacy subscriptions/lifetime/paid/trial/AI tables byte-equivalent and zero new external effects');
 console.log(`PASS: Commercial B1 ${groups} scenario groups; real restricted PostgreSQL and actual lock waits. No provider, billing or activation.`);
}finally{
 await Promise.all([a.query('ROLLBACK'),b.query('ROLLBACK')]);try{await cleanup();await gates();}finally{await Promise.allSettled([admin.end(),a.end(),b.end()]);}
}
