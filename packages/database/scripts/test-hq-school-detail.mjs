import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// C-HQ-3 HQ school detail (0225 proposed) integrity proof, TEST MODE, disposable database only. It proves: only a current HQ
// owner or an HQ operator with hq.billing.manage reads it (support, other operators, school owners, lapsed owners and unknown
// subjects are refused, an unknown school is 404 and a bad id 400); the restricted runtime can execute the read but not the
// invitation-count helper; the school, organization access row (identical to the B-HQ-1 overview row), ownership summary,
// invitation counts and people counts match the facts and stay scoped to the one school (a sibling school's rows never
// count); HQ seats are counted apart from owners and never as staff; the viewer flags follow the HQ role; the read writes
// nothing and never returns an email, token or person name.
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
process.env.HON_PUBLIC_ORIGIN='https://hon.example';
const {RuntimeDatabaseService}=await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const {SaasBillingService}=await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const {SaasSchoolBillingService}=await import('../../../apps/api/dist/school-billing/saas-school-billing.service.js');
const database=new RuntimeDatabaseService(),billing=new SaasBillingService(database),access=new SaasSchoolBillingService(billing);
const admin=new pg.Client(targets.owner),restricted=new pg.Client(targets.runtime);
const http=(n,code)=>e=>{assert.equal(e.getStatus?.(),n,e.stack);if(code)assert.equal(e.getResponse().code,code);return true;};
const deny=(p,n,code)=>assert.rejects(p,http(n,code));
const sqlDeny=(p,code)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);return true;});
const ORG=randomUUID(),S=randomUUID(),SIB=randomUUID(),ROLE=randomUUID(),STAFF_ROLE=randomUUID(),FAM=randomUUID(),SIBFAM=randomUUID();
const humans=Object.fromEntries(['owner','exowner','operator','onboarder','support','coOwnerA','coOwnerB','invitedOwner','endedOwner','staff','revokedStaff','futureStaff','sibStaff','parent1','parent2','endedParent','stranger']
 .map(k=>[k,{id:randomUUID(),user:randomUUID(),subject:`hqsd-${k}-${randomUUID()}`}]));
