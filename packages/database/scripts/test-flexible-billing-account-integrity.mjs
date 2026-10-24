import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';
import { flexibleBillingAccountsFixture } from './flexible-billing-accounts-local-guard.mjs';
import { verifyFlexibleBillingAccountsSecurity } from './flexible-billing-accounts-security.mjs';

await requireFlexibleBillingAccountsLocalUrls();
const owner = new URL(process.env.DATABASE_URL ?? '');
const runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');

const admin = new pg.Client({ connectionString: owner.toString(), ssl: false });
const restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const ids = Object.fromEntries([
  'org', 'school', 'otherSchool', 'user', 'staff', 'role', 'grant', 'payer', 'otherPayer', 'newPayer', 'concurrentPayer',
  'family', 'mixedRole', 'mixedGrant', 'extraPrincipal',
].map((key) => [key, randomUUID()]));
const subject = `flexible-billing-${randomUUID()}`;
const context = (patch = {}) => ({
  organizationId: ids.org, schoolId: ids.school, principalId: ids.staff,
  principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch,
});
const input = (person = ids.payer, patch = {}) => ({ responsiblePersonId: person, currency: 'USD', ...patch });
const status = (expected) => (error) => error?.getStatus?.() === expected || error?.code === '42501';
const sqlDenied = (work) => assert.rejects(work, (error) => error?.code === '42501');

async function organizationEffects() {
  const result = await admin.query(`SELECT
    (SELECT count(*)::int FROM hon.billing_accounts WHERE organization_id=$1) AS accounts,
    (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1) AS audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1) AS outbox,
    (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$1) AS idempotency,
    (SELECT count(*)::int FROM hon.memberships WHERE organization_id=$1) AS memberships,
    (SELECT count(*)::int FROM hon.invoices WHERE organization_id=$1) AS invoices,
    (SELECT count(*)::int FROM hon.payment_attempts WHERE organization_id=$1) AS payment_attempts,
    (SELECT count(*)::int FROM hon.membership_payment_schedules WHERE organization_id=$1) AS schedules,
    (SELECT count(*)::int FROM hon.communication_messages WHERE organization_id=$1) AS communications,
    (SELECT count(*)::int FROM hon.ai_usage_ledger WHERE organization_id=$1) AS ai_usage,
    (SELECT count(*)::int FROM hon.action_requests WHERE organization_id=$1) AS action_requests,
    (SELECT count(*)::int FROM hon.outbox_delivery_attempts WHERE organization_id=$1) AS provider_delivery_attempts`, [ids.org]);
  return result.rows[0];
}

