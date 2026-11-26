/** 0680 a membership becomes active when its agreement is signed. The public signing link (0499) on the restricted runtime role,
 * as the API calls it (one transaction, the same lock and statement timeouts), against the marked disposable Champions Club
 * fixture. Synthetic names only; nothing is charged, scheduled or sent. */
import assert from 'node:assert/strict';
import {randomUUID as K,randomBytes,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
for(const [u,user]of [[owner,'hon_champions_owner'],[runtime,'hon_champions_runtime']]){
 assert.equal(u.protocol,'postgresql:');assert.equal(u.hostname,'localhost');assert.equal(u.port,'5432');assert.equal(u.pathname,'/hon_champions_validation');assert.equal(u.username,user);assert(u.password);assert.equal(u.search,'');assert.equal(u.hash,'');
}
for(const key of Object.keys(process.env))assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|SENDGRID.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|SMS|EMAIL).*)$/i.test(key));
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false}),locker=new pg.Client({connectionString:owner.toString(),ssl:false});
let groups=0;const pass=name=>console.log('PASS MEMBERSHIP-ACTIVATES-ON-SIGNING '+(++groups)+' '+name);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const sha=s=>createHash('sha256').update(s).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
const SVC='00000000-0000-4000-8000-000000000499';
const NOT_EVALUATED=['PAYMENT','RECURRING_PAYMENT_AUTHORIZATION','FINANCIAL_RESPONSIBILITY','SCHOOL_ACTIVATION_POLICY'];
const addDays=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const addMonths=(date,months)=>{const d=new Date(date+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+months);return d.toISOString().slice(0,10);};
const midnight=date=>date+'T00:00:00.000Z';
// The API's link sign: one transaction with its timeouts; the deferred trigger runs at COMMIT.
async function sign(t,input,{rollback=false,lockTimeout='3s'}={}){
 await restricted.query('BEGIN');
 try{
  await restricted.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='"+lockTimeout+"'");
  const r=(await restricted.query('SELECT hon.sign_membership_agreement_link($1,$2::jsonb,$3::uuid) result',[t,JSON.stringify(input),K()])).rows[0].result;
  await restricted.query(rollback?'ROLLBACK':'COMMIT');return r;
 }catch(e){await restricted.query('ROLLBACK');throw e;}
}

