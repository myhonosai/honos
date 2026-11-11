import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// B6A behavioural entitlement-enforcement coverage. Every function the runtime role can execute is called, as
// the runtime role, by an owner holding every permission at their school, for two otherwise identical
// organizations: one with an ACTIVE Complete entitlement and one SUSPENDED. Arguments are filled from the
// parameter names (subject, school, organization, principal); anything else is NULL or an unknown id. Each
// call runs in a rolled-back savepoint, so nothing persists. Outcomes:
//   ENFORCED            the suspended call is refused where the active call is not, or refused differently
//   OPEN_BY_DESIGN      both succeed and the function is on the reviewed allowlist (billing recovery, settings, ...)
//   OPEN_KNOWN_GAP      both succeed and the function is a reviewed gap (none remain after 0172)
//   NOT_REACHED         both refused identically before any entitlement decision (needs richer input)
// The proof fails on any OPEN function that is neither allowlisted nor a recorded gap, and when an allowlisted
// recovery path stops working for a suspended school. Disposable localhost database only.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost validation URLs permitted; never remote DB.');
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
// D9 (0185): an HQ-owner exception carries its expiry and start in the entitlement window, so access must also end at
// the window's edges without anyone suspending the row. LAPSED is ACTIVE with an expired window, SCHEDULED is ACTIVE
// with a future start: every function that refuses the SUSPENDED school must refuse them too.
const orgs={ACTIVE:{id:randomUUID(),school:randomUUID(),role:randomUUID()},SUSPENDED:{id:randomUUID(),school:randomUUID(),role:randomUUID()},
 LAPSED:{id:randomUUID(),school:randomUUID(),role:randomUUID()},SCHEDULED:{id:randomUUID(),school:randomUUID(),role:randomUUID()}};
const humans=Object.fromEntries(Object.keys(orgs).map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`b6a-cov-${k}-${randomUUID()}`}]));

