/**
 * Checkout page share links proof (0620): SchoolCheckoutService.links (staff, school_checkout.manage) and
 * PublicSchoolCheckoutService.page (anyone with the link) on the restricted runtime role -> protected definers, on the
 * guarded disposable CRM-close fixture only. No network, no credentials, synthetic data; nothing is bought or sent.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CRM_CLOSE_OWNER_ROLE, CRM_CLOSE_RUNTIME_ROLE, crmCloseProofTargets, verifyCrmCloseProofConnection } from './crm-close-proof-target.mjs';

await import('./test-crm-close-proof-target.mjs');
const targets = crmCloseProofTargets(process.env);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const apiRequire = createRequire(resolve(repo, 'apps/api/package.json'));
apiRequire('reflect-metadata');
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { SchoolCheckoutService } = await load('school-checkout/school-checkout.service.js');
const { PublicSchoolCheckoutService } = await load('school-checkout/public-school-checkout.js');
const { SchoolPayOnceService } = await load('school-payments/school-pay-once.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const ids = Object.fromEntries(['organization', 'otherOrganization', 'school', 'otherSchool', 'family'].map((key) => [key, randomUUID()]));
const PREFIX = `cpl-${ids.organization.slice(0, 8)}`;
const sql = (text, values = []) => admin.query(text, values);
const one = (text, values = []) => sql(text, values).then((r) => r.rows[0]);
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };

const db = new RuntimeDatabaseService();
const staffApi = new SchoolCheckoutService(db);
// 0627 reads the school's processor to say whether a card can be taken; no processor is configured here.
const publicApi = new PublicSchoolCheckoutService(db, new SchoolPayOnceService(db, new Map()));

async function refused(run, status, code, label) {
  try { await run(); } catch (error) {
    const body = typeof error.getResponse === 'function' ? error.getResponse() : null;
    assert.equal(error.getStatus?.(), status, `${label}: expected ${status}, got ${error.getStatus?.()} ${JSON.stringify(body)} ${error.message}`);
    if (code) assert.equal(body?.code, code, `${label}: expected ${code}, got ${JSON.stringify(body)}`);
    checks += 1; return;
  }
  assert.fail(`${label}: expected a refusal`);
}
async function rejectsSql(run, pattern, label) {
  await sql('BEGIN');
  try { await run(); } catch (error) { await sql('ROLLBACK'); ok(pattern.test(error.message), `${label}: ${error.message}`); return; }
  await sql('ROLLBACK');
  assert.fail(`${label}: expected a refusal`);
}

// Disposable-fixture cleanup only (as in the 0598 proof).
async function cleanup() {
  const orgs = [ids.organization, ids.otherOrganization];
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 10; pass += 1) {
      let failed = 0;
      for (const table of tables) {
        await sql('SAVEPOINT cleanup_table');
        try {
          await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`);
          await sql(`DELETE FROM hon.${table} WHERE organization_id = ANY($1::uuid[])`, [orgs]);
          await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`);
          await sql('RELEASE SAVEPOINT cleanup_table');
        } catch { failed += 1; await sql('ROLLBACK TO SAVEPOINT cleanup_table'); }
      }
      if (!failed) break;
    }
    await sql('DELETE FROM hon.principal_role_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}

async function human(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Person')", [user, subject, `${label}-${user.slice(0, 8)}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Person')", [principal, user]);
  return { subject, principal };
}
async function staff(label, permissions, org = ids.organization, school = ids.school) {
  const actor = await human(label), role = randomUUID();
  await sql('INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,$3,false)', [role, org, `CPL_${role.slice(0, 8)}`]);
  for (const permission of permissions) await sql('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [role, org, permission]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')",
    [org, school, actor.principal, role]);
  return actor;
}

const en = (text, extra = {}) => ({ en: text, ...extra });
const option = (key, priceMinor, extra = {}) => ({ key, label: en(`Option ${key}`), description: null, planId: null, billing: 'ONE_TIME', priceMinor,
  recurringMinor: null, installments: null, downPayment: null, collectionMethod: null, additionalParticipantMinor: null, capacity: 0,
  availableThrough: null, mostPopular: false, createsMembership: false, ...extra });
const monthly = (key, extra = {}) => ({ ...option(key, null), billing: 'MONTHLY', recurringMinor: 22500, installments: 12, collectionMethod: 'REVIEW_REQUIRED',
  downPayment: { amountMinor: 45000, label: en('First and last month') }, ...extra });
const CONTENT = {
  currency: 'USD', title: en('Summer camp', { ko: '여름 캠프' }), description: en('A week of training.'), blocks: [{ position: 'ABOVE', text: en('Bring water.') }, { position: 'BELOW', text: en('See you there.') }],
  multiParticipant: { enabled: true, maxPerOrder: 3 },
  customFields: [{ key: 'size', label: en('Secret staff question'), kind: 'TEXT', required: true, options: [] }],
  addOns: [{ key: 'uniform', label: en('Uniform'), amountMinor: 2500, currency: 'USD', required: false }],
  options: [option('week', 5000, { additionalParticipantMinor: 3000, capacity: 3, mostPopular: true }), monthly('monthly'),
    option('ended', 1000, { availableThrough: '2020-01-01' })],
  waiver: { text: en('I accept the camp rules.') }, receiptNote: en('Private receipt note'), thankYou: en('Private thank you'),
};
let MANAGER, CLERK, FOREIGN_MANAGER, LIVE, DRAFT, ARCHIVED, FOREIGN_PAGE;
async function page(slug, content, { status = 'PUBLISHED', school = ids.school, org = ids.organization, by = MANAGER } = {}) {
  return (await one(`INSERT INTO hon.school_checkouts(organization_id,school_id,slug,group_key,status,content,created_by_principal_id,updated_by_principal_id)
    VALUES($1,$2,$3,'events',$4,$5,$6,$6) RETURNING id`, [org, school, slug, status, JSON.stringify(content), by.principal])).id;
}
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CPL Org','CPL Org'),($2,'CPL Other Org','CPL Other Org')", [ids.organization, ids.otherOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,effective_from) VALUES($1,'CORE',clock_timestamp()-interval '1 day'),($2,'CORE',clock_timestamp()-interval '1 day')", [ids.organization, ids.otherOrganization]);
  for (const [school, org, slug] of [[ids.school, ids.organization, 's'], [ids.otherSchool, ids.otherOrganization, 'o']]) {
    await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,$3,$4,'America/Los_Angeles')", [school, org, `CPL ${slug}`, `cpl-${slug}-${school.slice(0, 8)}`]);
  }
  MANAGER = await staff('manager', ['school_checkout.manage']);
  CLERK = await staff('clerk', ['people.read']);
  FOREIGN_MANAGER = await staff('foreign', ['school_checkout.manage'], ids.otherOrganization, ids.otherSchool);
  LIVE = await page('summer-camp', CONTENT);
  DRAFT = await page('draft-camp', CONTENT, { status: 'DRAFT' });
  ARCHIVED = await page('old-camp', CONTENT, { status: 'ARCHIVED' });
  FOREIGN_PAGE = await page('foreign-camp', CONTENT, { school: ids.otherSchool, org: ids.otherOrganization, by: FOREIGN_MANAGER });
}
const context = async (actor, school = ids.school) => {
  const scope = await db.resolveAuthorizedScope(MANAGER.subject, ids.school, 'school_checkout.manage');
  const own = actor === MANAGER ? scope : actor === FOREIGN_MANAGER ? await db.resolveAuthorizedScope(actor.subject, school, 'school_checkout.manage') : { ...scope, principalId: actor.principal };
  return { ...own, principalType: 'HUMAN_USER', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: '', source: 'HUMAN_UI', externalSubject: actor.subject };
};
const linkRows = () => sql('SELECT * FROM hon.school_checkout_links WHERE organization_id=ANY($1::uuid[]) ORDER BY checkout_id', [[ids.organization, ids.otherOrganization]]).then((r) => r.rows);
// 0627 shows the page's questions and thank-you text (the sign-up form); the receipt note stays private.
const LEAK = /Private receipt note|REVIEW_REQUIRED|collectionMethod|planId|capacity|organizationId|schoolId|checkoutId|@example\.test/;

try {
  await cleanup();
  await seed();

  // 1. Staff: every page of this school gets one link; running it again issues nothing new.
  const first = await staffApi.links(await context(MANAGER));
  ok(first.links.map((l) => l.pageId).sort().join() === [LIVE, DRAFT, ARCHIVED].sort().join(), 'one link per page of this school (live, draft, archived), none for another school');
  ok(first.links.every((l) => /^[a-f0-9]{48}$/.test(l.publicId)) && new Set(first.links.map((l) => l.publicId)).size === 3, '48-hex distinct link ids');
  const rows = await linkRows();
  ok(rows.length === 3 && rows.every((r) => r.issued_by_principal_id === MANAGER.principal && r.school_id === ids.school), 'link rows: issued by the manager for this school');
  ok((await one("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='school_checkout.link_issued' AND actor_principal_id=$2", [ids.organization, MANAGER.principal])).n === 3, 'one audit row per issued link');
  const again = await staffApi.links(await context(MANAGER));
  ok(JSON.stringify(again) === JSON.stringify(first) && (await linkRows()).length === 3
    && (await one("SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1 AND action_code='school_checkout.link_issued'", [ids.organization])).n === 3, 'again: same links, nothing new');
  const NEWER = await page('trial-class', { ...CONTENT, options: [option('trial', 0)] });
  const third = await staffApi.links(await context(MANAGER));
  ok(third.links.length === 4 && first.links.every((l) => third.links.some((x) => x.pageId === l.pageId && x.publicId === l.publicId)), 'a new page gets a link; old links keep their ids');
  await refused(async () => staffApi.links(await context(CLERK)), 403, null, 'without school_checkout.manage');
  const foreign = await staffApi.links(await context(FOREIGN_MANAGER, ids.otherSchool));
  ok(foreign.links.length === 1 && foreign.links[0].pageId === FOREIGN_PAGE, 'another organization sees only its own page link');
  await refused(async () => staffApi.links({ ...(await context(MANAGER)), idempotencyKey: 'k' }), 409, 'IDEMPOTENCY_KEY_NOT_ACCEPTED', 'no Idempotency-Key');
  await refused(async () => staffApi.links({ ...(await context(MANAGER)), source: 'AI_AGENT' }), 403, 'HUMAN_COMMAND_REQUIRED', 'direct human only');
  const link = (id) => third.links.find((l) => l.pageId === id).publicId;

  // 2. Public: a live page shows a whitelisted copy; draft, archived, unknown and malformed links show nothing.
  const shown = await publicApi.page(link(LIVE));
  ok(shown.publicId === link(LIVE) && shown.schoolName === 'CPL s' && shown.title.en === 'Summer camp' && shown.title.ko === '여름 캠프' && shown.description.en === 'A week of training.'
    && shown.currency === 'USD' && shown.maxParticipants === 3 && shown.blocks.map((b) => b.position).join() === 'ABOVE,BELOW' && shown.hasWaiver === true, 'title, text, blocks, waiver flag');
  ok(shown.options.map((o) => o.key).join() === 'week,monthly', 'an ended option is not listed');
  const [week, month] = shown.options;
  ok(week.priceMinor === 5000 && week.additionalParticipantMinor === 3000 && week.placesLeft === 3 && week.mostPopular && week.inFamilyApp === true, 'one-time option with places left, sold in the app');
  ok(month.priceMinor === null && month.recurringMinor === 22500 && month.installments === 12 && month.downPayment.amountMinor === 45000 && month.downPayment.label.en === 'First and last month'
    && month.placesLeft === null && month.inFamilyApp === false, 'monthly option with down payment, not sold in the app');
  ok(shown.addOns.length === 1 && shown.addOns[0].amountMinor === 2500 && shown.addOns[0].required === false, 'add-ons');
  ok(!LEAK.test(JSON.stringify(shown)), 'no receipt note, collection method, plan, capacity, ids or emails');
  ok(shown.version >= 1 && shown.questions.some((q) => q.label.en === 'Secret staff question') && shown.thankYou?.en === 'Private thank you'
    && shown.addOns[0].key === 'uniform' && shown.canPay === false && shown.testMode === true, '0627 sign-up form fields; no processor here, so no card');
  for (const [label, id] of [['draft', link(DRAFT)], ['archived', link(ARCHIVED)], ['unknown', 'a'.repeat(48)], ['malformed', 'x'], ['uppercase', link(LIVE).toUpperCase()], ['empty', '']]) {
    ok(await publicApi.page(id) === null, `${label} link shows nothing`);
  }
  ok((await publicApi.page(link(NEWER))).options[0].priceMinor === 0, 'a free option shows 0');

  // 3. The page's own status decides: draft stops the link, live again opens it with the same id.
  await sql("UPDATE hon.school_checkouts SET status='DRAFT',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [LIVE]);
  ok(await publicApi.page(link(LIVE)) === null, 'put in draft: the link stops');
  await sql("UPDATE hon.school_checkouts SET status='PUBLISHED',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [LIVE]);
  ok((await publicApi.page(link(LIVE)))?.title.en === 'Summer camp', 'live again: the same link opens');

  // 4. A suspended school or organization, or a lapsed entitlement, closes every link.
  // Fixture-only bypass of the status guards, inside one transaction each way.
  const flip = async (table, statement) => {
    await sql('BEGIN'); await sql(`ALTER TABLE hon.${table} DISABLE TRIGGER USER`); await sql(statement, [ids.organization, ids.school]);
    await sql(`ALTER TABLE hon.${table} ENABLE TRIGGER USER`); await sql('COMMIT');
  };
  for (const [label, table, on, off] of [
    ['suspended school', 'schools', "UPDATE hon.schools SET status='SUSPENDED' WHERE organization_id=$1 AND id=$2", "UPDATE hon.schools SET status='ACTIVE' WHERE organization_id=$1 AND id=$2"],
    ['suspended organization', 'organizations', "UPDATE hon.organizations SET status='SUSPENDED' WHERE id=$1 AND $2::uuid IS NOT NULL", "UPDATE hon.organizations SET status='ACTIVE' WHERE id=$1 AND $2::uuid IS NOT NULL"],
    ['lapsed entitlement', 'organization_entitlements', "UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1 AND $2::uuid IS NOT NULL",
      "UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1 AND $2::uuid IS NOT NULL"]]) {
    await flip(table, on);
    ok(await publicApi.page(link(LIVE)) === null, `${label}: the link shows nothing`);
    await flip(table, off);
  }
  ok((await publicApi.page(link(LIVE))) !== null, 'restored: the link opens again');

  // 5. A public read writes nothing.
  const reads = await one('SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1', [ids.organization]);
  await publicApi.page(link(LIVE));
  ok((await one('SELECT count(*)::int n FROM hon.audit_events WHERE organization_id=$1', [ids.organization])).n === reads.n, 'a public read writes nothing');

  // 6. Links never change, move or go away; a link cannot point at another school's page.
  const row = (await linkRows())[0];
  await rejectsSql(() => sql("UPDATE hon.school_checkout_links SET public_id=repeat('b',48) WHERE checkout_id=$1", [row.checkout_id]), /never changes/, 'no update');
  await rejectsSql(() => sql('DELETE FROM hon.school_checkout_links WHERE checkout_id=$1', [row.checkout_id]), /never changes/, 'no delete');
  await rejectsSql(() => sql('TRUNCATE hon.school_checkout_links'), /./, 'no truncate');
  await rejectsSql(() => sql('INSERT INTO hon.school_checkout_links(checkout_id,organization_id,school_id,issued_by_principal_id) VALUES($1,$2,$3,$4)',
    [FOREIGN_PAGE, ids.organization, ids.school, MANAGER.principal]), /./, 'not for another school\'s page');

  // 7. Runtime posture: two entry points; the helpers and the table stay private; the 011 section.
  for (const fn of ['issue_school_checkout_links(text)', 'read_public_school_checkout(text)']) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === true, `runtime executes ${fn}`);
  for (const fn of ['guard_school_checkout_link()', 'public_school_checkout(text)']) ok((await one('SELECT has_function_privilege($1,$2,\'EXECUTE\') x', [CRM_CLOSE_RUNTIME_ROLE, `hon.${fn}`])).x === false, `runtime cannot execute ${fn}`);
  await assert.rejects(runtime.query('SELECT * FROM hon.school_checkout_links LIMIT 1'), /permission denied/); checks += 1;
  await assert.rejects(runtime.query('SELECT hon.issue_school_checkout_links($1)', [MANAGER.subject]), /SCHOOL_CHECKOUT_FORBIDDEN/); checks += 1;
  ok((await runtime.query('SELECT hon.read_public_school_checkout($1) d', [link(DRAFT)])).rows[0].d === null, 'runtime public read of a draft: NULL');
  { const verify = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
    const section = verify.split('-- Checkout page share links exact verification (0620)')[1]?.split('-- End checkout page share links exact verification.')[0];
    ok(section, '011 section present');
    await sql(section.replace(/^[^\n]*\n(?:--[^\n]*\n)?/, '').replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE)); checks += 1; }

  console.log(`PASS: checkout page share links (0620): ${checks} checks.`);
} finally {
  await cleanup().catch((error) => console.error('cleanup failed', error));
  await runtime.end();
  await admin.end();
}