const H=k=>humans[k].subject,P=k=>humans[k].id;
const tok=()=>randomUUID().replace(/-/g,'')+randomUUID().replace(/-/g,'');
const guarded=['school_owner_invitations','school_staff_invitations','school_family_access_invitations','school_primary_owners','school_ownership_notices'];
async function cleanup(){
 await admin.query('ROLLBACK').catch(()=>{});
 await admin.query('BEGIN');try{
  for(const t of guarded)await admin.query(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
  for(const t of guarded)await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  for(const t of guarded)await admin.query(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
  for(const t of ['family_access_grants','student_profiles','families','people','principal_role_grants','role_permissions','roles','organization_entitlements','schools'])
   await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`,[ORG]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1',[ORG]);
  const ps=Object.values(humans).map(h=>h.id),us=Object.values(humans).map(h=>h.user);
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[ps]);
  await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[us]);
  await admin.query('COMMIT');
 }catch(e){await admin.query('ROLLBACK');throw e;}
}
const row=async(sql,params)=>(await admin.query(sql,params)).rows[0];
const q=(sql,params)=>admin.query(sql,params);
const read=(who,school=S)=>access.readHqSchoolDetail(H(who),school);
const writes=async()=>row(`SELECT (SELECT count(*) FROM hon.saas_audit)::int a,(SELECT count(*) FROM hon.saas_requests)::int r,(SELECT count(*) FROM hon.saas_outbox)::int o,
 (SELECT count(*) FROM hon.school_ownership_notices)::int n,(SELECT coalesce(sum(version),0) FROM hon.school_primary_owners)::int p,
 (SELECT coalesce(sum(version),0) FROM hon.organization_entitlements)::int v,(SELECT count(*) FROM hon.principal_role_grants)::int g`);
const grant=async(who,role,school,opts={})=>(await q(`INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from,effective_until,revoked_at,revoked_by_principal_id)
 VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::interval,${opts.until?'clock_timestamp()+$7::interval':'NULL'},${opts.revoked?'clock_timestamp(),$5':'NULL,NULL'}) RETURNING id`,
 [ORG,school,P(who),role,P('owner'),opts.from??'-2 hours',...(opts.until?[opts.until]:[])])).rows[0].id;

await Promise.all([admin.connect(),restricted.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(restricted,CHAMPIONS_RUNTIME_ROLE);
await verifyChampionsProofConnection({query:(...a)=>database['getPool']().query(...a)},CHAMPIONS_RUNTIME_ROLE);
try{
 assert.equal((await admin.query("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).rows[0].m,'HON disposable Champions Club validation');
 // ---------- 0. posture ----------
 for(const[sig,allowed]of [['read_hq_school_detail_from_hq(text,uuid)',true],['hq_school_invitation_counts(text,uuid,timestamptz)',false]])
  assert.equal((await restricted.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') a",['hon.'+sig])).rows[0].a,allowed,sig);
 assert.deepEqual(await row("SELECT prosecdef d,provolatile v,proconfig c FROM pg_proc WHERE oid='hon.read_hq_school_detail_from_hq(text,uuid)'::regprocedure"),
  {d:true,v:'v',c:['search_path=pg_catalog, hon']});
 assert.equal((await row("SELECT prosecdef d FROM pg_proc WHERE oid='hon.hq_school_invitation_counts(text,uuid,timestamptz)'::regprocedure")).d,false,'the helper is invoker');
 await cleanup();

 // ---------- fixture ----------
 await q('BEGIN');
 for(const h of Object.values(humans)){await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_PERSON_NAME')",[h.user,h.subject,`${h.user}@example.test`]);await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_PERSON_NAME',true)",[h.id,h.user]);}
 for(const[who,hqRole,perms,until]of [['owner','HON_HQ_OWNER',[],null],['exowner','HON_HQ_OWNER',[],'1 minute'],['operator','HON_HQ_OPERATOR',['hq.billing.manage'],null],
  ['onboarder','HON_HQ_OPERATOR',['hq.onboarding.manage','hq.dashboard.view'],null],['support','HON_HQ_SUPPORT',['hq.billing.manage'],null]])
  await q(`INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,$2,$3,clock_timestamp()-interval '1 hour',${until?`clock_timestamp()-interval '${until}'`:'NULL'})`,[P(who),hqRole,perms]);
 await q("INSERT INTO hon.organizations(id,legal_name,display_name,status,created_at) VALUES($1,'HQSD Fixture Dojo','HQSD Fixture Dojo','ACTIVE',clock_timestamp())",[ORG]);
 await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'CORE','ACTIVE',clock_timestamp()-interval '90 days')",[ORG]);
 await q("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,$3,$1::text,'America/Chicago')",[S,ORG,'HQSD School '+'x'.repeat(320)]);
 await q("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'HQSD Sibling',$1::text,'UTC')",[SIB,ORG]);
 await q("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','School Owner',true),($3,$2,'HQSD_STAFF','Front desk',false)",[ROLE,ORG,STAFF_ROLE]);
 await q("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions",[ROLE,ORG]);
 await q('COMMIT');

 // ---------- 1. authority and input ----------
 for(const who of ['support','onboarder','exowner','stranger'])await deny(read(who),403,'SAAS_FORBIDDEN');
 await deny(access.readHqSchoolDetail('hqsd-unknown-'+randomUUID(),S),403,'SAAS_FORBIDDEN');
 await deny(read('owner',randomUUID()),404,'SAAS_UNAVAILABLE');
 await deny(read('operator',randomUUID()),404,'SAAS_UNAVAILABLE');
 // A stranger never learns whether a school exists: authority is decided before the lookup.
 await deny(read('stranger',randomUUID()),403,'SAAS_FORBIDDEN');
 for(const bad of ['not-a-uuid','',null,42,S.toUpperCase()+'x'])await deny(read('owner',bad),400,'INVALID_SAAS_INPUT');
 await sqlDeny(restricted.query('SELECT hon.read_hq_school_detail_from_hq($1,NULL)',[H('owner')]),'22023');
 await sqlDeny(restricted.query("SELECT hon.hq_school_invitation_counts('OWNER',$1,now())",[S]),'42501');

 // ---------- 2. an empty school ----------
 const t0=await writes();
 let d=await read('owner');
 assert.deepEqual(d.school,{schoolId:S,schoolDisplayName:('HQSD School '+'x'.repeat(320)).slice(0,300),slug:S,timezone:'America/Chicago',schoolStatus:'ACTIVE',createdAt:d.school.createdAt});
 assert.equal(d.organization.organizationId,ORG); assert.equal(d.organization.accessStatus,'PROVISIONED_ACCESS');
 assert(d.organization.schools.some(s=>s.schoolId===S)&&d.organization.schools.some(s=>s.schoolId===SIB));
 assert.deepEqual(d.ownership,{ownerCount:0,primaryOwnerGrantId:null,primaryNeeded:false,hqSeatCount:0});
 const zero={pending:0,expired:0,accepted:0,revoked:0,ended:0};
 assert.deepEqual(d.invitations,{owner:zero,staff:zero,family:zero});
 assert.deepEqual(d.people,{staffWithAccess:0,familyMembersWithAccess:0,activeStudents:0});
 assert.deepEqual(d.viewer,{canGrantAndRevokeExceptions:true,canManageOwnership:true});
 const op=await read('operator');
 assert.deepEqual(op.viewer,{canGrantAndRevokeExceptions:false,canManageOwnership:false},'an operator reads but never manages');
 assert.deepEqual({...op,viewer:null,asOf:null},{...d,viewer:null,asOf:null},'owner and operator see the same facts');
 // The organization row is exactly the B-HQ-1 overview row for the same organization.
 let ov=(await access.readAccessOverview(H('owner'),{limit:'100'}));let found=ov.organizations.find(r=>r.organizationId===ORG);
 while(!found&&ov.nextCursor){const {encodeSaasAccessOverviewCursor}=await import('@hon/contracts');ov=await access.readAccessOverview(H('owner'),{limit:'100',cursor:encodeSaasAccessOverviewCursor(ov.nextCursor)});found=ov.organizations.find(r=>r.organizationId===ORG);}
 assert.deepEqual(d.organization,found,'same row as the overview');

 // ---------- 3. ownership, HQ seat and staff ----------
 const seat=await grant('owner',ROLE,S);                       // HQ seat: the provisioning HQ owner
 const a=await grant('coOwnerA',ROLE,S,{from:'-3 hours'});
 await grant('coOwnerB',ROLE,S);
 await grant('endedOwner',ROLE,S,{from:'-5 hours',until:'-1 hour'});
 await grant('staff',STAFF_ROLE,S);
 await grant('staff',STAFF_ROLE,S,{from:'-1 hour'});            // a second grant: still one person
 await grant('revokedStaff',STAFF_ROLE,S,{revoked:true});
 await grant('futureStaff',STAFF_ROLE,S,{from:'+2 hours'});
 await grant('sibStaff',STAFF_ROLE,SIB);                        // sibling school only
 d=await read('owner');
 assert.deepEqual(d.ownership,{ownerCount:2,primaryOwnerGrantId:null,primaryNeeded:true,hqSeatCount:1});
 assert.equal(d.people.staffWithAccess,3,'coOwnerA, coOwnerB, staff: never the HQ seat, ended, revoked, future or sibling grants');
 await q("INSERT INTO hon.school_primary_owners(school_id,organization_id,owner_grant_id,source,designated_by,designated_at) VALUES($1,$2,$3,'FIRST_OWNER',$4,clock_timestamp())",[S,ORG,a,P('coOwnerA')]);
 d=await read('owner');
 assert.deepEqual(d.ownership,{ownerCount:2,primaryOwnerGrantId:a,primaryNeeded:false,hqSeatCount:1});
 // The primary owner's grant ends: the school shows primaryNeeded again.
 await q('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1',[a]);
 d=await read('owner');
 assert.deepEqual(d.ownership,{ownerCount:1,primaryOwnerGrantId:null,primaryNeeded:true,hqSeatCount:1});
 assert.equal(d.people.staffWithAccess,2);
 assert.notEqual(seat,null);

 // ---------- 4. invitation counts ----------
 const okGrant=await grant('invitedOwner',ROLE,S,{from:'-30 minutes'});
 const stGrant=await grant('staff',STAFF_ROLE,S,{from:'-30 minutes'});
 await q('BEGIN');
 for(const t of ['school_owner_invitations','school_staff_invitations','school_family_access_invitations'])await q(`ALTER TABLE hon.${t} DISABLE TRIGGER USER`);
 const ownerInv=(school,status,extra={})=>q(`INSERT INTO hon.school_owner_invitations(organization_id,school_id,email,token_hash,created_by,created_at,expires_at,status,accepted_subject,owner_grant_id,accepted_at,revoked_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::interval,clock_timestamp()+$7::interval,$8,$9,$10,$11,$12)`,
  [ORG,school,`owner-${randomUUID()}@example.test`,tok(),P('owner'),extra.created??'-1 hour',extra.expires??'+5 days',status,extra.subject??null,extra.grant??null,extra.grant?new Date():null,status==='REVOKED'?new Date():null]);
 await ownerInv(S,'PENDING'); await ownerInv(S,'PENDING'); await ownerInv(S,'PENDING',{created:'-3 days',expires:'-1 day'});
 await ownerInv(S,'REVOKED'); await ownerInv(S,'ACCEPTED',{subject:H('invitedOwner'),grant:okGrant}); await ownerInv(SIB,'PENDING');
 const staffInv=(school,status,extra={})=>q(`INSERT INTO hon.school_staff_invitations(organization_id,school_id,role_id,email,token_hash,created_by,created_at,expires_at,status,accepted_subject,role_grant_id,accepted_at,revoked_at)
  VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::interval,clock_timestamp()+$8::interval,$9,$10,$11,$12,$13)`,
  [ORG,school,STAFF_ROLE,`staff-${randomUUID()}@example.test`,tok(),P('owner'),extra.created??'-1 hour',extra.expires??'+5 days',status,extra.subject??null,extra.grant??null,extra.grant?new Date():null,status==='REVOKED'?new Date():null]);
 await staffInv(S,'PENDING'); await staffInv(S,'PENDING',{created:'-8 days',expires:'-2 days'}); await staffInv(S,'PENDING',{created:'-6 days',expires:'-5 days'});
 await staffInv(S,'ACCEPTED',{subject:H('staff'),grant:stGrant}); await staffInv(SIB,'REVOKED');
 // Families, people and students.
 await q("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY'),($4,$2,$5,'PRIVATE_FAMILY')",[FAM,ORG,S,SIBFAM,SIB]);
 const fg=async(who,fam,school,opts={})=>(await q(`INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,effective_until,granted_by_principal_id)
  VALUES($1,$2,$3,$4,'PRIMARY_GUARDIAN',clock_timestamp()+$5::interval,${opts.until?'clock_timestamp()+$7::interval':'NULL'},$6) RETURNING id`,[ORG,school,fam,P(who),opts.from??'-1 hour',P('owner'),...(opts.until?[opts.until]:[])])).rows[0].id;
 const g1=await fg('parent1',FAM,S); await fg('parent1',FAM,S,{from:'-2 hours',until:'-90 minutes'});
 await fg('parent2',FAM,S); const ge=await fg('endedParent',FAM,S,{from:'-3 hours',until:'-1 hour'}); await fg('stranger',SIBFAM,SIB);
 const famInv=(school,fam,status,extra={})=>q(`INSERT INTO hon.school_family_access_invitations(organization_id,school_id,family_id,access_level,email,token_hash,created_by,created_at,expires_at,status,accepted_subject,access_grant_id,accepted_at,revoked_at,ended_at,ended_by)
  VALUES($1,$2,$3,'PRIMARY_GUARDIAN',$4,$5,$6,clock_timestamp()-interval '1 hour',clock_timestamp()+$7::interval,$8,$9,$10,$11,$12,$13,$14)`,
  [ORG,school,fam,`family-${randomUUID()}@example.test`,tok(),P('owner'),extra.expires??'+5 days',status,extra.subject??null,extra.grant??null,extra.grant?new Date():null,status==='REVOKED'?new Date():null,status==='ENDED'?new Date():null,status==='ENDED'?P('owner'):null]);
 await famInv(S,FAM,'PENDING'); await famInv(S,FAM,'REVOKED'); await famInv(S,FAM,'ACCEPTED',{subject:H('parent1'),grant:g1});
 await famInv(S,FAM,'ENDED',{subject:H('endedParent'),grant:ge}); await famInv(SIB,SIBFAM,'PENDING');
 for(const t of ['school_owner_invitations','school_staff_invitations','school_family_access_invitations'])await q(`ALTER TABLE hon.${t} ENABLE TRIGGER USER`);
 for(const[school,status]of [[S,'ACTIVE'],[S,'ACTIVE'],[S,'SUSPENDED'],[S,'ARCHIVED'],[SIB,'ACTIVE']]){
  const person=(await q("INSERT INTO hon.people(organization_id,school_id,given_name,family_name) VALUES($1,$2,'PRIVATE','PERSON') RETURNING id",[ORG,school])).rows[0].id;
  await q('INSERT INTO hon.student_profiles(organization_id,school_id,person_id,status) VALUES($1,$2,$3,$4)',[ORG,school,person,status]);
 }
 await q('COMMIT');
 const t1=await writes();
 d=await read('owner');
 assert.deepEqual(d.invitations,{
  owner:{pending:2,expired:1,accepted:1,revoked:1,ended:0},
  staff:{pending:1,expired:2,accepted:1,revoked:0,ended:0},
  family:{pending:1,expired:0,accepted:1,revoked:1,ended:1}});
 assert.deepEqual(d.people,{staffWithAccess:3,familyMembersWithAccess:2,activeStudents:2});
 assert.deepEqual(d.ownership,{ownerCount:2,primaryOwnerGrantId:null,primaryNeeded:true,hqSeatCount:1});

 // ---------- 5. independent recount ----------
 const indep=await row(`SELECT
  (SELECT count(DISTINCT principal_id) FROM hon.principal_role_grants g WHERE school_id=$1 AND revoked_at IS NULL AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())
    AND principal_id<>ALL($2::uuid[]))::int staff,
  (SELECT count(DISTINCT principal_id) FROM hon.family_access_grants WHERE school_id=$1 AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()))::int fam,
  (SELECT count(*) FROM hon.student_profiles WHERE school_id=$1 AND status='ACTIVE')::int st`,[S,[P('owner'),P('exowner'),P('operator'),P('onboarder'),P('support')]]);
 assert.deepEqual(d.people,{staffWithAccess:indep.staff,familyMembersWithAccess:indep.fam,activeStudents:indep.st});

 // ---------- 6. writes nothing, names nobody ----------
 for(let i=0;i<3;i++){await read('owner');await read('operator');}
 assert.deepEqual(await writes(),t1,'reads write nothing');
 assert.equal(t0.v,t1.v,'no entitlement changed');
 const text=JSON.stringify(d);
 assert(!/@example\.test/.test(text),'no email');
 assert(!/PRIVATE_/.test(text),'no person or family name');
 const tokens=(await q('SELECT token_hash FROM hon.school_owner_invitations WHERE organization_id=$1 UNION ALL SELECT token_hash FROM hon.school_staff_invitations WHERE organization_id=$1 UNION ALL SELECT token_hash FROM hon.school_family_access_invitations WHERE organization_id=$1',[ORG])).rows;
 assert(tokens.length>0&&tokens.every(r=>!text.includes(r.token_hash)),'no token');
 for(const h of Object.values(humans))assert(!text.includes(h.subject)&&!text.includes(h.id),'no subject or principal id');

 // ---------- 7. a reader revoked meanwhile gets nothing ----------
 await q("UPDATE hon.hq_operator_grants SET effective_until=clock_timestamp() WHERE principal_id=$1",[P('operator')]);
 await deny(read('operator'),403,'SAAS_FORBIDDEN');
 // A suspended school is still shown to HQ (HQ fixes and changes schools), with its status.
 await q("UPDATE hon.schools SET status='SUSPENDED' WHERE id=$1",[S]);
 d=await read('owner');
 assert.equal(d.school.schoolStatus,'SUSPENDED');
 assert.equal(d.ownership.ownerCount,0,'no live owner at a suspended school');
 console.log('HQ school detail proof passed (authority, input, empty school, overview-row parity, ownership/HQ seat, invitation and people counts scoped to one school, no writes, no personal data).');
}finally{
 try{await cleanup();}finally{await Promise.allSettled([admin.end(),restricted.end(),database.onModuleDestroy?.()]);}
}
