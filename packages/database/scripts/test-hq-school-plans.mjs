import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pricingOffers } from './price-acceptance-fixture.mjs';

// HQ school plan assignments (0676) integrity proof. Fixed disposable local Champions Club fixture only: synthetic
// organizations, no network, no charge, no checkout, no message and no deployment. It proves: only a current HQ owner
// assigns or removes a plan (billing operators read, school owners and other operators are refused); the runtime has three
// entry points and no table privilege; commands are idempotent by actor and key and need the exact current revision; only an
// offer of the published, not stopped set can be assigned and its terms are frozen (a new price version never changes the
// record and the retired offer can no longer be assigned); custom plans take any price from $0 (free with or without an end
// date; an end date only when free); archived schools refuse new plans; history is append-only and immutable; nothing
// touches subscriptions, checkouts, entitlements, offers or audit/billing tables.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const u of [owner,runtime])assert(u.protocol==='postgresql:'&&u.hostname==='localhost'&&u.port==='5432'&&u.pathname==='/hon_champions_validation'&&u.search===''&&u.hash===''&&u.password);
assert(owner.username==='hon_champions_owner'&&runtime.username==='hon_champions_runtime');
assert(!Object.keys(process.env).some(k=>/^PG[A-Z_]*$|^(?:STRIPE|SQUARE|OPENAI|ANTHROPIC|OPENROUTER|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(k)));
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {HqSchoolPlansService}=await import('../../../apps/api/dist/hq-school-plans/hq-school-plans.service.js');
const apiRequire=createRequire(new URL('../../../apps/api/package.json',import.meta.url));
const c=apiRequire('@hon/contracts');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),plans=new HqSchoolPlansService(billing);
const client=u=>new pg.Client({connectionString:u.toString(),ssl:false}),admin=client(owner),restricted=client(runtime);
const human=k=>({k,id:K(),user:K(),subject:`hsp-${k}-${K()}`});
const hq=human('owner'),billingOp=human('billing'),marketer=human('marketer');
const hqs=[hq,billingOp,marketer],orgs=[];
const principals=()=>[...hqs.map(h=>h.id),...orgs.map(o=>o.principal)];
const mine=['hq_school_plan_requests','hq_school_plan_assignments'];
const saasTables=['saas_offer_sales_stops','saas_offer_set_offers','saas_offer_sets'];
const row=async(q,p)=>(await admin.query(q,p)).rows[0];let groups=0;const passed=s=>console.log('PASS 0676 '+(++groups)+': '+s);
const deny=(work,status,code)=>assert.rejects(Promise.resolve().then(work),e=>{assert.equal(e.getStatus?.(),status,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;});
const sqlDeny=(work,code)=>assert.rejects(work,e=>{assert.equal(e.code,code,e.stack);return true;});
async function cleanup(){
  await admin.query('ROLLBACK');await admin.query('BEGIN');
  try {
    for(const t of [...mine,...saasTables,'saas_outbox','saas_audit','saas_requests']){
      await admin.query('ALTER TABLE hon.'+t+' DISABLE TRIGGER USER');
      if(t==='saas_outbox')await admin.query('DELETE FROM hon.saas_outbox WHERE audit_id IN (SELECT id FROM hon.saas_audit WHERE actor_principal_id=ANY($1::uuid[]))',[principals()]);
      else if(['saas_audit','saas_requests'].includes(t))await admin.query('DELETE FROM hon.'+t+' WHERE actor_principal_id=ANY($1::uuid[])',[principals()]);
      else await admin.query('DELETE FROM hon.'+t);
      await admin.query('ALTER TABLE hon.'+t+' ENABLE TRIGGER USER');
    }
    await admin.query('COMMIT');
  } catch(e){await admin.query('ROLLBACK');throw e;}
}
async function makeOrg(label){
  const o={label,id:K(),school:K(),role:K(),principal:K(),user:K(),subject:'hsp-'+K()};
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'HSP SYNTHETIC')",[o.user,o.subject,o.user+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','HSP SYNTHETIC',true)",[o.principal,o.user]);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'HSP SYNTHETIC','HSP SYNTHETIC')",[o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'UTC')",[o.school,o.id,'HSP School '+label,'hsp-'+o.school]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status) VALUES($1,'COMPLETE','ACTIVE')",[o.id]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','HSP owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.hon.purchase')",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[o.id,o.school,o.principal,o.role]);
  await admin.query('COMMIT');orgs.push(o);return o;
}
async function publish(basedOnSetId,patch={}){
  const d=await billing.createOfferSetDraft(hq.subject,{basedOnSetId,termsReference:'SYNTHETIC_HSP_TERMS_V1',founderTotalLimit:50,offers:pricingOffers(patch)},K());
  const set=(await billing.publishOfferSet(hq.subject,d.set.setId,{expectedRevision:d.set.revision,previewDigest:d.preview.previewDigest,approval:c.SAAS_HON_OS_OFFER_PUBLISH_APPROVAL},K())).set;
  return {set,offers:Object.fromEntries(set.offers.map(o=>[o.offerKind,o]))};
}
const custom=(patch={})=>({source:'CUSTOM',name:'Dojo partner deal',billingInterval:'MONTHLY',priceMinor:15000,freeUntil:null,...patch});
const assign=(who,o,expectedRevision,plan,key=K(),note=null)=>plans.assign(who.subject,o.school,{expectedRevision,plan,note},key);
const effects=async()=>row(`SELECT (SELECT count(*) FROM hon.saas_subscriptions)::int subs,(SELECT count(*) FROM hon.saas_checkout_sessions)::int checkouts,
  (SELECT count(*) FROM hon.saas_schedule_bindings)::int bindings,(SELECT count(*) FROM hon.saas_access_exceptions)::int exceptions,
  (SELECT count(*) FROM hon.saas_founder_reservations)::int founder,(SELECT md5(string_agg(organization_id::text||tier::text||status::text,',' ORDER BY organization_id)) FROM hon.organization_entitlements) ent`);
