import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// Champions Club foundation (0148) integrity proof. Disposable localhost fixture only.
const owner=new URL(process.env.DATABASE_URL??''),runtime=new URL(process.env.HON_RUNTIME_DATABASE_URL??'');
if(owner.hostname!=='localhost'||owner.port!=='5432'||owner.pathname!=='/hon_champions_validation'||owner.username!=='hon_champions_owner'||runtime.hostname!==owner.hostname||runtime.port!==owner.port||runtime.pathname!==owner.pathname||runtime.username!=='hon_champions_runtime')throw new Error('Only exact disposable localhost Champions Club URLs permitted; never remote DB.');
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {ChampionsClubService}=await import('../../../apps/api/dist/champions/champions-club.service.js');
const runtimeDatabase=new RuntimeDatabaseService(),service=new ChampionsClubService(runtimeDatabase);
const httpStatus=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const admin=new pg.Client({connectionString:owner.toString(),ssl:false}),restricted=new pg.Client({connectionString:runtime.toString(),ssl:false});
const championsTables=['champions_outbox','champions_audit','champions_attribution_history','champions_attributions','champions_requests','champions_referral_codes','champions_policies'];
const ids=Object.fromEntries(['orgA','orgB','orgC','orgD','orgR','orgE','orgS','orgOld','orgSuspended','orgUnentitled','schoolA','schoolA2','schoolB','schoolD','schoolU','staffRole','plainRole','parentRole','dualRoleA','dualRoleD','dualRoleS','unentitledRole','schoolS'].map(k=>[k,randomUUID()]));
const humans=Object.fromEntries(['owner','operator','operatorNoPerm','support','staff','staffNoPerm','parent','hqStaff','inactive','dual','unentitled'].map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`champions-${k}-${randomUUID()}`}]));
const orgs=()=>[ids.orgA,ids.orgB,ids.orgC,ids.orgD,ids.orgR,ids.orgE,ids.orgS,ids.orgOld,ids.orgSuspended,ids.orgUnentitled];
const sqlDeny=(fn,code='42501',message)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.stack);if(message)assert.equal(e.message,message);return true;});
const call=async(fn,args,types)=>(await restricted.query(`SELECT hon.${fn}(${args.map((_,i)=>`$${i+1}${types?.[i]?`::${types[i]}`:''}`).join(',')}) r`,args)).rows[0].r;
const keys=()=>[randomUUID(),randomUUID(),randomUUID()];
const issue=(who,school=ids.schoolA,key=randomUUID())=>call('issue_champions_referral_code',[humans[who].subject,school,key,randomUUID(),randomUUID()]);
const schoolView=(who,school=ids.schoolA)=>call('read_champions_school_view',[humans[who].subject,school]);
const draft=(who,p,key=randomUUID())=>call('create_champions_policy_draft',[humans[who].subject,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,'jsonb']);
const publish=(who,policy,key=randomUUID())=>call('publish_champions_policy',[humans[who].subject,policy,key,randomUUID(),randomUUID()]);
const capture=(who,p,key=randomUUID())=>call('capture_champions_attribution',[humans[who].subject,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,'jsonb']);
const decide=(who,id,p,key=randomUUID())=>call('decide_champions_attribution',[humans[who].subject,id,JSON.stringify(p),key,randomUUID(),randomUUID()],[null,null,'jsonb']);
const listHq=(who,state=null)=>call('read_champions_attributions_from_hq',[humans[who].subject,state]);
const programHq=who=>call('read_champions_program_from_hq',[humans[who].subject]);
const terms=(patch={})=>({attributionWindowDays:90,refundWindowDays:30,minimumPaidDays:30,minimumPaidInvoices:1,paymentVerificationSource:'HQ_OWNER_ATTESTATION',welcomeCreditMinor:10000,termsReference:'Fixture terms v1 (not legal terms)',...patch});
const iso=d=>d.toISOString();
async function snapshot(){const out={};for(const t of ['organizations','organization_entitlements','schools','roles','role_permissions','principal_role_grants','hq_operator_grants','audit_events','outbox_events'])out[t]=(await admin.query(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`)).rows.map(r=>r.r);return out;}
async function cleanup(){
 await admin.query('BEGIN');try{
  for(const t of championsTables){await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);await admin.query(`DELETE FROM hon.${t}`);await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);}
  const principalIds=Object.values(humans).map(h=>h.id);
  for(const t of ['principal_role_grants','role_permissions','roles','organization_entitlements'])await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs()]);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[principalIds]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
  await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs()]);
  await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs()]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
async function addOrg(id,{createdAt='clock_timestamp()',status='ACTIVE',tier='CORE'}={}){
 await admin.query(`INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'Champions fixture','Champions fixture',$2::hon.membership_status,${createdAt})`,[id,status]);
 if(tier)await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,$2,clock_timestamp()-interval '1 day')",[id,tier]);
}
async function grant(who,role,org,school){await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval \'1 hour\')',[org,school,humans[who].id,role]);}
await Promise.all([admin.connect(),restricted.connect()]);
try{
 const marker=(await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
 assert.equal(marker.owner,'hon_champions_owner');assert.equal(marker.marker,'HON disposable Champions Club validation');
 const posture=(await restricted.query("SELECT NOT(rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication) safe FROM pg_roles WHERE rolname=current_user")).rows[0];assert(posture.safe);
 // Runtime has no direct table access at all.
 for(const t of championsTables)await sqlDeny(()=>restricted.query(`SELECT * FROM hon.${t}`));
 for(const signature of ['champions_claim_request(uuid,uuid,text,text,uuid,uuid)','require_champions_hq_actor(text,boolean)','require_champions_school_actor(text,uuid)','champions_record(uuid,uuid,text,text,text,uuid,uuid,jsonb,jsonb,jsonb,timestamptz)'])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",['hon.'+signature])).rows[0].allowed,false,signature);
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.permissions WHERE code='champions.participate' AND is_staff_assignable AND NOT is_sensitive")).rows[0].n,1);

 // ---------- fixture ----------
 await cleanup();
 await admin.query('BEGIN');
 await addOrg(ids.orgA);await addOrg(ids.orgD);await addOrg(ids.orgOld,{createdAt:"clock_timestamp()-interval '30 days'"});await addOrg(ids.orgUnentitled,{tier:null});
 for(const[school,org]of [[ids.schoolA,ids.orgA],[ids.schoolA2,ids.orgA],[ids.schoolD,ids.orgD],[ids.schoolU,ids.orgUnentitled]])await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Champions fixture school',$1::text,'America/New_York')",[school,org]);
 for(const[who,h]of Object.entries(humans)){await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')",[h.user,h.subject,`${h.user}@example.test`]);await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',$3)",[h.id,h.user,who!=='inactive']);}
 for(const[role,org,code,perms]of [[ids.staffRole,ids.orgA,'CHAMPIONS_STAFF',['champions.participate']],[ids.plainRole,ids.orgA,'FRONT_DESK',['crm.lead.read']],[ids.parentRole,ids.orgA,'PARENT',['champions.participate']],[ids.dualRoleA,ids.orgA,'DUAL_A',['champions.participate']],[ids.dualRoleD,ids.orgD,'DUAL_D',['champions.participate']],[ids.unentitledRole,ids.orgUnentitled,'CHAMPIONS_STAFF',['champions.participate']]]){
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,'Fixture role')",[role,org,code]);
  for(const permission of perms)await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,permission]);
 }
 for(const who of ['staff','hqStaff','inactive'])await grant(who,ids.staffRole,ids.orgA,ids.schoolA);
 await grant('staffNoPerm',ids.plainRole,ids.orgA,ids.schoolA);await grant('parent',ids.parentRole,ids.orgA,ids.schoolA);
 await grant('dual',ids.dualRoleA,ids.orgA,ids.schoolA);await grant('dual',ids.dualRoleD,ids.orgD,ids.schoolD);
 await grant('unentitled',ids.unentitledRole,ids.orgUnentitled,ids.schoolU);
 for(const[who,role,perms]of [['owner','HON_HQ_OWNER',[]],['operator','HON_HQ_OPERATOR',['hq.champions.manage']],['operatorNoPerm','HON_HQ_OPERATOR',['hq.schools.read']],['support','HON_HQ_SUPPORT',['hq.champions.manage']],['hqStaff','HON_HQ_OPERATOR',['hq.champions.manage']]])
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour')",[humans[who].id,role,perms]);
 await admin.query('COMMIT');
 const before=await snapshot();

 // ---------- school participation: referral code ----------
 const empty=await schoolView('staff');
 assert.deepEqual(empty,{schoolId:ids.schoolA,referralCode:null,program:{status:'POLICY_UNDECIDED',policyVersion:null,financialRewards:'DISABLED'},referrals:{pending:0,qualified:0,rejected:0,refunded:0,reversed:0}});
 for(const who of ['staffNoPerm','parent','hqStaff','inactive','owner','operator','unentitled'])await sqlDeny(()=>issue(who),'42501','CHAMPIONS_FORBIDDEN');
 await sqlDeny(()=>issue('unentitled',ids.schoolU),'42501','CHAMPIONS_FORBIDDEN');
 await sqlDeny(()=>issue('staff',ids.schoolA2),'42501','CHAMPIONS_FORBIDDEN');
 await sqlDeny(()=>issue('staff',ids.schoolD),'42501','CHAMPIONS_FORBIDDEN');
 await sqlDeny(()=>call('issue_champions_referral_code',['unknown-subject',ids.schoolA,randomUUID(),randomUUID(),randomUUID()]),'42501');
 await sqlDeny(()=>call('issue_champions_referral_code',[humans.staff.subject,ids.schoolA,null,randomUUID(),randomUUID()]),'22023');
 const issueKey=randomUUID();
 const issued=await issue('staff',ids.schoolA,issueKey);
 assert.match(issued.code,/^[A-HJ-NP-Z2-9]{10}$/);assert.equal(issued.created,true);assert.equal(issued.replayed,false);assert.equal(issued.status,'ACTIVE');
 assert.deepEqual(await issue('staff',ids.schoolA,issueKey),{...issued,replayed:true});
 const again=await issue('staff');assert.equal(again.code,issued.code);assert.equal(again.created,false);
 const code=issued.code;
 assert.equal((await admin.query("SELECT count(*)::int n FROM hon.champions_referral_codes WHERE school_id=$1",[ids.schoolA])).rows[0].n,1);
 // Context-bound sessions (tenant, family, delegated or Action Engine) are refused outright.
 for(const setting of ['app.hon_organization_id','app.hon_school_id','app.hon_family_id','app.hon_principal_id','app.hon_action_request_id','app.hon_delegated_by_principal_id']){
  await restricted.query('BEGIN');
  try{await restricted.query('SELECT set_config($1,$2,true)',[setting,randomUUID()]);await sqlDeny(()=>restricted.query('SELECT hon.read_champions_school_view($1,$2)',[humans.staff.subject,ids.schoolA]),'42501');}finally{await restricted.query('ROLLBACK');}
  await restricted.query('BEGIN');
  try{await restricted.query('SELECT set_config($1,$2,true)',[setting,randomUUID()]);await sqlDeny(()=>restricted.query('SELECT hon.read_champions_program_from_hq($1)',[humans.owner.subject]),'42501');}finally{await restricted.query('ROLLBACK');}
 }

 // Referred organizations are created after the code exists (no retroactive attribution).
 await admin.query('BEGIN');
 await addOrg(ids.orgB);await addOrg(ids.orgC);await addOrg(ids.orgR);await addOrg(ids.orgS);await addOrg(ids.orgSuspended,{status:'SUSPENDED'});
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Referred fixture school',$1::text,'America/New_York')",[ids.schoolB,ids.orgB]);
 await admin.query('COMMIT');

 // ---------- HQ authority and attribution capture ----------
 for(const who of ['operatorNoPerm','support','staff','parent','inactive'])await sqlDeny(()=>capture(who,{referralCode:code,referredOrganizationId:ids.orgB}),'42501','CHAMPIONS_FORBIDDEN');
 for(const who of ['operatorNoPerm','support','staff'])await sqlDeny(()=>programHq(who),'42501');
 for(const bad of [{referralCode:code},{referralCode:code,referredOrganizationId:ids.orgB,extra:1},{referralCode:code.toLowerCase(),referredOrganizationId:ids.orgB},{referralCode:code,referredOrganizationId:'not-a-uuid'},{referralCode:'O0O0O0O0O0',referredOrganizationId:ids.orgB}])
  await sqlDeny(()=>capture('operator',bad),'22023','INVALID_CHAMPIONS_INPUT');
 await sqlDeny(()=>capture('operator',{referralCode:'ABCDEFGHJK',referredOrganizationId:ids.orgB}),'P0002');
 await sqlDeny(()=>capture('operator',{referralCode:code,referredOrganizationId:randomUUID()}),'P0002');
 await sqlDeny(()=>capture('operator',{referralCode:code,referredOrganizationId:ids.orgA}),'23514','CHAMPIONS_SELF_REFERRAL');
 await sqlDeny(()=>capture('operator',{referralCode:code,referredOrganizationId:ids.orgD}),'23514','CHAMPIONS_SELF_REFERRAL');
 await sqlDeny(()=>capture('operator',{referralCode:code,referredOrganizationId:ids.orgOld}),'23514','CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE');
 await sqlDeny(()=>capture('operator',{referralCode:code,referredOrganizationId:ids.orgSuspended}),'23514','CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE');
 const captureKey=randomUUID();
 const capturedB=(await capture('operator',{referralCode:code,referredOrganizationId:ids.orgB},captureKey));
 assert.equal(capturedB.replayed,false);
 const b=capturedB.attribution;
 assert.equal(b.state,'PENDING');assert.equal(b.stateReason,'CAPTURED');assert.equal(b.version,1);assert.equal(b.referrerSchoolId,ids.schoolA);assert.equal(b.referredOrganizationId,ids.orgB);assert.equal(b.qualifiedAt,null);
 assert.deepEqual(await capture('operator',{referralCode:code,referredOrganizationId:ids.orgB},captureKey),{...capturedB,replayed:true});
 await sqlDeny(()=>capture('operator',{referralCode:code,referredOrganizationId:ids.orgC},captureKey),'23505','CHAMPIONS_KEY_REUSED');
 await sqlDeny(()=>capture('owner',{referralCode:code,referredOrganizationId:ids.orgB}),'23P01','CHAMPIONS_DUPLICATE_ATTRIBUTION');
 const c=(await capture('owner',{referralCode:code,referredOrganizationId:ids.orgC})).attribution;
 // A revoked code captures nothing.
 const otherCode=(await admin.query("INSERT INTO hon.champions_referral_codes(organization_id,school_id,code,status,revoked_at,created_by_principal_id,created_at) VALUES($1,$2,'ZZZZZZZZZZ','REVOKED',clock_timestamp(),$3,clock_timestamp()-interval '1 day') RETURNING code",[ids.orgA,ids.schoolA2,humans.staff.id])).rows[0].code;
 await sqlDeny(()=>capture('owner',{referralCode:otherCode,referredOrganizationId:ids.orgSuspended}),'23514','CHAMPIONS_ATTRIBUTION_NOT_ELIGIBLE');

 // ---------- program policy: undecided terms block qualification and publication ----------
 const qualifyBody=(version,evidence={})=>({decision:'QUALIFY',reasonCode:'QUALIFICATION_VERIFIED',expectedVersion:version,evidence:{firstPaidAt:iso(new Date(Date.now()-3600_000)),paidInvoiceCount:1,reference:'Fixture owner attestation',...evidence}});
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(1)),'23514','CHAMPIONS_POLICY_UNDECIDED');
 assert.deepEqual(await programHq('operator'),{published:null,drafts:[],financialRewards:'DISABLED'});
 for(const bad of [{...terms(),extra:1},(({termsReference,...rest})=>rest)(terms()),terms({attributionWindowDays:-1}),terms({attributionWindowDays:'90'}),terms({minimumPaidInvoices:1.5}),terms({paymentVerificationSource:null})])
  await sqlDeny(()=>draft('operator',bad),'22023','INVALID_CHAMPIONS_INPUT');
 await sqlDeny(()=>draft('operator',terms({attributionWindowDays:0})),'23514');
 await sqlDeny(()=>draft('operator',terms({paymentVerificationSource:'CARD_PROCESSOR'})),'23514');
 for(const who of ['operatorNoPerm','support','staff'])await sqlDeny(()=>draft(who,terms()),'42501');
 const undecided=(await draft('operator',terms({attributionWindowDays:null,paymentVerificationSource:'UNDECIDED',termsReference:null}))).policy;
 assert.equal(undecided.status,'DRAFT');assert.equal(undecided.policyVersion,1);assert.equal(undecided.financialRewards,'DISABLED');
 await sqlDeny(()=>publish('operator',undecided.policyId),'42501');
 await sqlDeny(()=>publish('owner',undecided.policyId),'23514','CHAMPIONS_POLICY_UNDECIDED');
 await sqlDeny(()=>publish('owner',randomUUID()),'P0002');
 const billing=(await draft('owner',terms({paymentVerificationSource:'HON_BILLING'}))).policy;
 const published1=await publish('owner',billing.policyId);
 assert.equal(published1.policy.status,'PUBLISHED');assert.equal(published1.retiredPolicyId,null);
 await sqlDeny(()=>publish('owner',billing.policyId),'40001','CHAMPIONS_POLICY_NOT_DRAFT');
 assert.equal((await schoolView('staff')).program.status,'PUBLISHED');
 // HON billing is not an authoritative payment source yet: qualification fails closed.
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(1)),'23514','CHAMPIONS_PAYMENT_SOURCE_UNAVAILABLE');

 const strict=(await draft('owner',terms())).policy;
 const published2=await publish('owner',strict.policyId);
 assert.equal(published2.retiredPolicyId,billing.policyId);
 assert.equal((await admin.query('SELECT status FROM hon.champions_policies WHERE id=$1',[billing.policyId])).rows[0].status,'RETIRED');
 // The 30-day refund window and minimum paid period have not elapsed.
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(1)),'23514','CHAMPIONS_QUALIFICATION_NOT_MET');
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(1,{firstPaidAt:iso(new Date(Date.now()-40*86400_000))})),'23514','CHAMPIONS_QUALIFICATION_NOT_MET');

 const immediate=(await draft('owner',terms({attributionWindowDays:1,refundWindowDays:0,minimumPaidDays:0}))).policy;
 await publish('owner',immediate.policyId);
 const program=await programHq('operator');
 assert.equal(program.published.policyId,immediate.policyId);assert.equal(program.published.financialRewards,'DISABLED');
 assert.deepEqual(program.drafts.map(d=>d.policyId),[undecided.policyId]);
 // Decision input and authority.
 for(const bad of [{decision:'QUALIFY',reasonCode:'REFUND_ISSUED',expectedVersion:1,evidence:qualifyBody(1).evidence},{decision:'QUALIFY',reasonCode:'QUALIFICATION_VERIFIED',expectedVersion:1},{decision:'REJECT',reasonCode:'FRAUD_SUSPECTED',expectedVersion:'1'},{decision:'REJECT',reasonCode:'REFUND_ISSUED',expectedVersion:1},{decision:'APPROVE',reasonCode:'QUALIFICATION_VERIFIED',expectedVersion:1},qualifyBody(1,{paidInvoiceCount:-1}),qualifyBody(1,{firstPaidAt:'2026-10-18'}),qualifyBody(1,{reference:' padded '}),qualifyBody(1,{extra:true})])
  await sqlDeny(()=>decide('owner',b.attributionId,bad),'22023','INVALID_CHAMPIONS_INPUT');
 for(const who of ['operator','operatorNoPerm','support','staff'])await sqlDeny(()=>decide(who,b.attributionId,qualifyBody(1)),'42501');
 await sqlDeny(()=>decide('owner',randomUUID(),qualifyBody(1)),'P0002');
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(2)),'40001','CHAMPIONS_VERSION_CONFLICT');
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(1,{paidInvoiceCount:0})),'23514','CHAMPIONS_QUALIFICATION_NOT_MET');
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(1,{firstPaidAt:iso(new Date(Date.now()+3600_000))})),'23514','CHAMPIONS_QUALIFICATION_NOT_MET');
 // The referred organization must hold an active entitlement.
 await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1",[ids.orgC]);
 await sqlDeny(()=>decide('owner',c.attributionId,qualifyBody(1)),'23514','CHAMPIONS_QUALIFICATION_NOT_MET');
 await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1",[ids.orgC]);
 // An attribution outside the policy window expires (captured_at backdated by the fixture owner only).
 await admin.query('ALTER TABLE hon.champions_attributions DISABLE TRIGGER champions_guarded');
 await admin.query("UPDATE hon.champions_attributions SET captured_at=captured_at-interval '3 days' WHERE id=$1",[c.attributionId]);
 await admin.query('ALTER TABLE hon.champions_attributions ENABLE TRIGGER champions_guarded');
 await sqlDeny(()=>decide('owner',c.attributionId,qualifyBody(1)),'23514','CHAMPIONS_ATTRIBUTION_EXPIRED');

 const qualifyKey=randomUUID(),qualifyPayload=qualifyBody(1);
 const qualified=await decide('owner',b.attributionId,qualifyPayload,qualifyKey);
 assert.equal(qualified.attribution.state,'QUALIFIED');assert.equal(qualified.attribution.version,2);assert.equal(qualified.attribution.qualifiedPolicyVersion,immediate.policyVersion);assert.equal(qualified.replayed,false);
 assert.deepEqual(await decide('owner',b.attributionId,qualifyPayload,qualifyKey),{...qualified,replayed:true});
 await sqlDeny(()=>decide('owner',b.attributionId,qualifyBody(2),qualifyKey),'23505','CHAMPIONS_KEY_REUSED');
 const stored=(await admin.query('SELECT qualification_evidence e, qualified_policy_id p FROM hon.champions_attributions WHERE id=$1',[b.attributionId])).rows[0];
 assert.deepEqual(stored.e,{source:'HQ_OWNER_ATTESTATION',reference:'Fixture owner attestation',paidInvoiceCount:1,firstPaidAt:qualifyPayload.evidence.firstPaidAt});assert.equal(stored.p,immediate.policyId);
 await sqlDeny(()=>decide('owner',b.attributionId,{decision:'REJECT',reasonCode:'FRAUD_SUSPECTED',expectedVersion:2}),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 const reversed=await decide('owner',b.attributionId,{decision:'REVERSE',reasonCode:'PAYMENT_REVERSED',expectedVersion:2});
 assert.equal(reversed.attribution.state,'REVERSED');assert.equal(reversed.attribution.version,3);assert.equal(reversed.attribution.qualifiedPolicyVersion,immediate.policyVersion);
 for(const body of [{decision:'REFUND',reasonCode:'REFUND_ISSUED',expectedVersion:3},{decision:'REVERSE',reasonCode:'FRAUD_SUSPECTED',expectedVersion:3}])
  await sqlDeny(()=>decide('owner',b.attributionId,body),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');
 // HQ operator may reject; refunds before qualification are owner-only.
 await sqlDeny(()=>decide('operator',c.attributionId,{decision:'REFUND',reasonCode:'REFUND_ISSUED',expectedVersion:1}),'42501');
 const rejected=await decide('operator',c.attributionId,{decision:'REJECT',reasonCode:'ATTRIBUTION_EXPIRED',expectedVersion:1});
 assert.equal(rejected.attribution.state,'REJECTED');assert.equal(rejected.attribution.qualifiedAt,null);
 // A shared user that appears only after capture is still caught at qualification.
 const sAttr=(await capture('operator',{referralCode:code,referredOrganizationId:ids.orgS})).attribution;
 await admin.query('BEGIN');
 await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Late-grant fixture school',$1::text,'America/New_York')",[ids.schoolS,ids.orgS]);
 await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'LATE_OWNER','Fixture role')",[ids.dualRoleS,ids.orgS]);
 await grant('dual',ids.dualRoleS,ids.orgS,ids.schoolS);
 await admin.query('COMMIT');
 await sqlDeny(()=>decide('owner',sAttr.attributionId,qualifyBody(1)),'23514','CHAMPIONS_SELF_REFERRAL');
 assert.equal((await decide('operator',sAttr.attributionId,{decision:'REJECT',reasonCode:'SELF_REFERRAL',expectedVersion:1})).attribution.state,'REJECTED');
 // A refund inside the guarantee period ends a PENDING referral without qualification.
 const r=(await capture('operator',{referralCode:code,referredOrganizationId:ids.orgR})).attribution;
 const refunded=await decide('owner',r.attributionId,{decision:'REFUND',reasonCode:'REFUND_ISSUED',expectedVersion:1});
 assert.equal(refunded.attribution.state,'REFUNDED');assert.equal(refunded.attribution.qualifiedPolicyVersion,null);
 await sqlDeny(()=>decide('owner',r.attributionId,qualifyBody(2)),'40001','CHAMPIONS_TRANSITION_NOT_ALLOWED');

 // ---------- reads ----------
 const view=await schoolView('staff');
 assert.deepEqual(view.referrals,{pending:0,qualified:0,rejected:2,refunded:1,reversed:1});assert.equal(view.referralCode.code,code);
 assert.equal(JSON.stringify(view).includes(ids.orgB),false,'Referring school never sees referred organization identity.');
 const all=await listHq('operator');assert.equal(all.attributions.length,4);assert.equal(all.limit,100);
 assert.deepEqual((await listHq('owner','REVERSED')).attributions.map(a=>a.attributionId),[b.attributionId]);
 await sqlDeny(()=>listHq('operator','BOGUS'),'22023');
 for(const who of ['operatorNoPerm','support','staff'])await sqlDeny(()=>listHq(who),'42501');
 for(const who of ['owner','operator','staffNoPerm'])await sqlDeny(()=>schoolView(who),'42501');

 // ---------- evidence ----------
 const history=(await admin.query('SELECT from_state,to_state,version,state_reason FROM hon.champions_attribution_history WHERE attribution_id=$1 ORDER BY version',[b.attributionId])).rows;
 assert.deepEqual(history,[{from_state:null,to_state:'PENDING',version:1,state_reason:'CAPTURED'},{from_state:'PENDING',to_state:'QUALIFIED',version:2,state_reason:'QUALIFICATION_VERIFIED'},{from_state:'QUALIFIED',to_state:'REVERSED',version:3,state_reason:'PAYMENT_REVERSED'}]);
 const evidence=(await admin.query("SELECT (SELECT count(*)::int FROM hon.champions_requests WHERE status='COMPLETED') completed,(SELECT count(*)::int FROM hon.champions_requests WHERE status<>'COMPLETED') open,(SELECT count(*)::int FROM hon.champions_audit) audits,(SELECT count(*)::int FROM hon.champions_outbox) outbox,(SELECT count(*)::int FROM hon.champions_outbox WHERE payload->'internalOnly'='true'::jsonb AND payload->'executionAllowed'='false'::jsonb) inert")).rows[0];
 assert.equal(evidence.open,0,'Failed commands leave no request receipt.');assert.equal(evidence.audits,evidence.completed);assert.equal(evidence.outbox,evidence.audits);assert.equal(evidence.inert,evidence.outbox);
 // 2 issues, 4 captures, 4 drafts, 3 publishes, 5 decisions.
 assert.equal(evidence.completed,18);
 for(const sql of ["UPDATE hon.champions_audit SET entity_type='POLICY'","DELETE FROM hon.champions_outbox","TRUNCATE hon.champions_attribution_history","UPDATE hon.champions_requests SET operation='x'","DELETE FROM hon.champions_attributions","UPDATE hon.champions_attributions SET state='QUALIFIED', version=version+1 WHERE state='REJECTED'","UPDATE hon.champions_policies SET welcome_credit_minor=0","UPDATE hon.champions_policies SET status='DRAFT' WHERE status='RETIRED'","UPDATE hon.champions_referral_codes SET status='ACTIVE', revoked_at=NULL WHERE status='REVOKED'","DELETE FROM hon.champions_referral_codes"])
  await sqlDeny(()=>admin.query(sql),'42501');
 await sqlDeny(()=>admin.query('UPDATE hon.champions_policies SET financial_rewards_enabled=true'),'42501');
 await admin.query('ALTER TABLE hon.champions_policies DISABLE TRIGGER champions_guarded');
 try{await sqlDeny(()=>admin.query('UPDATE hon.champions_policies SET financial_rewards_enabled=true'),'23514');}finally{await admin.query('ALTER TABLE hon.champions_policies ENABLE TRIGGER champions_guarded');}
 // Nothing outside the Champions Club tables changed (entitlement status was restored above).
 const after=await snapshot();
 // Rows the fixture itself adds after the baseline (referred organizations, the late grant) are excluded; updated_at is ignored.
 const strip=rows=>rows.map(r=>{const o=JSON.parse(r);delete o.updated_at;return JSON.stringify(o);}).filter(r=>![ids.orgB,ids.orgC,ids.orgR,ids.orgS,ids.orgSuspended,ids.schoolB,ids.schoolS,ids.dualRoleS].some(id=>r.includes(id)));
 for(const t of Object.keys(before))assert.deepEqual(strip(after[t]),strip(before[t]),t);
 // ---------- API service against the real database: closed response contracts accept actual output ----------
 const apiView=await service.readSchoolView(humans.staff.subject,ids.schoolA.toUpperCase());
 assert.deepEqual(apiView,view);
 const apiKey=randomUUID(),apiIssue=await service.issueReferralCode(humans.staff.subject,ids.schoolA,apiKey);
 assert.equal(apiIssue.code,code);assert.equal(apiIssue.created,false);assert.deepEqual(await service.issueReferralCode(humans.staff.subject,ids.schoolA,apiKey),{...apiIssue,replayed:true});
 for(const who of ['parent','hqStaff','owner'])await assert.rejects(()=>service.issueReferralCode(humans[who].subject,ids.schoolA,randomUUID()),httpStatus(403,'CHAMPIONS_FORBIDDEN'));
 await assert.rejects(()=>service.readProgram(humans.staff.subject),httpStatus(403));
 assert.equal((await service.readProgram(humans.operator.subject)).published.policyId,immediate.policyId);
 assert.equal((await service.readAttributions(humans.owner.subject,undefined)).attributions.length,4);
 assert.equal((await service.readAttributions(humans.owner.subject,'REFUNDED')).attributions[0].attributionId,r.attributionId);
 await admin.query('BEGIN');await addOrg(ids.orgE);await admin.query('COMMIT');
 await assert.rejects(()=>service.captureAttribution(humans.operator.subject,{referralCode:code,referredOrganizationId:ids.orgA},randomUUID()),httpStatus(422,'CHAMPIONS_SELF_REFERRAL'));
 await assert.rejects(()=>service.captureAttribution(humans.operator.subject,{referralCode:code,referredOrganizationId:ids.orgB},randomUUID()),httpStatus(409,'CHAMPIONS_DUPLICATE_ATTRIBUTION'));
 const e=(await service.captureAttribution(humans.operator.subject,{referralCode:code,referredOrganizationId:ids.orgE},randomUUID())).attribution;
 assert.equal(e.state,'PENDING');
 await assert.rejects(()=>service.decideAttribution(humans.operator.subject,e.attributionId,qualifyBody(1),randomUUID()),httpStatus(403));
 await assert.rejects(()=>service.decideAttribution(humans.owner.subject,e.attributionId,qualifyBody(2),randomUUID()),httpStatus(409,'CHAMPIONS_VERSION_CONFLICT'));
 await assert.rejects(()=>service.decideAttribution(humans.owner.subject,e.attributionId,qualifyBody(1,{paidInvoiceCount:0}),randomUUID()),httpStatus(422,'CHAMPIONS_QUALIFICATION_NOT_MET'));
 const eQualified=(await service.decideAttribution(humans.owner.subject,e.attributionId,qualifyBody(1),randomUUID())).attribution;
 assert.equal(eQualified.state,'QUALIFIED');assert.equal((await service.readSchoolView(humans.staff.subject,ids.schoolA)).referrals.qualified,1);
 assert.equal((await service.decideAttribution(humans.owner.subject,e.attributionId,{decision:'REFUND',reasonCode:'REFUND_ISSUED',expectedVersion:2},randomUUID())).attribution.state,'REFUNDED');
 await assert.rejects(()=>service.decideAttribution(humans.owner.subject,e.attributionId,{decision:'REVERSE',reasonCode:'PAYMENT_REVERSED',expectedVersion:3},randomUUID()),httpStatus(409,'CHAMPIONS_TRANSITION_NOT_ALLOWED'));
 const apiDraft=(await service.createPolicyDraft(humans.operator.subject,terms({minimumPaidInvoices:2}),randomUUID())).policy;
 const apiPublishKey=randomUUID(),apiPublished=await service.publishPolicy(humans.owner.subject,apiDraft.policyId,apiPublishKey);
 assert.equal(apiPublished.retiredPolicyId,immediate.policyId);
 assert.deepEqual(await service.publishPolicy(humans.owner.subject,apiDraft.policyId,apiPublishKey),{...apiPublished,replayed:true});
 await assert.rejects(()=>service.publishPolicy(humans.owner.subject,undecided.policyId,randomUUID()),httpStatus(422,'CHAMPIONS_POLICY_UNDECIDED'));
 await assert.rejects(()=>service.createPolicyDraft(humans.operator.subject,terms({paymentVerificationSource:'CARD_PROCESSOR'}),randomUUID()),httpStatus(400,'INVALID_CHAMPIONS_INPUT'));
 console.log('PASS: Champions Club foundation authority (HQ owner/operator/support, school staff, parent, HQ-dual, inactive, unentitled, context-bound), referral code issue/replay, self (at capture and at qualification)/duplicate/retroactive/suspended/revoked attribution denial, undecided-policy and unavailable-payment-source qualification denial, refund-window/minimum-paid/entitlement/expiry qualification gates, QUALIFIED->REVERSED, PENDING->REJECTED and PENDING->REFUNDED transitions, idempotent replay and key reuse, immutable history/audit/inert outbox, financial rewards pinned disabled, no unrelated table effects, and the API service end to end with closed response contracts on real database output.');
}finally{
 try{await restricted.query('ROLLBACK').catch(()=>{});await cleanup();}finally{await Promise.all([admin.end(),restricted.end(),runtimeDatabase.onModuleDestroy()]);}
}
