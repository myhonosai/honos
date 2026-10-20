import pg from 'pg';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { flexibleBillingAccountsFixture, requireFlexibleBillingAccountsLocalUrls } from './flexible-billing-accounts-local-guard.mjs';

// Disposable-localhost lock-order matrix for the Owner Launch / CRM / billing transaction family (PR #41, 0169).
// Every workflow is paused at each of its lock stages by a blocker transaction holding EXCLUSIVE on the next table
// it locks (or, for TypeScript-driven commands, at a statement boundary). Every other workflow then arrives on
// independent data and runs until it finishes or waits; the blocker is released and both must commit with their
// exact effects. Pausing each side in turn covers both arrival orders for every pair.
// The matrix first runs against the pre-0169 bodies (0139, 0160, 0168 re-installed inside this disposable
// database) and must observe the reported Owner Launch DRAFT vs adult CRM DRAFT deadlock, proving it can fail.
// The 0169 bodies are then restored byte-for-byte and the full matrix must finish with zero failures.
await requireFlexibleBillingAccountsLocalUrls();
const ownerUrl = new URL(process.env.DATABASE_URL ?? '');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { BillingAccountService } = await import('../../../apps/api/dist/billing/billing-account.service.js');
const { MembershipService } = await import('../../../apps/api/dist/billing/membership.service.js');
const { CrmAdultMembershipDraftService } = await import('../../../apps/api/dist/billing/crm-adult-membership-draft.service.js');
const { LeadRegistrationService } = await import('../../../apps/api/dist/crm/lead-registration.service.js');
const { OwnerLaunchService } = await import('../../../apps/api/dist/owner-launch/owner-launch.service.js');

