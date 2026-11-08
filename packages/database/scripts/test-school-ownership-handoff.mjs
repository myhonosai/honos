// B-ID-4 school ownership (0223 proposed) integrity proof, TEST MODE, disposable Champions Club database only.
// Owner decisions 2026-11-08: H-4, H-5 and "keep HQ owner seats" (which replaced H-1..H-3). It proves, through the
// restricted runtime role: provisioning still makes the HQ provisioner an OWNER of the school (the HQ seat) and that seat
// keeps working after a real owner accepts; no command or acceptance ends it and there is no cleanup surface; HQ seats are
// shown to HQ but never listed as school owners or made primary; H-4 the first owner becomes primary, an HQ owner can move
// it, a revoked primary is reported as needed; H-5 existing owners get OWNER_INVITED / OWNER_ADDED notices. Only HQ owners
// use the HQ entry points; only a live non-HQ owner of that school reads the school view. Evidence rows are immutable.
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import { verifySchoolAccountSecurity } from './school-account-security.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID as K, randomBytes } from 'node:crypto';
await import('./test-champions-proof-target.mjs');
const targets=championsProofTargets(process.env);
if(Object.keys(process.env).some(key=>/^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key)))throw new Error('Provider credentials/execution switches are forbidden.');
const admin=new pg.Client(targets.owner),rt=new pg.Client(targets.runtime);
const q=async(sql,args=[])=>(await admin.query(sql,args)).rows;
const call=async(sql,args)=>(await rt.query(sql,args)).rows[0].r;
const deny=(p,code,msg)=>assert.rejects(p,e=>{assert.equal(e.code,code,e.stack);if(msg)assert.match(e.message,msg);return true;});
const hex=()=>randomBytes(32).toString('hex');
let groups=0;const pass=n=>console.log(`PASS B-ID-4 ${++groups}: ${n}`);

const tag=K().slice(0,8);
const hq={subject:`bid4-hq-${tag}`,user:K(),principal:K()},op={subject:`bid4-op-${tag}`,user:K(),principal:K()};
const owners=Object.fromEntries(['a1','a2','l1','m1','x','exhq'].map(k=>[k,{subject:`oidc:bid4:${k}:${K()}`,email:`bid4-${k}-${tag}@example.invalid`}]));
async function inviteWith(school,email){const tokenHash=hex();const r=await call("SELECT hon.manage_school_owner_invitation($1,'INVITE',$2::jsonb,$3) r",[hq.subject,JSON.stringify({schoolId:school,email,tokenHash,ttlHours:24}),K()]);return {...r,tokenHash};}
const accept=(who,inv,key=K())=>call('SELECT hon.accept_school_owner_invitation($1,$2,$3::jsonb,$4) r',[owners[who].subject,owners[who].email,JSON.stringify({invitationId:inv.invitationId,tokenHash:inv.tokenHash,confirmation:'ACCEPT_SCHOOL_OWNER_INVITATION'}),key]);
const ownership=(school,who=hq.subject)=>call('SELECT hon.read_school_ownership_from_hq($1,$2) r',[who,school]);
const manage=(op_,input,key=K(),who=hq.subject)=>call('SELECT hon.manage_school_ownership($1,$2,$3::jsonb,$4) r',[who,op_,JSON.stringify(input),key]);
const schoolView=(who,school)=>call('SELECT hon.read_school_ownership($1,$2) r',[who,school]);
const notices=async school=>(await q('SELECT kind,invited_email FROM hon.school_ownership_notices WHERE school_id=$1 ORDER BY occurred_at,id',[school]));
const hqGrants=async school=>(await q("SELECT g.id FROM hon.principal_role_grants g JOIN hon.roles r ON r.id=g.role_id AND r.code='OWNER' WHERE g.school_id=$1 AND g.principal_id=$2 AND (g.effective_until IS NULL OR g.effective_until>clock_timestamp()) ORDER BY g.id",[school,hq.principal])).map(r=>r.id);
let n=0;
const provision=async()=>(await q("SELECT organization_id \"organizationId\",school_id \"schoolId\",owner_role_id \"roleId\" FROM hon.provision_school_from_hq($1,'B-ID-4 synthetic','B-ID-4 synthetic','B-ID-4 school',$2,'UTC','COMPLETE',$3,$3,$4,$4)",[hq.subject,`bid4-${tag}-${++n}`,K(),K()]))[0];

