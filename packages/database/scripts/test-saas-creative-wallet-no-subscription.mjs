import pg from 'pg';
import { CHAMPIONS_OWNER_ROLE, CHAMPIONS_RUNTIME_ROLE, championsProofTargets, verifyChampionsProofConnection } from './champions-proof-target.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// 0209 regression (Codex #146, 2026-11-05): a school with NO SaaS subscription reads its own creative wallet.
// On 0202 hon.saas_creative_eligibility referenced its unassigned `per` record and raised SQLSTATE 55000, so the
// canonical school wallet GET returned 503 SAAS_UNAVAILABLE before validation. The school here is ACTIVE with an
// in-effect COMPLETE entitlement and a staff member holding ai.premium.request, and has no subscription, purchase,
// lot or wallet row. Nothing is seeded to dodge the path: no subscription, no credit/policy approval, no program
// activation outside a rolled-back transaction. DISPOSABLE DATABASE ONLY; no provider, payment or AI call.
await import('./test-champions-proof-target.mjs');
const targets = championsProofTargets(process.env);
if (Object.keys(process.env).some((key) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|DIRECT_LLM_API|STRIPE|SQUARE|TWILIO|SENDGRID|SUPABASE|AWS|HEYGEN|HIGGSFIELD|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER))(?:_|$)/i.test(key))) throw new Error('Provider credentials/execution switches are forbidden.');
const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { SaasBillingService } = await import('../../../apps/api/dist/saas-billing/saas-billing.service.js');
const { SaasCreativeWalletService } = await import('../../../apps/api/dist/saas-billing/saas-creative-wallet.service.js');
const database = new RuntimeDatabaseService(), billing = new SaasBillingService(database), wallet = new SaasCreativeWalletService(billing);
const admin = new pg.Client(targets.owner);
const ids = Object.fromEntries(['org', 'school', 'user', 'principal', 'role'].map((k) => [k, randomUUID()]));
const subject = `cw-nosub-${randomUUID()}`;
const http = (n, code) => (e) => { assert.equal(e?.getStatus?.(), n, e?.stack ?? String(e)); if (code) assert.equal(e.getResponse().code, code, e.stack); return true; };
const row = async (sql, params) => (await admin.query(sql, params)).rows[0];
const results = [];
async function check(id, title, fn) {
  try { await fn(); results.push([id, 'PASS']); console.log(`PASS ${id}: ${title}`); }
  catch (e) { results.push([id, 'FAIL']); console.log(`FAIL ${id}: ${title}\n  ${String(e?.message ?? e).split('\n').slice(0, 6).join('\n  ')}`); }
}
async function cleanup() {
  await admin.query('ROLLBACK').catch(() => {});
  for (const t of ['principal_role_grants', 'role_permissions', 'roles', 'organization_entitlements', 'schools']) await admin.query(`DELETE FROM hon.${t} WHERE organization_id=$1`, [ids.org]);
  await admin.query('DELETE FROM hon.organizations WHERE id=$1', [ids.org]);
  await admin.query('DELETE FROM hon.principals WHERE id=$1', [ids.principal]);
  await admin.query('DELETE FROM hon.users WHERE id=$1', [ids.user]);
}
/** Rows that a read must never create or change for this organization. */
const footprint = async () => row(`SELECT
  (SELECT count(*)::int FROM hon.saas_subscriptions WHERE organization_id=$1) subscriptions,
  (SELECT count(*)::int FROM hon.saas_creative_wallets WHERE school_id=$2) wallets,
  (SELECT count(*)::int FROM hon.saas_creative_lots WHERE school_id=$2) lots,
  (SELECT count(*)::int FROM hon.saas_creative_ledger WHERE school_id=$2) ledger,
  (SELECT count(*)::int FROM hon.saas_creative_reservations WHERE school_id=$2) reservations,
  (SELECT count(*)::int FROM hon.saas_creative_topup_purchases WHERE school_id=$2) purchases,
  (SELECT status FROM hon.saas_creative_program WHERE program_id=1) program`, [ids.org, ids.school]);

