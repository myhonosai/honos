import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { RevenuePlanningService } from '../../../apps/api/dist/planning/revenue-planning.service.js';
import { RevenuePlanningController } from '../../../apps/api/dist/planning/revenue-planning.controller.js';
for(const key of ['DATABASE_URL','HON_RUNTIME_DATABASE_URL']) {
 if(!process.env[key]) throw new Error('Administrator and restricted runtime URLs required.');
 const u=new URL(process.env[key]);if(u.hostname!=='localhost'||u.pathname!=='/hon_revenue_validation') throw new Error('Only disposable localhost/hon_revenue_validation is allowed; remote fixtures forbidden.');
}
const admin=new pg.Client({connectionString:process.env.DATABASE_URL}),runtime=new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL});
const db=new RuntimeDatabaseService(),svc=new RevenuePlanningService(db),controller=new RevenuePlanningController(db,svc);
const runtimeRole=new URL(process.env.HON_RUNTIME_DATABASE_URL).username;
if(!['hon_runtime','hon_revenue_runtime'].includes(runtimeRole))throw new Error('Known restricted local runtime role required.');
const ids=Object.fromEntries(['org','otherOrg','school','sibling','otherSchool','role','legacyRole','otherRole'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['planner','legacy','sibling','other','parent','hq'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`revenue-${k}-${randomUUID()}`} ]));
const orgs=[ids.org,ids.otherOrg], privateTables=['revenue_plans','revenue_plan_versions','revenue_plan_requests'];
const c=(who='planner',school=ids.school,key=randomUUID())=>({organizationId:school===ids.otherSchool?ids.otherOrg:ids.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:key});
const input=(assumptions={trialToMembership:0.5,activitiesPerLead:3})=>({expectedVersion:0,targetMonthlyMinor:100000,currency:'USD',targetFrom:'2026-11-01T00:00:00.000Z',targetTo:'2026-12-01T00:00:00.000Z',historyFrom:'2026-01-01T00:00:00.000Z',historyTo:'2026-01-31T00:00:00.000Z',baselineMethod:'CURRENT_MONTHLY_SCHEDULES',assumptions});
const deny=(fn,status=403)=>assert.rejects(fn,e=>{assert.equal(e.getStatus?.(),status,e.stack);return true;});
const sqlDeny=(fn,code='42501')=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);return true;});
const snapshot=async tables=>{const out={};for(const t of tables)out[t]=(await admin.query(`SELECT to_jsonb(t) record FROM hon.${t} t WHERE organization_id=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,[orgs])).rows;return out;};
const count=async t=>Number((await admin.query(`SELECT count(*) n FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs])).rows[0].n);
async function direct(who,school,work,patch={}) {
 const ctx={...c(who,school),...patch};await runtime.query('BEGIN');
 try {
  for(const [key,value] of Object.entries({organization_id:ctx.organizationId,school_id:ctx.schoolId,principal_id:ctx.principalId,principal_type:ctx.principalType,source:ctx.source,request_id:ctx.requestId,action_request_id:ctx.actionRequestId??'',delegated_by_principal_id:ctx.delegatedByPrincipalId??''})) await runtime.query('SELECT set_config($1,$2,true)',[`app.hon_${key}`,value]);
  const result=await work(ctx);await runtime.query('COMMIT');return result;
 }catch(e){await runtime.query('ROLLBACK');throw e;}
}
let injected=false;
async function cleanup(){
 await admin.query('ROLLBACK');
 if(injected){await admin.query('DROP TRIGGER IF EXISTS revenue_fixture_failure ON hon.audit_events');await admin.query('DROP TRIGGER IF EXISTS revenue_fixture_failure ON hon.outbox_events');await admin.query('DROP FUNCTION IF EXISTS hon.revenue_fixture_failure()');}
 await admin.query('BEGIN');try{
  for(const t of privateTables)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  for(const t of ['revenue_plan_requests','revenue_plan_versions','revenue_plans','outbox_delivery_attempts','outbox_events','audit_events','payment_attempts','invoices','membership_payment_schedules','memberships','billing_accounts','crm_appointments','crm_activities','crm_leads','crm_pipeline_stages','crm_pipelines','family_access_grants','families','people','principal_role_grants','role_permissions','roles','organization_entitlements'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
  for(const t of privateTables)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.id)]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.id)]);await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(x=>x.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs]);await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