function args(f,k,target=k){
 const o=orgs[target],h=humans[k];
 return f.types.map((t,i)=>{
  const n=(f.names[i]??'').toLowerCase();
  if(t==='text'&&/subject/.test(n))return h.subject;
  if(t==='uuid'&&/school/.test(n))return o.school;
  if(t==='uuid'&&/org/.test(n))return o.id;
  if(t==='uuid'&&/principal|actor/.test(n))return h.id;
  if(t==='uuid')return '00000000-0000-4000-8000-00000000c0ff';
  if(t==='jsonb'||t==='json')return '{}';
  return null;
 });
}
// Reviewed: open to a suspended school on purpose. B6A keeps billing recovery and settings available.
const OPEN_BY_DESIGN={
 'hon.read_hon_os_registration(text)':'account identity (B-ID-5 0241): the signed-in owner sees the sign-up program, current terms and their own REGISTERED school before any access exists; read only, grants nothing',
 'hon.read_hon_os_trial(text)':'account identity (D11-B 0246): the registered owner sees the trial program, the public trial they may start and their own trial before any access exists; read only, grants nothing',
 'hon.read_school_ownership(text,uuid)':'account identity (B-ID-4 0223): a school owner sees co-owners, the primary owner and ownership notices, read only, even while the school is suspended or not yet paid',
 'hon.read_saas_school_billing_account(text,uuid)':'billing recovery: the school sees why access is unavailable and what it owes',
 'hon.read_saas_school_access_standing(text,uuid)':'billing recovery: the owner sees the payment issue, grace end, owner CRM read-only window or CRM lock (read only)',
 'hon.read_saas_school_plan_options(text,uuid)':'billing recovery: plan selection and checkout for the first or a renewed payment',
 'hon.read_saas_hon_os_offers_for_school(text,uuid)':'billing recovery: the published HON OS offers and the server eligibility decision for this school (read only)',
 'hon.read_my_language_preference(text,uuid)':'personal interface setting',
 'hon.read_school_language_default(text,uuid)':'interface setting; grants nothing',
 'hon.submit_public_form(text,jsonb,text)':'public intake route (owner: keep public routes available); B6B decides suspended-school intake',
 'hon.submit_kiosk_handoff(text,text)':'public kiosk route; B6B decides suspended-school behaviour',
 'hon.chad_follow_up_draft_is_current(uuid,jsonb)':'boolean predicate over ids; returns no data and grants nothing',
 'hon.crm_lead_target_is_current(uuid,uuid)':'boolean predicate over ids; returns no data and grants nothing',
 'hon.marketing_action_is_current(uuid,jsonb)':'boolean predicate over ids; returns no data and grants nothing',
 'hon.teaching_action_is_current(uuid,jsonb)':'boolean predicate over ids; returns no data and grants nothing',
 'hon.principal_has_school_permission(uuid,uuid,uuid,text)':'boolean permission predicate; grants nothing by itself',
 'hon.human_action_reviewer()':'returns the fixed reviewer identity; no school data',
};
// Reviewed gaps: none open. The six staff scope resolvers recorded here before (achievements, staff reporting,
// follow-ups, human work queue, teaching studio, testing registration review) are gated in 0172 and are now in
// MUST_ENFORCE. A new open function must be reviewed into OPEN_BY_DESIGN or gated; it cannot be parked here silently.
const OPEN_KNOWN_GAP={};
// Must stay refused for a suspended school (a regression that un-gates one of these fails the proof).
const MUST_ENFORCE=['hon.issue_champions_referral_code(text,uuid,uuid,uuid,uuid)','hon.read_champions_contests_for_school(text,uuid)',
 'hon.read_champions_school_rewards(text,uuid)','hon.read_champions_school_statistics(text,uuid)','hon.read_champions_school_view(text,uuid)',
 'hon.read_organization_operations_summary(text,uuid,timestamp with time zone,timestamp with time zone)','hon.read_saas_school_credits(text,uuid)',
 'hon.read_school_command_center(text,uuid,uuid)','hon.read_school_health_score(text,uuid,uuid)','hon.resolve_chad_follow_up_scope(text)',
 'hon.resolve_crm_lead_close_scope(text,uuid)','hon.resolve_instructor_qualification_scope(text)','hon.resolve_owner_launch_scope(text)',
 'hon.resolve_planned_absence_review_scope(text)','hon.resolve_renewal_scope(text)','hon.resolve_retention_review_scope(text,uuid)',
 'hon.resolve_teaching_assistant_scope(text)','hon.resolve_testing_certificate_scope(text,uuid)','hon.resolve_testing_scorecard_scope(text,uuid)',
 // Formerly recorded gaps, gated in 0172.
 'hon.resolve_achievement_scope(text,uuid)','hon.resolve_current_staff_reporting_scope(text)','hon.resolve_follow_up_scope(text)',
 'hon.resolve_human_work_scope(text)','hon.resolve_teaching_studio_scope(text,uuid)','hon.resolve_testing_registration_review_scopes(text)'];

async function call(f,k,target=k){
 const a=args(f,k,target);
 await restricted.query('SAVEPOINT s');
 try{
  const r=await restricted.query(`SELECT * FROM ${f.sig.replace(/\(.*$/,'')}(${a.map((_,i)=>`$${i+1}::${f.types[i]}`).join(',')}) v`,a);
  // No row, or only NULLs, is a refusal too (scope resolvers return nothing for an unauthorized subject).
  return r.rows.some(row=>Object.values(row).some(v=>v!==null))?'OK':'EMPTY';
 }
 catch(e){return `${e.code}:${String(e.message).slice(0,60)}`;}
 finally{await restricted.query('ROLLBACK TO SAVEPOINT s');}
}