await admin.connect();
await verifyChampionsProofConnection(admin, CHAMPIONS_OWNER_ROLE);
await verifyChampionsProofConnection({ query: (...a) => database['getPool']().query(...a) }, CHAMPIONS_RUNTIME_ROLE);
try {
  assert.equal((await row("SELECT shobj_description(oid,'pg_database') m FROM pg_database WHERE datname=current_database()")).m, 'HON disposable Champions Club validation');
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CW NOSUB Fixture LLC','CW NOSUB Fixture')", [ids.org]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'CW NOSUB Main',$3,'America/Chicago')", [ids.school, ids.org, `cw-nosub-${ids.school}`]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'COMPLETE',clock_timestamp()-interval '1 day')", [ids.org]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'PRIVATE_DIRECTORY')", [ids.user, subject, `${ids.user}@example.test`]);
  await admin.query("INSERT INTO hon.principals(id,user_id,principal_type,display_name,is_active) VALUES($1,$2,'HUMAN_USER','PRIVATE_DIRECTORY',true)", [ids.principal, ids.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'CW_NOSUB_STAFF','Fixture staff',false)", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.premium.request')", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 hour')", [ids.org, ids.school, ids.principal, ids.role]);
  await admin.query('COMMIT');
  const before = await footprint();
  assert.deepEqual(before, { subscriptions: 0, wallets: 0, lots: 0, ledger: 0, reservations: 0, purchases: 0, program: 'INACTIVE' }, 'virgin school, shipped-INACTIVE program');

  await check('N1', 'eligibility for a school with no subscription returns a reason instead of SQLSTATE 55000', async () => {
    const e = (await row('SELECT hon.saas_creative_eligibility($1,clock_timestamp()) e', [ids.school])).e;
    assert.deepEqual(e, { eligible: false, reason: 'PROGRAM_INACTIVE', subscriptionId: null, window: null });
  });

  await check('N2', 'the canonical school wallet read (restricted runtime role, API validator) succeeds with the INACTIVE zero posture', async () => {
    const v = await wallet.readSchoolWallet(subject, ids.school);
    assert.equal(v.eligibility.eligible, false); assert.equal(v.eligibility.reason, 'PROGRAM_INACTIVE');
    assert.equal(v.eligibility.window, null);
    assert.equal(Object.hasOwn(v.eligibility, 'subscriptionId'), false, 'school view still omits the subscription id');
    assert.equal(v.balance.availableCredits, 0); assert.equal(v.balance.heldCredits, 0);
    assert.deepEqual([v.lots.length, v.history.length, v.reservations.length, v.purchases.length], [0, 0, 0, 0]);
  });

  await check('N3', 'with the program switched on (rolled back), the no-subscription school gets the intended refusal reason', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER TABLE hon.saas_creative_program DISABLE TRIGGER USER');
      await admin.query("UPDATE hon.saas_creative_program SET status='ACTIVE',authorization_reference='Fixture only, rolled back',changed_by_principal_id=$1 WHERE program_id=1", [ids.principal]);
      const e = (await row('SELECT hon.saas_creative_eligibility($1,clock_timestamp()) e', [ids.school])).e;
      assert.deepEqual(e, { eligible: false, reason: 'PAID_ACCESS_REQUIRED', subscriptionId: null, window: null });
    } finally { await admin.query('ROLLBACK'); }
    assert.equal((await footprint()).program, 'INACTIVE', 'program state restored by rollback');
  });

  await check('N4', 'authorization is unchanged: unknown subject and a foreign school are refused', async () => {
    await assert.rejects(wallet.readSchoolWallet(`unknown-${randomUUID()}`, ids.school), http(403, 'SAAS_FORBIDDEN'));
    await assert.rejects(wallet.readSchoolWallet(subject, randomUUID()), http(403, 'SAAS_FORBIDDEN'));
  });

  await check('N5', 'reads write nothing and the function keeps its 0202 posture (invoker, no runtime EXECUTE, only the initializer added)', async () => {
    assert.deepEqual(await footprint(), before);
    const f = await row(`SELECT p.prosecdef, p.provolatile, has_function_privilege($1, p.oid, 'EXECUTE') runtime_exec, pg_get_functiondef(p.oid) def
      FROM pg_proc p WHERE p.oid='hon.saas_creative_eligibility(uuid,timestamp with time zone)'::regprocedure`, [CHAMPIONS_RUNTIME_ROLE]);
    assert.deepEqual([f.prosecdef, f.provolatile, f.runtime_exec], [false, 's', false]);
    assert.match(f.def, /SELECT NULL::integer AS period_index, NULL::timestamptz AS period_start, NULL::timestamptz AS period_end INTO per;/);
  });

  const failed = results.filter(([, s]) => s === 'FAIL');
  console.log(`${results.length - failed.length}/${results.length} no-subscription creative wallet checks passed`);
  if (failed.length) process.exitCode = 1;
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  await admin.end(); await database.onModuleDestroy?.();
}