await Promise.all([admin.connect(),rt.connect()]);
await verifyChampionsProofConnection(admin,CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection(rt,CHAMPIONS_RUNTIME_ROLE);
try{
 // ---------- posture ----------
 await verifySchoolAccountSecurity(admin,CHAMPIONS_RUNTIME_ROLE);
 const entry=['read_school_ownership_from_hq(text,uuid)','manage_school_ownership(text,text,jsonb,uuid)','read_school_ownership(text,uuid)'];
 const helpers=['school_owner_review_or_busy(uuid)','guard_school_primary_owner()','school_owner_grant_rows(uuid,timestamptz)','school_live_primary_grant(uuid,timestamptz)','school_set_primary_owner(uuid,uuid,uuid,text,uuid,timestamptz)',
  'school_ownership_owner_json(uuid,timestamptz,uuid)','school_ownership_notices_json(uuid)'];
 for(const f of [...entry,...helpers]){
  const r=(await q("SELECT has_function_privilege($1,$2,'EXECUTE') ok,p.prosecdef d,p.proconfig c,(SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0)::int pub FROM pg_proc p WHERE p.oid=$2::regprocedure",[CHAMPIONS_RUNTIME_ROLE,'hon.'+f]))[0];
  assert.equal(r.ok,entry.includes(f),f);assert.equal(r.d,entry.includes(f),f);assert.equal(r.pub,0,f);assert(r.c.includes('search_path=pg_catalog, hon'),f);
 }
 for(const f of ['read_hq_owner_grant_cleanup(text)','school_end_hq_owner_grants(uuid,timestamptz,uuid,text,uuid)'])
  assert.equal((await q('SELECT to_regprocedure($1) p',['hon.'+f]))[0].p,null,f+' must not exist (HQ seats are kept)');
 pass('three private tables are forced deny-all; only the three entry points reach the runtime; helpers are invoker-only and ungranted');

 // ---------- fixture identities ----------
 for(const [a,role,perms]of [[hq,'HON_HQ_OWNER',[]],[op,'HON_HQ_OPERATOR',['hq.onboarding.manage','hq.billing.manage']]]){
  await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'B-ID-4 synthetic HQ')",[a.user,a.subject,a.user+'@example.invalid']);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','B-ID-4 synthetic HQ')",[a.principal,a.user]);
  await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from) VALUES($1,$2,$3,clock_timestamp()-interval '2 days')",[a.principal,role,perms]);
 }

 // ---------- HQ seat at provisioning ----------
 const A=await provision(),L=await provision();
 for(const s of [A,L]){
  const g=await q('SELECT principal_id,role_id,effective_until,revoked_at FROM hon.principal_role_grants WHERE organization_id=$1',[s.organizationId]);
  assert.deepEqual(g,[{principal_id:hq.principal,role_id:s.roleId,effective_until:null,revoked_at:null}]);
 }
 const [lSeat]=await hqGrants(L.schoolId);
 const fresh=await ownership(L.schoolId);
 assert.deepEqual({o:fresh.owners,p:fresh.primaryOwnerGrantId,need:fresh.primaryNeeded,hq:fresh.hqOwnerGrantIds},{o:[],p:null,need:false,hq:[lSeat]});
 assert.equal('hqOwnerCleanup' in fresh,false);
 await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_from=clock_timestamp()-interval '1 day',effective_until=NULL WHERE organization_id=$1",[L.organizationId]);
 assert.notEqual((await q('SELECT hon.school_staff_manager($1,$2) m',[hq.subject,L.schoolId]))[0].m,null,'HQ seat reaches the school');
 pass('provisioning gives the HQ provisioner an open-ended OWNER seat; HQ sees it as an HQ seat, not a school owner; it works once the school is active');

 // ---------- acceptance keeps the HQ seat; H-4 first owner ----------
 const invL=await inviteWith(L.schoolId,owners.l1.email);
 assert.deepEqual(await notices(L.schoolId),[],'an HQ seat is not an owner to notify');
 await accept('l1',invL);
 assert.deepEqual(await hqGrants(L.schoolId),[lSeat],'HQ seat kept');
 assert.deepEqual((await q('SELECT effective_until,revoked_at FROM hon.principal_role_grants WHERE id=$1',[lSeat]))[0],{effective_until:null,revoked_at:null});
 assert.notEqual((await q('SELECT hon.school_staff_manager($1,$2) m',[hq.subject,L.schoolId]))[0].m,null,'HQ seat still reaches the school');
 const lView=await ownership(L.schoolId);
 assert.equal(lView.owners.length,1);assert.equal(lView.owners[0].email,owners.l1.email);assert.equal(lView.owners[0].primary,true);assert.equal(lView.owners[0].viaInvitation,true);
 assert.equal(lView.primaryOwnerGrantId,lView.owners[0].ownerGrantId);assert.deepEqual(lView.hqOwnerGrantIds,[lSeat]);
 assert.deepEqual(await notices(L.schoolId),[]);
 assert.equal((await q("SELECT count(*)::int n FROM hon.audit_events WHERE action_code='school.owner.hq_grant.end'"))[0].n,0);
 await deny(manage('SET_PRIMARY',{schoolId:L.schoolId,ownerGrantId:lSeat}),'P0002',/OWNERSHIP_OWNER_NOT_LIVE/);
 await deny(manage('END_HQ_OWNER_GRANTS',{schoolId:L.schoolId,expectedGrantIds:[lSeat]}),'22023');
 await deny(schoolView(hq.subject,L.schoolId),'42501');
 assert.deepEqual(await hqGrants(L.schoolId),[lSeat]);
 pass('a school owner accepting leaves the HQ seat open (no end, audit or notice); the first owner becomes primary (H-4); an HQ seat cannot be primary or use the owner view; no end command exists');

 // A former (or future) HQ person cannot accept an owner invitation (staff_member_eligible rule): HQ reaches schools through its seat.
 const ex={user:K(),principal:K()};
 await q("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'B-ID-4 former HQ')",[ex.user,owners.exhq.subject,owners.exhq.email]);
 await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','B-ID-4 former HQ')",[ex.principal,ex.user]);
 await q("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,effective_from,effective_until) VALUES($1,'HON_HQ_OPERATOR','{}',clock_timestamp()-interval '3 days',clock_timestamp()-interval '2 days')",[ex.principal]);
 const invEx=await inviteWith(L.schoolId,owners.exhq.email);
 assert.deepEqual((await notices(L.schoolId)).map(x=>x.kind),['OWNER_INVITED']);
 await deny(accept('exhq',invEx),'23514',/ACCOUNT_REVIEW_REQUIRED/);
 assert.equal((await q('SELECT status FROM hon.school_owner_invitations WHERE id=$1',[invEx.invitationId]))[0].status,'PENDING');
 assert.equal((await q('SELECT count(*)::int n FROM hon.principal_role_grants WHERE principal_id=$1',[ex.principal]))[0].n,0);
 await q("UPDATE hon.hq_operator_grants SET effective_from=clock_timestamp()+interval '1 day',effective_until=NULL WHERE principal_id=$1",[ex.principal]);
 await deny(accept('exhq',invEx),'23514',/ACCOUNT_REVIEW_REQUIRED/);
 assert.deepEqual((await ownership(L.schoolId)).owners.map(o=>o.email),[owners.l1.email]);
 pass('a person with an expired or future HQ row cannot accept an owner invitation (refused before any write)');

 // ---------- H-4 / H-5 at A ----------
 const inv1=await inviteWith(A.schoolId,owners.a1.email);await accept('a1',inv1);
 assert.deepEqual(await notices(A.schoolId),[]);
 const inv2=await inviteWith(A.schoolId,owners.a2.email);
 assert.deepEqual(await notices(A.schoolId),[{kind:'OWNER_INVITED',invited_email:owners.a2.email}]);
 await accept('a2',inv2);
 assert.deepEqual((await notices(A.schoolId)).map(x=>x.kind),['OWNER_INVITED','OWNER_ADDED']);
 let aView=await ownership(A.schoolId);
 const [g1,g2]=aView.owners.map(o=>o.ownerGrantId);
 assert.equal(aView.owners.length,2);assert.equal(aView.hqOwnerGrantIds.length,1,'HQ seat still there');assert.equal(aView.primaryOwnerGrantId,g1,'first owner stays primary');
 // School owner view: both owners see the notices; others are refused.
 const v2=await schoolView(owners.a2.subject,A.schoolId);
 assert.equal(v2.yourOwnerGrantId,g2);assert.equal(v2.primaryOwnerGrantId,g1);
 assert.deepEqual(v2.notices.map(x=>x.kind),['OWNER_ADDED','OWNER_INVITED']);
 assert(!JSON.stringify(v2).includes('token'));
 for(const who of [hq.subject,op.subject,owners.l1.subject,owners.x.subject,'unknown'])await deny(schoolView(who,A.schoolId),'42501');
 const pKey=K(),moved=await manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:g2},pKey);
 assert.deepEqual({c:moved.changed,p:moved.primaryOwnerGrantId},{c:true,p:g2});
 assert.deepEqual(await manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:g2},pKey),moved);
 assert.equal((await manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:g2})).changed,false);
 await deny(manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:lView.owners[0].ownerGrantId}),'P0002',/OWNERSHIP_OWNER_NOT_LIVE/);
 await deny(manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:g2},K(),op.subject),'42501');
 assert.equal((await notices(A.schoolId)).at(-1).kind,'PRIMARY_OWNER_CHANGED');
 // Revoking the primary owner's invitation ends its grant: the school needs a new primary, the other owner stays.
 await call("SELECT hon.manage_school_owner_invitation($1,'REVOKE',$2::jsonb,$3) r",[hq.subject,JSON.stringify({invitationId:inv2.invitationId}),K()]);
 aView=await ownership(A.schoolId);
 assert.deepEqual({n:aView.owners.length,p:aView.primaryOwnerGrantId,need:aView.primaryNeeded},{n:1,p:null,need:true});
 await deny(schoolView(owners.a2.subject,A.schoolId),'42501');
 assert.equal((await manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:g1})).primaryOwnerGrantId,g1);
 pass('H-4/H-5: first owner is primary; existing owners get invited and added notices; HQ owner moves primary (replay, no-op, refusals); a revoked primary is reported as needed');

 // ---------- authority and immutability ----------
 for(const f of [()=>ownership(A.schoolId,op.subject),()=>ownership(A.schoolId,'unknown'),()=>ownership(A.schoolId,owners.a1.subject)])await deny(f(),'42501');
 await deny(ownership(K()),'P0002');
 await deny(manage('SET_PRIMARY',{schoolId:A.schoolId,ownerGrantId:g1,extra:1}),'22023');
 await deny(manage('NOPE',{schoolId:A.schoolId}),'22023');
 await deny(q('UPDATE hon.school_ownership_notices SET kind=kind'),'42501');
 await deny(q('DELETE FROM hon.school_ownership_requests'),'42501');
 await deny(q('UPDATE hon.school_primary_owners SET designated_at=designated_at WHERE school_id=$1',[A.schoolId]),'42501');
 await deny(q('DELETE FROM hon.school_primary_owners WHERE school_id=$1',[A.schoolId]),'42501');
 for(const t of ['school_primary_owners','school_ownership_notices','school_ownership_requests'])await deny(rt.query(`SELECT 1 FROM hon.${t} LIMIT 1`),'42501');
 pass('HQ reads and commands are HQ-owner only; input is closed; notices and requests are immutable; primary rows only move with a version bump; runtime has no table access');
 console.log(`School ownership proof passed (${groups} groups; HQ seats kept, H-4, H-5; no entitlement, billing, payment, AI credit or delivery effect).`);
}finally{
 await Promise.allSettled([admin.end(),rt.end()]);
}