const today=new Date(),dateIn=days=>new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()+days)).toISOString().slice(0,10);

await Promise.all([admin,restricted].map(x=>x.connect()));
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).marker,'HON disposable Champions Club validation');
  // ---------- posture ----------
  const entry=['read_hq_school_plan(text,uuid)','assign_hq_school_plan(text,uuid,jsonb,uuid)','remove_hq_school_plan(text,uuid,jsonb,uuid)'];
  const internal=['require_hq_school_plan_owner(text)','hq_school_plan_owner_eligible(uuid)','hq_school_plan_json(hon.hq_school_plan_assignments)',
    'hq_school_plan_offers()','hq_school_plan_current(uuid)','hq_school_plan_view(uuid,uuid)','hq_school_plan_claim(uuid,uuid,text,text)',
    'hq_school_plan_lock(uuid,integer,boolean)','hq_school_plan_expected(jsonb)','hq_school_plan_note(jsonb)','guard_hq_school_plan_evidence()'];
  for(const [sig,allowed] of [...entry.map(s=>[s,true]),...internal.map(s=>[s,false])])
    assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
  for(const t of mine){
    for(const priv of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await restricted.query('SELECT has_table_privilege(current_user,$1,$2) a',['hon.'+t,priv])).rows[0].a,false,t+' '+priv);
    assert.deepEqual(await row("SELECT relrowsecurity r,relforcerowsecurity f FROM pg_class WHERE oid=$1::regclass",['hon.'+t]),{r:true,f:true},t);
  }
  for(const t of [...mine,...saasTables])assert.equal((await row('SELECT count(*)::int n FROM hon.'+t)).n,0,'dedicated empty fixture required: '+t);
  passed('runtime holds exactly three entry points, no helper and no table privilege; forced RLS on both tables');

  // ---------- fixture ----------
  await admin.query('BEGIN');
  for(const [h,role,perms] of [[hq,'HON_HQ_OWNER',[]],[billingOp,'HON_HQ_OPERATOR',['hq.billing.manage']],[marketer,'HON_HQ_OPERATOR',['hq.marketing.manage']]]){
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'HSP SYNTHETIC')",[h.user,h.subject,h.user+'@example.test']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','HSP SYNTHETIC',true)",[h.id,h.user]);
    await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[h.id,role,perms]);
  }
  await admin.query('COMMIT');
  const A=await makeOrg('A'),B=await makeOrg('B'),C=await makeOrg('C');
  const before=await effects();

  // ---------- empty state, before any offer set is published ----------
  const empty=await plans.read(hq.subject,A.school);
  assert.equal(empty.current,null);assert.equal(empty.revision,0);assert.deepEqual(empty.history,[]);assert.deepEqual(empty.offers,[]);
  assert.equal(empty.onNow,'NONE');assert.equal(empty.viewer.canManage,true);assert.equal(empty.effect,'RECORD_ONLY');assert.equal(empty.charging,'OFF');
  assert.equal(empty.schoolName,'HSP School A');
  const asOperator=await plans.read(billingOp.subject,A.school);assert.equal(asOperator.viewer.canManage,false);
  await deny(()=>plans.read(marketer.subject,A.school),403,'SAAS_FORBIDDEN');
  await deny(()=>plans.read(A.subject,A.school),403,'SAAS_FORBIDDEN');
  await deny(()=>plans.read(hq.subject,K()),404,'SAAS_UNAVAILABLE');
  // A custom plan works with no published offer set.
  const r1=await assign(hq,A,0,custom());
  assert.equal(r1.operation,'ASSIGN');assert.equal(r1.assignment.revision,1);assert.equal(r1.assignment.planName,'Dojo partner deal');
  assert.equal(r1.assignment.priceMinor,15000);assert.equal(r1.assignment.founder,false);assert.equal(r1.charging,'OFF');assert.equal(r1.replayed,false);
  passed('empty view before any offer set; HQ owner manages, billing operator reads only, marketing operator and school owner refused; a custom plan needs no published set');

  // ---------- authority, input, idempotency, revision ----------
  for(const who of [billingOp,marketer,A])await deny(()=>assign(who,A,1,custom({priceMinor:9900})),403,'SAAS_FORBIDDEN');
  await deny(()=>plans.remove(billingOp.subject,A.school,{expectedRevision:1,note:null},K()),403,'SAAS_FORBIDDEN');
  for(const bad of [custom({priceMinor:-1}),custom({priceMinor:10_000_001}),custom({billingInterval:'ONE_TIME'}),custom({name:' padded'}),
    custom({name:'ab'}),custom({freeUntil:dateIn(30)}),custom({priceMinor:0,freeUntil:'2026-02-30'}),{...custom(),extra:1},{source:'OFFER'},{source:'OTHER'}])
    await deny(()=>assign(hq,A,1,bad),400,'INVALID_SAAS_INPUT');
  await deny(()=>plans.assign(hq.subject,A.school,{expectedRevision:1,plan:custom(),note:' x'},K()),400,'INVALID_SAAS_INPUT');
  await deny(()=>assign(hq,A,0,custom({priceMinor:9900})),409,'SAAS_VERSION_CONFLICT');
  await deny(()=>assign(hq,A,1,custom()),422,'HQ_SCHOOL_PLAN_NO_CHANGE');
  const key=K(),r2=await assign(hq,A,1,custom({priceMinor:12900,billingInterval:'ANNUAL'}),key,'Annual deal agreed by phone');
  const again=await assign(hq,A,1,custom({priceMinor:12900,billingInterval:'ANNUAL'}),key,'Annual deal agreed by phone');
  assert.equal(again.replayed,true);assert.deepEqual({...again,replayed:false},r2);
  await deny(()=>assign(hq,A,1,custom({priceMinor:13900}),key),409,'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await row('SELECT count(*)::int n FROM hon.hq_school_plan_assignments WHERE organization_id=$1',[A.id])).n,2);
  passed('owner-only commands; closed input (price $0-$100,000, monthly/annual, trimmed name, no extra keys, end date only when free); exact revision; no-change refused; exact replay and key reuse');

  // ---------- free plans (owner decision 2026-11-24: free may last forever) ----------
  const free=await assign(hq,A,2,custom({name:'Free pilot',priceMinor:0}));
  assert.equal(free.assignment.priceMinor,0);assert.equal(free.assignment.freeUntil,null);
  const freeEnds=await assign(hq,A,3,custom({name:'Free pilot',priceMinor:0,freeUntil:dateIn(60)}));
  assert.equal(freeEnds.assignment.freeUntil,dateIn(60));
  await deny(()=>assign(hq,A,4,custom({name:'Free pilot',priceMinor:0,freeUntil:dateIn(0)})),422,'HQ_SCHOOL_PLAN_FREE_END_INVALID');
  await deny(()=>assign(hq,A,4,custom({name:'Free pilot',priceMinor:0,freeUntil:dateIn(4*366)})),422,'HQ_SCHOOL_PLAN_FREE_END_INVALID');
  passed('a free custom plan may last forever or end on a chosen date after today and within three years');

  // ---------- published offers: assign, freeze, new version ----------
  const v1=await publish(null);
  const seen=await plans.read(hq.subject,B.school);
  assert.deepEqual(seen.offers.map(o=>o.offerKind),['REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL']);
  const founder=v1.offers.FOUNDER_MONTHLY;
  const b1=await assign(hq,B,0,{source:'OFFER',offerId:founder.offerId});
  assert.deepEqual([b1.assignment.source,b1.assignment.offerKind,b1.assignment.priceMinor,b1.assignment.founder,b1.assignment.billingInterval,b1.assignment.offerSetVersion],
    ['OFFER','FOUNDER_MONTHLY',19920,true,'MONTHLY',1]);
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_founder_reservations')).n,before.founder,'assigning a founder offer reserves no founder spot');
  await deny(()=>assign(hq,B,1,{source:'OFFER',offerId:K()}),422,'HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE');
  const v2=await publish(v1.set.setId,{FOUNDER_MONTHLY:{priceMinor:17900}});
  const after=await plans.read(hq.subject,B.school);
  assert.equal(after.current.priceMinor,19920,'a new offer version never changes an assigned plan');assert.equal(after.current.offerSetVersion,1);
  await deny(()=>assign(hq,B,1,{source:'OFFER',offerId:founder.offerId}),422,'HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE');
  const b2=await assign(hq,B,1,{source:'OFFER',offerId:v2.offers.FOUNDER_MONTHLY.offerId});
  assert.equal(b2.assignment.priceMinor,17900);assert.equal(b2.assignment.offerSetVersion,2);
  await billing.stopOfferSales(hq.subject,v2.offers.REGULAR_ANNUAL.offerId,{reasonCode:'OWNER_DISABLED'},K());
  await deny(()=>assign(hq,B,2,{source:'OFFER',offerId:v2.offers.REGULAR_ANNUAL.offerId}),422,'HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE');
  assert.equal((await plans.read(hq.subject,B.school)).offers.some(o=>o.offerKind==='REGULAR_ANNUAL'),false,'a stopped offer is not offered');
  passed('only offers of the published, not stopped set are assignable; terms are frozen; a founder offer reserves no spot; a new price version leaves the record unchanged and retires the old offer for new assignments');

  // ---------- school plan features (0699): display only, locked features from the assigned offer ----------
  const features=(who,o)=>billing.readSchoolPlanFeatures(who.subject,o.school);
  const clerk={user:K(),id:K(),role:K(),subject:'hsp-clerk-'+K()};
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'HSP SYNTHETIC')",[clerk.user,clerk.subject,clerk.user+'@example.test']);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','HSP SYNTHETIC',true)",[clerk.id,clerk.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'FRONT_DESK','HSP front desk',false)",[clerk.role,C.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.premium.request')",[clerk.role,C.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day')",[C.id,C.school,clerk.id,clerk.role,C.principal]);
  await admin.query('COMMIT');orgs.push({principal:clerk.id});
  const all=c.HON_OS_PLAN_CAPABILITIES,complete=['marketing.campaigns_ai_managed','attribution.ai_insight','ai.workforce','ai.delegated_jobs','ai.orchestration'];
  const none=await features(C,C);
  assert.deepEqual([none.source,none.planName,none.included,none.locked],['NONE',null,[...all],[]],'no plan: nothing locked');
  const onCustom=await features(A,A);
  assert.deepEqual([onCustom.source,onCustom.planName,onCustom.locked],['CUSTOM','Free pilot',[]],'a custom plan locks nothing');
  const onFull=await features(B,B);assert.deepEqual([onFull.source,onFull.planName,onFull.locked],['OFFER','FOUNDER_MONTHLY',[]]);
  const coreOnly=all.filter(x=>!complete.includes(x));
  const v3=await publish(v2.set.setId,{REGULAR_MONTHLY:{displayName:'HON OS Core',priceMinor:14900,capabilities:[...coreOnly].reverse()}});
  assert.deepEqual(v3.offers.REGULAR_MONTHLY.capabilities,coreOnly);
  await assign(hq,C,0,{source:'OFFER',offerId:v3.offers.REGULAR_MONTHLY.offerId});
  for(const who of [C,clerk]){
    const f=await features(who,C);
    assert.deepEqual([f.source,f.planName,f.included,f.locked],['OFFER','HON OS Core',coreOnly,complete],'the assigned plan leaves out the AI team');
    assert.deepEqual(c.validateSaasSchoolPlanFeatures(f),f);
  }
  for(const who of [hq,billingOp,A,B])await deny(()=>features(who,C),403,'SAAS_FORBIDDEN');
  await deny(()=>billing.readSchoolPlanFeatures(C.subject,K()),403,'SAAS_FORBIDDEN');
  await deny(()=>billing.readSchoolPlanFeatures(C.subject,'not-a-uuid'),400,'INVALID_SAAS_INPUT');
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,'hon.school_plan_features(uuid,uuid)','EXECUTE') a")).rows[0].a,false);
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,'hon.read_school_plan_features(text,uuid)','EXECUTE') a")).rows[0].a,true);
  const canonical=await readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const block=canonical.split('-- School plan features exact verification (0699)')[1]?.split('-- End school plan features exact verification.')[0];
  assert.ok(block,'011 section present');await admin.query(block.slice(block.indexOf('\n')+1).replaceAll('hon_runtime',runtime.username));
  await plans.remove(hq.subject,C.school,{expectedRevision:1,note:null},K());
  assert.deepEqual((await features(clerk,C)).locked,[],'removing the plan unlocks everything');
  await admin.query('BEGIN');await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=$2 WHERE principal_id=$1',[clerk.id,C.principal]);await admin.query('COMMIT');
  await deny(()=>features(clerk,C),403,'SAAS_FORBIDDEN');
  passed('0699 plan features: any current staff member of the exact school sees what the assigned offer includes and leaves out (canonical order); no plan, a custom plan or a removed plan locks nothing; HQ, other schools, revoked staff and unknown schools are refused; only the read is a runtime entry point');

  // ---------- remove, history, archived ----------
  const removed=await plans.remove(hq.subject,B.school,{expectedRevision:2,note:'School closed its account'},K());
  assert.equal(removed.assignment.action,'REMOVE');assert.equal(removed.assignment.planName,null);
  const viewB=await plans.read(hq.subject,B.school);
  assert.equal(viewB.current,null);assert.equal(viewB.revision,3);assert.deepEqual(viewB.history.map(h=>[h.revision,h.action]),[[3,'REMOVE'],[2,'ASSIGN'],[1,'ASSIGN']]);
  await deny(()=>plans.remove(hq.subject,B.school,{expectedRevision:3,note:null},K()),422,'HQ_SCHOOL_PLAN_NONE');
  await admin.query('BEGIN');await admin.query("UPDATE hon.schools SET status='ARCHIVED' WHERE id=$1",[B.school]);await admin.query('COMMIT');
  await deny(()=>assign(hq,B,3,custom()),422,'HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED');
  const viewA=await plans.read(hq.subject,A.school);
  const removedA=await plans.remove(hq.subject,A.school,{expectedRevision:viewA.revision,note:null},K());
  assert.equal(removedA.assignment.revision,5);
  passed('remove appends a REMOVE revision and keeps history newest first; removing with no plan is refused; an archived school refuses a new plan');

  // ---------- immutability and no side effects ----------
  for(const q of ['UPDATE hon.hq_school_plan_assignments SET price_minor=1','DELETE FROM hon.hq_school_plan_assignments','TRUNCATE hon.hq_school_plan_requests CASCADE',
    'UPDATE hon.hq_school_plan_requests SET operation=operation','DELETE FROM hon.hq_school_plan_requests']){
    await admin.query('BEGIN');await sqlDeny(admin.query(q),'42501');await admin.query('ROLLBACK');}
  for(const q of ['SELECT * FROM hon.hq_school_plan_assignments',"INSERT INTO hon.hq_school_plan_requests SELECT * FROM hon.hq_school_plan_requests LIMIT 1"])
    await sqlDeny(restricted.query(q),'42501');
  await admin.query('BEGIN');
  await sqlDeny(admin.query("INSERT INTO hon.hq_school_plan_assignments(organization_id,revision,school_id,action,source,plan_name,billing_interval,price_minor,currency,founder,free_until,actor_principal_id,recorded_at) VALUES($1,99,$2,'ASSIGN','CUSTOM','Bad end',  'MONTHLY',5000,'USD',false,'2030-01-01',$3,clock_timestamp())",[A.id,A.school,hq.id]),'23514');
  await admin.query('ROLLBACK');
  const end=await effects();
  assert.deepEqual(end,before,'no subscription, checkout, schedule binding, access exception, founder reservation or entitlement changed');
  assert.equal((await row('SELECT count(*)::int n FROM hon.saas_audit WHERE action_code LIKE $1',['%school_plan%'])).n,0);
  passed('records and receipts never change (even for the owner role); runtime has no table path; table checks back the rules; no billing, access or entitlement effect');
  console.log(`PASS: HQ school plan assignments (0676) ${groups} scenario groups; no checkout, charge, message, provider call or deployment.`);
} finally {
  await Promise.allSettled([admin.query('ROLLBACK'),restricted.query('ROLLBACK')]);
  try { await cleanup(); }
  finally { await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]); }
}
