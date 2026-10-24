import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K, createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pricingOffers, scheduleInput, acceptanceInput } from './price-acceptance-fixture.mjs';
import { verifySaasBillingSecurity } from './saas-billing-security.mjs';
// Canonical DISPOSABLE credentials only; never permit URL/PG override paths or provider credentials.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&u.search===''&&u.hash===''&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^(?:STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasPriceAcceptanceService}=await import('../../../apps/api/dist/saas-pricing/saas-price-acceptance.service.js');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),pricing=new SaasPriceAcceptanceService(billing);
const callDatabase=database.callSaasBilling.bind(database);
database.callSaasBilling=async(...args)=>{try{return await callDatabase(...args);}catch(e){
 if(!['42501','P0002','40001','23505','55P03','57014','22023','22P02','23514'].includes(e.code))
  console.error('A2 disposable SQL diagnostic',JSON.stringify({operation:args[0],code:e.code,message:e.message,position:e.position,where:e.where}));
 throw e;
}};
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url)),c=apiRequire('@hon/contracts');
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false});
const admin=client(owner),a=client(runtime),b=client(runtime);
const humans=Object.fromEntries(['hq','operator','school','other','staff','expired','ai'].map(k=>[k,{id:K(),user:K(),subject:'a2-'+K()}]));
const H=k=>humans[k].subject,org={id:K(),school:K(),second:K(),role:K()},foreign={id:K(),school:K(),role:K()};
const tables=['saas_price_acceptances','saas_price_schedules'];let groups=0;
const passed=x=>console.log('PASS A2 '+(++groups)+': '+x);
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
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');await gates();passed('private ACLs/forced RLS/security registry; empty A2 tables; all activation gates closed');
 await admin.query('BEGIN');
 for(const[k,h]of Object.entries(humans)){
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'A2 SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,$3,'A2 SYNTHETIC',true)",[h.id,k==='ai'?null:h.user,k==='ai'?'AI_EMPLOYEE':'HUMAN_USER']);
 }
 for(const[k,role]of [['hq','HON_HQ_OWNER'],['operator','HON_HQ_OPERATOR'],['ai','HON_HQ_OWNER']])await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[k].id,role,k==='operator'?['hq.billing.manage']:[]]);
 for(const o of [org,foreign]){
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'A2 SYNTHETIC','A2 SYNTHETIC')",[o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'A2 SYNTHETIC',$3,'UTC')",[o.school,o.id,'a2-'+o.school]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','SUSPENDED')",[o.id]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','A2 synthetic owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
 }
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'A2 second school',$3,'UTC')",[org.second,org.id,'a2-'+org.second]);
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
 const life={...pricingOffers()[0],offerCode:'LIFETIME',offerKind:'LIFETIME',displayName:'Synthetic historical shape only',priceMinor:357600,saleLimit:1,cancellationTiming:null};
 const set=await publish([...pricingOffers(),life]),offers=Object.fromEntries(set.offers.map(o=>[o.offerKind,o])),schedules={};
 for(const kind of c.SAAS_SCHEDULED_OFFER_KINDS){
  const renewal=offers[kind.endsWith('MONTHLY')?'REGULAR_MONTHLY':'REGULAR_ANNUAL'];
  schedules[kind]=(await record(offers[kind],renewal)).schedule;
  assert.deepEqual(schedules[kind].terms,c.proposedHonOsLaunchPriceSchedule(kind));
  assert.equal((await pricing.schedule(H('operator'),schedules[kind].scheduleId)).scheduleDigest,schedules[kind].scheduleDigest);
 }
 assert(schedules.FOUNDER_MONTHLY.disclosureText.includes('$199.20 per month for the first 12 qualifying paid monthly periods. Thereafter, $249.00'));
 assert(schedules.FOUNDER_ANNUAL.disclosureText.includes('$1,494.00 for the first annual subscription period. Renews at $2,097.00'));
 assert.equal(schedules.FOUNDER_ANNUAL.terms.monthlyListReferenceMinor*12,298800);passed('exact four schedules, 12 paid monthly periods, one annual period, correct annual comparison and explicit disclosure');
 await nothing(()=>record(offers.LIFETIME,offers.REGULAR_ANNUAL),422,'SAAS_PRICE_TERMS_UNSUPPORTED');
 await nothing(()=>record(offers.FOUNDER_MONTHLY,offers.REGULAR_ANNUAL,1),422,'SAAS_PRICE_TERMS_UNSUPPORTED');
 const draft=await billing.createOfferSetDraft(H('hq'),{basedOnSetId:null,termsReference:'SYNTHETIC_UNPUBLISHED',founderTotalLimit:50,offers:pricingOffers()},K());
 await nothing(()=>record(draft.set.offers[0],draft.set.offers[0]),422,'SAAS_OFFER_NOT_AVAILABLE');await billing.discardOfferSetDraft(H('hq'),draft.set.setId,{expectedRevision:1},K());
 passed('new lifetime sales, mismatched renewal interval and unpublished offer schedules refused');
 for(const who of ['operator','school','other','expired','ai'])await nothing(()=>record(offers.REGULAR_MONTHLY,offers.REGULAR_MONTHLY,1,K(),who),403,'SAAS_FORBIDDEN');
 for(const who of ['hq','operator','expired','ai'])await nothing(()=>preview(schedules.REGULAR_MONTHLY,who),403,'SAAS_FORBIDDEN');
 await nothing(()=>preview(schedules.REGULAR_MONTHLY,'other'),403,'SAAS_FORBIDDEN');
 await nothing(()=>preview(schedules.REGULAR_MONTHLY,'school',org.second),403,'SAAS_FORBIDDEN');
 passed('live human HQ-owner recording; exact-school purchase permission; cross-organization, same-organization ungranted school, expired and AI denied');
 for(const kind of ['FOUNDER_MONTHLY','FOUNDER_ANNUAL']){const p=await preview(schedules[kind]);assert(p.blockers.includes('FOUNDER_ALLOCATION_CONTRACT_UNAVAILABLE'));assert.equal(p.canAcknowledge,false);await nothing(()=>accept(p),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');}
 const p=await preview(schedules.REGULAR_MONTHLY),pAnnual=await preview(schedules.REGULAR_ANNUAL);assert(p.canAcknowledge&&pAnnual.canAcknowledge);await gates();
 for(const patch of [{initialPriceMinor:1},{renewalPriceMinor:1},{discountPercent:50},{discounts:[]},{founderAllocationId:K()},{paid:true},{activate:true},{aiCredits:1},{organizationId:foreign.id}])await nothing(()=>pricing.accept(H('school'),org.school,{...acceptanceInput(p),...patch},K()),400,'INVALID_SAAS_INPUT');
 passed('founder allocation fails closed; no founder slot consumed; closed commands reject price/eligibility/discount/financial/access claims');
 await nothing(()=>pricing.accept(H('school'),org.school,{...acceptanceInput(p),scheduleDigest:'0'.repeat(64)},K()),409,'SAAS_PRICE_PREVIEW_STALE');
 await nothing(()=>pricing.accept(H('school'),org.school,{...acceptanceInput(p),acceptanceDigest:'0'.repeat(64)},K()),409,'SAAS_PRICE_PREVIEW_STALE');
 await nothing(()=>record(offers.REGULAR_MONTHLY,offers.REGULAR_MONTHLY,0),409,'SAAS_VERSION_CONFLICT');
 const oldFootprint=await footprint();await preview(schedules.REGULAR_MONTHLY);await pricing.schedule(H('hq'),schedules.REGULAR_MONTHLY.scheduleId);assert.deepEqual(await footprint(),oldFootprint);passed('digest/revision mismatch rollback; previews and reads never write');
 const key=K(),accepted=(await accept(p,key)).acceptance;
 assert.deepEqual(accepted.schedule,schedules.REGULAR_MONTHLY);assert.equal(accepted.paymentStatus,'NOT_AUTHORIZED');assert.equal(accepted.accessGranted,false);
 assert.equal((await accept(p,key)).replayed,true);assert.deepEqual((await accept(p,key)).acceptance,accepted);
 await nothing(()=>pricing.accept(H('school'),org.school,{...acceptanceInput(p),acceptanceDigest:'1'.repeat(64)},key),409,'IDEMPOTENCY_KEY_REUSED');
 await nothing(()=>accept(p),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');
 assert.deepEqual(await pricing.acceptance(H('staff'),org.school,accepted.acceptanceId),accepted);
 await nothing(()=>pricing.acceptance(H('other'),org.school,accepted.acceptanceId),403,'SAAS_FORBIDDEN');
 await nothing(()=>pricing.acceptance(H('other'),foreign.school,accepted.acceptanceId),404,'SAAS_UNAVAILABLE');passed('immutable acknowledgement, historical exact-key replay, changed-key request refusal and independently authorized receipt read');
 // Both orders: competing keys and different authorized staff; one complete decision, no partial loser.
 const concurrentKeys=[K(),K()],results=await Promise.all(concurrentKeys.map((key,i)=>settled(accept(pAnnual,key,i?'staff':'school'))));
 assert.equal(results.filter(x=>x.value).length,1);assert.equal(results.find(x=>x.error).error.getStatus(),422);
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_price_acceptances WHERE schedule_id=$1',[schedules.REGULAR_ANNUAL.scheduleId])).n,1);
 passed('concurrent acceptance by two authorized humans yields exactly one immutable record');
 // Same-key contenders cannot duplicate. Explicit replay is the only retry, never an automatic command.
 const second=(await record(offers.REGULAR_ANNUAL,offers.REGULAR_ANNUAL,1)).schedule,ps=await preview(second),sameKey=K();
 await a.query('BEGIN');await sqlAccept(a,acceptanceInput(ps),sameKey);
 await nothing(()=>accept(ps,sameKey),409,'SAAS_OUTCOME_UNKNOWN');await a.query('COMMIT');assert.equal((await accept(ps,sameKey)).replayed,true);passed('same-key in-flight conflict and unknown-result exact retry preserve a single action');
 const revisions=await Promise.all([settled(record(offers.REGULAR_ANNUAL,offers.REGULAR_ANNUAL,2)),settled(record(offers.REGULAR_ANNUAL,offers.REGULAR_ANNUAL,2))]);
 assert.equal(revisions.filter(x=>x.value).length,1);assert.equal(revisions.find(x=>x.error).error.getStatus(),409);passed('competing HQ schedule revisions serialize with one complete winner and stale-revision refusal');
 const revised=(await record(offers.REGULAR_MONTHLY,offers.REGULAR_MONTHLY,1)).schedule;
 assert((await preview(schedules.REGULAR_MONTHLY)).blockers.includes('SCHEDULE_SUPERSEDED'));await nothing(()=>accept(p),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');
 assert.deepEqual((await accept(p,key)).acceptance,accepted);assert.deepEqual(await pricing.acceptance(H('school'),org.school,accepted.acceptanceId),accepted);passed('new immutable schedule versions stale old previews but never alter original accepted terms or replay');
 // IAM changes that commit while command waits must be observed, and clock expiry is checked after waits/at commit.
 const pr=await preview(revised);let pid;
 await admin.query('BEGIN');await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp() WHERE principal_id=$1',[humans.staff.id]);pid=(await row('SELECT pg_backend_pid() p')).p;
 let pending=settled(accept(pr,K(),'staff'));await waitFor(pid);await admin.query('COMMIT');assert.equal((await pending).error.getStatus(),403);
 await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL,effective_until=clock_timestamp()+interval \'1 second\' WHERE principal_id=$1',[humans.staff.id]);
 await admin.query('BEGIN');await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('saas.offer_sets',0))");pid=(await row('SELECT pg_backend_pid() p')).p;
 const expiryBefore=await footprint();pending=settled(accept(pr,K(),'staff'));await waitFor(pid);await sleep(1100);await admin.query('COMMIT');assert.equal((await pending).error.getStatus(),403);assert.deepEqual(await footprint(),expiryBefore);
 await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.staff.id]);passed('permission revocation during IAM lock wait and clock expiry during offer lock wait commit no evidence');
 await admin.query('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval \'1 second\' WHERE principal_id=$1',[humans.staff.id]);
 const beforeAbort=await footprint();await a.query('BEGIN');await sqlAccept(a,acceptanceInput(pr),K(),'staff');await sleep(1100);await sqlDeny(a.query('COMMIT'),'42501');assert.deepEqual(await footprint(),beforeAbort);
 await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.staff.id]);passed('deferred live-authority verification rolls back acceptance, request, audit and outbox at commit');
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE']){await a.query('BEGIN ISOLATION LEVEL '+isolation);await sqlDeny(sqlAccept(a,acceptanceInput(pr)),'22023');await a.query('ROLLBACK');}passed('unsupported snapshot isolation cannot reuse stale authorization after waiting');
 // Acceptance/stop-sales in BOTH real lock arrival orders.
 await a.query('BEGIN');const winnerKey=K();await sqlAccept(a,acceptanceInput(pr),winnerKey);pid=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;
 pending=settled(billing.stopOfferSales(H('hq'),offers.REGULAR_MONTHLY.offerId,{reasonCode:'OWNER_DISABLED'},K()));await waitFor(pid);await a.query('COMMIT');assert((await pending).value);
 assert.equal((await accept(pr,winnerKey)).replayed,true);await nothing(()=>accept(pr),422,'SAAS_PRICE_ACCEPTANCE_BLOCKED');passed('acceptance-first sales stop waits, original historical receipt survives, new acknowledgement refused');
 const stoppedSchedule=(await record(offers.FOUNDER_ANNUAL,offers.REGULAR_ANNUAL,1)).schedule;
 // Use a fresh offer set for reverse stop order and historical price changes.
 const next=await publish(pricingOffers({REGULAR_MONTHLY:{priceMinor:30000},REGULAR_ANNUAL:{priceMinor:250000}}));
 assert.deepEqual(await pricing.acceptance(H('school'),org.school,accepted.acceptanceId),accepted);
 assert.equal((await accept(p,key)).acceptance.schedule.terms.initialPriceMinor,24900);
 const no=Object.fromEntries(next.offers.map(o=>[o.offerKind,o]));const ns=(await record(no.REGULAR_MONTHLY,no.REGULAR_MONTHLY)).schedule,np=await preview(ns);
 await a.query('BEGIN');await a.query('SELECT hon.stop_saas_offer_sales($1,$2,$3,$4,$5,$6)',[H('hq'),no.REGULAR_MONTHLY.offerId,{reasonCode:'OWNER_DISABLED'},K(),K(),K()]);pid=(await a.query('SELECT pg_backend_pid() p')).rows[0].p;
 pending=settled(accept(np));await waitFor(pid);await a.query('COMMIT');assert.equal((await pending).error.getStatus(),422);passed('stop-first lock order refuses acknowledgement; new HQ prices leave previous accepted schedule unchanged');
 // No runtime direct table/column/helper path, forged context or historical UPDATE/DELETE/TRUNCATE.
 for(const t of tables){for(const q of ['SELECT * FROM hon.'+t,'DELETE FROM hon.'+t,'UPDATE hon.'+t+' SET id=id','TRUNCATE hon.'+t])await sqlDeny(b.query(q),'42501');await sqlDeny(admin.query('UPDATE hon.'+t+' SET id=id'),'42501');}
 await sqlDeny(b.query("SELECT hon.saas_price_content($1,$2)",[no.REGULAR_ANNUAL.offerId,no.REGULAR_ANNUAL.offerId]),'42501');
 await b.query("SELECT set_config('hon.saas.owner','true',false)");await sqlDeny(b.query('INSERT INTO hon.saas_price_acceptances SELECT * FROM hon.saas_price_acceptances LIMIT 1'),'42501');
 await sqlDeny(admin.query('TRUNCATE hon.saas_price_acceptances CASCADE'),'42501');passed('private table/function/column ACLs, immutable history and no forgeable PostgreSQL setting authority');
 // New schedule-bound configurations MUST NOT silently use legacy fixed-price hosted checkout.
 await admin.query('CREATE TEMP TABLE a2_provider_probe(hon_os_offer_id uuid); CREATE TRIGGER guard BEFORE INSERT ON a2_provider_probe FOR EACH ROW EXECUTE FUNCTION hon.guard_saas_price_provider_boundary()');
 await sqlDeny(admin.query('INSERT INTO a2_provider_probe VALUES($1)',[no.REGULAR_MONTHLY.offerId]),'23514');
 await admin.query('INSERT INTO a2_provider_probe VALUES($1)',[K()]);
 await sqlDeny(admin.query('SELECT hon.guard_saas_price_provider_boundary()'),'0A000'); // trigger-only, not an alternate command
 assert.equal((await row('SELECT count(*)::int n FROM hon.saas_checkout_sessions')).n,0);
 const active=await billing.readOfferManagement(H('hq'));assert.equal(active.chargesEnabled,false);
 passed('A2 creates no checkout/subscription/invoice/provider schedule/paid-period evidence or financial activation');
 if(!process.env.HON_STAGING_NETWORK_AUDIT){
  // Full PostgreSQL CI only: REAL signed cookie -> production guard -> controller/service -> restricted database.
  // The no-HTTP commercial rehearsal executes all DB races separately and does not claim this HTTP evidence.
  const {Test}=apiRequire('@nestjs/testing');const {issueSession,sessionConfig,HON_SESSION_COOKIE}=apiRequire('@hon/auth');
  const {SaasPriceScheduleHqController,SaasPriceAcceptanceSchoolController}=await import('../../../apps/api/dist/saas-pricing/saas-price-acceptance.controller.js');
  const {HonIdentityGuard}=await import('../../../apps/api/dist/foundation/hon-identity.guard.js');
  const {HonIdentityService}=await import('../../../apps/api/dist/foundation/hon-identity.service.js');
  const {SaasReadGuard,SaasCommandGuard}=await import('../../../apps/api/dist/saas-billing/saas-billing.guards.js');
  const {json}=apiRequire('express');const saved={...process.env};Object.assign(process.env,{HON_AUTH_MODE:'OIDC',HON_SESSION_JWT_SECRET:'A2_TEST_ONLY_SIGNED_SESSION_SECRET_123456789012345',HON_SESSION_AUDIENCE:'a2-disposable-test',HON_PUBLIC_ORIGIN:'https://hon.example'});
  const mod=await Test.createTestingModule({controllers:[SaasPriceScheduleHqController,SaasPriceAcceptanceSchoolController],providers:[SaasPriceAcceptanceService,SaasBillingService,RuntimeDatabaseService,HonIdentityGuard,HonIdentityService,SaasReadGuard,SaasCommandGuard]}).compile();
  const app=mod.createNestApplication({bodyParser:false});app.use(json({strict:true}));app.setGlobalPrefix('v1');
  try{
   await app.listen(0,'127.0.0.1');const base='http://127.0.0.1:'+app.getHttpServer().address().port+'/v1';
   const cookie=(who,now)=>HON_SESSION_COOKIE+'='+issueSession({externalSubject:H(who),displayName:'SYNTHETIC',email:'synthetic@example.test'},sessionConfig(),now);
   const path=base+'/schools/'+org.school+'/hon-os-price-acceptances/'+accepted.acceptanceId;
   assert.equal((await fetch(path)).status,401);assert.equal((await fetch(path,{headers:{cookie:HON_SESSION_COOKIE+'=invalid'}})).status,401);
   assert.equal((await fetch(path,{headers:{cookie:cookie('school',Math.floor(Date.now()/1000)-50000)}})).status,401);
   const success=await fetch(path,{headers:{cookie:cookie('school')}});assert.equal(success.status,200);assert.deepEqual((await success.json()).data,accepted);
   assert.equal((await fetch(path,{headers:{cookie:cookie('other')}})).status,403);
   assert.equal((await fetch(base+'/schools/'+org.second+'/hon-os-price-acceptances/'+accepted.acceptanceId,{headers:{cookie:cookie('school')}})).status,403);
   const newAnnual=(await record(no.REGULAR_ANNUAL,no.REGULAR_ANNUAL)).schedule,pp=await preview(newAnnual);
   const headers={cookie:cookie('school'),origin:'https://hon.example','content-type':'application/json','sec-fetch-site':'same-origin','sec-fetch-mode':'same-origin','sec-fetch-dest':'empty','x-hon-human-command':c.SAAS_COMMANDS.acceptPriceSchedule,'idempotency-key':K()};
   // Node fetch overrides sec-fetch-mode; use node:http for exact production same-origin marker.
   const {request}=apiRequire('node:http');const send=()=>new Promise((yes,nope)=>{const req=request(base+'/schools/'+org.school+'/hon-os-price-acceptances',{method:'POST',headers},res=>{let text='';res.on('data',x=>text+=x);res.on('end',()=>yes({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',nope);req.end(JSON.stringify(acceptanceInput(pp)));});
   const httpReceipt=await send();assert.equal(httpReceipt.status,200,JSON.stringify(httpReceipt));assert.equal(httpReceipt.data.data.acceptance.paymentStatus,'NOT_AUTHORIZED');assert.equal((await send()).data.data.replayed,true);
   await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp() WHERE principal_id=$1',[humans.school.id]);assert.equal((await send()).status,403);
   await admin.query('UPDATE hon.principal_role_grants SET revoked_at=NULL WHERE principal_id=$1',[humans.school.id]);
   passed('actual signed-session HTTP/API/restricted PostgreSQL acceptance, exact replay, missing/invalid session, cross-school denial and revoked permission');
  }finally{await app.close();process.env=saved;}
 }
 await verifySaasBillingSecurity(admin,'hon_champions_runtime');assert.deepEqual(await snapshot(),before);await gates();passed('all pre-existing business tables unchanged, D9/D10/D11-A and legacy rights preserved, no AI allowances/ledger effects');
 console.log(`PASS: Commercial A2 ${groups} scenario groups; real restricted PostgreSQL, actual lock waits; synthetic acceptance ONLY; no providers/payment/activation.`);
}finally{
 await Promise.all([a.query('ROLLBACK'),b.query('ROLLBACK')]);try{await cleanup();await gates();}finally{await Promise.allSettled([admin.end(),a.end(),b.end()]);}
}