await Promise.all([admin.connect(),runtime.connect()]);
try{
 const role=(await runtime.query('SELECT rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];assert(Object.values(role).every(v=>v===false));
 for(const t of [...privateTables,'users','principals','roles','permissions','role_permissions','principal_role_grants','crm_activities','family_access_grants','hq_operator_grants','hq_ai_provider_connections','hq_ai_control_requests']){
  assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed",[`hon.${t}`])).rows[0].allowed,false,t);await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${t}`));
 }
 const helpers=['hon.validate_revenue_plan_input(jsonb)','hon.guard_revenue_plan()','hon.guard_revenue_plan_history()','hon.require_revenue_planning_actor(text)','hon.lock_revenue_planning_actor(text)','hon.revenue_plan_snapshot(uuid)'];
 for(const f of helpers)assert.equal((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",[f])).rows[0].allowed,false,f);
 for(const f of ['hon.save_revenue_plan(text,uuid,jsonb,text,uuid,uuid)','hon.read_revenue_plan(text,text,uuid,integer)']){
  const r=(await admin.query('SELECT p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls trusted,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault(\'f\',p.proowner))) a WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname=$2))) broad FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure',[f,runtimeRole])).rows[0];assert.equal(r.prosecdef,true);assert.equal(r.trusted,true);assert.equal(r.broad,false);assert.deepEqual(r.proconfig,['search_path=pg_catalog, hon']);
 }
 await admin.query('BEGIN');
 for(const org of orgs){await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic revenue fixture','Synthetic revenue fixture')",[org]);await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',clock_timestamp()-interval '1 day')",[org]);}
 for(const [school,org]of [[ids.school,ids.org],[ids.sibling,ids.org],[ids.otherSchool,ids.otherOrg]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,'Synthetic school',$1::text)",[school,org]);
 for(const h of Object.values(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY')",[h.id,h.user]);}
 for(const [role,org,permission]of [[ids.role,ids.org,'planning.revenue.manage'],[ids.legacyRole,ids.org,'school.view'],[ids.otherRole,ids.otherOrg,'planning.revenue.manage']]){await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1::uuid,$2,$1::text,'Fixture')",[role,org]);await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,permission]);}
 for(const [who,role,org,school]of [['planner',ids.role,ids.org,ids.school],['legacy',ids.legacyRole,ids.org,ids.school],['sibling',ids.role,ids.org,ids.sibling],['other',ids.otherRole,ids.otherOrg,ids.otherSchool]])await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[org,school,humans[who].id,role]);
 const family=randomUUID();await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY')",[family,ids.org,ids.school]);
 await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$5,clock_timestamp()-interval '1 day')",[ids.org,ids.school,family,humans.parent.id,humans.planner.id]);
 await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['planning.revenue.manage'],clock_timestamp()-interval '1 day')",[humans.hq.id]);
 const person=async(org,school)=>{const id=randomUUID();await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,'PRIVATE_CONTACT','PRIVATE_NAME','private@example.test','+15551234567')",[id,org,school]);return id;};
 const membership=async(org,school,currency='USD',frequency='MONTHLY',amount=10000)=>{
  const payer=await person(org,school),account=randomUUID(),m=randomUUID();await admin.query('INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,$4,$5)',[account,org,school,payer,currency]);
  await admin.query("INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_PLAN_CODE','ACTIVE',clock_timestamp()-interval '1 day')",[m,org,school,account,payer]);await admin.query("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,auto_renew) VALUES($1,$2,$3,$4,$5,$6,true)",[org,school,m,frequency,amount,currency]);return {m,account};
 };
 const memberships=[];for(let n=0;n<5;n++)memberships.push(await membership(ids.org,ids.school));await membership(ids.org,ids.school,'USD','ANNUAL',999999);await membership(ids.org,ids.school,'EUR','MONTHLY',999999);
 await membership(ids.org,ids.sibling,'USD','MONTHLY',777777);await membership(ids.otherOrg,ids.otherSchool,'USD','MONTHLY',888888);
 const invoice=randomUUID();await admin.query("INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,total_minor) VALUES($1,$2,$3,$4,$5,'PAID','USD',12345,12345)",[invoice,ids.org,ids.school,memberships[0].account,memberships[0].m]);await admin.query("INSERT INTO hon.payment_attempts(organization_id,school_id,invoice_id,provider_code,provider_account_reference,provider_idempotency_reference,provider_payment_reference,state,amount_minor,currency) VALUES($1,$2,$3,'PRIVATE_PROVIDER','PRIVATE_PAYER_TOKEN','PRIVATE_PAYMENT_METHOD','PRIVATE_PAYMENT_REF','SUCCEEDED',12345,'USD')",[ids.org,ids.school,invoice]);
 const mainLeads=[];
 for(const [org,school,n]of [[ids.org,ids.school,40],[ids.org,ids.sibling,25],[ids.otherOrg,ids.otherSchool,25]]){
  const pipeline=randomUUID(),stage=randomUUID(),payer=await person(org,school);await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_PIPELINE')",[pipeline,org,school]);await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'PRIVATE_STAGE',1)",[stage,org,school,pipeline]);
  for(let i=0;i<n+1;i++){const lead=randomUUID();await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,attribution,created_at,status) VALUES($1,$2,$3,$4,$5,$6,'{\"privateNote\":\"PRIVATE_ATTRIBUTION\"}',$7,'WON')",[lead,org,school,payer,pipeline,stage,i===n?input().historyTo:'2026-01-02T00:00:00.000Z']);if(school===ids.school&&i<n)mainLeads.push(lead);
   if(i<20)await admin.query("INSERT INTO hon.crm_appointments(organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,notes,created_by_principal_id) VALUES($1,$2,$3,'TRIAL',$4,'2026-01-03T00:00:00Z','2026-01-03T01:00:00Z','PRIVATE_APPOINTMENT_NOTE',$5)",[org,school,lead,i<10?'COMPLETED':i<18?'NO_SHOW':'CANCELLED',humans.planner.id]);
  }
 }
 await admin.query('COMMIT');
 assert.equal((await db.resolveParentFamilyScopes(humans.parent.subject,ids.school)).length,1);
 const forbidden=['families','family_access_grants','people','billing_accounts','membership_payment_schedules','memberships','payment_attempts','invoices','crm_leads','crm_appointments','crm_activities','communication_consents','communication_messages','action_requests','action_approvals','ai_usage_ledger','ai_invocation_plans','work_items'];const before=await snapshot(forbidden);
 const original=c(),r=await svc.save(original,null,input()),p=r.projection;assert.equal(p.evidence.eligibleMonthlyMinor,50000);assert.equal(p.evidence.eligibleMemberships,5);assert.equal(p.evidence.excludedMemberships,2);assert.equal(p.evidence.leads,40);assert.equal(p.evidence.bookedTrialLeads,20);assert.equal(p.evidence.completedTrialLeads,10);
 assert.deepEqual(Object.values(p.funnel).map(q=>q.required),[5,10,20,40,120]);assert.equal(p.signals.leadToAppointment.source,'SCOPED_HISTORY');assert.equal(p.signals.trialToMembership.source,'HUMAN_ASSUMPTION');assert.equal(p.assumptions.length,2);
 assert.deepEqual((await svc.save(original,null,input())).projection,p);assert.equal((await svc.save(original,null,input())).replayed,true);assert.deepEqual(await svc.read(c(),p.plan.id,1),p);
 assert.doesNotMatch(JSON.stringify(p),/PRIVATE_|private@example|15551234567|payer|paymentMethod|invoiceId|personId|notes|attribution/);
 await deny(()=>svc.save(original,null,{...input(),targetMonthlyMinor:1}),409);
 for(const who of ['legacy','parent','hq']){await deny(()=>svc.list(c(who)));await deny(()=>svc.save(c(who),null,input()));}
 await deny(()=>svc.read(c('sibling',ids.sibling),p.plan.id),404);await deny(()=>svc.read(c('other',ids.otherSchool),p.plan.id),404);await deny(()=>svc.read({...c(),organizationId:ids.otherOrg},p.plan.id));
 await deny(()=>controller.current(ids.otherOrg,ids.school,p.plan.id,{honIdentity:{externalSubject:humans.planner.subject}}));await deny(()=>controller.list(ids.org,ids.school,{honIdentity:{externalSubject:humans.hq.subject}}));
 for(const patch of [{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{source:'AI'},{source:'PUBLIC_API'},{source:'HQ_SUPPORT'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()},{externalSubject:humans.hq.subject}])await deny(()=>svc.save({...c(),...patch},null,input()));
 for(const bad of [{...input(),targetMonthlyMinor:1000000000001},{...input(),currency:'usd'},{...input(),targetMonthlyMinor:-1},{...input(),assumptions:{trialToMembership:1.01}},{...input(),assumptions:{trialToMembership:0.1234567}},{...input(),assumptions:{activitiesPerLead:-1}},{...input(),targetTo:input().targetFrom},{...input(),historyTo:'2099-12-01T00:00:00.000Z'},{...input(),actorPrincipalId:humans.parent.id}])await deny(()=>svc.save(c(),null,bad),400);
 await deny(()=>svc.save(c(),p.plan.id,{...input(),expectedVersion:1,currency:'EUR'}),400);
 const empty=(await svc.save(c('sibling',ids.sibling),null,{...input({}),targetMonthlyMinor:800000})).projection;assert.equal(empty.gapMinor,22223);assert.equal(empty.signals.newMembershipMonthlyMinor.source,'UNAVAILABLE');assert.equal(empty.funnel.memberships.required,null);assert.equal(empty.funnel.memberships.status,'ASSUMPTION_REQUIRED');assert.equal(empty.signals.trialToMembership.value,null,'WON must never be inferred as membership');
 // No legacy billing/CRM permission or HQ grant confers planning authority, even on direct SQL.
 for(const who of ['legacy','parent','hq']) await sqlDeny(()=>direct(who,ids.school,ctx=>runtime.query('SELECT hon.read_revenue_plan($1,\'LIST\',NULL,NULL)',[ctx.externalSubject])));
 await sqlDeny(()=>direct('sibling',ids.sibling,ctx=>runtime.query('SELECT hon.read_revenue_plan($1,\'SAVED\',$2,1)',[ctx.externalSubject,p.plan.id])),'P0002');
 // Closed metadata cannot bypass state at the actual restricted database boundary.
 for(const field of ['algorithmVersion','version','evidence','snapshotHash','validation','evidenceState']) await sqlDeny(()=>direct('planner',ids.school,ctx=>runtime.query('SELECT hon.save_revenue_plan($1,NULL,$2::jsonb,$3,$4,$5)',[ctx.externalSubject,JSON.stringify({...input(),[field]:'forged'}),ctx.idempotencyKey,ctx.requestId,ctx.correlationId])),'22023');
 for(const assumptions of [{trialToMembership:0.1234567},{trialToMembership:0.0000001},{leadToAppointment:1.000001},{newMembershipMonthlyMinor:1000000000001},{activitiesPerLead:1001},{unknownRate:0.5}]) await sqlDeny(()=>direct('planner',ids.school,ctx=>runtime.query('SELECT hon.save_revenue_plan($1,NULL,$2::jsonb,$3,$4,$5)',[ctx.externalSubject,JSON.stringify(input(assumptions)),ctx.idempotencyKey,ctx.requestId,ctx.correlationId])),'22023');
 for(const version of [0,1000000000]) await sqlDeny(()=>direct('planner',ids.school,ctx=>runtime.query('SELECT hon.read_revenue_plan($1,\'SAVED\',$2,$3)',[ctx.externalSubject,p.plan.id,version])),'22023');
 const zero=(await svc.save(c(),null,{...input({}),targetMonthlyMinor:0})).projection;assert(Object.values(zero.funnel).every(q=>q.required===0&&q.status==='NOT_REQUIRED'));
 const zeroRate=(await svc.save(c(),null,input({newMembershipMonthlyMinor:10000,trialToMembership:0,appointmentToTrial:1,leadToAppointment:1,activitiesPerLead:0}))).projection;assert.equal(zeroRate.funnel.trials.status,'ZERO_DENOMINATOR');assert.equal(zeroRate.funnel.leads.required,null);
 const zeroPrice=(await svc.save(c(),null,input({newMembershipMonthlyMinor:0}))).projection;assert.equal(zeroPrice.funnel.memberships.status,'ZERO_DENOMINATOR');
 const baselineAssumption=(await svc.save(c(),null,{...input(),baselineMethod:'ZERO_BASELINE'})).projection;assert.equal(baselineAssumption.baseline.source,'HUMAN_ZERO_ASSUMPTION');assert.equal(baselineAssumption.evidence.eligibleMonthlyMinor,50000);
 const concurrencyContext=c(),updates=await Promise.all([svc.save(concurrencyContext,p.plan.id,{...input(),expectedVersion:1}),svc.save(concurrencyContext,p.plan.id,{...input(),expectedVersion:1})]);assert.equal(updates.filter(x=>!x.replayed).length,1);assert.deepEqual(updates[0].projection,updates[1].projection);
 const races=await Promise.allSettled([svc.save(c(),p.plan.id,{...input(),expectedVersion:2}),svc.save(c(),p.plan.id,{...input(),expectedVersion:2})]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(races.find(x=>x.status==='rejected').reason.getStatus(),409);
 const current=await svc.read(c(),p.plan.id);assert.equal(current.plan.version,3);assert.equal(current.evidenceState,'LIVE');assert.equal(p.evidenceState,'SAVED');assert.deepEqual(await svc.read(c(),p.plan.id,1),p);
 // Changes to live schedules must change captured evidence, not revision 1/hash.
 await admin.query('UPDATE hon.membership_payment_schedules SET amount_minor=10001 WHERE membership_id=$1',[memberships[0].m]);
 const changed=await svc.read(c(),p.plan.id);assert.equal(changed.evidence.eligibleMonthlyMinor,50001);assert.equal(changed.signals.newMembershipMonthlyMinor.numerator,50001);assert.equal(changed.signals.newMembershipMonthlyMinor.denominator,5);assert.notEqual(changed.snapshotHash,p.snapshotHash);assert.deepEqual(await svc.read(c(),p.plan.id,1),p);
 await admin.query('UPDATE hon.membership_payment_schedules SET amount_minor=10000 WHERE membership_id=$1',[memberships[0].m]);
 // Exclusion rules must be observed, not normalize annual schedules or currencies.
 for(const [apply,restore] of [
  ["UPDATE hon.membership_payment_schedules SET auto_renew=false WHERE membership_id=$1","UPDATE hon.membership_payment_schedules SET auto_renew=true WHERE membership_id=$1"],
  ["UPDATE hon.membership_payment_schedules SET currency='EUR' WHERE membership_id=$1","UPDATE hon.membership_payment_schedules SET currency='USD' WHERE membership_id=$1"],
  ["UPDATE hon.memberships SET term_ends_at=clock_timestamp()-interval '1 hour' WHERE id=$1","UPDATE hon.memberships SET term_ends_at=NULL WHERE id=$1"],
 ]) {await admin.query(apply,[memberships[0].m]);const excluded=await svc.read(c(),p.plan.id);assert.equal(excluded.evidence.eligibleMemberships,4);assert.equal(excluded.evidence.excludedMemberships,3);assert.equal(excluded.signals.newMembershipMonthlyMinor.source,'UNAVAILABLE');await admin.query(restore,[memberships[0].m]);}
 const duplicateSchedule=(await admin.query("INSERT INTO hon.membership_payment_schedules(organization_id,school_id,membership_id,frequency,amount_minor,currency,auto_renew) VALUES($1,$2,$3,'MONTHLY',10000,'USD',true) RETURNING id",[ids.org,ids.school,memberships[0].m])).rows[0].id;
 assert.equal((await svc.read(c(),p.plan.id)).evidence.eligibleMemberships,4);await admin.query('DELETE FROM hon.membership_payment_schedules WHERE id=$1',[duplicateSchedule]);
 // An unresolved/repeated trial disables historical signals, never replaces saved evidence.
 const duplicate=randomUUID();await admin.query("INSERT INTO hon.crm_appointments(id,organization_id,school_id,crm_lead_id,appointment_type,status,starts_at,ends_at,created_by_principal_id) VALUES($1,$2,$3,$4,'TRIAL','SCHEDULED','2026-01-04T00:00:00Z','2026-01-04T01:00:00Z',$5)",[duplicate,ids.org,ids.school,mainLeads[0],humans.planner.id]);
 const ambiguous=await svc.read(c(),p.plan.id);assert.equal(ambiguous.evidence.ambiguousTrialLeads,1);assert.equal(ambiguous.signals.leadToAppointment.source,'UNAVAILABLE');assert.deepEqual(await svc.read(c(),p.plan.id,1),p);await admin.query('DELETE FROM hon.crm_appointments WHERE id=$1',[duplicate]);
 await sqlDeny(()=>runtime.query('SELECT hon.read_revenue_plan($1,\'CURRENT\',$2,NULL)',[humans.planner.subject,p.plan.id]));
 await runtime.query('BEGIN');await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','AI',true)",[ids.org,ids.school,humans.planner.id]);await sqlDeny(()=>runtime.query('SELECT hon.read_revenue_plan($1,\'CURRENT\',$2,NULL)',[humans.planner.subject,p.plan.id]));await runtime.query('ROLLBACK');assert.equal((await runtime.query('SELECT hon.current_school_id() id')).rows[0].id,null);
 // Accidental table grants cannot bypass deny-all forced RLS on actual runtime.
 for(const t of privateTables){
  await admin.query(`GRANT SELECT,INSERT ON hon.${t} TO ${runtimeRole}`);
  try {assert.equal((await direct('planner',ids.school,()=>runtime.query(`SELECT count(*) n FROM hon.${t}`))).rows[0].n,'0');
   if(t==='revenue_plans') {
    // Normally the invoker guard also lacks validator EXECUTE. Temporarily
    // permit that helper to prove the independent deny-all RLS write boundary.
    await admin.query(`GRANT EXECUTE ON FUNCTION hon.validate_revenue_plan_input(jsonb) TO ${runtimeRole}`);
    try {await assert.rejects(()=>direct('planner',ids.school,()=>runtime.query("INSERT INTO hon.revenue_plans(organization_id,school_id,version,algorithm_version,input) VALUES($1,$2,1,'school-revenue-v1',$3)",[ids.org,ids.school,JSON.stringify(p.plan.input)])),e=>{assert.equal(e.code,'42501');assert.match(e.message,/row-level security/);return true;});}
    finally{await admin.query(`REVOKE EXECUTE ON FUNCTION hon.validate_revenue_plan_input(jsonb) FROM ${runtimeRole}`);}
   }
   if(t==='revenue_plan_versions') await sqlDeny(()=>direct('planner',ids.school,ctx=>runtime.query("INSERT INTO hon.revenue_plan_versions(plan_id,organization_id,school_id,version,actor_principal_id,source,request_id,snapshot) VALUES($1,$2,$3,99,$4,'HUMAN_UI',$5,'{}')",[p.plan.id,ids.org,ids.school,ctx.principalId,ctx.requestId])));
   if(t==='revenue_plan_requests') await sqlDeny(()=>direct('planner',ids.school,ctx=>runtime.query("INSERT INTO hon.revenue_plan_requests(organization_id,school_id,principal_id,idempotency_key,fingerprint,response) VALUES($1,$2,$3,'direct','direct','{}')",[ids.org,ids.school,ctx.principalId])));
  }finally{await admin.query(`REVOKE SELECT,INSERT ON hon.${t} FROM ${runtimeRole}`);}await sqlDeny(()=>admin.query(`TRUNCATE hon.${t} CASCADE`));
 }
 for(const f of ['hon.revenue_plan_snapshot','hon.require_revenue_planning_actor']) await sqlDeny(()=>direct('planner',ids.school,()=>runtime.query(`SELECT ${f}($1)`,[f.endsWith('snapshot')?p.plan.id:humans.planner.subject])));

 for(const t of ['revenue_plan_versions','revenue_plan_requests'])await sqlDeny(()=>admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ids.org]));
 // Injected audit/outbox failures roll back plan, revision, replay and both evidence tables.
 for(const table of ['audit_events','outbox_events']){
  await admin.query(`CREATE FUNCTION hon.revenue_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'revenue fixture rollback'; END IF; RETURN NEW; END $$`);await admin.query(`CREATE TRIGGER revenue_fixture_failure BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.revenue_fixture_failure()`);injected=true;
  const tables=[...privateTables,'audit_events','outbox_events'],prior=await snapshot(tables);await assert.rejects(()=>svc.save(c(),p.plan.id,{...input(),expectedVersion:3}),/revenue fixture rollback/);assert.deepEqual(await snapshot(tables),prior);
  await admin.query(`DROP TRIGGER revenue_fixture_failure ON hon.${table}`);await admin.query('DROP FUNCTION hon.revenue_fixture_failure()');injected=false;
 }
 for(const mutation of [
  ['UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.planner.id],'UPDATE hon.principals SET is_active=true WHERE id=$1'],
  ["DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='planning.revenue.manage'",[ids.role],"INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,'"+ids.org+"','planning.revenue.manage')"],
  ['UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1',[humans.planner.id],'UPDATE hon.principal_role_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE principal_id=$1'],
  ["UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[ids.school],"UPDATE hon.schools SET status='ACTIVE' WHERE id=$1"],
  ["UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1",[ids.org],"UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1"],
  ["UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.org],"UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1"],
 ]){await admin.query(mutation[0],mutation[1]);await deny(()=>svc.save(original,null,input()));await deny(()=>svc.read(c(),p.plan.id,1));await admin.query(mutation[2],mutation[1]);}
 const duplicatePrincipal=randomUUID();await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Ambiguous')",[duplicatePrincipal,humans.planner.user]);await deny(()=>svc.list(c()));await admin.query('DELETE FROM hon.principals WHERE id=$1',[duplicatePrincipal]);
 await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '300 milliseconds' WHERE principal_id=$1",[humans.planner.id]);await admin.query('BEGIN');await admin.query('SELECT 1 FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);const waited=svc.save(original,null,input()).then(value=>({value}),error=>({error}));await new Promise(r=>setTimeout(r,450));await admin.query('COMMIT');assert.equal((await waited).error?.getStatus(),403);await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE principal_id=$1',[humans.planner.id]);
 for(const tier of ['CORE','COMPLETE']){await admin.query('UPDATE hon.organization_entitlements SET tier=$2 WHERE organization_id=$1',[ids.org,tier]);assert.equal((await svc.read(c(),p.plan.id)).plan.id,p.plan.id);}
 // The school cap and list bound are independent of a caller-supplied version.
 while((await svc.list(c('sibling',ids.sibling))).length<50) await svc.save(c('sibling',ids.sibling),null,{...input({}),targetMonthlyMinor:0});
 assert.equal((await svc.list(c('sibling',ids.sibling))).length,50);await deny(()=>svc.save(c('sibling',ids.sibling),null,input()),400);
 const audits=(await admin.query('SELECT prior_state,next_state FROM hon.audit_events WHERE organization_id=ANY($1::uuid[])',[orgs])).rows;assert.doesNotMatch(JSON.stringify(audits),/PRIVATE_|targetMonthly|currency|assumptions|eligibleMonthly|notes/);
 assert.deepEqual(await snapshot(forbidden),before,'No CRM, billing, payment, communication, AI, Action Engine, tasks or people mutations');
 assert.equal(await count('audit_events'),await count('revenue_plan_requests'));assert.equal(await count('outbox_events'),await count('revenue_plan_requests'));assert.equal(await count('revenue_plan_versions'),await count('revenue_plan_requests'));
 const out=(await admin.query('SELECT event_type,payload FROM hon.outbox_events WHERE organization_id=ANY($1::uuid[])',[orgs])).rows;assert(out.every(x=>x.event_type==='planning.revenue.human_saved'&&x.payload.internalOnly===true));assert.doesNotMatch(JSON.stringify(out),/PRIVATE_|targetMonthly|currency|assumptions|notes/);
 console.log('Verified deterministic human revenue plans: exact live school authority/all tiers, safe scoped evidence, assumptions and zero-denominator behavior, immutable saved snapshots, concurrency/replay, revocation/expiry after wait, ACL/RLS denial, atomic audit/inert outbox and zero forbidden effects.');
}finally{try{await cleanup();}finally{await Promise.all([admin.end(),runtime.end(),db.onModuleDestroy()]);}}
