import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';

// Disposable-localhost regression proof for PR #41 review findings, on the flexible billing-account fixture:
// 1. Lock order: the conventional billing-account command and the adult CRM membership DRAFT command run
//    concurrently in both arrival orders, each one deterministically held at its lock point until the other is
//    observed waiting. Neither may deadlock, duplicate an account or membership, or leave a partial transaction.
// 2. Legacy replay: an idempotency record completed by the pre-0159 billing-account service (old fingerprint and
//    receipt shape) replays its original receipt verbatim with no new account, audit, outbox or idempotency row,
//    while a genuinely different request under the same key is still refused.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'user', 'staff', 'role', 'grant', 'pipeline', 'stage'].map((key) => [key, randomUUID()]));
const subject = `billing-crm-draft-${randomUUID()}`;
const context = (patch = {}) => ({ organizationId: ids.org, schoolId: ids.school, principalId: ids.staff, principalType: 'HUMAN_USER',
  source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: randomUUID(), ...patch });
const draftContext = (patch = {}) => context({ externalSubject: subject, ...patch });
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let assertions = 0;

// Wraps the real runtime service so a test can hold one transaction at an exact statement boundary.
function gated(database, { before, after }) {
  return {
    async withTenantTransaction(scope, work) {
      return database.withTenantTransaction(scope, (client) => work(new Proxy(client, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property);
          return async (sql, ...rest) => {
            const text = typeof sql === 'string' ? sql : sql?.text ?? '';
            if (before) await before(text);
            const result = await target.query(sql, ...rest);
            if (after) await after(text);
            return result;
          };
        },
      })));
    },
    withTenantReadOnlyTransaction: (...args) => database.withTenantReadOnlyTransaction(...args),
  };
}
function gate() { let open; const opened = new Promise((resolve) => { open = resolve; }); let reach; const reached = new Promise((resolve) => { reach = resolve; }); return { open, opened, reach, reached }; }
// Returns once the second command waits on a lock or (0169: no shared lock left to wait on) has already finished.
async function waitForBlockedBackend(second) {
  let settled = false; second.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (settled) return;
    const waiting = (await admin.query(`SELECT count(*)::int AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE NOT l.granted AND a.datname=current_database()`)).rows[0].count;
    if (waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The second transaction neither waited nor finished; the interleaving was not exercised.');
}
async function effects(person) {
  return (await admin.query(`SELECT
    (SELECT count(*)::int FROM hon.billing_accounts WHERE organization_id=$1 AND responsible_person_id=$2) AS accounts,
    (SELECT count(*)::int FROM hon.billing_accounts WHERE organization_id=$1 AND responsible_person_id=$2 AND account_classification='CANONICAL') AS canonical,
    (SELECT count(*)::int FROM hon.memberships WHERE organization_id=$1 AND participant_person_id=$2) AS memberships,
    (SELECT count(*)::int FROM hon.audit_events WHERE organization_id=$1) AS audits,
    (SELECT count(*)::int FROM hon.outbox_events WHERE organization_id=$1) AS outbox,
    (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$1) AS idempotency,
    (SELECT count(*)::int FROM hon.idempotency_records WHERE organization_id=$1 AND status<>'COMPLETED') AS unfinished`, [ids.org, person])).rows[0];
}

await admin.connect();
const database = new RuntimeDatabaseService();
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const lockOrder = (await admin.query("SELECT prosrc FROM pg_proc WHERE oid='hon.draft_crm_adult_membership(text,jsonb,uuid,uuid,uuid)'::regprocedure")).rows[0].prosrc;
  assert.match(lockOrder, /DO NOTHING RETURNING true INTO reserved;\s*reserved:=coalesce\(reserved,false\);\s*LOCK TABLE hon\.users,[^;]*IN SHARE MODE;/, '0169 reservation-first lock order is installed');
  assert.doesNotMatch(lockOrder, /LOCK TABLE hon\.idempotency_records|hon\.crm_adult_membership_draft_sources,hon\.idempotency_records/, '0162 and 0168 lock orders are replaced'); assertions += 2;

  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_LOCK_ORG','PRIVATE_LOCK_ORG')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_LOCK_SCHOOL',$3)", [ids.school, ids.org, `lock-${ids.school}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_LOCK_STAFF')", [ids.user, subject, `${ids.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_LOCK_STAFF')", [ids.staff, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'FRONT_DESK','PRIVATE_LOCK_ROLE')", [ids.role, ids.org]);
  for (const permission of ['crm.lead.read', 'crm.lead.register', 'student.profile.manage', 'people.create', 'family.create', 'family.member.manage', 'billing.membership.create', 'billing.account.create']) {
    await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [ids.role, ids.org, permission]);
  }
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [ids.grant, ids.org, ids.school, ids.staff, ids.role]);
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_LOCK_PIPELINE')", [ids.pipeline, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [ids.stage, ids.org, ids.school, ids.pipeline]);

  const registrations = new LeadRegistrationService(database);
  // A registered adult whose canonical account was created through the real billing-account command.
  async function registeredAdult() {
    const person = randomUUID(), lead = randomUUID();
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email) VALUES($1,$2,$3,'Ada','Student','private@example.test')", [person, ids.org, ids.school]);
    await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, ids.org, ids.school, person, ids.pipeline, ids.stage]);
    const registered = await registrations.register(draftContext(), lead, { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' });
    assert.equal(registered.result.outcome, 'REGISTERED');
    const created = await new BillingAccountService(database).create(context(), { responsiblePersonId: person, currency: 'USD' });
    assert.equal(created.account.classification, 'CANONICAL');
    return { person, student: registered.result.studentProfileId, account: created.account.id };
  }
  const draftInput = (student) => ({ studentProfileId: student, planCode: 'STAFF-OPAQUE', confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' });

  // Order A: billing-account command reserves its idempotency row first, then the DRAFT arrives before the
  // billing command takes its billing_accounts lock. Under 0162's order this was a lock cycle (40P01).
  {
    const adult = await registeredAdult(), before = await effects(adult.person), held = gate();
    const billing = new BillingAccountService(gated(database, { before: async (sql) => {
      if (sql.includes('lock_current_direct_human_billing_accounts')) { held.reach(); await held.opened; }
    } }));
    const drafts = new CrmAdultMembershipDraftService(database);
    const billingKey = randomUUID(), draftKey = randomUUID();
    const first = billing.create(context({ idempotencyKey: billingKey }), { responsiblePersonId: adult.person, currency: 'USD' });
    await held.reached;
    const second = drafts.draft(draftContext({ idempotencyKey: draftKey }), draftInput(adult.student));
    await waitForBlockedBackend(second);
    held.open();
    const [account, draft] = await Promise.all([first, second]);
    assert.equal(account.account.id, adult.account); assert.equal(account.account.reused, true); assert.equal(draft.replayed, false);
    assert.equal((await admin.query('SELECT billing_account_id FROM hon.memberships WHERE id=$1', [draft.receipt.membershipId])).rows[0].billing_account_id, adult.account);
    const after = await effects(adult.person);
    assert.deepEqual({ accounts: after.accounts, canonical: after.canonical, memberships: after.memberships, unfinished: after.unfinished },
      { accounts: 1, canonical: 1, memberships: 1, unfinished: 0 });
    assert.equal(after.idempotency - before.idempotency, 2); assertions += 6;
  }

  // Order B: the DRAFT commits its locks first and is held open; the billing-account command then arrives.
  {
    const adult = await registeredAdult(), before = await effects(adult.person), held = gate();
    const drafts = new CrmAdultMembershipDraftService(gated(database, { after: async (sql) => {
      if (sql.includes('hon.draft_crm_adult_membership(')) { held.reach(); await held.opened; }
    } }));
    const billing = new BillingAccountService(database);
    const first = drafts.draft(draftContext(), draftInput(adult.student));
    await held.reached;
    const second = billing.create(context(), { responsiblePersonId: adult.person, currency: 'USD' });
    await waitForBlockedBackend(second);
    held.open();
    const [draft, account] = await Promise.all([first, second]);
    assert.equal(draft.replayed, false); assert.equal(account.account.id, adult.account); assert.equal(account.account.reused, true);
    const after = await effects(adult.person);
    assert.deepEqual({ accounts: after.accounts, canonical: after.canonical, memberships: after.memberships, unfinished: after.unfinished },
      { accounts: 1, canonical: 1, memberships: 1, unfinished: 0 });
    assert.equal(after.idempotency - before.idempotency, 2); assertions += 5;
  }

  // Legacy replay: a record written by the pre-0159 service, keyed by its original request fingerprint.
  {
    const service = new BillingAccountService(database);
    const payer = randomUUID();
    await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Legacy','Payer')", [payer, ids.org, ids.school]);
    const legacyAccount = (await admin.query(`INSERT INTO hon.billing_accounts(organization_id,school_id,responsible_person_id,currency)
      VALUES($1,$2,$3,'USD') RETURNING id,responsible_person_id AS "responsiblePersonId",currency,version,created_at AS "createdAt"`, [ids.org, ids.school, payer])).rows[0];
    const legacyReceipt = { ...legacyAccount, createdAt: legacyAccount.createdAt.toISOString() };
    const submittedId = payer.toUpperCase();
    const legacyRecords = [
      { key: randomUUID(), fp: fingerprint({ responsiblePersonId: payer, currency: 'USD' }), submitted: payer },
      { key: randomUUID(), fp: fingerprint({ responsiblePersonId: submittedId, currency: 'USD' }), submitted: submittedId },
    ];
    for (const record of legacyRecords) {
      await admin.query(`INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,response_status,response_body,expires_at)
        VALUES($1,$2,$3,$4,$5,'COMPLETED',201,$6::jsonb,now()+interval '1 day')`, [ids.org, ids.school, ids.staff, record.key, record.fp, JSON.stringify(legacyReceipt)]);
    }
    const inProgressKey = randomUUID();
    await admin.query(`INSERT INTO hon.idempotency_records(organization_id,school_id,principal_id,idempotency_key,request_fingerprint,status,expires_at)
      VALUES($1,$2,$3,$4,$5,'IN_PROGRESS',now()+interval '1 day')`, [ids.org, ids.school, ids.staff, inProgressKey, fingerprint({ responsiblePersonId: payer, currency: 'USD' })]);
    const stored = (await admin.query('SELECT id,request_fingerprint,response_body FROM hon.idempotency_records WHERE organization_id=$1 ORDER BY id', [ids.org])).rows;
    const before = await effects(payer);
    for (const record of legacyRecords) {
      for (const request of [{ responsiblePersonId: record.submitted, currency: 'USD' }, { responsiblePersonId: record.submitted }, { responsiblePersonId: record.submitted, currency: 'USD', createAdditional: false }]) {
        const replay = await service.create(context({ idempotencyKey: record.key }), request);
        assert.equal(replay.replayed, true); assert.deepEqual(replay.account, legacyReceipt); assertions += 2;
      }
      for (const different of [{ responsiblePersonId: record.submitted, currency: 'EUR' }, { responsiblePersonId: randomUUID(), currency: 'USD' },
        { responsiblePersonId: record.submitted, currency: 'USD', createAdditional: true, additionalReason: 'Separate payer agreement' }]) {
        await assert.rejects(service.create(context({ idempotencyKey: record.key }), different), (error) => error?.getStatus?.() === 409
          && error.getResponse().code === 'IDEMPOTENCY_KEY_REUSED'); assertions++;
      }
    }
    await assert.rejects(service.create(context({ idempotencyKey: inProgressKey }), { responsiblePersonId: payer, currency: 'USD' }),
      (error) => error?.getStatus?.() === 409 && error.getResponse().code === 'IDEMPOTENCY_IN_PROGRESS'); assertions++;
    assert.deepEqual(await effects(payer), before, 'legacy replay created no account, audit, outbox or idempotency row');
    assert.deepEqual((await admin.query('SELECT id,request_fingerprint,response_body FROM hon.idempotency_records WHERE organization_id=$1 ORDER BY id', [ids.org])).rows, stored,
      'legacy receipts and fingerprints stay immutable'); assertions += 2;
  }
  console.log(`PASS: billing-account / adult CRM DRAFT compatibility (${assertions} assertions): both arrival orders held deterministically at the lock point complete without deadlock, duplicate account or membership, or unfinished idempotency; pre-0159 billing-account idempotency records replay their original receipt verbatim (submitted and lower-case ids, defaulted and explicit non-additional input) with zero new rows, while different currency, payer or additional-account requests under the same key are refused and in-progress legacy work stays in progress.`);
} finally {
  await database.onModuleDestroy();
  await admin.end();
}
