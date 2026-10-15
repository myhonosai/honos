import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { StaffRoleService } from '../../../apps/api/dist/staff-roles/staff-role.service.js';
import { StaffRoleController } from '../../../apps/api/dist/staff-roles/staff-role.controller.js';
import { RuntimeDatabaseService } from '../../../apps/api/dist/foundation/runtime-database.service.js';

if (!process.env.DATABASE_URL || !process.env.HON_RUNTIME_DATABASE_URL) throw new Error('Both admin and restricted runtime database URLs are required.');
const opts = connectionString => ({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false } });
const admin = new pg.Client(opts(process.env.DATABASE_URL));
const runtime = new pg.Client(opts(process.env.HON_RUNTIME_DATABASE_URL));
const db = new RuntimeDatabaseService(); const service = new StaffRoleService(db); const controller = new StaffRoleController(db, service);
const ids = Object.fromEntries(['org','otherOrg','a','b','other','owner','weakRole','desk','strong','system','foreignRole','ownerGrant','weakGrant','systemGrant'].map(k => [k,randomUUID()]));
const humans = Object.fromEntries(['actor','weak','target','hq','privileged','inactive'].map(k => [k,{ user: randomUUID(), id: randomUUID(), subject: `staff-${k}-${randomUUID()}` }]));
const ai = randomUUID(); const orgs = [ids.org,ids.otherOrg];
const actions = ['iam.custom_role.create','iam.custom_role.update','iam.staff_role.grant','iam.staff_role.revoke'];
const context = (who='actor',school=ids.a,key=randomUUID()) => ({organizationId:ids.org,schoolId:school,principalId:humans[who].id,externalSubject:humans[who].subject,principalType:'HUMAN_USER',source:'HUMAN_UI',idempotencyKey:key,requestId:randomUUID(),correlationId:randomUUID()});
const input = (roleId=ids.desk,who='target') => ({roleId,targetPrincipalId:humans[who].id,targetExternalSubject:humans[who].subject});
const status = n => e => { assert.equal(e.getStatus(),n); return true; };
const denied = (fn,n=403) => assert.rejects(async()=>fn(),status(n));
const sqlDenied = (fn,code='42501') => assert.rejects(fn,e=>{assert.equal(e.code,code);return true;});
const count = async table => Number((await admin.query(`SELECT count(*) n FROM hon.${table} WHERE organization_id=ANY($1::uuid[])`,[orgs])).rows[0].n);
let triggerInstalled=false;
async function cleanup() {
  await admin.query('ROLLBACK');
  if (triggerInstalled) { await admin.query('DROP TRIGGER IF EXISTS staff_role_test_failure ON hon.outbox_events'); await admin.query('DROP FUNCTION IF EXISTS hon.staff_role_test_failure()'); }
  await admin.query('BEGIN');
  try {
    for (const t of ['outbox_delivery_attempts','outbox_events','audit_events','idempotency_records','principal_role_grants','organization_entitlements']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=ANY($1::uuid[])`,[orgs]);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.id)]);
    await admin.query('DELETE FROM hon.roles WHERE organization_id=ANY($1::uuid[])',[orgs]);
    await admin.query('DELETE FROM hon.principals WHERE id=ANY($1::uuid[])',[[...Object.values(humans).map(h=>h.id),ai]]);
    await admin.query('DELETE FROM hon.users WHERE id=ANY($1::uuid[])',[Object.values(humans).map(h=>h.user)]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id=ANY($1::uuid[])',[orgs]);
    await admin.query('DELETE FROM hon.organizations WHERE id=ANY($1::uuid[])',[orgs]);
    await admin.query('COMMIT');
  } catch(e) { await admin.query('ROLLBACK'); throw e; }
}
await Promise.all([admin.connect(),runtime.connect()]);
try {
  for (const t of ['users','principals','roles','permissions','role_permissions','principal_role_grants','hq_operator_grants']) {
    const priv=(await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') p",[`hon.${t}`])).rows[0].p;
    assert.equal(priv,false); await sqlDenied(()=>runtime.query(`SELECT * FROM hon.${t} LIMIT 1`));
  }
  await sqlDenied(()=>runtime.query('SELECT hon.resolve_staff_role_target($1,$2,$3)',[humans.target.id,humans.target.subject,humans.actor.id]));
  const posture=(await admin.query(`SELECT p.proname,p.prosecdef,p.proconfig,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='hon_runtime'))) broad
    FROM pg_proc p WHERE p.pronamespace='hon'::regnamespace AND p.proname IN('mutate_staff_role','read_staff_role','resolve_staff_role_target')`)).rows;
  assert.equal(posture.length,3); for(const p of posture){assert(p.prosecdef);assert.deepEqual(p.proconfig,['search_path=pg_catalog, hon']);assert.equal(p.broad,false);}
  const perms=(await admin.query("SELECT code,is_sensitive FROM hon.permissions WHERE code LIKE 'iam.%'")).rows;
  assert.equal(perms.length,5); assert(perms.every(p=>p.is_sensitive));
  const rls=(await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='hon.role_permissions'::regclass")).rows[0];assert(rls.relrowsecurity&&rls.relforcerowsecurity);
  await admin.query('BEGIN');
  for(const org of orgs) await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',[org,'Staff role integrity fixture']);
  for(const [id,org] of [[ids.a,ids.org],[ids.b,ids.org],[ids.other,ids.otherOrg]]) await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1::uuid,$2,$3,$1::text)',[id,org,'School fixture']);
  for(const [key,h] of Object.entries(humans)) {
    await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)',[h.user,h.subject,`${h.user}@example.test`,'PRIVATE_CONTACT']);
    await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_CONTACT',$3)",[h.id,h.user,key!=='inactive']);
  }
  await admin.query("INSERT INTO hon.principals(id,principal_type,display_name) VALUES($1,'AI_EMPLOYEE','AI fixture')",[ai]);
  for(const [id,org,code,system] of [[ids.owner,ids.org,'OWNER',true],[ids.system,ids.org,'SYSTEM_ADMIN',true],[ids.weakRole,ids.org,'WEAK',false],[ids.desk,ids.org,'FRONT_DESK',false],[ids.strong,ids.org,'STRONG',false],[ids.foreignRole,ids.otherOrg,'FRONT_DESK',false]]) await admin.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,$4)',[id,org,code,system]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions',[ids.owner,ids.org]);
  for(const p of ['school.view','iam.staff_role.manage',...actions]) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[ids.weakRole,ids.org,p]);
  for(const [role,org,p] of [[ids.desk,ids.org,'school.view'],[ids.strong,ids.org,'reporting.view'],[ids.system,ids.org,'school.view'],[ids.foreignRole,ids.otherOrg,'school.view']]) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[role,org,p]);
  for(const [id,principal,role,school] of [[ids.ownerGrant,humans.actor.id,ids.owner,ids.a],[ids.weakGrant,humans.weak.id,ids.weakRole,ids.a],[ids.systemGrant,humans.privileged.id,ids.system,ids.b]]) await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')",[id,ids.org,school,principal,role]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes,granted_by_principal_id) VALUES($1,'HON_HQ_SUPPORT',ARRAY['hq.support.read'],$1)",[humans.hq.id]);
  await admin.query('COMMIT');

  const prohibited=['communication_messages','communication_consents','payment_attempts','invoices','memberships','people','action_requests','action_approvals','ai_usage_ledger','ai_invocation_plans','work_items'];
  const before=Object.fromEntries(await Promise.all(prohibited.map(async t=>[t,await count(t)])));
  const usersBefore=Number((await admin.query('SELECT count(*) n FROM hon.users')).rows[0].n);
  const createBody={code:'CUSTOM_RECEPTION',name:'Reception',permissionCodes:['school.view']};
  const c=context(); const role=await service.create(c,createBody);assert.equal(role.replayed,false);assert.equal(role.record.version,1);assert.equal(role.record.schoolId,ids.a);
  assert.deepEqual(await service.create(c,createBody),{record:role.record,replayed:true});
  await denied(()=>service.create(c,{...createBody,name:'different'}),409);
  await denied(()=>service.create(context(),createBody),409);
  for(const code of ['OWNER','HON_HQ_OWNER','SYSTEM_ADMIN','HQ_ADMIN','PLATFORM_ADMIN','custom_reception']) await denied(()=>service.create(context(),{...createBody,code}),400);
  for(const permissionCodes of [['school.view','school.view'],['hq.onboarding.manage'],['unknown.permission'],[]]) await denied(()=>service.create(context(),{...createBody,code:'CUSTOM_INVALID',permissionCodes}),400);
  await denied(()=>service.create(context('weak'),{...createBody,code:'CUSTOM_TOO_STRONG',permissionCodes:['reporting.view']}));
  await denied(()=>service.create(context(),{...createBody,email:'x@example.test'}),400);
  for(const source of ['AI','AUTOMATION','INTEGRATION','PUBLIC_API','MIGRATION']) await denied(()=>service.create({...context(),source},{...createBody,code:'CUSTOM_SOURCE'}));
  for(const principalType of ['AI_EMPLOYEE','AUTOMATION','INTEGRATION','SYSTEM_SERVICE']) await denied(()=>service.grant({...context(),principalType},input()));
  await denied(()=>service.grant({...context(),actionRequestId:randomUUID()},input()));
  await denied(()=>service.grant({...context(),delegatedByPrincipalId:humans.weak.id},input()));
  await denied(()=>service.grant({...context(),externalSubject:humans.weak.subject},input()));
  await denied(()=>service.grant(context('actor',ids.b),input()));
  await denied(()=>controller.grant(ids.otherOrg,ids.a,randomUUID(),input(),{honIdentity:{externalSubject:humans.actor.subject}}));
  await denied(()=>controller.grant(ids.org,ids.other,randomUUID(),input(),{honIdentity:{externalSubject:humans.actor.subject}}));
  await denied(()=>service.grant({...context(),organizationId:ids.otherOrg,schoolId:ids.other},input(ids.foreignRole)));
  await denied(()=>service.grant(context(),input(ids.foreignRole)),404);
  await denied(()=>service.grant(context(),input(ids.owner)));
  await denied(()=>service.grant(context(),input(ids.system)));
  await denied(()=>service.grant(context('weak'),input(ids.strong)));
  await denied(()=>service.grant(context(),input(ids.desk,'actor')));
  for(const who of ['hq','privileged','inactive']) await denied(()=>service.grant(context(),input(ids.desk,who)));
  await denied(()=>service.grant(context(),{roleId:ids.desk,targetPrincipalId:ai,targetExternalSubject:'ai'}));
  await denied(()=>service.grant(context(),{...input(),targetExternalSubject:'mismatch'}));
  await denied(()=>service.grant(context(),{...input(),targetPrincipalId:randomUUID()}));
  await denied(()=>service.grant(context(),{...input(),email:'create-me@example.test'}),400);
  for(const effectiveUntil of ['2026-02-30T00:00:00Z','infinity',new Date(Date.now()-1000).toISOString(),new Date(Date.now()+91*86400000).toISOString()]) await denied(()=>service.grant(context(),{...input(),effectiveUntil}),400);
  await denied(()=>service.update(context(),ids.owner,{name:'hack',permissionCodes:['school.view'],expectedVersion:1}),404);
  await denied(()=>service.update(context('weak'),role.record.id,{name:'hack',permissionCodes:['reporting.view'],expectedVersion:1}));
  await denied(()=>service.update(context(),role.record.id,{name:'stale',permissionCodes:['school.view'],expectedVersion:2}),409);
  const updates=await Promise.allSettled([service.update(context(),role.record.id,{name:'Updated',permissionCodes:['school.view'],expectedVersion:1}),service.update(context(),role.record.id,{name:'Other update',permissionCodes:['school.view'],expectedVersion:1})]);
  assert.equal(updates.filter(r=>r.status==='fulfilled').length,1);assert.equal(updates.filter(r=>r.status==='rejected'&&r.reason.getStatus()===409).length,1);
  const updated=updates.find(r=>r.status==='fulfilled').value;assert.equal(updated.record.version,2);
  const grantContext=context(); const grantInput={...input(role.record.id),effectiveUntil:new Date(Date.now()+3600000).toISOString()};
  const sameKey=await Promise.all([service.grant(grantContext,grantInput),service.grant(grantContext,grantInput)]);assert.equal(sameKey.filter(r=>!r.replayed).length,1);assert.equal(sameKey[0].record.id,sameKey[1].record.id);
  const grant=sameKey[0].record;assert.equal(grant.version,1);assert.equal(grant.principalId,humans.target.id);
  assert.equal((await db.resolveAuthorizedScope(humans.target.subject,ids.a,'school.view')).principalId,humans.target.id);
  assert.equal(await db.resolveAuthorizedScope(humans.target.subject,ids.b,'school.view'),undefined);
  await denied(()=>service.grant(context(),grantInput),409);
  await denied(()=>service.revoke(context('actor',ids.b),grant.id,{expectedVersion:1}));
  await denied(()=>service.revoke(context(),ids.ownerGrant,{expectedVersion:1}));
  await denied(()=>service.revoke(context(),ids.systemGrant,{expectedVersion:1}),404);
  await denied(()=>service.revoke(context(),grant.id,{expectedVersion:2}),409);
  assert.deepEqual(await service.read(context(),'GRANT',grant.id),grant);
  assert.equal((await service.read(context(),'ROLE',role.record.id)).version,2);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,now()-interval '1 day')",[ids.org,ids.b,humans.actor.id,ids.owner]);
  await denied(()=>service.read(context('actor',ids.b),'ROLE',role.record.id),404);
  await denied(()=>service.read(context('actor',ids.b),'GRANT',grant.id),404);
  await denied(()=>service.update(context('actor',ids.b),role.record.id,{name:'cross school',permissionCodes:['school.view'],expectedVersion:2}),404);
  await denied(()=>service.grant(context('actor',ids.b),input(role.record.id)),404);
  await denied(()=>service.revoke(context('actor',ids.b),grant.id,{expectedVersion:1}),404);
  const revoked=await service.revoke(context(),grant.id,{expectedVersion:1});assert.equal(revoked.record.version,2);assert(revoked.record.revokedAt);assert.equal(revoked.record.effectiveUntil,revoked.record.revokedAt);
  const evidence=await count('audit_events'); const endAgain=await service.revoke(context(),grant.id,{expectedVersion:1});assert(endAgain.replayed);assert.equal(await count('audit_events'),evidence);
  assert.equal(await db.resolveAuthorizedScope(humans.target.subject,ids.a,'school.view'),undefined);
  // Expiry and future grants are not live. Revocation never deletes a row.
  const expiring=await service.grant(context(),input(ids.desk));
  await admin.query("UPDATE hon.principal_role_grants SET effective_from=now()-interval '2 days',effective_until=now()-interval '1 day' WHERE id=$1",[expiring.record.id]);
  assert.equal(await db.resolveAuthorizedScope(humans.target.subject,ids.a,'school.view'),undefined);
  assert((await service.revoke(context(),expiring.record.id,{expectedVersion:1})).replayed);
  const futureId=randomUUID(); await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day')",[futureId,ids.org,ids.a,humans.target.id,ids.desk,humans.actor.id]);
  assert.equal(await db.resolveAuthorizedScope(humans.target.subject,ids.a,'school.view'),undefined);
  await denied(()=>service.revoke(context(),futureId,{expectedVersion:1}),409);
  // Updating a role currently assigned to the actor is forbidden even if subset.
  const own=await service.create(context(),{code:'CUSTOM_OWN',name:'Own',permissionCodes:['school.view']});
  await admin.query('INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$3)',[ids.org,ids.a,humans.actor.id,own.record.id]);
  await denied(()=>service.update(context(),own.record.id,{name:'Own change',permissionCodes:['school.view'],expectedVersion:1}));
  // An indirect role update cannot change an HQ or non-human recipient either.
  for(const principal of [humans.hq.id,ai]) {
    const unsafeGrant=randomUUID();
    await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$6)',[unsafeGrant,ids.org,ids.a,principal,role.record.id,humans.actor.id]);
    await denied(()=>service.update(context(),role.record.id,{name:'Protected recipient',permissionCodes:['school.view'],expectedVersion:2}));
    await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1',[unsafeGrant]);
  }
  // Final OWNER-equivalent coverage: the actor holds the same permissions as a
  // UNION of separate roles, not one equivalent grant. The target is the only
  // grant covering the fixture owner's complete actual permission set.
  const ownerOther=randomUUID(),iamOther=randomUUID(),reportOther=randomUUID(),equivalent=randomUUID(),equivalentGrant=randomUUID();
  for(const [id,code,sys,scope] of [[ownerOther,'OWNER',true,null],[iamOther,'IAM_MANAGER',false,null],[reportOther,'REPORTER',false,null],[equivalent,'CUSTOM_EQUIVALENT',false,ids.other]]) await admin.query('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role,management_school_id) VALUES($1,$2,$3,$3,$4,$5)',[id,ids.otherOrg,code,sys,scope]);
  for(const [roleId,codes] of [[ownerOther,['school.view','reporting.view']],[iamOther,['iam.staff_role.manage',...actions]],[reportOther,['reporting.view']],[equivalent,['school.view','reporting.view']]]) for(const code of codes) await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)',[roleId,ids.otherOrg,code]);
  for(const [grantId,principal,roleId] of [[randomUUID(),humans.weak.id,iamOther],[randomUUID(),humans.weak.id,ids.foreignRole],[randomUUID(),humans.weak.id,reportOther],[equivalentGrant,humans.target.id,equivalent]]) await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,now()-interval '1 day')",[grantId,ids.otherOrg,ids.other,principal,roleId,humans.weak.id]);
  const otherContext={...context('weak'),organizationId:ids.otherOrg,schoolId:ids.other};
  await denied(()=>service.revoke(otherContext,equivalentGrant,{expectedVersion:1}));
  assert.equal((await admin.query('SELECT revoked_at FROM hon.principal_role_grants WHERE id=$1',[equivalentGrant])).rows[0].revoked_at,null);
  await denied(()=>service.update({...otherContext,idempotencyKey:randomUUID()},equivalent,{name:'Lose coverage',permissionCodes:['school.view'],expectedVersion:1}));
  // Actor authority is live, not cached by initial controller resolution.
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1',[humans.weak.id]);
  await denied(()=>service.create(context('weak'),{...createBody,code:'CUSTOM_INACTIVE_ACTOR'}));
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1',[humans.weak.id]);
  await admin.query("UPDATE hon.principal_role_grants SET effective_until=clock_timestamp()+interval '1 second' WHERE id=$1",[ids.weakGrant]);
  await admin.query('BEGIN');await admin.query('SELECT id FROM hon.organizations WHERE id=$1 FOR UPDATE',[ids.org]);
  const waiting=service.create(context('weak'),{...createBody,code:'CUSTOM_EXPIRED_AFTER_WAIT'}).then(()=>({ok:true}),error=>({error}));
  await new Promise(resolve=>setTimeout(resolve,1600));await admin.query('ROLLBACK');
  const waited=await waiting;assert.equal(waited.error?.getStatus(),403);
  await admin.query('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1',[ids.weakGrant]);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='iam.staff_role.grant'",[ids.weakRole]);
  await denied(()=>service.grant(context('weak'),input(ids.strong)));
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'iam.staff_role.grant')",[ids.weakRole,ids.org]);
  // Actual HQ provisioning retains one OWNER grant and all five new permissions.
  // It is tested under an admin rollback so no extra tenant or HQ evidence remains.
  await admin.query('BEGIN');
  await admin.query("UPDATE hon.hq_operator_grants SET permission_codes=ARRAY['hq.onboarding.manage'] WHERE principal_id=$1",[humans.hq.id]);
  const provision=(await admin.query("SELECT * FROM hon.provision_school_from_hq($1,'Fixture','Fixture','Fixture',$2,'UTC','ESSENTIAL'::hon.plan_tier,$3,$4,$5,$6)",[humans.hq.subject,`fixture-${randomUUID()}`,randomUUID(),randomUUID(),randomUUID(),randomUUID()])).rows[0];
  assert.equal((await admin.query("SELECT count(*) n FROM hon.role_permissions WHERE role_id=$1 AND permission_code LIKE 'iam.%'",[provision.owner_role_id])).rows[0].n,'5');
  assert.equal((await admin.query('SELECT count(*) n FROM hon.principal_role_grants WHERE organization_id=$1',[provision.organization_id])).rows[0].n,'1');
  await admin.query('ROLLBACK');
  // Runtime source/context gates cannot be bypassed by calling the fixed SQL API.
  await runtime.query('BEGIN');
  await runtime.query("SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_source','AI',true)",[ids.org,ids.a,humans.actor.id]);
  await sqlDenied(()=>runtime.query('SELECT hon.mutate_staff_role($1,$2,NULL,$3,$4,$5,$6)',[humans.actor.subject,actions[0],createBody,randomUUID(),randomUUID(),randomUUID()]));
  await runtime.query('ROLLBACK');
  assert.equal((await runtime.query("SELECT nullif(current_setting('app.hon_organization_id',true),'') c")).rows[0].c,null);
  // Inject a fixture-only outbox failure: business row, evidence and key all roll back.
  await admin.query(`CREATE FUNCTION hon.staff_role_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.organization_id='${ids.org}'::uuid THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$`);
  await admin.query('CREATE TRIGGER staff_role_test_failure BEFORE INSERT ON hon.outbox_events FOR EACH ROW EXECUTE FUNCTION hon.staff_role_test_failure()');triggerInstalled=true;
  const auditBefore=await count('audit_events');const outboxBefore=await count('outbox_events');const keysBefore=await count('idempotency_records');
  await assert.rejects(()=>service.create(context(),{code:'CUSTOM_ROLLBACK',name:'Rollback',permissionCodes:['school.view']}),/fixture failure/);
  assert.equal(await count('audit_events'),auditBefore);assert.equal(await count('outbox_events'),outboxBefore);assert.equal(await count('idempotency_records'),keysBefore);
  assert.equal((await admin.query("SELECT count(*) n FROM hon.roles WHERE organization_id=$1 AND code='CUSTOM_ROLLBACK'",[ids.org])).rows[0].n,'0');
  await admin.query('DROP TRIGGER staff_role_test_failure ON hon.outbox_events');await admin.query('DROP FUNCTION hon.staff_role_test_failure()');triggerInstalled=false;
  // All successes have exactly one corresponding inert outbox record; no PII.
  const audits=(await admin.query('SELECT * FROM hon.audit_events WHERE organization_id=$1',[ids.org])).rows;
  const events=(await admin.query('SELECT * FROM hon.outbox_events WHERE organization_id=$1',[ids.org])).rows;
  assert.equal(audits.length,events.length);assert(audits.every(a=>a.source==='HUMAN_UI'&&a.actor_principal_id===humans.actor.id&&!a.action_request_id&&actions.includes(a.action_code)));
  for(const a of audits) assert.equal(events.filter(e=>e.causation_id===a.request_id&&e.aggregate_id===a.entity_id).length,1);
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_CONTACT|targetExternalSubject|@example|email|phone/);
  for(const t of prohibited) assert.equal(await count(t),before[t],`${t} must not change`);
  assert.equal(Number((await admin.query('SELECT count(*) n FROM hon.users')).rows[0].n),usersBefore);
  console.log('PASS staff roles: real restricted runtime, scoped custom roles, human/exact target, subset, protected system/HQ/OWNER, expiry, revocation, concurrency, atomic audit/outbox, denied directory and zero prohibited effects.');
} finally {
  await db.onModuleDestroy(); await runtime.end(); await cleanup(); await admin.end();
}
