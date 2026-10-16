import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const riskyEnvironment = Object.keys(process.env).filter((key) => /^(?:OPENROUTER|DIRECT_LLM_API|HEYGEN|HIGGSFIELD|OPENAI|ANTHROPIC|GOOGLE|STRIPE|SQUARE|TWILIO|SHOPIFY|META|FACEBOOK|INSTAGRAM|TIKTOK|SENDGRID|MAILGUN|POSTMARK|SLACK|DISCORD|AWS|AZURE|GCP|GOOGLE_CLOUD|SUPABASE)(?:_|$)/i.test(key)
  || /^(?:HON_)?(?:AI|ACTION(?:_ENGINE)?|PROVIDER(?:S)?|EXTERNAL|PAYMENT(?:S)?|COMMUNICATION(?:S)?|MESSAGING|MESSAGE(?:S)?|DELIVERY|PUBLISH|CONSUMER|WORKER|EXECUTION)(?:_|$)/i.test(key));
if (riskyEnvironment.length) throw new Error(`Parent billing local integrity validation refuses provider/payment/messaging/action/worker/execution environments (${riskyEnvironment.join(', ')}).`);
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
if (owner.hostname !== 'localhost' || owner.port !== '5432' || owner.pathname !== '/hon_parent_billing_validation' || owner.username !== 'hon_parent_billing_owner'
  || runtime.hostname !== owner.hostname || runtime.port !== owner.port || runtime.pathname !== owner.pathname || runtime.username !== 'hon_parent_billing_runtime') throw new Error('Only the exact isolated localhost parent billing validation database is permitted.');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { ParentBillingViewService } = await import('../../../apps/api/dist/families/parent-billing-view.service.js');
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false }); const db = new RuntimeDatabaseService(); const view = new ParentBillingViewService(db);
const ids = Object.fromEntries(['organization','school','otherSchool','guardian','guardianUser','viewer','viewerUser','otherGuardian','otherGuardianUser','staff','staffUser','staffRole','staffRoleGrant','hq','hqUser','hqGrant','family','otherFamily','crossSchoolFamily','child','otherChild','crossSchoolChild','payer','unsafePayer','crossSchoolPayer','account','unsafeAccount','crossSchoolAccount','membership','unsafeMembership','crossSchoolMembership','invoice','otherInvoice','crossSchoolInvoice','payment','grant','viewerGrant','otherGrant'].map(key => [key, randomUUID()]));
const subject = `parent-billing-${randomUUID()}`, viewerSubject = `parent-billing-viewer-${randomUUID()}`, otherSubject = `parent-billing-other-${randomUUID()}`, staffSubject = `parent-billing-staff-${randomUUID()}`, hqSubject = `parent-billing-hq-${randomUUID()}`;
await admin.connect();
try {
  await admin.query('INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [ids.organization, 'PRIVATE_ORGANIZATION']);
  await admin.query('INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,$3,$4),($5,$2,$3,$6)', [ids.school, ids.organization, 'PRIVATE_SCHOOL', `billing-${ids.school}`, ids.otherSchool, `billing-${ids.otherSchool}`]);
  await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4),($5,$6,$7,$8),($9,$10,$11,$12)', [ids.guardianUser, subject, `${ids.guardianUser}@example.test`, 'PRIVATE_GUARDIAN', ids.viewerUser, viewerSubject, `${ids.viewerUser}@example.test`, 'PRIVATE_VIEWER', ids.otherGuardianUser, otherSubject, `${ids.otherGuardianUser}@example.test`, 'PRIVATE_OTHER_GUARDIAN']);
  await admin.query('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [ids.staffUser, staffSubject, `${ids.staffUser}@example.test`, 'PRIVATE_STAFF', ids.hqUser, hqSubject, `${ids.hqUser}@example.test`, 'PRIVATE_HQ']);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3),($4,'HUMAN_USER',$5,$6),($7,'HUMAN_USER',$8,$9)", [ids.guardian, ids.guardianUser, 'PRIVATE_GUARDIAN', ids.viewer, ids.viewerUser, 'PRIVATE_VIEWER', ids.otherGuardian, ids.otherGuardianUser, 'PRIVATE_OTHER_GUARDIAN']);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,$3),($4,'HUMAN_USER',$5,$6)", [ids.staff, ids.staffUser, 'PRIVATE_STAFF', ids.hq, ids.hqUser, 'PRIVATE_HQ']);
  await admin.query('INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,$3,$4)', [ids.staffRole, ids.organization, `billing-staff-${ids.staffRole}`, 'PRIVATE_STAFF_ROLE']);
  await admin.query('INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,$6)', [ids.staffRoleGrant, ids.organization, ids.school, ids.staff, ids.staffRole, ids.guardian]);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role,permission_codes) VALUES($1,$2,'HON_HQ_OPERATOR',ARRAY['hq.read'])", [ids.hqGrant, ids.hq]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FAMILY'),($4,$2,$3,'PRIVATE_OTHER_FAMILY')", [ids.family, ids.organization, ids.school, ids.otherFamily]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_CROSS_SCHOOL_FAMILY')", [ids.crossSchoolFamily, ids.organization, ids.otherSchool]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Authorized','Child'),($4,$2,$3,'PRIVATE_PAYER','Hidden'),($5,$2,$3,'PRIVATE_UNSAFE_PAYER','Hidden'),($6,$2,$3,'PRIVATE_OTHER_CHILD','Denied')", [ids.child, ids.organization, ids.school, ids.payer, ids.unsafePayer, ids.otherChild]);
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Cross','School Child'),($4,$2,$3,'PRIVATE_CROSS_SCHOOL_PAYER','Hidden')", [ids.crossSchoolChild, ids.organization, ids.otherSchool, ids.crossSchoolPayer]);
  await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'STUDENT',false),($1,$2,$3,$5,'GUARDIAN',true),($1,$2,$6,$7,'STUDENT',false)", [ids.organization, ids.school, ids.family, ids.child, ids.payer, ids.otherFamily, ids.otherChild]);
  await admin.query("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role,is_billing_contact) VALUES($1,$2,$3,$4,'STUDENT',false),($1,$2,$3,$5,'GUARDIAN',true)", [ids.organization, ids.otherSchool, ids.crossSchoolFamily, ids.crossSchoolChild, ids.crossSchoolPayer]);
  await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'PRIMARY_GUARDIAN',now()-interval '1 day',$5),($6,$2,$3,$4,$7,'VIEWER',now()-interval '1 day',$5),($8,$2,$3,$9,$10,'PRIMARY_GUARDIAN',now()-interval '1 day',$10)", [ids.grant, ids.organization, ids.school, ids.family, ids.guardian, ids.viewerGrant, ids.viewer, ids.otherGrant, ids.otherFamily, ids.otherGuardian]);
  await admin.query("INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,$4,'USD'),($5,$2,$3,$6,'USD')", [ids.account, ids.organization, ids.school, ids.payer, ids.unsafeAccount, ids.unsafePayer]);
  await admin.query("INSERT INTO hon.billing_accounts(id,organization_id,school_id,responsible_person_id,currency) VALUES($1,$2,$3,$4,'USD')", [ids.crossSchoolAccount, ids.organization, ids.otherSchool, ids.crossSchoolPayer]);
  await admin.query("INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_PLAN','ACTIVE',now()-interval '1 day',now()+interval '30 days')", [ids.membership, ids.organization, ids.school, ids.account, ids.child]);
  await admin.query("INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state,term_started_at,term_ends_at) VALUES($1,$2,$3,$4,$5,'PRIVATE_CROSS_SCHOOL_PLAN','ACTIVE',now()-interval '1 day',now()+interval '30 days')", [ids.crossSchoolMembership, ids.organization, ids.otherSchool, ids.crossSchoolAccount, ids.crossSchoolChild]);
  await admin.query("INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at) VALUES($1,$2,$3,$4,$5,'ISSUED','USD',12000,0,12000,now()+interval '10 days'),($6,$2,$3,$4,NULL,'ISSUED','USD',999,0,999,now()+interval '2 days')", [ids.invoice, ids.organization, ids.school, ids.account, ids.membership, ids.otherInvoice]);
  await admin.query("INSERT INTO hon.invoices(id,organization_id,school_id,billing_account_id,membership_id,status,currency,subtotal_minor,discount_minor,total_minor,due_at) VALUES($1,$2,$3,$4,$5,'ISSUED','USD',777,0,777,now()+interval '3 days')", [ids.crossSchoolInvoice, ids.organization, ids.otherSchool, ids.crossSchoolAccount, ids.crossSchoolMembership]);
  await admin.query("INSERT INTO hon.payment_attempts(organization_id,school_id,invoice_id,provider_code,provider_account_reference,provider_idempotency_reference,provider_payment_reference,state,amount_minor,currency,initiated_at) VALUES($1,$2,$3,'PRIVATE_PROVIDER','PRIVATE_ACCOUNT','PRIVATE_TOKEN','PRIVATE_PAYMENT','PENDING',12000,'USD',now()-interval '1 hour')", [ids.organization, ids.school, ids.invoice]);
  await admin.query("INSERT INTO hon.payment_attempts(organization_id,school_id,invoice_id,provider_code,provider_account_reference,provider_idempotency_reference,provider_payment_reference,state,amount_minor,currency,initiated_at) VALUES($1,$2,$3,'PRIVATE_CROSS_SCHOOL_PROVIDER','PRIVATE_CROSS_SCHOOL_ACCOUNT','PRIVATE_CROSS_SCHOOL_TOKEN','PRIVATE_CROSS_SCHOOL_PAYMENT','PENDING',777,'USD',now()-interval '1 hour')", [ids.organization, ids.otherSchool, ids.crossSchoolInvoice]);
  const snapshot = async () => {
    const tables = (await admin.query("SELECT table_name FROM information_schema.tables WHERE table_schema='hon' AND table_type='BASE TABLE' ORDER BY table_name")).rows;
    const state = {};
    for (const { table_name: table } of tables) {
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error('Unsafe fixture table name.');
      state[table] = (await admin.query(`SELECT count(*)::text AS count, coalesce(jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)),'[]'::jsonb) AS rows FROM hon.${table} row`)).rows[0];
    }
    return state;
  };
  const readWithoutEffects = async (label, read) => {
    const before = await snapshot();
    try { return await read(); }
    finally { assert.deepEqual(await snapshot(), before, `${label} must leave every HON row, audit/outbox and provider/action/payment/communication state unchanged`); }
  };
  await assert.rejects(readWithoutEffects('viewer denial', () => view.get(viewerSubject)), error => error.getStatus() === 403);
  const otherFamilyResult = await readWithoutEffects('other-family guardian projection', () => view.get(otherSubject));
  assert.equal(otherFamilyResult.data.memberships.status, 'AVAILABLE');
  assert.equal(otherFamilyResult.data.invoices.status, 'AVAILABLE');
  assert(!JSON.stringify(otherFamilyResult.data).includes('Authorized Child'));
  const result = await readWithoutEffects('guardian billing projection', () => view.get(subject));
  assert.equal(result.data.accessLevel, 'PRIMARY_GUARDIAN'); assert.equal(result.data.memberships.status, 'AVAILABLE'); assert.equal(result.data.invoices.status, 'AVAILABLE');
  if (result.data.memberships.status !== 'AVAILABLE' || result.data.invoices.status !== 'AVAILABLE') throw new Error('Expected available fixture result');
  assert.equal(result.data.memberships.items.length, 1); assert.equal(result.data.memberships.items[0].participant.displayName, 'Authorized Child'); assert.equal(result.data.memberships.items[0].state, 'ACTIVE'); assert.equal(result.data.invoices.items.length, 1); assert.equal(result.data.invoices.items[0].totalMinor, 12000); assert.equal(result.data.invoices.items[0].paymentAttempts.items[0].state, 'PENDING');
  assert(!/PRIVATE_|familyId|schoolId|organizationId|principalId|accountId|membershipId|invoiceId|paymentId|provider|token|planCode|discount|credit|card|method/i.test(JSON.stringify(result.data)));
  assert(!JSON.stringify(result.data).includes('Cross School'), 'A current guardian result must suppress the complete other-school billing graph.');
  const direct = await readWithoutEffects('direct runtime billing projection', () => db.readParentBillingView(subject)); assert(!JSON.stringify(direct).includes('PRIVATE_PROVIDER'));
  await admin.query("INSERT INTO hon.memberships(id,organization_id,school_id,billing_account_id,participant_person_id,plan_code,state) VALUES($1,$2,$3,$4,$5,'PRIVATE_UNSAFE_PLAN','ACTIVE')", [ids.unsafeMembership, ids.organization, ids.school, ids.unsafeAccount, ids.child]);
  const insufficient = await readWithoutEffects('payer-link withholding', () => view.get(subject)); assert.equal(insufficient.data.memberships.status, 'UNAVAILABLE'); assert.equal(insufficient.data.invoices.status, 'UNAVAILABLE'); assert(!JSON.stringify(insufficient.data).includes('Authorized Child'));
  await admin.query('DELETE FROM hon.memberships WHERE id=$1', [ids.unsafeMembership]);
  const extraGrant = randomUUID(); await admin.query("INSERT INTO hon.family_access_grants(id,organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,'SECONDARY_GUARDIAN',now()-interval '1 day',$5)", [extraGrant, ids.organization, ids.school, ids.otherFamily, ids.guardian]); await assert.rejects(readWithoutEffects('ambiguous-family denial', () => view.get(subject)), error => error.getStatus() === 409); await admin.query('DELETE FROM hon.family_access_grants WHERE id=$1', [extraGrant]);
  await admin.query('UPDATE hon.family_access_grants SET effective_until=now()-interval \'1 minute\' WHERE id=$1', [ids.grant]); await assert.rejects(readWithoutEffects('expired-guardian denial', () => view.get(subject)), error => error.getStatus() === 403); await admin.query('UPDATE hon.family_access_grants SET effective_until=NULL WHERE id=$1', [ids.grant]);
  await assert.rejects(readWithoutEffects('unknown-subject denial', () => view.get(`unknown-${randomUUID()}`)), error => error.getStatus() === 403);
  await assert.rejects(readWithoutEffects('staff denial', () => view.get(staffSubject)), error => error.getStatus() === 403);
  await assert.rejects(readWithoutEffects('HQ denial', () => view.get(hqSubject)), error => error.getStatus() === 403);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [ids.guardian]); await assert.rejects(readWithoutEffects('inactive-principal denial', () => view.get(subject)), error => error.getStatus() === 403); await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [ids.guardian]);
  await admin.query("UPDATE hon.families SET status='ARCHIVED' WHERE id=$1", [ids.family]); await assert.rejects(readWithoutEffects('archived-family denial', () => view.get(subject)), error => error.getStatus() === 403); await admin.query("UPDATE hon.families SET status='ACTIVE' WHERE id=$1", [ids.family]);
  await admin.query("UPDATE hon.schools SET status='ARCHIVED' WHERE id=$1", [ids.school]); await assert.rejects(readWithoutEffects('archived-school denial', () => view.get(subject)), error => error.getStatus() === 403); await admin.query("UPDATE hon.schools SET status='ACTIVE' WHERE id=$1", [ids.school]);
  await admin.query("UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1", [ids.organization]); await assert.rejects(readWithoutEffects('suspended-organization denial', () => view.get(subject)), error => error.getStatus() === 403); await admin.query("UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1", [ids.organization]);
  const posture = (await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,has_function_privilege($1,p.oid,'EXECUTE') runtime_execute,NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname=$1)) OR a.is_grantable) closed FROM pg_proc p WHERE p.oid='hon.read_parent_billing_view(text)'::regprocedure`, [runtime.username])).rows[0];
  assert.equal(posture.prosecdef, true); assert.equal(posture.provolatile, 'v'); assert.deepEqual(posture.proconfig, ['search_path=pg_catalog, hon']); assert.equal(posture.runtime_execute, true); assert.equal(posture.closed, true);
  const rls = await admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid = ANY(ARRAY['hon.billing_accounts'::regclass,'hon.memberships'::regclass,'hon.invoices'::regclass,'hon.payment_attempts'::regclass])"); assert(rls.rows.every(row => row.relrowsecurity && row.relforcerowsecurity));
  const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false }); await restricted.connect(); try {
    const observed = await readWithoutEffects('restricted direct runtime billing projection', async () => {
      await restricted.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const projection = await restricted.query('SELECT hon.read_parent_billing_view($1) data', [subject]);
        await restricted.query('COMMIT');
        return projection;
      } catch (error) {
        await restricted.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    assert.equal(observed.rows[0].data.accessLevel, 'PRIMARY_GUARDIAN');
    for (const table of ['users','principals','family_access_grants']) await assert.rejects(readWithoutEffects(`restricted ${table} table denial`, () => restricted.query(`SELECT * FROM hon.${table}`)), error => error.code === '42501');
  } finally { await restricted.end(); }
  console.log('PASS: parent billing uses only exact live guardian/current-family child links, redacts payer/provider identifiers, fails closed on ambiguity/insufficiency/revocation, and has zero read effects.');
} finally { await db.onModuleDestroy(); await admin.end(); }