const admin = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const blocker = new pg.Client({ connectionString: ownerUrl.toString(), ssl: false });
const ids = Object.fromEntries(['org', 'school', 'user', 'staff', 'role', 'grant', 'pipeline', 'stage', 'program', 'session'].map((key) => [key, randomUUID()]));
const subject = `lock-order-${randomUUID()}`;
const context = (patch = {}) => { const requestId = randomUUID(); return { organizationId: ids.org, schoolId: ids.school, principalId: ids.staff,
  principalType: 'HUMAN_USER', source: 'HUMAN_UI', externalSubject: subject, requestId, correlationId: requestId, idempotencyKey: randomUUID(), ...patch }; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let assertions = 0;

const migration = (name) => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
function functionSql(sql, name) {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION hon\\.${name}\\([\\s\\S]*?\\nEND \\$\\$;\\n`));
  assert.ok(match, `${name} definition`);
  return match[0].replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}
const changed = { register_crm_lead_person: '0160_crm_lead_registration.sql', draft_crm_adult_membership: '0168_crm_adult_membership_draft_lock_order.sql',
  read_owner_launch_membership_draft: '0139_owner_launch_membership_draft_confirmation.sql' };
const current = '0169_crm_owner_launch_canonical_lock_order.sql';
const bodies = async () => Object.fromEntries((await admin.query(`SELECT proname,md5(prosrc) hash FROM pg_proc
  WHERE pronamespace='hon'::regnamespace AND proname = ANY($1) ORDER BY proname`, [Object.keys(changed)])).rows.map((row) => [row.proname, row.hash]));
async function install(source, overrides = {}) {
  for (const [name, file] of Object.entries(changed)) await admin.query(overrides[name] ?? functionSql(await migration(source ?? file), name));
}

// Wraps the real runtime service so a TypeScript-driven command can be held at an exact statement boundary.
function gated(database, after) {
  return { withTenantTransaction: (scope, work) => database.withTenantTransaction(scope, (client) => work(new Proxy(client, {
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property);
      return async (sql, ...rest) => { const result = await target.query(sql, ...rest); await after(typeof sql === 'string' ? sql : sql?.text ?? ''); return result; };
    } }))), withTenantReadOnlyTransaction: (...args) => database.withTenantReadOnlyTransaction(...args) };
}
function track(promise) { const state = { done: false }; state.promise = promise.then((value) => { state.done = true; return value; }, (error) => { state.done = true; throw error; }); state.promise.catch(() => {}); return state; }
async function waiting(excluded = []) {
  return (await admin.query(`SELECT l.pid,l.locktype,c.relname FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid LEFT JOIN pg_class c ON c.oid=l.relation
    WHERE NOT l.granted AND a.datname=current_database() AND NOT (l.pid = ANY($1::int[]))`, [excluded])).rows;
}
async function until(condition, message) {
  for (let attempt = 0; attempt < 300; attempt++) { const value = await condition(); if (value) return value; await sleep(10); }
  throw new Error(message);
}
const waitCycle = async () => (await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity x CROSS JOIN LATERAL unnest(pg_blocking_pids(x.pid)) y(pid)
  WHERE x.datname=current_database() AND x.pid = ANY(pg_blocking_pids(y.pid))) cycle`)).rows[0].cycle;
const deadlocks = async () => Number((await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()')).rows[0].deadlocks);

await admin.connect(); await blocker.connect();
const database = new RuntimeDatabaseService();
const services = { accounts: new BillingAccountService(database), memberships: new MembershipService(database), drafts: new CrmAdultMembershipDraftService(database),
  registrations: new LeadRegistrationService(database), launch: new OwnerLaunchService(database) };
try {
  const marker = (await admin.query("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.deepEqual(marker, { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const installed = await bodies();
  const expected = {};
  for (const name of Object.keys(changed)) {
    expected[name] = (await admin.query('SELECT md5($1)', [functionSql(await migration(current), name).match(/AS \$\$([\s\S]*)\$\$;\n$/)[1]])).rows[0].md5;
  }
  assert.deepEqual(installed, expected, '0169 bodies are installed'); assertions++;

  // Fixture: one school, one direct human staff principal that is both the Owner Launch actor and the CRM/billing actor.
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'PRIVATE_LOCK_ORG','PRIVATE_LOCK_ORG')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'PRIVATE_LOCK_SCHOOL',$3)", [ids.school, ids.org, `lock-${ids.school}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_LOCK_STAFF')", [ids.user, subject, `${ids.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'PRIVATE_LOCK_STAFF')", [ids.staff, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name) VALUES($1,$2,'FRONT_DESK','PRIVATE_LOCK_ROLE')", [ids.role, ids.org]);
  for (const permission of ['school.view', 'people.create', 'student.profile.manage', 'curriculum.progress.record', 'program.manage', 'schedule.session.manage',
    'crm.lead.read', 'crm.lead.register', 'family.create', 'family.member.manage', 'billing.membership.create', 'billing.account.create', 'billing.membership.activate', 'schedule.booking.manage']) {
    await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [ids.role, ids.org, permission]);
  }
  await admin.query("INSERT INTO hon.principal_role_grants(id,organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,$4,clock_timestamp()-interval '1 day')", [ids.grant, ids.org, ids.school, ids.staff, ids.role]);
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_LOCK_PIPELINE')", [ids.pipeline, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position,terminal_status) VALUES($1,$2,$3,$4,'Won',1,'WON')", [ids.stage, ids.org, ids.school, ids.pipeline]);
  await admin.query("INSERT INTO hon.programs(id,organization_id,school_id,name) VALUES($1,$2,$3,'PRIVATE_LOCK_PROGRAM')", [ids.program, ids.org, ids.school]);
  await admin.query("INSERT INTO hon.class_sessions(id,organization_id,school_id,program_id,name,starts_at,ends_at,capacity,booking_policy) VALUES($1,$2,$3,$4,'PRIVATE_LOCK_CLASS',clock_timestamp()+interval '30 days',clock_timestamp()+interval '30 days 1 hour',500,'WALK_IN')", [ids.session, ids.org, ids.school, ids.program]);

  // Independent data builders, all through the real commands.
  const person = async () => { const id = randomUUID(); await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,'Lock',$4)", [id, ids.org, ids.school, `Person-${id}`]); return id; };
  const olRegister = (c = context()) => services.launch.register(c, { programId: ids.program, expectedProgramVersion: 1, classSessionId: ids.session, expectedClassSessionVersion: 1,
    givenName: `Launch ${randomUUID()}`, familyName: 'PRIVATE_LOCK', birthDate: '1990-02-03', attestation: 'NEW_ADULT_NO_GUARDIAN_REQUIRED' });
  const olDraftInput = (registrationId) => ({ registrationId, expectedReceiptVersion: 1, planCode: 'STAFF-OPAQUE', termStartedAt: '2027-01-01T00:00:00.000Z', termEndsAt: '2028-01-01T00:00:00.000Z', currency: 'USD' });
  async function wonLead() {
    const lead = randomUUID(), contact = await person();
    await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status) VALUES($1,$2,$3,$4,$5,$6,'WON')", [lead, ids.org, ids.school, contact, ids.pipeline, ids.stage]);
    return { lead, person: contact };
  }
  const registerInput = { registrationPath: 'ADULT', birthDate: '1990-01-02', confirmation: 'I_CONFIRM_DIRECT_HUMAN_CRM_REGISTRATION' };
  async function crmAdult() {
    const { lead, person: adult } = await wonLead();
    const registered = await services.registrations.register(context(), lead, registerInput);
    assert.equal(registered.result.outcome, 'REGISTERED');
    const account = await services.accounts.create(context(), { responsiblePersonId: adult, currency: 'USD' });
    return { person: adult, student: registered.result.studentProfileId, account: account.account.id };
  }
  const draftInput = (student) => ({ studentProfileId: student, planCode: 'STAFF-OPAQUE', confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' });
  async function msDraft() {
    const payer = await person();
    const account = await services.accounts.create(context(), { responsiblePersonId: payer, currency: 'USD' });
    const created = await services.memberships.createDraft(context(), { billingAccountId: account.account.id, participantPersonId: payer, planCode: 'STAFF-OPAQUE' });
    return created.membership;
  }

  // Each workflow: prepare (unpaused), run (optionally through a gated database), exact outcome check, and its lock stages.
  // A stage names the next table the workflow locks (blocker holds EXCLUSIVE on it) or a statement it has just run.
  const workflows = {
    'Owner Launch registration': { prepare: async () => ({}), run: () => olRegister(),
      check: (r) => { assert.equal(r.replayed, false); assert.equal(r.receipt.status, 'REGISTERED_NO_BOOKING'); },
      stages: ['permissions', 'programs', 'people', 'student_curriculum_enrollments', 'audit_events'] },
    'Owner Launch DRAFT': { prepare: async () => ({ registration: (await olRegister()).receipt.registrationId }),
      run: (d) => services.launch.draftMembership(context(), olDraftInput(d.registration)),
      check: (r) => { assert.equal(r.replayed, false); assert.equal(r.receipt.state, 'DRAFT'); assert.equal(r.receipt.billingAccountCreated, true); },
      stages: ['permissions', 'student_registration_receipts', 'billing_accounts', 'idempotency_records', 'audit_events'] },
    'Owner Launch DRAFT confirmation': { prepare: async () => ({}), run: () => services.launch.readMembershipDraft(context()),
      check: (r) => assert.ok(['NO_RECORDED_DRAFT', 'RECORDED_DRAFT', 'DRAFT_UNAVAILABLE'].includes(r.state)),
      stages: ['permissions', 'people', 'billing_accounts', 'audit_events'] },
    'Owner Launch booking context': { prepare: async () => ({}), run: () => services.launch.readFirstClassBookingContext(context()),
      check: (r) => assert.equal(typeof r, 'object'), stages: ['permissions', 'idempotency_records', 'people', 'audit_events'] },
    'CRM registration': { prepare: wonLead, run: (d) => services.registrations.register(context(), d.lead, registerInput),
      check: (r) => { assert.equal(r.replayed, false); assert.equal(r.result.outcome, 'REGISTERED'); },
      stages: ['family_access_grants', 'people', 'crm_leads', 'audit_events'] },
    'Adult CRM DRAFT': { prepare: crmAdult, run: (d) => services.drafts.draft(context(), draftInput(d.student)),
      check: (r) => { assert.equal(r.replayed, false); assert.equal(r.receipt.state, 'DRAFT'); },
      stages: ['users', 'family_access_grants', 'people', 'billing_accounts', 'audit_events'] },
    'Adult CRM DRAFT replay': { prepare: async () => { const adult = await crmAdult(), c = context(); const first = await services.drafts.draft(c, draftInput(adult.student)); return { ...adult, c, first }; },
      run: (d) => services.drafts.draft({ ...d.c, requestId: randomUUID() }, draftInput(d.student)),
      check: (r, d) => { assert.equal(r.replayed, true); assert.deepEqual(r.receipt, d.first.receipt); },
      stages: ['users', 'family_access_grants', 'people', 'memberships'] },
    'Adult CRM DRAFT confirmation': { prepare: async () => { const adult = await crmAdult(); await services.drafts.draft(context(), draftInput(adult.student)); return adult; },
      run: (d) => services.drafts.confirmCurrentDraft(context({ idempotencyKey: '' }), { studentProfileId: d.student }),
      check: (r) => assert.equal(typeof r, 'object'), stages: ['family_access_grants', 'people', 'billing_accounts'] },
    'Billing account create': { prepare: async () => ({ payer: await person() }),
      run: (d, db = database) => new BillingAccountService(db).create(context(), { responsiblePersonId: d.payer, currency: 'USD' }),
      check: (r) => { assert.equal(r.replayed, false); assert.equal(r.account.classification, 'CANONICAL'); },
      stages: ['billing_accounts', 'audit_events'] },
    'Membership create': { prepare: async () => { const payer = await person(); return { payer, account: (await services.accounts.create(context(), { responsiblePersonId: payer, currency: 'USD' })).account.id }; },
      run: (d, db = database) => new MembershipService(db).createDraft(context(), { billingAccountId: d.account, participantPersonId: d.payer, planCode: 'STAFF-OPAQUE' }),
      check: (r) => { assert.equal(r.replayed ?? false, false); assert.equal(r.membership.state, 'DRAFT'); }, stages: ['memberships', 'audit_events'] },
    'Membership activation': { prepare: async () => ({ membership: await msDraft() }),
      run: (d, db = database) => new MembershipService(db).activate(context(), d.membership.id, { expectedVersion: d.membership.version }),
      check: (r) => { assert.equal(r.replayed, false); assert.equal(r.membership.state, 'ACTIVE'); }, stages: ['idempotency_records', 'audit_events'] },
  };

  // Runs workflow A paused at `stage`, then B on independent data; returns null on success or a failure description.
  async function cell(aName, stage, bName) {
    const A = workflows[aName], B = workflows[bName];
    const aData = await A.prepare(), bData = await B.prepare();
    const before = await deadlocks();
    await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE hon.${stage} IN EXCLUSIVE MODE`);
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    let a, b, released = false;
    try {
      a = track(A.run(aData));
      const aPid = await until(async () => { if (a.done) throw new Error(`${aName} never reached stage ${stage}: ${await a.promise.then((v) => JSON.stringify(v), (e) => e?.response?.code ?? e?.message)}`);
        return (await waiting([blockerPid])).find((row) => row.relname === stage)?.pid; }, `${aName} never reached stage ${stage}`);
      b = track(B.run(bData));
      await until(async () => b.done || (await waiting([blockerPid, aPid])).length > 0, `${bName} neither finished nor waited`);
      await blocker.query('ROLLBACK'); released = true;
      // Observe the waits-for graph directly while both run: a cycle is the deadlock itself, before PostgreSQL aborts one side.
      let cycle = false;
      while (!(a.done && b.done)) { cycle ||= await waitCycle(); await sleep(5); }
      const [ra, rb] = await Promise.allSettled([a.promise, b.promise]);
      const failures = [];
      for (const [name, result, data, workflow] of [[aName, ra, aData, A], [bName, rb, bData, B]]) {
        if (result.status === 'rejected') { failures.push(`${name}: ${result.reason?.response?.code ?? result.reason?.getResponse?.()?.code ?? result.reason?.code ?? result.reason?.message}`); continue; }
        try { workflow.check(result.value, data); } catch (error) { failures.push(`${name}: wrong outcome ${error.message}`); }
      }
      if (!failures.length) return null;
      return `${failures.join('; ')}${cycle ? ' [wait cycle observed]' : ''}${(await deadlocks()) > before ? ' [deadlock counted]' : ''}`;
    } finally {
      if (!released) await blocker.query('ROLLBACK');
      await Promise.allSettled([a?.promise, b?.promise].filter(Boolean));
    }
  }
  async function matrix(include = () => true) {
    const failures = []; let cells = 0;
    for (const [aName, workflow] of Object.entries(workflows)) for (const stage of workflow.stages) for (const bName of Object.keys(workflows)) {
      if (!include(aName, bName)) continue;
      const failure = await cell(aName, stage, bName); cells++;
      if (failure) failures.push(`${aName} @${stage} vs ${bName}: ${failure}`);
    }
    return { cells, failures };
  }
  const unfinished = async () => Number((await admin.query("SELECT count(*) FROM hon.idempotency_records WHERE organization_id=$1 AND status<>'COMPLETED'", [ids.org])).rows[0].count);

  // Activation held just after its membership row lock (statement gate) while a replay of the same DRAFT arrives.
  async function activationVsReplay() {
    const adult = await crmAdult(), c = context(); const first = await services.drafts.draft(c, draftInput(adult.student));
    const membership = (await admin.query('SELECT id,version FROM hon.memberships WHERE participant_person_id=$1', [adult.person])).rows[0];
    let open, reach; const opened = new Promise((resolve) => { open = resolve; }), reached = new Promise((resolve) => { reach = resolve; });
    const held = gated(database, async (sql) => { if (/FROM hon\.memberships[\s\S]*FOR UPDATE/.test(sql)) { reach(); await opened; } });
    const a = track(new MembershipService(held).activate(context(), membership.id, { expectedVersion: membership.version }));
    await reached;
    const b = track(services.drafts.draft({ ...c, requestId: randomUUID() }, draftInput(adult.student)));
    await until(async () => b.done || (await waiting()).length > 0, 'replay neither finished nor waited');
    open();
    let cycle = false;
    while (!(a.done && b.done)) { cycle ||= await waitCycle(); await sleep(5); }
    return [...await Promise.allSettled([a.promise, b.promise]), first, cycle];
  }

  // 1. The pre-0169 bodies: the reported cycle (Owner Launch DRAFT holding IAM SHARE locks while the adult DRAFT
  //    holds idempotency_records) must deadlock, proving the matrix detects the defect.
  await install();
  const legacy = await bodies();
  for (const name of Object.keys(changed)) assert.notEqual(legacy[name], expected[name], `${name} pre-0169 body installed`);
  const old = await matrix();
  const reported = old.failures.filter((failure) => failure.startsWith('Owner Launch DRAFT @student_registration_receipts vs Adult CRM DRAFT:'));
  assert.equal(reported.length, 1, 'the reported Owner Launch DRAFT vs adult CRM DRAFT conflict reproduces on the pre-0169 bodies');
  assert.match(reported[0], /wait cycle observed/); assertions += 4;
  const [oldActivation, oldReplay, , oldCycle] = await activationVsReplay();
  assert.ok(oldCycle && [oldActivation, oldReplay].some((result) => result.status === 'rejected'), 'pre-0169 replay vs activation forms a wait cycle'); assertions++;
  console.log(`Pre-0169 bodies: ${old.failures.length} of ${old.cells} interleavings failed, plus DRAFT replay vs held activation:\n  ${old.failures.join('\n  ')}`);

  // Ablations: each remaining part of 0169 is necessary on its own.
  // (a) 0169 CRM bodies with the pre-0169 Owner Launch DRAFT confirmation order: the confirmation still cycles.
  await install(current, { read_owner_launch_membership_draft: functionSql(await migration(changed.read_owner_launch_membership_draft), 'read_owner_launch_membership_draft') });
  const confirmation = await matrix((a, b) => [a, b].includes('Owner Launch DRAFT confirmation'));
  assert.ok(confirmation.failures.some((failure) => /wait cycle observed/.test(failure)), 'pre-0169 confirmation order still forms a cycle with 0169 CRM bodies');
  // (b) 0169 DRAFT that still row-locks the replayed membership under its table lock: replay vs held activation cycles.
  const rowLocked = functionSql(await migration(current), 'draft_crm_adult_membership')
    .replace('AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id;', 'AND m.billing_account_id=relation.account_id AND m.participant_person_id=relation.person_id FOR UPDATE;');
  assert.notEqual(rowLocked, functionSql(await migration(current), 'draft_crm_adult_membership'));
  await install(current, { draft_crm_adult_membership: rowLocked });
  const [, , , rowCycle] = await activationVsReplay();
  assert.ok(rowCycle, 'a replay row lock under the memberships table lock cycles with a held activation'); assertions += 3;
  console.log(`Ablations: pre-0169 confirmation order with 0169 CRM bodies failed ${confirmation.failures.length} of ${confirmation.cells} interleavings; a replay membership row lock formed a wait cycle with a held activation.`);

  // 2. The 0169 bodies, restored byte-for-byte: every interleaving of every pair completes.
  await install(current);
  assert.deepEqual(await bodies(), expected, '0169 bodies restored'); assertions++;
  const fixed = await matrix();
  assert.deepEqual(fixed.failures, [], 'no interleaving fails under the canonical order');
  assert.equal(await unfinished(), 0, 'no unfinished idempotency reservation'); assertions += 2 + fixed.cells;

  // 3. Same-entity races under 0169, both arrival orders.
  const status = (code) => (error) => error?.getResponse?.()?.code === code;
  async function race(first, second, stage) {
    await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE hon.${stage} IN EXCLUSIVE MODE`);
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const a = track(first());
    const aPid = await until(async () => (await waiting([blockerPid])).find((row) => row.relname === stage)?.pid, 'first command never reached its stage');
    const b = track(second());
    await until(async () => b.done || (await waiting([blockerPid, aPid])).length > 0, 'second command neither finished nor waited');
    await blocker.query('ROLLBACK');
    return Promise.allSettled([a.promise, b.promise]);
  }
  const counts = async (adult) => (await admin.query(`SELECT (SELECT count(*)::int FROM hon.memberships WHERE participant_person_id=$1) memberships,
    (SELECT count(*)::int FROM hon.crm_adult_membership_draft_sources s JOIN hon.memberships m ON m.id=s.membership_id WHERE m.participant_person_id=$1) sources,
    (SELECT count(*)::int FROM hon.audit_events a JOIN hon.memberships m ON m.id=a.entity_id WHERE m.participant_person_id=$1) audits,
    (SELECT count(*)::int FROM hon.outbox_events o JOIN hon.memberships m ON m.id=o.aggregate_id WHERE m.participant_person_id=$1) outbox`, [adult])).rows[0];
  for (const stage of ['users', 'people', 'billing_accounts', 'audit_events']) {
    // Same key, same request: exactly one DRAFT; the other replays its receipt verbatim.
    { const adult = await crmAdult(), c = context();
      const [x, y] = await race(() => services.drafts.draft(c, draftInput(adult.student)), () => services.drafts.draft({ ...c, requestId: randomUUID() }, draftInput(adult.student)), stage);
      assert.equal(x.status, 'fulfilled'); assert.equal(y.status, 'fulfilled'); assert.deepEqual([x.value.replayed, y.value.replayed].sort(), [false, true]);
      assert.deepEqual(x.value.receipt, y.value.receipt); assert.deepEqual(await counts(adult.person), { memberships: 1, sources: 1, audits: 1, outbox: 1 }); assertions += 5; }
    // Same adult, different keys: one DRAFT, the other a non-writing unavailable outcome.
    { const adult = await crmAdult();
      const [x, y] = await race(() => services.drafts.draft(context(), draftInput(adult.student)), () => services.drafts.draft(context(), draftInput(adult.student)), stage);
      const [won, lost] = x.status === 'fulfilled' ? [x, y] : [y, x];
      assert.equal(won.status, 'fulfilled'); assert.equal(won.value.replayed, false); assert.equal(lost.status, 'rejected');
      assert.ok(status('CRM_ADULT_MEMBERSHIP_UNAVAILABLE')(lost.reason), String(lost.reason?.getResponse?.()?.code));
      assert.deepEqual(await counts(adult.person), { memberships: 1, sources: 1, audits: 1, outbox: 1 }); assertions += 5; }
    // Same key reused for a different student by the same principal: refused, no partial effect.
    { const one = await crmAdult(), two = await crmAdult(), c = context();
      const [x, y] = await race(() => services.drafts.draft(c, draftInput(one.student)), () => services.drafts.draft({ ...c, requestId: randomUUID() }, draftInput(two.student)), stage);
      const [won, lost] = x.status === 'fulfilled' ? [x, y] : [y, x];
      assert.equal(won.status, 'fulfilled'); assert.ok(status('CRM_ADULT_MEMBERSHIP_CONFLICT')(lost.reason) || lost.reason?.getStatus?.() === 409);
      const loser = won === x ? two : one;
      assert.deepEqual(await counts(loser.person), { memberships: 0, sources: 0, audits: 0, outbox: 0 }); assertions += 3; }
  }
  // DRAFT replay against activation of the same membership (pre-0169 the replay row-locked it under its table lock).
  for (const order of ['activation first', 'replay first']) {
    const adult = await crmAdult(), c = context(); const first = await services.drafts.draft(c, draftInput(adult.student));
    const membership = (await admin.query('SELECT id,version FROM hon.memberships WHERE participant_person_id=$1', [adult.person])).rows[0];
    const activate = () => services.memberships.activate(context(), membership.id, { expectedVersion: membership.version });
    const replay = () => services.drafts.draft({ ...c, requestId: randomUUID() }, draftInput(adult.student));
    const [x, y] = order === 'activation first' ? await race(activate, replay, 'idempotency_records') : await race(replay, activate, 'people');
    const [activation, replayed] = order === 'activation first' ? [x, y] : [y, x];
    assert.equal(activation.status, 'fulfilled', String(activation.reason?.getResponse?.()?.code)); assert.equal(activation.value.membership.state, 'ACTIVE');
    assert.equal(replayed.status, 'fulfilled', String(replayed.reason?.getResponse?.()?.code)); assert.deepEqual(replayed.value.receipt, first.receipt); assertions += 4;
  }
  { const [activation, replayed, first] = await activationVsReplay();
    assert.equal(activation.status, 'fulfilled'); assert.equal(replayed.status, 'fulfilled'); assert.deepEqual(replayed.value.receipt, first.receipt); assertions += 3; }

  // 4. Known residual: one principal reusing ONE idempotency key concurrently for an Owner Launch DRAFT and an adult CRM
  //    DRAFT. Owner Launch reserves its key after its table locks (unchanged); the CRM command reserves first. The
  //    database may abort one side; the outcome must still be exactly one command, no partial effect, a 409 for the other.
  for (const stage of ['users', 'billing_accounts']) {
    const adult = await crmAdult(), registration = (await olRegister()).receipt.registrationId, key = randomUUID();
    const crm = () => services.drafts.draft(context({ idempotencyKey: key }), draftInput(adult.student));
    const ol = () => services.launch.draftMembership(context({ idempotencyKey: key }), olDraftInput(registration));
    const [x, y] = stage === 'users' ? await race(crm, ol, stage) : await race(ol, crm, stage);
    const outcomes = [x, y].map((result) => result.status);
    assert.equal(outcomes.filter((value) => value === 'fulfilled').length, 1, 'exactly one command under the reused key');
    assert.equal((await admin.query('SELECT count(*)::int count FROM hon.idempotency_records WHERE organization_id=$1 AND idempotency_key=$2', [ids.org, key])).rows[0].count, 1);
    assertions += 2;
  }
  assert.equal(await unfinished(), 0, 'no unfinished idempotency reservation'); assertions++;
  console.log(`PASS: Owner Launch / CRM / billing lock order (${assertions} assertions): pre-0169 bodies failed ${old.failures.length} of ${old.cells} paused interleavings including the reported Owner Launch DRAFT vs adult CRM DRAFT deadlock, and each 0169 change is necessary on its own; with 0169 all ${fixed.cells} interleavings (${Object.keys(workflows).length} workflows, every lock stage of each against every other) commit with exact outcomes; same-key, same-adult, key-reuse and replay-vs-activation races leave one membership, one source, one audit and one outbox row; the reused-key residual fails closed with one command and no partial effect.`);
} finally {
  // Never leave a pre-0169 body behind in the fixture, even when an assertion failed mid-matrix.
  await install(current).catch(() => {});
  await database.onModuleDestroy();
  await blocker.end().catch(() => {});
  await admin.end();
}
