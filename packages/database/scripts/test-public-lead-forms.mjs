import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';
import { PublicFormService } from '../../../apps/api/dist/marketing/public-form.service.js';
import { StaffPublicFormController } from '../../../apps/api/dist/marketing/public-form.controller.js';
import { CampaignService } from '../../../apps/api/dist/marketing/campaign.service.js';
import { LeadService } from '../../../apps/api/dist/crm/lead.service.js';
if (process.env.HON_CAMPAIGN_VALIDATION_TARGET !== 'postgresql://localhost:5432/hon_campaign_validation') throw new Error('Explicit disposable local validation target required.');
for (const [key,role] of [['DATABASE_URL','hon_campaign_owner'],['HON_RUNTIME_DATABASE_URL','hon_campaign_runtime']]) {
  const u = new URL(process.env[key] ?? 'https://invalid');
  if (u.hostname !== 'localhost' || u.port !== '5432' || u.pathname !== '/hon_campaign_validation' || u.username !== role) throw new Error('Exact disposable local campaign validation URLs required.');
}
const admin = new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false});
const runtime = new pg.Client({connectionString:process.env.HON_RUNTIME_DATABASE_URL,ssl:false});
const db = new RuntimeDatabaseService(), forms = new PublicFormService(db), campaigns = new CampaignService(db), leads = new LeadService(db), controller = new StaffPublicFormController(db,forms);
const id = Object.fromEntries(['org','otherOrg','school','sibling','otherSchool','pipeline','stage','siblingPipeline','siblingStage','otherPipeline','otherStage','role','limitedRole','otherRole'].map(k=>[k,randomUUID()]));
const humans = Object.fromEntries(['staff','limited','sibling','other','parent','hq'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`form-${k}-${randomUUID()}`} ]));
const c = (who='staff', school=id.school, key=randomUUID()) => ({organizationId: school===id.otherSchool?id.otherOrg:id.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',requestId:randomUUID(),correlationId:randomUUID(),idempotencyKey:key});
const config = (patch={}) => ({expectedVersion:0,title:'School enquiries',description:'Enquiry only',pipelineId:id.pipeline,pipelineStageId:id.stage,campaignId:null,optionalFields:['ageBand'],...patch});
const body = (patch={}) => ({name:'PRIVATE_NAME',email:'private@example.test',mobile:'',interest:'PRIVATE_INTEREST',source:'PRIVATE_SOURCE',website:'',acknowledged:true,ageBand:'ADULT',...patch});
const deny = (fn,status=403) => assert.rejects(async()=>fn(),e=>e.getStatus?.()===status);
const sqlDeny = fn => assert.rejects(fn,e=>e.code==='42501');
const submit = (form,input=body(),key=randomUUID()) => forms.submit(form.publicId,input,key);
const row = async (table,where,args) => (await admin.query(`SELECT * FROM hon.${table} WHERE ${where}`,args)).rows;
const count = async table => Number((await admin.query(`SELECT count(*) n FROM hon.${table} WHERE organization_id=ANY($1::uuid[])`,[[id.org,id.otherOrg]])).rows[0].n);
const primary = ['people','crm_leads','crm_lead_attributions','public_lead_forms','public_lead_form_receipts','audit_events','outbox_events'];
const countTables = async tables => { const result = {}; for (const table of tables) result[table] = await count(table); return result; };
const counts = () => countTables(primary);
const noEffects = ['communication_consents','communication_messages','crm_appointments','class_bookings','attendance_records','memberships','membership_payment_schedules','billing_accounts','invoices','payment_attempts','action_requests','action_approvals','ai_usage_ledger','ai_invocation_plans','work_items','crm_activities','student_profiles','outbox_delivery_attempts'];
let injection;
await admin.connect(); await runtime.connect();
try {
  await admin.query('BEGIN');
  for (const org of [id.org,id.otherOrg]) {
    await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Form fixture','Form fixture')",[org]);
    await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'ESSENTIAL',clock_timestamp()-interval '1 day')",[org]);
  }
  for (const [school,org] of [[id.school,id.org],[id.sibling,id.org],[id.otherSchool,id.otherOrg]]) await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,'Fixture',$1::text)",[school,org]);
  for (const h of Object.values(humans)) {
    await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY')",[h.id,h.user]);
  }
  for (const [role,org] of [[id.role,id.org],[id.limitedRole,id.org],[id.otherRole,id.otherOrg]]) {
    await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1::uuid,$2,$1::text,'Fixture')",[role,org]);
    await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE ($1::uuid=$3::uuid AND code='marketing.form.configure') OR ($1::uuid<>$3::uuid AND (code LIKE 'marketing.%' OR code LIKE 'crm.%'))",[role,org,id.limitedRole]);
  }
  for (const [who,role,org,school] of [['staff',id.role,id.org,id.school],['limited',id.limitedRole,id.org,id.school],['sibling',id.role,id.org,id.sibling],['other',id.otherRole,id.otherOrg,id.otherSchool]]) await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",[org,school,humans[who].id,role]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['marketing.form.read','marketing.form.configure'],clock_timestamp()-interval '1 day')",[humans.hq.id]);
  const family=randomUUID(); await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Fixture')",[family,id.org,id.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',$5,clock_timestamp()-interval '1 day')",[id.org,id.school,family,humans.parent.id,humans.staff.id]);
  for (const [pipeline,stage,org,school] of [[id.pipeline,id.stage,id.org,id.school],[id.siblingPipeline,id.siblingStage,id.org,id.sibling],[id.otherPipeline,id.otherStage,id.otherOrg,id.otherSchool]]) {
    await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Fixture')",[pipeline,org,school]);
    await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)",[stage,org,school,pipeline]);
  }
  await admin.query('COMMIT');
  const effectsBefore = await countTables(noEffects);
  for (const who of ['parent','hq']) { await deny(()=>forms.list(c(who))); await deny(()=>controller.list({honIdentity:{externalSubject:humans[who].subject}})); }
  await deny(()=>forms.list(c('limited'))); await deny(()=>forms.mutate(c('limited'),'configure',null,config({campaignId:randomUUID()})));
  const useful = (await forms.mutate(c('limited'),'configure',null,config())).form; assert.equal(useful.status,'DRAFT');
  await deny(()=>forms.mutate(c('limited'),'publish',useful.id,{expectedVersion:1}));
  for (const patch of [{source:'PUBLIC_API'},{source:'AI'},{principalType:'AI_EMPLOYEE'},{principalType:'AUTOMATION'},{principalType:'INTEGRATION'},{actionRequestId:randomUUID()},{delegatedByPrincipalId:randomUUID()}]) await deny(()=>forms.list({...c(),...patch}));
  for (const patch of [{pipelineStageId:id.siblingStage},{pipelineId:id.otherPipeline},{campaignId:randomUUID()},{optionalFields:['medicalNotes']},{optionalFields:['ageBand','ageBand']},{title:'=FORMULA'},{description:'Line\nBreak'},{actorId:humans.staff.id}]) await deny(()=>forms.mutate(c(),'configure',null,config(patch)),400);
  const ci = {expectedVersion:0,code:'FORM_'+randomUUID().slice(0,8).toUpperCase(),name:'Fixture campaign',goal:'Human plan',offerLabel:'',channel:'WEBSITE',startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2026-02-01T00:00:00.000Z',plannedBudgetMinor:0,currency:'USD'};
  const campaignDraft = (await campaigns.save(c(),null,ci)).campaign;
  await deny(()=>forms.mutate(c(),'configure',null,config({campaignId:campaignDraft.id})),400);
  const active = (await campaigns.status(c(),campaignDraft.id,{expectedVersion:1,status:'ACTIVE'})).campaign;
  await deny(()=>forms.mutate(c('sibling',id.sibling),'configure',null,config({pipelineId:id.siblingPipeline,pipelineStageId:id.siblingStage,campaignId:active.id})),400);
  await deny(()=>forms.mutate(c('other',id.otherSchool),'configure',null,config({pipelineId:id.otherPipeline,pipelineStageId:id.otherStage,campaignId:active.id})),400);
  const ctx=c(),input=config({campaignId:active.id});
  const draft=(await forms.mutate(ctx,'configure',null,input)).form;
  assert.match(draft.publicId,/^[a-f0-9]{48}$/); assert((await forms.mutate(ctx,'configure',null,input)).replayed);
  await deny(()=>forms.mutate(ctx,'configure',null,{...input,title:'Changed'}),409);
  assert.equal(await forms.published(draft.publicId),null); assert.equal(await submit(draft),'invalid');
  assert.equal(await forms.submit('f'.repeat(48),body(),randomUUID()),'invalid');
  const publishCtx=c(); const f=(await forms.mutate(publishCtx,'publish',draft.id,{expectedVersion:1})).form;
  assert((await forms.mutate(publishCtx,'publish',draft.id,{expectedVersion:1})).replayed);
  const projection=await forms.published(f.publicId); assert.deepEqual(Object.keys(projection).sort(),['description','optionalFields','publicId','title']);
  await deny(()=>forms.mutate(c(),'configure',f.id,config({expectedVersion:2})),400);
  const badBodies=[{actorId:humans.staff.id},{organizationId:id.otherOrg},{schoolId:id.sibling},{formId:randomUUID()},{campaignId:active.id},{name:'x'.repeat(121)},{email:'x'.repeat(255)},{mobile:'+123'},{interest:'x'.repeat(81)},{source:'x'.repeat(81)},{name:'=IMPORTXML(1)'},{source:' +SUM(1)'},{name:'Line\nBreak'},{name:'Control\u0001'},{name:'Bidi\u202e'},{name:{}},{email:12},{acknowledged:'true'},{website:'bot'},{ageBand:'PRIVATE_CUSTOM'},{experience:'NEW'},{email:'',mobile:''}];
  const baseline=await counts();
  for (const patch of badBodies) assert.equal(await submit(f,body(patch)),'invalid',JSON.stringify(patch));
  assert.deepEqual(await counts(),baseline);
  for (const patch of [{source:'\u00a0=SUM(1)'},{name:'\u3000+FORMULA'},{schoolId:id.otherSchool},{experience:'NEW'},{acknowledged:'true'}]) assert.equal((await runtime.query('SELECT hon.submit_public_form($1,$2::jsonb,$3) result',[f.publicId,JSON.stringify(body(patch)),randomUUID()])).rows[0].result,'INVALID');
  assert.deepEqual(await counts(),baseline);
  const key=randomUUID(); assert.equal(await submit(f,body(),key),'accepted');
  const afterFirst=await counts();
  assert.equal(await submit(f,body(),key),'accepted'); const aliasKey=randomUUID(); assert.equal(await submit(f,body(),aliasKey),'accepted'); assert.equal(await submit(f,body({name:'Alias changed'}),aliasKey),'invalid');
  assert.equal(await submit(f,body({name:'Changed'}),key),'invalid'); assert.deepEqual(await counts(),{...afterFirst,public_lead_form_receipts:afterFirst.public_lead_form_receipts+1});
  const receipt=(await row('public_lead_form_receipts','form_id=$1',[f.id]))[0];
  const lead=(await row('crm_leads','id=$1',[receipt.lead_id]))[0], attribution=(await row('crm_lead_attributions','lead_id=$1',[lead.id]))[0];
  assert.equal(lead.organization_id,id.org); assert.equal(lead.school_id,id.school); assert.equal(lead.source_code,'PUBLIC_API'); assert.equal(lead.program_interest_code,'PRIVATE_INTEREST');
  assert.equal(attribution.campaign_id,active.id); assert.equal(attribution.campaign_version,2); assert.deepEqual(attribution.campaign_snapshot,active); assert.equal(attribution.source_facts.acknowledged,true);
  assert.equal(attribution.source_facts.publicForm.version,2); assert.equal(attribution.source_facts.sourceDetail,'PRIVATE_SOURCE');
  assert(!JSON.stringify(receipt).includes('PRIVATE_NAME')); assert(!JSON.stringify(receipt).includes('private@example.test')); assert(!JSON.stringify(receipt).includes(key));
  const service='00000000-0000-4000-8000-000000000075';
  const audit=(await row('audit_events',"entity_id=$1 AND source='PUBLIC_API'",[lead.id]))[0]; assert.equal(audit.actor_principal_id,service); assert.equal(audit.action_request_id,null); assert.equal(audit.delegated_by_principal_id,null);
  assert.equal((await admin.query('SELECT count(*) n FROM hon.principal_role_grants WHERE principal_id=$1',[service])).rows[0].n,'0');
  for (const table of ['audit_events','outbox_events']) { const evidence=JSON.stringify(await row(table,'organization_id=$1',[id.org])); assert.doesNotMatch(evidence,/PRIVATE_NAME|PRIVATE_INTEREST|PRIVATE_SOURCE|private@example\.test|PRIVATE_DIRECTORY/); }
  assert.equal((await row('outbox_events','aggregate_id=$1',[lead.id]))[0].event_type,'marketing.form.lead_received');
  // Ordinary existing-contact creation is independent. A different enquiry NEVER merges.
  const normal=(await leads.create(c(),{pipelineId:id.pipeline,pipelineStageId:id.stage,primaryContact:{givenName:'PRIVATE_NAME',familyName:'',email:'private@example.test'}})).lead;
  assert.equal(await submit(f,body({interest:'Second enquiry'})),'accepted');
  const second=(await row('crm_leads',"id<>$1 AND id<>$2 AND source_code='PUBLIC_API' AND school_id=$3",[lead.id,normal.id,id.school]))[0]; assert(second); assert.notEqual(second.primary_person_id,normal.primaryPersonId);
  for (const assignment of ["source_code='Other'","attribution='{}'","created_at=clock_timestamp()"]) await sqlDeny(()=>admin.query(`UPDATE hon.crm_leads SET ${assignment} WHERE id=$1`,[lead.id]));
  await sqlDeny(()=>admin.query('DELETE FROM hon.crm_lead_attributions WHERE lead_id=$1',[lead.id]));
  const paused=(await campaigns.status(c(),active.id,{expectedVersion:2,status:'PAUSED'})).campaign;
  assert.equal(await submit(f,body(),key),'invalid'); assert.equal(await forms.published(f.publicId),null); assert.deepEqual((await row('crm_lead_attributions','lead_id=$1',[lead.id]))[0],attribution);
  await campaigns.status(c(),active.id,{expectedVersion:paused.version,status:'ACTIVE'});
  // Both contact identities limit even when the other identity is rotated.
  for (let n=0;n<5;n++) assert.equal(await submit(f,body({email:'shared@example.test',mobile:`+1555000000${n}`,interest:`Attempt ${n}`})),'accepted');
  assert.equal(await submit(f,body({email:'shared@example.test',mobile:'+15550000009',interest:'Attempt 6'})),'rate-limited');
  for (let n=0;n<5;n++) assert.equal(await submit(f,body({email:`rotated${n}@example.test`,mobile:'+15559999999',interest:`Mobile ${n}`})),'accepted');
  assert.equal(await submit(f,body({email:'rotated6@example.test',mobile:'+15559999999',interest:'Mobile 6'})),'rate-limited');
  await admin.query("UPDATE hon.public_lead_form_rates SET attempts=200 WHERE form_id=$1 AND bucket='FORM_ACCEPTS'",[f.id]);
  assert.equal(await submit(f,body({email:'global@example.test'})),'rate-limited');
  await admin.query("UPDATE hon.public_lead_form_rates SET window_start=clock_timestamp()-interval '2 hours' WHERE form_id=$1",[f.id]);
  assert.equal(await submit(f,body({email:'global@example.test'})),'accepted');
  // Concurrent exact duplicate POSTs create one new lead, with no internal state returned.
  const concurrentBefore=await count('crm_leads'); const same=body({email:'concurrent@example.test'}), sameKey=randomUUID();
  assert.deepEqual(await Promise.all([submit(f,same,sameKey),submit(f,same,sameKey)]),['accepted','accepted']); assert.equal(await count('crm_leads'),concurrentBefore+1);
  // Audit/outbox failure rolls back person, lead, attribution, receipt and counts. Errors contain no PII.
  for (const table of ['audit_events','outbox_events']) {
    const before=await counts();
    await admin.query(`CREATE OR REPLACE FUNCTION hon.form_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${id.org}'::uuid THEN RAISE EXCEPTION 'PRIVATE_NAME private@example.test'; END IF; RETURN NEW; END $$; CREATE TRIGGER form_fixture_failure BEFORE INSERT ON hon.${table} FOR EACH ROW EXECUTE FUNCTION hon.form_fixture_failure()`); injection=table;
    assert.equal(await submit(f,body({email:`failure-${table}@example.test`})),'unavailable'); assert.deepEqual(await counts(),before);
    await admin.query(`DROP TRIGGER form_fixture_failure ON hon.${table}`); injection=null;
  }
  await admin.query('DROP FUNCTION hon.form_fixture_failure()');
  // Lifecycle optimistic race: only one disable succeeds. Disabled/unknown both generically deny replay.
  const race=await Promise.allSettled([forms.mutate(c(),'disable',f.id,{expectedVersion:2}),forms.mutate(c(),'disable',f.id,{expectedVersion:2})]); assert.equal(race.filter(x=>x.status==='fulfilled').length,1); assert.equal(race.find(x=>x.status==='rejected').reason.getStatus(),409);
  assert.equal(await submit(f,body(),key),'invalid'); assert.equal(await forms.published(f.publicId),null);
  const disabled=race.find(x=>x.status==='fulfilled').value.form;
  const edited=(await forms.mutate(c(),'configure',f.id,config({expectedVersion:disabled.version,title:'Revised form',campaignId:active.id}))).form;
  assert.equal(edited.publicId,f.publicId); assert.deepEqual((await row('crm_lead_attributions','lead_id=$1',[lead.id]))[0],attribution);
  await forms.mutate(c(),'publish',f.id,{expectedVersion:edited.version});
  const read=await forms.list(c()); assert.equal(read.find(x=>x.id===f.id).acceptedCount,Number((await admin.query('SELECT count(DISTINCT lead_id) n FROM hon.public_lead_form_receipts WHERE form_id=$1',[f.id])).rows[0].n)); assert(!JSON.stringify(read).includes('PRIVATE_NAME')); assert(!JSON.stringify(read).includes('hash_secret'));
  // Campaign is optional, not client-supplied or fabricated. Quotes remain data.
  const plain=(await forms.mutate(c(),'publish',useful.id,{expectedVersion:1})).form;
  assert.equal(await submit(plain,body({name:"Robert'); DROP TABLE hon.organizations; --",email:'injection@example.test'})),'accepted');
  const plainReceipt=(await row('public_lead_form_receipts','form_id=$1',[plain.id]))[0];
  const plainAttribution=(await row('crm_lead_attributions','lead_id=$1',[plainReceipt.lead_id]))[0]; assert.equal(plainAttribution.campaign_id,null); assert.equal(plainAttribution.campaign_snapshot,null);
  assert.equal((await row('people','id=(SELECT primary_person_id FROM hon.crm_leads WHERE id=$1)',[plainReceipt.lead_id]))[0].given_name,"Robert'); DROP TABLE hon.organizations; --");
  assert.equal((await row('organizations','id=$1',[id.org])).length,1);
  await deny(()=>forms.list({...c(),externalSubject:humans.other.subject})); await deny(()=>forms.list(c('staff',id.sibling)));
  for (const table of ['organizations','schools']) {
    const target=table==='organizations'?id.org:id.school;
    await admin.query(`UPDATE hon.${table} SET status='SUSPENDED' WHERE id=$1`,[target]);
    assert.equal(await submit(f,body(),key),'invalid'); assert.equal(await forms.published(f.publicId),null);
    await admin.query(`UPDATE hon.${table} SET status='ACTIVE' WHERE id=$1`,[target]);
  }
  await admin.query("UPDATE hon.crm_pipeline_stages SET terminal_status='WON' WHERE id=$1",[id.stage]);
  assert.equal(await submit(f,body(),key),'invalid'); assert.equal(await forms.published(f.publicId),null);
  await admin.query('UPDATE hon.crm_pipeline_stages SET terminal_status=NULL WHERE id=$1',[id.stage]);
  // Exact permission revocation denies fresh commands and unchanged staff replay.
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketing.form.publish'",[id.role]); await deny(()=>forms.mutate(publishCtx,'publish',draft.id,{expectedVersion:1}));
  await admin.query("INSERT INTO hon.role_permissions VALUES($1,$2,'marketing.form.publish')",[id.role,id.org]);
  await admin.query('UPDATE hon.principal_role_grants SET revoked_at=clock_timestamp(),revoked_by_principal_id=principal_id WHERE principal_id=$1',[humans.limited.id]); await deny(()=>forms.mutate(c('limited'),'configure',null,config()));
  // Observe an actual organization lock wait, revoke before release, require post-wait denial.
  await admin.query('BEGIN'); const blocker=(await admin.query('SELECT pg_backend_pid() pid')).rows[0].pid; await admin.query('SELECT id FROM hon.organizations WHERE id=$1 FOR UPDATE',[id.org]);
  const waiting=forms.list(c()).then(value=>({value}),error=>({error})); const probe=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:false}); await probe.connect();
  let blocked=false; const deadline=Date.now()+2000; while(Date.now()<deadline) { blocked=(await probe.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[blocker])).rows[0].blocked; if(blocked) break; await new Promise(resolve=>setTimeout(resolve,10)); } assert(blocked);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='marketing.form.read'",[id.role]); await admin.query('COMMIT'); assert.equal((await waiting).error.getStatus(),403); await probe.end();
  await admin.query("INSERT INTO hon.role_permissions VALUES($1,$2,'marketing.form.read')",[id.role,id.org]);
  // Direct private data writes/helpers and forged ingress GUCs cannot authorize public lead creation.
  for (const table of ['public_lead_forms','public_lead_form_versions','public_lead_form_requests','public_lead_form_receipts','public_lead_form_rates','users','principals','roles','permissions','role_permissions','principal_role_grants','family_access_grants','organizations','schools','hq_operator_grants','hq_ai_provider_connections','hq_ai_control_requests','crm_activities']) {
    await sqlDeny(()=>runtime.query(`SELECT * FROM hon.${table}`)); assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(current_user,$1,'INSERT,UPDATE') allowed",[`hon.${table}`])).rows[0].allowed,false);
  }
  await sqlDeny(()=>runtime.query('SELECT hon.create_public_form_lead($1,$2,$3::jsonb,$4)',[f.id,randomUUID(),JSON.stringify(body()),randomUUID()]));
  for (const [sql,args] of [['SELECT hon.public_form_staff_summary($1)',[f.id]],['SELECT hon.take_public_form_rate($1,$2,$3)',[f.id,'FORGED',1]],['SELECT hon.validate_public_form_submission($1::jsonb,$2::jsonb)',[JSON.stringify(body()),'["ageBand"]']]]) await sqlDeny(()=>runtime.query(sql,args));
  await runtime.query('BEGIN');
  await runtime.query("SELECT set_config('app.hon_principal_id','00000000-0000-4000-8000-000000000075',true),set_config('app.hon_principal_type','SYSTEM_SERVICE',true),set_config('app.hon_source','PUBLIC_API',true)");
  await sqlDeny(()=>runtime.query('SELECT hon.create_public_form_lead($1,$2,$3::jsonb,$4)',[f.id,randomUUID(),JSON.stringify(body()),randomUUID()])); await runtime.query('ROLLBACK');
  await sqlDeny(()=>leads.create(c(),{pipelineId:id.pipeline,pipelineStageId:id.stage,primaryContact:{givenName:'Forge',familyName:''},attribution:{publicForm:'forged'}}).catch(e=>{ if(e.getStatus?.()===403) throw {code:'42501'}; throw e; }));
  await admin.query('UPDATE hon.organization_entitlements SET status=\'INACTIVE\' WHERE organization_id=$1',[id.org]).catch(async()=>{ await admin.query('UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1',[id.org]); });
  assert.equal(await submit(f),'invalid');
  assert.deepEqual(await countTables(noEffects),effectsBefore);
  assert.equal((await admin.query("SELECT count(*) n FROM pg_trigger WHERE tgenabled='D' AND tgrelid IN('hon.public_lead_forms'::regclass,'hon.crm_leads'::regclass,'hon.crm_lead_attributions'::regclass)")).rows[0].n,'0');
  console.log('Public form integration passed: exact human scope/lifecycle/revocation/lock waits, active campaign derivation, validation/honeypot, bounded contact/form rate controls, replay/duplicate races, no merge, immutable attribution, redaction, atomic rollback, no consent/messages/billing/AI/actions, private RLS/helper denial.');
} finally {
  await admin.query('ROLLBACK');
  if(injection) await admin.query(`DROP TRIGGER IF EXISTS form_fixture_failure ON hon.${injection}`);
  await admin.query('DROP FUNCTION IF EXISTS hon.form_fixture_failure()');
  await runtime.end(); await admin.end(); await db.onModuleDestroy();
}