async function tenantTransaction(client, work, scope = context()) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),
      set_config('app.hon_principal_id',$3,true),set_config('app.hon_principal_type',$4,true),set_config('app.hon_request_id',$5,true),
      set_config('app.hon_source',$6,true),set_config('app.hon_action_request_id',$7,true),set_config('app.hon_delegated_by_principal_id',$8,true)`,
    [scope.organizationId, scope.schoolId, scope.principalId, scope.principalType, scope.requestId, scope.source, scope.actionRequestId ?? '', scope.delegatedByPrincipalId ?? '']);
    await client.query('SELECT hon.require_tenant_context()');
    const value = await work();
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

await Promise.all([admin.connect(), restricted.connect()]);
const database = new RuntimeDatabaseService();
const service = new BillingAccountService(database);
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  await verifyFlexibleBillingAccountsSecurity(admin, runtime.username);
  const backfill = await admin.query(`SELECT id,account_classification FROM hon.billing_accounts
    WHERE responsible_person_id='00000000-0000-4000-8000-000000000103'::uuid ORDER BY created_at,id`);
  assert.deepEqual(backfill.rows, [
    { id: '00000000-0000-4000-8000-000000000104', account_classification: 'CANONICAL' },
    { id: '00000000-0000-4000-8000-000000000105', account_classification: 'ADDITIONAL' },
    { id: '00000000-0000-4000-8000-000000000106', account_classification: 'ADDITIONAL' },
  ], '0152 did not deterministically preserve earliest canonical and later additional legacy accounts.');

  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_FLEXIBLE_ORG','PRIVATE_FLEXIBLE_ORG')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_FLEXIBLE_SCHOOL',$3),($4,$2,'PRIVATE_FLEXIBLE_OTHER_SCHOOL',$5)", [ids.school, ids.org, `flexible-${ids.school}`, ids.otherSchool, `flexible-other-${ids.otherSchool}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',now()-interval '1 day')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_FLEXIBLE_STAFF')", [ids.user, subject, `${ids.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_FLEXIBLE_STAFF')", [ids.staff, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'FLEXIBLE_BILLING_STAFF','PRIVATE_FLEXIBLE_BILLING_STAFF')", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.account.create')", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.grant, ids.org, ids.school, ids.staff, ids.role]);
  await admin.query(`INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES
    ($1,$2,$3,'Avery','Payer'),($4,$2,$5,'Bailey','Foreign'),($6,$2,$3,'Casey','No Canonical'),($7,$2,$3,'Drew','Concurrent')`,
  [ids.payer, ids.org, ids.school, ids.otherPayer, ids.otherSchool, ids.newPayer, ids.concurrentPayer]);

  // Direct runtime access can only use the tenant-bound operational boundary.
  await sqlDenied(() => restricted.query('SELECT * FROM hon.principals'));
  await sqlDenied(() => restricted.query('SELECT hon.require_crm_lead_close_actor($1)', [subject]));
  await sqlDenied(() => restricted.query('UPDATE hon.billing_accounts SET currency=$1', ['EUR']));
  await tenantTransaction(restricted, async () => {
    const own = await restricted.query('SELECT id FROM hon.billing_accounts WHERE organization_id=$1', [ids.org]);
    assert.equal(own.rowCount, 0, 'Tenant-scoped direct account read exposed unexpected data.');
    const foreign = await restricted.query('SELECT id FROM hon.billing_accounts WHERE school_id=$1', [ids.otherSchool]);
    assert.equal(foreign.rowCount, 0, 'Forced RLS exposed a foreign-school account.');
  });
  await assert.rejects(() => tenantTransaction(restricted, () => restricted.query(
    `INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification)
     VALUES($1,$2,$3,'USD','CANONICAL')`, [ids.org, ids.otherSchool, ids.otherPayer])), (error) => error?.code === '42501');

  const initial = await organizationEffects();
  const created = await service.create(context(), input());
  assert.equal(created.replayed, false); assert.equal(created.account.reused, false); assert.equal(created.account.classification, 'CANONICAL');
  const canonicalId = created.account.id;
  const afterCreate = await organizationEffects();
  assert.equal(afterCreate.accounts, initial.accounts + 1); assert.equal(afterCreate.audits, initial.audits + 1); assert.equal(afterCreate.outbox, initial.outbox + 1);

  const beforeReuse = await organizationEffects();
  const reused = await service.create(context(), input());
  assert.equal(reused.replayed, false); assert.equal(reused.account.reused, true); assert.equal(reused.account.id, canonicalId);
  const afterReuse = await organizationEffects();
  assert.equal(afterReuse.accounts, beforeReuse.accounts, 'Matching canonical reuse wrote another account.');
  assert.equal(afterReuse.outbox, beforeReuse.outbox, 'Matching canonical reuse wrote an outbox event.');
  assert.equal(afterReuse.audits, beforeReuse.audits + 1, 'Matching canonical reuse lacked audit evidence.');
  const reuseAudit = await admin.query("SELECT action_code,next_state FROM hon.audit_events WHERE organization_id=$1 AND action_code='billing.account.reuse' ORDER BY occurred_at DESC LIMIT 1", [ids.org]);
  assert.equal(reuseAudit.rows[0]?.next_state?.reused, true);

  const beforeCurrencyConflict = await organizationEffects();
  await assert.rejects(() => service.create(context(), input(ids.payer, { currency: 'EUR' })), status(409));
  assert.deepEqual(await organizationEffects(), beforeCurrencyConflict, 'Canonical currency conflict wrote any operational evidence.');

  const beforeNoCanonical = await organizationEffects();
  await assert.rejects(() => service.create(context(), input(ids.newPayer, { createAdditional: true, additionalReason: 'Separate responsible-party arrangement.' })), status(409));
  await assert.rejects(
    () => service.create(context(), input(ids.newPayer, { createAdditional: true, additionalReason: 'x'.repeat(501) })),
    /Invalid additional billing-account reason\./,
  );
  assert.deepEqual(await organizationEffects(), beforeNoCanonical, 'Additional-without-canonical or unbounded reason wrote data.');

  const additionalKey = randomUUID();
  const additionalInput = input(ids.payer, { currency: 'EUR', createAdditional: true, additionalReason: 'Separate responsible-party arrangement.' });
  const additional = await service.create(context({ idempotencyKey: additionalKey }), additionalInput);
  assert.equal(additional.account.classification, 'ADDITIONAL'); assert.equal(additional.account.reused, false);
  const additionalEvidence = await admin.query(`SELECT
    (SELECT next_state FROM hon.audit_events WHERE entity_id=$1::uuid AND action_code='billing.account.create') AS audit,
    (SELECT payload FROM hon.outbox_events WHERE aggregate_id=$1::uuid AND event_type='billing.account.created') AS outbox`, [additional.account.id]);
  assert.equal(additionalEvidence.rows[0]?.audit?.additionalReason, additionalInput.additionalReason);
  assert.equal(additionalEvidence.rows[0]?.outbox?.additionalReason, undefined, 'Additional-account reason leaked into outbox payload.');

  const beforeReplay = await organizationEffects();
  const replay = await service.create(context({ idempotencyKey: additionalKey }), additionalInput);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.account, additional.account);
  assert.deepEqual(await organizationEffects(), beforeReplay, 'Exact idempotency replay wrote duplicate account/audit/outbox evidence.');
  await assert.rejects(() => service.create(context({ idempotencyKey: additionalKey }), input(ids.payer)), status(409));
  assert.deepEqual(await organizationEffects(), beforeReplay, 'Changed payload on an idempotency key wrote data.');

  // Two independent public services race the same canonical command. The table
  // lock serializes normal commands; the partial index remains the final invariant.
  const secondDatabase = new RuntimeDatabaseService();
  const secondService = new BillingAccountService(secondDatabase);
  try {
    const raced = await Promise.all([
      service.create(context({ idempotencyKey: randomUUID() }), input(ids.concurrentPayer)),
      secondService.create(context({ idempotencyKey: randomUUID() }), input(ids.concurrentPayer)),
    ]);
    assert.equal(raced.filter((result) => !result.account.reused).length, 1);
    assert.equal(raced.filter((result) => result.account.reused).length, 1);
  } finally { await secondDatabase.onModuleDestroy(); }
  assert.equal((await admin.query("SELECT count(*)::int n FROM hon.billing_accounts WHERE responsible_person_id=$1 AND account_classification='CANONICAL'", [ids.concurrentPayer])).rows[0].n, 1);
  await assert.rejects(() => tenantTransaction(restricted, () => restricted.query(
    `INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency,account_classification)
     VALUES($1,$2,$3,'USD','CANONICAL')`, [ids.org, ids.school, ids.concurrentPayer])), (error) => error?.code === '23505');

  // Current-state rechecks: all failures roll back the just-reserved idempotency row.
  const assertNoWriteDenied = async (operation, expected = 403) => {
    const before = await organizationEffects();
    await assert.rejects(operation, status(expected));
    assert.deepEqual(await organizationEffects(), before, 'Denied flexible billing-account command wrote data.');
  };
  await assertNoWriteDenied(() => service.create(context({ schoolId: ids.otherSchool }), input()));
  await assertNoWriteDenied(() => service.create(context(), input(ids.otherPayer)), 400);
  await admin.query("DELETE FROM hon.role_permissions WHERE role_id=$1 AND permission_code='billing.account.create'", [ids.role]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'billing.account.create')", [ids.role, ids.org]);
  await admin.query('UPDATE hon.principals SET is_active=false WHERE id=$1', [ids.staff]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query('UPDATE hon.principals SET is_active=true WHERE id=$1', [ids.staff]);
  await admin.query("UPDATE hon.organization_entitlements SET status='SUSPENDED' WHERE organization_id=$1", [ids.org]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query("UPDATE hon.organization_entitlements SET status='ACTIVE' WHERE organization_id=$1", [ids.org]);
  await admin.query("INSERT INTO hon.hq_operator_grants(id,principal_id,hq_role) VALUES($1,$2,'HON_HQ_OWNER')", [randomUUID(), ids.staff]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'PRIVATE_FLEXIBLE_FAMILY')", [ids.family, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,'VIEWER',now()-interval '1 day',$4)", [ids.org, ids.school, ids.family, ids.staff]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query('DELETE FROM hon.family_access_grants WHERE principal_id=$1', [ids.staff]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'PARENT_MIXED','PRIVATE_FLEXIBLE_MIXED')", [ids.mixedRole, ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,now()-interval '1 day')", [ids.mixedGrant, ids.org, ids.school, ids.staff, ids.mixedRole]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query('DELETE FROM hon.principal_role_grants WHERE id=$1', [ids.mixedGrant]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_FLEXIBLE_DUPLICATE')", [ids.extraPrincipal, ids.user]);
  await assertNoWriteDenied(() => service.create(context(), input()));
  await admin.query('DELETE FROM hon.principals WHERE id=$1', [ids.extraPrincipal]);
  for (const patch of [{ principalType: 'AI_EMPLOYEE' }, { source: 'AI' }, { source: 'AUTOMATION' }, { actionRequestId: randomUUID() }, { delegatedByPrincipalId: randomUUID() }]) {
    await assertNoWriteDenied(() => service.create(context(patch), input()));
  }

  for (const sql of [
    'ALTER TABLE hon.billing_accounts NO FORCE ROW LEVEL SECURITY',
    `GRANT UPDATE ON hon.billing_accounts TO ${runtime.username}`,
    `GRANT SELECT ON hon.principals TO ${runtime.username}`,
    `GRANT EXECUTE ON FUNCTION hon.require_crm_lead_close_actor(text) TO ${runtime.username}`,
  ]) {
    await admin.query('BEGIN');
    try { await admin.query(sql); await assert.rejects(() => verifyFlexibleBillingAccountsSecurity(admin, runtime.username)); } finally { await admin.query('ROLLBACK'); }
  }
  await verifyFlexibleBillingAccountsSecurity(admin, runtime.username);
  const effects = await organizationEffects();
  assert.equal(effects.memberships, 0); assert.equal(effects.invoices, 0); assert.equal(effects.payment_attempts, 0); assert.equal(effects.schedules, 0);
  assert.equal(effects.communications, 0); assert.equal(effects.ai_usage, 0); assert.equal(effects.action_requests, 0); assert.equal(effects.provider_delivery_attempts, 0);
  console.log('PASS: disposable localhost flexible billing accounts prove deterministic 0159 backfill, one canonical account under concurrent normal commands and duplicate-index attempt, audited exact-currency reuse/no outbox, currency/no-canonical/idempotency conflicts without writes, bounded audited additional accounts with inert outbox, current direct-human school/permission/tier/person/HQ/family/mixed/nonhuman/delegated/action denials, forced-RLS restricted-runtime ACL boundaries, and zero membership/invoice/payment/schedule/provider/communication/AI effects.');
} finally {
  await database.onModuleDestroy();
  await Promise.all([restricted.end(), admin.end()]);
}