await Promise.all([admin.connect(),restricted.connect()]);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 await admin.query('BEGIN');
 for(const[k,o]of Object.entries(orgs)){
  const h=humans[k];
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)",[h.id,h.user]);
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)",[o.id,`B6A Coverage Dojo ${k}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from,effective_until) VALUES($1,'COMPLETE',$2,$3::timestamptz,$4::timestamptz)",
   [o.id,k==='SUSPENDED'?'SUSPENDED':'ACTIVE',k==='SCHEDULED'?new Date(Date.now()+86_400_000):new Date(Date.now()-90*86_400_000),
    k==='LAPSED'?new Date(Date.now()-3_600_000):k==='SCHEDULED'?new Date(Date.now()+30*86_400_000):null]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/New_York')",[o.school,o.id,`School ${k}`]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true)",[o.role,o.id]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[o.role,o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')",[o.id,o.school,h.id,o.role]);
 }
 await admin.query('COMMIT');
 const fns=(await admin.query(`SELECT p.oid::regprocedure::text sig, p.proname, coalesce(p.proargnames,'{}') names,
   ARRAY(SELECT format_type(t,NULL) FROM unnest(p.proargtypes::oid[]) t) types
  FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.prokind='f' AND has_function_privilege('hon_champions_runtime',p.oid,'EXECUTE')
  ORDER BY 1`)).rows;
 const results=[];
 await restricted.query('BEGIN');
 for(const f of fns){
  const act=await call(f,'ACTIVE'),sus=await call(f,'SUSPENDED'),lapsed=await call(f,'LAPSED'),scheduled=await call(f,'SCHEDULED');
  const outcome=act==='OK'&&sus==='OK'?'OPEN':sus!=='OK'&&act!==sus?'ENFORCED':act==='OK'?'ENFORCED':'NOT_REACHED';
  results.push({sig:f.sig,outcome,act,sus,lapsed,scheduled});
 }
 await restricted.query('ROLLBACK');
 if(process.argv[2]==='--explore'){for(const r of results)console.log(`${r.outcome}\t${r.sig}\t${r.act}\t${r.sus}`);}
 const by=o=>results.filter(r=>r.outcome===o).map(r=>r.sig);
 const open=by('OPEN'),enforced=by('ENFORCED');
 const unreviewed=open.filter(s=>!(s in OPEN_BY_DESIGN)&&!(s in OPEN_KNOWN_GAP));
 assert.deepEqual(unreviewed,[],'functions open to a suspended school that nobody reviewed');
 assert.deepEqual(Object.keys(OPEN_BY_DESIGN).filter(s=>!open.includes(s)),[],'a reviewed recovery path no longer works for a suspended school (or was renamed)');
 assert.deepEqual(Object.keys(OPEN_KNOWN_GAP).filter(s=>!open.includes(s)),[],'a recorded gap changed: update OPEN_KNOWN_GAP');
 assert.deepEqual(MUST_ENFORCE.filter(s=>!enforced.includes(s)),[],'a gated function is no longer refused for a suspended school');
 // Outside its window an entitlement grants nothing a suspended one would not (D9 exception expiry and start).
 assert.deepEqual(results.filter(r=>r.outcome==='ENFORCED'&&(r.lapsed===r.act||r.scheduled===r.act)).map(r=>r.sig),[],
  'a function refused for a suspended school still answers an expired or not-yet-started entitlement');
 // Tenant isolation: the active school's owner never reaches the other organization through any reached function.
 await restricted.query('BEGIN');
 const cross=[];
 for(const f of fns.filter(f=>[...open,...enforced].includes(f.sig)&&f.names.some((n,i)=>f.types[i]==='uuid'&&/school|org/.test(n??''))&&f.names.some(n=>/subject/.test(n??''))))
  if(await call(f,'ACTIVE','SUSPENDED')==='OK')cross.push(f.sig);
 await restricted.query('ROLLBACK');
 assert.deepEqual(cross,[],'a school owner reached another organization');
 console.log(`PASS: B6A entitlement enforcement coverage — ${fns.length} runtime-callable functions called as an all-permission school owner for an ACTIVE, a SUSPENDED, an expired-window and a future-window organization: ${enforced.length} refuse the suspended school (and both windows), ${open.length-Object.keys(OPEN_KNOWN_GAP).length} stay open by reviewed design (billing recovery, settings, public intake, predicates), ${Object.keys(OPEN_KNOWN_GAP).length} recorded gaps, ${by('NOT_REACHED').length} refused identically before any entitlement decision with generic input (covered by the static inventory); no cross-organization access.`);
}finally{
 await restricted.query('ROLLBACK').catch(()=>{});
 await admin.query('ROLLBACK').catch(()=>{});
 const ids=Object.values(orgs).map(o=>o.id);
 for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements','schools'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[ids]).catch(e=>console.error(e.message));
 await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[ids]).catch(e=>console.error(e.message));
 await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]).catch(e=>console.error(e.message));
 await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]).catch(e=>console.error(e.message));
 await Promise.allSettled([admin.end(),restricted.end()]);
}