try{
 await Promise.all([admin.connect(),restricted.connect(),locker.connect()]);
 assert.equal((await q("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()"))[0].m,'HON disposable Champions Club validation');

 // 1. Posture: one private forced-RLS outcome table; the two functions are owner-only; a deferred constraint trigger; the verifier section passes.
 for(const p of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) ok',[runtime.username,'hon.membership_signing_activations',p]))[0].ok,false,p);
 assert.deepEqual((await q("SELECT relrowsecurity r,relforcerowsecurity f,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid)::int n FROM pg_class c WHERE oid='hon.membership_signing_activations'::regclass"))[0],{r:true,f:true,n:0});
 for(const f of ['hon.membership_start_on_signing(hon.membership_agreement_signatures,uuid)','hon.membership_agreement_signed_starts()']){
  for(const role of [runtime.username,'public'])assert.equal((await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[role,f]))[0].ok,false,f);
  assert.equal((await q("SELECT prosecdef d,proconfig c FROM pg_proc WHERE oid=$1::regprocedure",[f]))[0].d,true);}
 assert.deepEqual((await q("SELECT tgdeferrable d,tginitdeferred i,tgconstraint<>0 c FROM pg_trigger WHERE tgrelid='hon.membership_agreement_signatures'::regclass AND tgname='membership_agreement_signed_starts'"))[0],{d:true,i:true,c:true});
 await assert.rejects(()=>restricted.query('SELECT * FROM hon.membership_signing_activations'),e=>e.code==='42501');
 await assert.rejects(()=>restricted.query('SELECT hon.membership_agreement_signed_starts()'),e=>e.code==='42501');
 {const verify=readFileSync(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql',import.meta.url),'utf8');
  const section=verify.split('-- Membership activates on signing exact verification (0680)')[1]?.split('-- End membership activates on signing exact verification.')[0]?.replace(/^[^\n]*\n/,'');
  assert(section);await q(section.replaceAll('hon_runtime',runtime.username));}
 pass('one private forced-RLS outcome table; both functions SECURITY DEFINER and owner-only; a deferred constraint trigger on signatures; the deployment verifier section passes');

 // Fixture: one school with paid access, a family with one guardian, five children with DRAFTs, and the current agreement version.
 const hq={subject:'signing-start-hq-'+K()};
 {const user=K(),principal=K();await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Signing start synthetic HQ')",[user,hq.subject,K()+'@example.invalid']);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','Signing start synthetic HQ',true)",[principal,user]);
  await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.onboarding.manage'],clock_timestamp()-interval '2 days')",[principal]);
  hq.principal=principal;}
 const A=(await q("SELECT organization_id AS \"organizationId\",school_id AS \"schoolId\" FROM hon.provision_school_from_hq($1,'Signing start synthetic','Signing start synthetic','Signing school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,'signing-start-'+K(),K(),K()]))[0];
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[A.organizationId]);
 const today=(await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date,'YYYY-MM-DD') d"))[0].d;
 const family=K();await q("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Rivera Family')",[family,A.organizationId,A.schoolId]);
 const addPerson=async given=>(await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Rivera') RETURNING id",[A.organizationId,A.schoolId,given]))[0].id;
 const member=(p,role)=>q('INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,$5)',[A.organizationId,A.schoolId,family,p,role]);
 const guardian=await addPerson('Elena');await member(guardian,'GUARDIAN');
 const account=(await q("INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,'USD') RETURNING id",[A.organizationId,A.schoolId,guardian]))[0].id;
 const plan=async(code,termKind='FIXED_MONTHS',termMonths=12,programId=null)=>{const id=K();
  await q('INSERT INTO hon.membership_plans(id,organization_id,school_id,plan_code,current_version,created_by_principal_id) VALUES($1,$2,$3,$4,1,$5)',[id,A.organizationId,A.schoolId,code,hq.principal]);
  await q(`INSERT INTO hon.membership_plan_versions(plan_id,version,organization_id,school_id,display_name,program_id,availability,currency,price_minor,billing_frequency,term_kind,term_months,actor_principal_id)
    VALUES($1,1,$2,$3,$4,$8,'AVAILABLE','USD',15000,'MONTHLY',$5,$6,$7)`,[id,A.organizationId,A.schoolId,'Plan '+code,termKind,termKind==='FIXED_MONTHS'?termMonths:null,hq.principal,programId]);
  return {id,code};};
 const yearly=await plan('SIGN_YEARLY'),open=await plan('SIGN_OPEN','OPEN_ENDED');
 const programOf=async name=>(await q("INSERT INTO hon.programs(organization_id,school_id,name,status) VALUES($1,$2,$3,'SCHEDULED') RETURNING id",[A.organizationId,A.schoolId,name]))[0].id;
 const karate=await plan('SIGN_KARATE','FIXED_MONTHS',12,await programOf('Karate')),judo=await plan('SIGN_JUDO','FIXED_MONTHS',6,await programOf('Judo'));
 const draft=async(personId,{p=null,code='SYNTHETIC_FREE_TEXT',start=today})=>{
  const id=(await q("INSERT INTO hon.memberships(organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'DRAFT',$6,NULL) RETURNING id",[A.organizationId,A.schoolId,account,personId,p?p.code:code,start?midnight(start):null]))[0].id;
  if(p)await q('INSERT INTO hon.membership_plan_selections(membership_id,organization_id,school_id,plan_id,plan_version,actor_principal_id) VALUES($1,$2,$3,$4,1,$5)',[id,A.organizationId,A.schoolId,p.id,hq.principal]);
  return id;};
 const child=async(given,birth)=>{const personId=await addPerson(given);await member(personId,'STUDENT');
  const studentProfileId=(await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,birth_date) VALUES($1,$2,$3,$4,$5) RETURNING id',[A.organizationId,A.schoolId,personId,family,birth]))[0].id;
  return {personId,studentProfileId};};
 const kids={today:await child('Lucia','2016-02-01'),late:await child('Mateo','2017-03-01'),future:await child('Sofia','2018-04-01'),free:await child('Diego','2015-05-01'),
  nobirth:await child('Ines',null),locked:await child('Pablo','2016-06-01'),twice:await child('Rosa','2016-07-01')};
 const m={today:await draft(kids.today.personId,{p:yearly}),late:await draft(kids.late.personId,{p:yearly,start:addDays(today,-10)}),
  future:await draft(kids.future.personId,{p:open,start:addDays(today,30)}),free:await draft(kids.free.personId,{}),nobirth:await draft(kids.nobirth.personId,{p:yearly}),
  locked:await draft(kids.locked.personId,{p:yearly}),twice:await draft(kids.twice.personId,{p:karate})};
 m.twiceOther=await draft(kids.twice.personId,{p:judo});
 const body='1. Synthetic test text only.';const digest=sha('Membership agreement\n\n'+body);
 await admin.query('BEGIN');
 const versionId=(await q("INSERT INTO hon.membership_agreement_versions(organization_id,school_id,number,published_by_principal_id) VALUES($1,$2,1,$3) RETURNING id",[A.organizationId,A.schoolId,hq.principal]))[0].id;
 await q("INSERT INTO hon.membership_agreement_texts(version_id,organization_id,school_id,language,title,body,digest) VALUES($1,$2,$3,'en','Membership agreement',$4,$5)",[versionId,A.organizationId,A.schoolId,body,digest]);
 await admin.query('COMMIT');
 const link=async students=>{const t=token();
  await q("UPDATE hon.membership_agreement_links SET state='REPLACED',closed_at=clock_timestamp() WHERE family_id=$1 AND state='OPEN'",[family]);
  await q("INSERT INTO hon.membership_agreement_links(organization_id,school_id,family_id,recipient_person_id,student_profile_ids,token_hash,created_by_principal_id,created_at,expires_at) SELECT $1,$2,$3,$4,$5::uuid[],$6,$7,t,t+interval '14 days' FROM (SELECT clock_timestamp() t) x",
   [A.organizationId,A.schoolId,family,guardian,students.map(s=>s.studentProfileId),sha(t),hq.principal]);
  return t;};
 const input=students=>({versionId,language:'en',digest,signerName:'Elena Rivera',eSignConsent:true,studentProfileIds:students.map(s=>s.studentProfileId)});
 const membership=id=>q('SELECT state::text,version,term_started_at,term_ends_at FROM hon.memberships WHERE id=$1',[id]).then(r=>r[0]);
 const outcomes=id=>q('SELECT outcome,reason_codes,decision_id FROM hon.membership_signing_activations WHERE membership_id=$1',[id]);
 const evidence=async()=>Object.fromEntries(await Promise.all(['membership_activation_decisions','membership_effective_periods','membership_signing_activations','audit_events','outbox_events'].map(async t=>[t,(await q('SELECT count(*)::int n FROM hon.'+t))[0].n])));

 // 2. A signing that rolls back starts nothing and records nothing.
 {const before=await evidence();const t=await link([kids.today]);
  assert.equal(await sign(t,input([kids.today]),{rollback:true}),'SIGNED');
  assert.deepEqual(await evidence(),before);assert.equal((await membership(m.today)).state,'DRAFT');}
 pass('a signing that rolls back starts nothing and records nothing');

 // 3. Signing starts the plan-bound DRAFT with the staff dates: 0177 evidence with the AGREEMENT_SIGNED basis, audit and the usual activated event.
 {const t=await link([kids.today]);assert.equal(await sign(t,input([kids.today])),'SIGNED');
  const now=await membership(m.today);assert.equal(now.state,'ACTIVE');assert.equal(now.version,2);
  assert.equal(now.term_started_at.toISOString(),midnight(today));assert.equal(now.term_ends_at.toISOString(),midnight(addMonths(today,12)));
  const sig=(await q('SELECT * FROM hon.membership_agreement_signatures WHERE student_profile_id=$1',[kids.today.studentProfileId]))[0];
  const d=(await q('SELECT * FROM hon.membership_activation_decisions WHERE membership_id=$1',[m.today]))[0];
  assert.equal(d.decision_basis,'AGREEMENT_SIGNED');assert.equal(d.signature_id,sig.id);assert.equal(d.actor_principal_id,SVC);
  assert.equal(d.authorizing_permission,'membership_agreement.signed');assert.equal(d.override_permission,null);assert.equal(d.reason_code,'ROUTINE_ENROLLMENT');
  assert.deepEqual(d.requirements_not_evaluated,NOT_EVALUATED);assert.deepEqual(d.acknowledged_warnings,[]);assert.deepEqual(d.overrides,[]);
  assert.equal(d.correlation_id,sig.signing_id);assert.equal(d.idempotency_key,'agreement-signature:'+sig.id+':'+m.today);
  assert.match(d.preview_digest,/^[a-f0-9]{64}$/);assert.equal(d.request_fingerprint,d.preview_digest);
  assert.equal(d.receipt.decisionBasis,'AGREEMENT_SIGNED');assert.equal(d.receipt.signatureId,sig.id);assert.equal(d.receipt.effectiveStatusAtActivation,'IN_EFFECT');
  const p=(await q('SELECT * FROM hon.membership_effective_periods WHERE membership_id=$1',[m.today]))[0];
  assert.equal(p.change_kind,'INITIAL');assert.equal(p.date_source,'SUGGESTED');assert.equal(p.adjustment_reason,null);assert.equal(p.authorizing_permission,'membership_agreement.signed');
  assert.equal(p.decision_id,d.id);assert.equal(p.actor_principal_id,SVC);
  const audit=(await q("SELECT source,actor_principal_id,next_state FROM hon.audit_events WHERE action_code='billing.membership.activate' AND entity_id=$1",[m.today]));
  assert.equal(audit.length,1);assert.equal(audit[0].source,'PUBLIC_API');assert.equal(audit[0].actor_principal_id,SVC);
  const ev=(await q("SELECT schema_version,aggregate_version,payload FROM hon.outbox_events WHERE event_type='billing.membership.activated' AND aggregate_id=$1",[m.today]));
  assert.equal(ev.length,1);assert.equal(ev[0].schema_version,2);assert.equal(ev[0].aggregate_version,2);assert.equal(ev[0].payload.decisionBasis,'AGREEMENT_SIGNED');
  for(const x of [audit[0].next_state,ev[0].payload,d.receipt])assert(!JSON.stringify(x).match(/Elena|Lucia|Rivera/));
  assert.deepEqual(await outcomes(m.today),[{outcome:'STARTED',reason_codes:[],decision_id:d.id}]);}
 pass('signing starts the child\'s plan-bound DRAFT on the staff dates: one 0177 decision (AGREEMENT_SIGNED, the signature, the link principal, the agreement now evaluated), the initial period, the DRAFT->ACTIVE change, a PUBLIC_API audit row and the usual billing.membership.activated event, identifiers only');

 // 4. Dates: a passed start moves to the signing day with the fixed term recounted; a future start stays and is SCHEDULED.
 {const t=await link([kids.late,kids.future]);assert.equal(await sign(t,input([kids.late,kids.future])),'SIGNED');
  const late=await membership(m.late);assert.equal(late.state,'ACTIVE');
  assert.equal(late.term_started_at.toISOString(),midnight(today));assert.equal(late.term_ends_at.toISOString(),midnight(addMonths(today,12)));
  const lp=(await q('SELECT * FROM hon.membership_effective_periods WHERE membership_id=$1',[m.late]))[0];
  assert.equal(lp.date_source,'STAFF_ADJUSTED');assert.equal(lp.start_date.toISOString().slice(0,10),today);
  assert.equal(lp.suggested_start_date.toISOString().slice(0,10),addDays(today,-10));assert.match(lp.adjustment_reason,/agreement was signed/);
  const fut=await membership(m.future);assert.equal(fut.state,'ACTIVE');assert.equal(fut.term_started_at.toISOString(),midnight(addDays(today,30)));assert.equal(fut.term_ends_at,null);
  const fd=(await q('SELECT acknowledged_warnings,receipt FROM hon.membership_activation_decisions WHERE membership_id=$1',[m.future]))[0];
  assert.deepEqual(fd.acknowledged_warnings,['START_DATE_IN_FUTURE']);assert.equal(fd.receipt.effectiveStatusAtActivation,'SCHEDULED');}
 pass('a membership never starts before it was signed: a passed start moves to the signing day (fixed term recounted, recorded as adjusted with its reason); a future start is kept and the membership is SCHEDULED');

 // 5. Anything staff still need to decide leaves the DRAFT as it was, records the reasons, and the signing still succeeds.
 {const before=await evidence();const t=await link([kids.free,kids.nobirth]);assert.equal(await sign(t,input([kids.free,kids.nobirth])),'SIGNED');
  for(const id of [m.free,m.nobirth])assert.deepEqual(await membership(id).then(x=>[x.state,x.version]),['DRAFT',1]);
  assert.deepEqual(await outcomes(m.free),[{outcome:'LEFT_FOR_STAFF',reason_codes:['LEGACY_FREE_TEXT_PLAN'],decision_id:null}]);
  assert.deepEqual(await outcomes(m.nobirth),[{outcome:'LEFT_FOR_STAFF',reason_codes:['BIRTH_DATE_MISSING'],decision_id:null}]);
  const after=await evidence();
  assert.deepEqual([after.membership_activation_decisions,after.membership_effective_periods,after.membership_signing_activations],
   [before.membership_activation_decisions,before.membership_effective_periods,before.membership_signing_activations+2]);
  assert.equal((await q("SELECT count(*)::int n FROM hon.outbox_events WHERE event_type='billing.membership.activated' AND aggregate_id=ANY($1)",[[m.free,m.nobirth]]))[0].n,0);}
 pass('a free-text plan or a missing birth date leaves the DRAFT for staff with its reason codes; no decision, period or activated event; the signing still succeeds');

 // 6. A lock conflict leaves that DRAFT for staff and never fails the signing; the conflict's writes and locks are rolled back.
 {await locker.query('BEGIN');await locker.query('SELECT 1 FROM hon.memberships WHERE id=$1 FOR UPDATE',[m.locked]);
  const t=await link([kids.locked]);const r=await sign(t,input([kids.locked]),{lockTimeout:'300ms'});
  await locker.query('ROLLBACK');
  assert.equal(r,'SIGNED');assert.equal((await membership(m.locked)).state,'DRAFT');
  assert.deepEqual(await outcomes(m.locked),[{outcome:'LEFT_FOR_STAFF',reason_codes:['START_FAILED_55P03'],decision_id:null}]);
  assert.equal((await q('SELECT count(*)::int n FROM hon.membership_activation_decisions WHERE membership_id=$1',[m.locked]))[0].n,0);
  assert.equal((await q('SELECT count(*)::int n FROM hon.membership_agreement_signatures WHERE student_profile_id=$1',[kids.locked.studentProfileId]))[0].n,1);}
 pass('a lock conflict leaves that DRAFT for staff (START_FAILED_55P03) and the signature still commits; nothing of the failed start is kept');

 // 7. Only the signed child's DRAFTs, only once: an ACTIVE membership is untouched; a DRAFT made after the signature waits for staff Start.
 {const second=await draft(kids.today.personId,{p:open,start:addDays(today,400)});
  const t=await link([kids.twice]);assert.equal(await sign(t,input([kids.twice])),'SIGNED');
  // One signature starts the child's DRAFT in each program, each with its own decision naming the same signature.
  const both=await q('SELECT membership_id,signature_id FROM hon.membership_activation_decisions WHERE membership_id=ANY($1)',[[m.twice,m.twiceOther]]);
  assert.equal(both.length,2);assert.equal(both[0].signature_id,both[1].signature_id);
  assert.equal((await membership(m.twice)).state,'ACTIVE');
  const other=await membership(m.twiceOther);assert.equal(other.state,'ACTIVE');assert.equal(other.term_ends_at.toISOString(),midnight(addMonths(today,6)));
  for(const id of [m.twice,m.twiceOther])assert.equal((await outcomes(id))[0].outcome,'STARTED');
  assert.deepEqual(await membership(second).then(x=>[x.state,x.version]),['DRAFT',1]);assert.deepEqual(await outcomes(second),[]);
  assert.deepEqual(await membership(m.today).then(x=>[x.state,x.version]),['ACTIVE',2]);
  assert.equal((await q('SELECT count(*)::int n FROM hon.membership_activation_decisions WHERE membership_id=$1',[m.today]))[0].n,1);}
 pass('one signature starts the child\'s DRAFT in each program (two decisions, one signature); a signing looks only at its own child\'s DRAFTs; an ACTIVE membership is untouched; a DRAFT made after the signature stays for staff Start');

 // 8. Evidence: outcomes are immutable, and the widened 0177 checks still bind each basis to its own rules.
 {const any=(await q('SELECT signature_id,membership_id FROM hon.membership_signing_activations LIMIT 1'))[0];
  await assert.rejects(()=>q("UPDATE hon.membership_signing_activations SET outcome='LEFT_FOR_STAFF' WHERE signature_id=$1 AND membership_id=$2",[any.signature_id,any.membership_id]),/IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE/);
  await assert.rejects(()=>q('DELETE FROM hon.membership_signing_activations WHERE signature_id=$1',[any.signature_id]),/IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE/);
  await assert.rejects(()=>q('TRUNCATE hon.membership_signing_activations'),/IMMUTABLE_MEMBERSHIP_ACTIVATION_EVIDENCE/);
  const d=(await q('SELECT * FROM hon.membership_activation_decisions WHERE membership_id=$1',[m.today]))[0];
  const tryDecision=async patch=>{const row={...d,id:K(),membership_id:m.nobirth,idempotency_key:'proof-'+K(),signature_id:null,...patch};
   const cols=['id','organization_id','school_id','membership_id','prior_membership_version','next_membership_version','decision_basis','membership_source','actor_principal_id',
    'authorizing_permission','override_permission','reason_code','reason_text','acknowledged_warnings','overrides','adult_verification','preview_digest','evaluated_facts',
    'requirements_not_evaluated','idempotency_key','request_fingerprint','request_id','correlation_id','receipt','signature_id'];
   await admin.query('SAVEPOINT x');
   try{await q('INSERT INTO hon.membership_activation_decisions('+cols.join(',')+') VALUES('+cols.map((c,i)=>'$'+(i+1)+(['acknowledged_warnings','overrides','evaluated_facts','requirements_not_evaluated','receipt','adult_verification'].includes(c)?'::jsonb':'')).join(',')+')',
    cols.map(c=>c in row&&row[c]!==null&&typeof row[c]==='object'&&!(row[c] instanceof Date)?JSON.stringify(row[c]):row[c]));return 'inserted';}
   catch(e){return e.code;}finally{await admin.query('ROLLBACK TO SAVEPOINT x');}};
  await admin.query('BEGIN');
  assert.equal(await tryDecision({}),'23514');// a signing basis with no signature
  assert.equal(await tryDecision({decision_basis:'STAFF_ACTIVATION_PRE_POLICY'}),'23514');// a staff basis with the signing permission
  assert.equal(await tryDecision({decision_basis:'STAFF_ACTIVATION_PRE_POLICY',authorizing_permission:'billing.membership.activate'}),'23514');// a staff basis that leaves out AGREEMENT
  assert.equal(await tryDecision({signature_id:d.signature_id,membership_id:m.today}),'23505');// one decision per membership, whatever the signature
  assert.equal(await tryDecision({signature_id:(await q('SELECT id FROM hon.membership_agreement_signatures WHERE student_profile_id=$1',[kids.nobirth.studentProfileId]))[0].id,reason_code:'OTHER',reason_text:'Synthetic.'}),'23514');
  await admin.query('ROLLBACK');}
 pass('outcome rows are immutable; a signing decision needs its signature, the signing permission and ROUTINE_ENROLLMENT, a staff decision keeps the 0177 permission and still lists the agreement as not evaluated, and a membership has one decision');

 console.log('Membership activates on signing proof (0680): '+groups+' groups passed');
}finally{
 await Promise.allSettled([admin.end(),restricted.end(),locker.end()]);
}
