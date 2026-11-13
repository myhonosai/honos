import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
// B-HQ-3 HQ business numbers (0326) proof, TEST MODE, disposable database only. It proves: only an HQ owner or an HQ
// operator with hq.billing.manage reads the numbers (a lapsed owner, support staff without the permission and unknown
// subjects are refused); the runtime can execute only the read, never the price helper; every count and sum moves by
// exactly what synthetic records add (one record per school, binding over v1, annual / 12 rounded, lifetime and unpriced
// kept out of MRR, voided and suspended v1 subscriptions counted as stopped in the month of the step, trial conversions);
// months are UTC calendar months, oldest first; the read writes nothing; a reader revoked meanwhile gets nothing.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const {validateHqBusinessNumbers}=await import('../../contracts/dist/index.js');
const database=new RuntimeDatabaseService(),reads=new SaasSchoolBillingService(new SaasBillingService(database));
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const humans=Object.fromEntries(['owner','exowner','billingOp','supportAgent','stranger']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqbiz-${k}-${randomUUID()}`,name:`Fixture ${k}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const TABLES=['saas_subscriptions','saas_subscription_history','saas_schedule_bindings','hon_os_trial_enrollments','hon_os_school_registrations'];
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
 await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
 await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
 await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
}
const rowCounts=async()=>(await admin.query(`SELECT ${[...TABLES,'organizations'].map(t=>`(SELECT count(*) FROM hon.${t})::int ${t}`).join(',')}`)).rows[0];
const read=async(months)=>validateHqBusinessNumbers((await admin.query('SELECT hon.read_hq_business_numbers($1,$2) d',[H('owner'),months])).rows[0].d);

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['read_hq_business_numbers(text,integer)',true],['hq_business_monthly_minor(jsonb)',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 await cleanup();
 await admin.query('BEGIN');
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)",[h.user,h.subject,`${h.user}@example.test`,h.name]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER',$3,true)",[h.id,h.user,h.name]);}
 for(const[who,role,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['billingOp','HON_HQ_OPERATOR',['hq.billing.manage'],null],
  ['supportAgent','HON_HQ_SUPPORT',['hq.support.manage'],null]])
  await admin.query(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),role,perms]);
 await admin.query('COMMIT');

 // ---------- 1. authority and input ----------
 for(const who of ['owner','billingOp']){
  const v=await reads.readHqBusinessNumbers(H(who),{});
  assert.equal(v.monthsRequested,6,who); assert.equal(v.months.length,6); assert.equal(v.chargesEnabled,false); assert.equal(v.churnRateAvailable,false);
 }
 assert.equal((await reads.readHqBusinessNumbers(H('owner'),{months:'12'})).months.length,12);
 for(const who of ['exowner','supportAgent','stranger'])await deny(reads.readHqBusinessNumbers(H(who),{}),403,'SAAS_FORBIDDEN');
 for(const bad of [{months:'0'},{months:'13'},{months:'x'},{schoolId:randomUUID()}])await deny(reads.readHqBusinessNumbers(H('owner'),bad),400,'INVALID_SAAS_INPUT');
 for(const bad of [0,13,null])await assert.rejects(restricted.query('SELECT hon.read_hq_business_numbers($1,$2)',[H('owner'),bad]),e=>e.code==='22023');
 await assert.rejects(restricted.query('SELECT hon.hq_business_monthly_minor($1)',[{}]),e=>e.code==='42501');

 // ---------- 2. every number moves by exactly what synthetic records add ----------
 // The records are written straight into the five source tables inside one transaction that is rolled back. Their
 // foreign keys and guard triggers are lifted inside that transaction only (the write paths are proven elsewhere);
 // every CHECK constraint still holds, so each record has a real shape.
 await admin.query('BEGIN');
 for(const t of TABLES){
  for(const {conname} of (await admin.query("SELECT conname FROM pg_constraint WHERE conrelid=('hon.'||$1)::regclass AND contype='f'",[t])).rows)
   await admin.query(`ALTER TABLE hon.${t} DROP CONSTRAINT ${conname}`);
  await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
 }
 const now=new Date((await admin.query('SELECT clock_timestamp() t')).rows[0].t).getTime();
 const ms=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),1),day=86400e3;
 const at=x=>new Date(x).toISOString();
 const cur1=at(ms+(now-ms)/3),cur=at(ms+2*(now-ms)/3),prev=at(ms-5*day),old2=at(ms-40*day),outside=at(ms-120*day);
 const mKey=x=>x.slice(0,7);
 const before=await read(3),rowsBefore=await rowCounts();
 assert.deepEqual(before.months.map(m=>m.month),[mKey(old2),mKey(prev),mKey(cur)],'UTC calendar months, oldest first');
 const O=Object.fromEntries('ABCDEFGH'.split('').map(k=>[k,randomUUID()]));
 for(const[k,id]of Object.entries(O))
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,$2,$2,'ACTIVE',$3)",[id,`HQB Fixture ${k}`,k==='H'?prev:cur]);
 await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQB Fixture old','HQB Fixture old','ACTIVE',$2)",[randomUUID(),outside]);
 const fake=()=>'fake_'+randomBytes(8).toString('hex');
 async function binding(org,status,requirements,activated){
  const live=status==='ACTIVE';
  await admin.query(`INSERT INTO hon.saas_schedule_bindings(binding_key,generation_id,organization_id,school_id,requirements,requirements_digest,provider,provider_mode,status,status_reason,
   provider_account_reference,provider_subscription_reference,provider_schedule_reference,actor_principal_id,idempotency_key,observed_by_principal_id,observation_key,created_at,bound_at,activated_at)
   VALUES($1,$2,$3,$4,$5,$6,'STRIPE_SIMULATED','TEST',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17)`,
   [randomUUID(),randomUUID(),org,randomUUID(),requirements,randomBytes(32).toString('hex'),status,live?'FIRST_PAYMENT_VERIFIED':'AMOUNT_MISMATCH',
    fake(),fake(),fake(),P('owner'),randomUUID(),P('owner'),randomUUID(),activated??old2,live?activated:null]);
 }
 async function subscription(org,{status,interval='MONTHLY',price=14900,started=null,history}){
  const id=randomUUID(),life=interval==='LIFETIME',inService=['IN_SERVICE','SUSPENDED'].includes(status);
  await admin.query(`INSERT INTO hon.saas_subscriptions(id,organization_id,source,catalog_id,offer_id,plan_code,entitlement_tier,offer_kind,billing_interval,price_minor,founder_reservation_id,
   entitlement_version_at_record,status,status_reason,version,service_started_at,period_anchor_at,period_index,current_period_start,current_period_end,created_by_principal_id,created_at,updated_at)
   VALUES($1,$2,'CATALOG_OFFER',$3,$4,'CORE','CORE',$5,$6,$7,$8,1,$9,$10,$11,$12,$12,$13,$12,$14,$15,$16,$16)`,
   [id,org,randomUUID(),randomUUID(),life?'FOUNDER_LIFETIME':'REGULAR_MONTHLY',interval,price,life?randomUUID():null,status,
    {IN_SERVICE:'SERVICE_STARTED',SUSPENDED:'OWNER_HOLD',VOIDED:'RECORDED_IN_ERROR'}[status],history.length,inService?started:null,
    inService&&!life?0:null,inService&&!life?at(Date.parse(started)+31*day):null,P('owner'),history[0][1]]);
  for(const[i,[st,t]]of history.entries())
   await admin.query("INSERT INTO hon.saas_subscription_history(subscription_id,version,status,status_reason,actor_principal_id,occurred_at) VALUES($1,$2,$3,'RECORDED',$4,$5)",[id,i+1,st,P('owner'),t]);
 }
 async function trial(org,starts){
  await admin.query(`INSERT INTO hon.hon_os_trial_enrollments(organization_id,school_id,registration_id,campaign_id,campaign_version_id,publication_id,policy_decision_id,capability_profile,duration_days,
   terms_reference,starts_at,ends_at,prior_entitlement,granted_entitlement_version,enrolled_by_principal_id,subject,idempotency_key,program_status,ai_budget)
   VALUES($1,$2,$3,$4,$5,$6,$7,'CORE',14,'fixture',$8,$8::timestamptz+interval '14 days','{}',2,$9,$10,$11,'TEST_MODE','null')`,
   [org,randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),randomUUID(),starts,P('owner'),`oidc:hqbiz-${randomUUID()}`,randomUUID()]);
 }
 async function registration(org,t){
  await admin.query(`INSERT INTO hon.hon_os_school_registrations(organization_id,school_id,owner_principal_id,owner_grant_id,subject,verified_email,terms_version_id,terms_accepted_at,program_status,idempotency_key,registered_at)
   VALUES($1,$2,$3,$4,$5,'owner@example.test',$6,$7,'TEST_MODE',$8,$7)`,[org,randomUUID(),randomUUID(),randomUUID(),`oidc:hqbiz-${randomUUID()}`,randomUUID(),t,randomUUID()]);
 }
 // A: HON OS monthly binding wins over its older v1 subscription; it began paying last month, after its trial.
 await binding(O.A,'ACTIVE',{billingInterval:'MONTHLY',lockedPriceMinor:24900},cur);
 await subscription(O.A,{status:'IN_SERVICE',price:14900,started:prev,history:[['PENDING_ACTIVATION',old2],['IN_SERVICE',prev]]});
 await trial(O.A,old2);
 // B: annual binding, 2,388.06 a year counts as 199.01 a month (rounded to the cent).
 await binding(O.B,'ACTIVE',{billingInterval:'ANNUAL',lockedPriceMinor:238806},cur);
 // C: v1 monthly subscription that started this month after a trial started this month.
 await trial(O.C,cur1);
 await subscription(O.C,{status:'IN_SERVICE',price:14900,started:cur,history:[['PENDING_ACTIVATION',cur1],['IN_SERVICE',cur]]});
 // D: lifetime purchase: counted, never added to MRR.
 await subscription(O.D,{status:'IN_SERVICE',interval:'LIFETIME',price:189600,started:cur,history:[['PENDING_ACTIVATION',cur1],['IN_SERVICE',cur]]});
 // E: an active binding whose recorded price cannot be read: unpriced, not paying.
 await binding(O.E,'ACTIVE',{billingInterval:'MONTHLY'},cur);
 // F: paid from last month, suspended this month. G: paid two months ago, voided last month (its start date is cleared).
 await subscription(O.F,{status:'SUSPENDED',price:14900,started:prev,history:[['PENDING_ACTIVATION',old2],['IN_SERVICE',prev],['SUSPENDED',cur]]});
 await subscription(O.G,{status:'VOIDED',price:14900,history:[['IN_SERVICE',old2],['VOIDED',prev]]});
 // H: binding held for review; public sign-ups for H (this month), G (last month) and one outside the window.
 await binding(O.H,'NEEDS_REVIEW',{billingInterval:'MONTHLY',lockedPriceMinor:24900},null);
 await registration(O.H,cur); await registration(O.G,prev); await registration(randomUUID(),outside);
 assert.equal((await admin.query('SELECT hon.hq_business_monthly_minor($1) v',[{billingInterval:'ANNUAL',lockedPriceMinor:238806}])).rows[0].v,'19901');
 for(const bad of [{billingInterval:'LIFETIME',lockedPriceMinor:'100'},{billingInterval:'MONTHLY',lockedPriceMinor:-1},{billingInterval:'MONTHLY',lockedPriceMinor:1.5},{billingInterval:'MONTHLY',lockedPriceMinor:'24900'},{billingInterval:'MONTHLY'}])
  assert.equal((await admin.query('SELECT hon.hq_business_monthly_minor($1) v',[bad])).rows[0].v,null,JSON.stringify(bad));

 const rowsMid=await rowCounts(),after=await read(3);
 assert.deepEqual(await rowCounts(),rowsMid,'the read writes nothing');
 const d=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,typeof a[k]==='object'?d(a[k],b[k]):a[k]-b[k]]));
 assert.deepEqual(d(after.current,before.current),{mrrMinor:24900+19901+14900,arrMinor:(24900+19901+14900)*12,payingSchools:3,
  payingByInterval:{MONTHLY:2,ANNUAL:1},payingBySource:{SCHEDULE_BINDING:2,V1_SUBSCRIPTION:1},unpricedActiveRecords:1,lifetimeSchools:1,
  bindingsNeedingReview:1,suspendedSubscriptions:1,activeTrials:1});
 const flows=after.months.map((m,i)=>{const{month,monthToDate,...rest}=d(m,{...before.months[i],month:0,monthToDate:0});return rest;});
 assert.deepEqual(after.months.map(m=>[m.month,m.monthToDate]),[[mKey(old2),false],[mKey(prev),false],[mKey(cur),true]]);
 assert.deepEqual(flows,[
  {newSchools:0,publicSignups:0,trialsStarted:1,newPayingSchools:1,trialConversions:0,stoppedPayingSchools:0}, // G began paying (history only); A's trial
  {newSchools:1,publicSignups:1,trialsStarted:0,newPayingSchools:2,trialConversions:1,stoppedPayingSchools:1}, // H created; G signed up; A and F began; A after its trial; G voided
  {newSchools:7,publicSignups:1,trialsStarted:1,newPayingSchools:4,trialConversions:1,stoppedPayingSchools:1}, // B, C, D, E began; C after its trial; F suspended
 ]);
 assert(!JSON.stringify(after).match(/HQB Fixture|example\.test|oidc:|fake_/),'no school, person or provider reference');
 await admin.query('ROLLBACK');
 assert.deepEqual(await rowCounts(),rowsBefore,'everything added is rolled back');
 for(const t of TABLES)assert((await admin.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid=('hon.'||$1)::regclass AND contype='f'",[t])).rows[0].n>0,`${t} keys restored`);

 // ---------- 3. a reader revoked meanwhile gets nothing ----------
 await admin.query("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('billingOp')]);
 await deny(reads.readHqBusinessNumbers(H('billingOp'),{}),403,'SAAS_FORBIDDEN');
 console.log('HQ business numbers proof passed (posture, authority, input bounds, one record per school, binding over v1, annual / 12, lifetime and unpriced kept out of MRR, stopped-paying evidence, trial conversions, UTC months, no references, read-only, revocation).');
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
