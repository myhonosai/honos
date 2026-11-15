/** School website acceptance (WB2-WB4): Chromium -> production Next -> the real Nest API (dist/main.js) -> the guarded
 *  disposable Champions Club PostgreSQL fixture. An owner of a SYNTHETIC school starts a website from a template, edits
 *  it, previews it on computer and phone, connects a published lead form, publishes it, and a visitor submits the form on
 *  the public site, which creates an actual CRM lead through the unchanged 0075 intake. No provider, payment, message,
 *  AI or domain. Local only: HON_WEBSITE_BROWSER_LOCAL=1, built apps/api and apps/web, and Chromium. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

assert.equal(process.env.HON_WEBSITE_BROWSER_LOCAL, '1');
const owner = new URL(process.env.DATABASE_URL ?? ''), runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? '');
for (const [u, user] of [[owner, 'hon_champions_owner'], [runtime, 'hon_champions_runtime']]) {
  assert.equal(u.hostname, 'localhost'); assert.equal(u.pathname, '/hon_champions_validation'); assert.equal(u.username, user);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const req = createRequire(join(repo, 'apps/api/package.json'));
const { issueSession, HON_SESSION_COOKIE } = req('@hon/auth');
const { SIGNUP_CONFIRMATION } = req('@hon/contracts');
const { chromium } = createRequire(process.env.HON_BROWSER_TOOLS ? join(process.env.HON_BROWSER_TOOLS, 'package.json') : join(repo, 'package.json'))('playwright');
const shots = process.env.HON_WEBSITE_SHOTS ?? join(repo, '.website-shots'); mkdirSync(shots, { recursive: true });
const WEB = 'http://127.0.0.1:3000', API = 'http://127.0.0.1:3001';
const session = { mode: 'OIDC', audience: 'school-website-browser', secret: randomBytes(32).toString('hex') };
const common = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', HON_AUTH_MODE: 'OIDC', HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret,
  HON_SESSION_VERIFIED_EMAIL_ENABLED: 'true', HON_PUBLIC_ORIGIN: WEB, HON_DEPLOYMENT_ENVIRONMENT: 'preview' };
const admin = new pg.Client({ connectionString: owner.toString(), ssl: false }), restricted = new pg.Client({ connectionString: runtime.toString(), ssl: false });
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const children = []; let current = null;
const start = (cmd, args, cwd, env, ready) => new Promise((ok, fail) => {
  const c = spawn(cmd, args, { cwd, env: { ...common, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(c);
  let log = ''; const t = setTimeout(() => fail(new Error('start timeout: ' + log.slice(-2000))), 60000);
  const on = d => { log += d; if (ready.test(log)) { clearTimeout(t); ok(c); } };
  c.stdout.on('data', on); c.stderr.on('data', on); c.on('exit', code => { clearTimeout(t); fail(new Error(`${cmd} exited ${code}: ${log.slice(-2000)}`)); });
});
const step = name => console.log('PASS WEBSITE BROWSER ' + name);

try {
  await Promise.all([admin.connect(), restricted.connect()]);
  // A synthetic school through the real sign-up entry point; paid access stood in by the owner connection.
  await q("UPDATE hon.hon_os_signup_program SET status='TEST_MODE',recorded_at=clock_timestamp() WHERE program_id=1");
  const terms = (await q('SELECT id FROM hon.hon_os_signup_terms_versions ORDER BY version DESC LIMIT 1'))[0].id;
  const subject = 'oidc:website-browser:' + randomUUID(), email = `owner-${randomUUID()}@example.invalid`;
  const school = (await restricted.query('SELECT hon.register_hon_os_school($1,$2,$3::jsonb,$4) data', [subject, email,
    { ownerName: 'Synthetic Owner', schoolName: 'Synthetic Tiger Dojo', legalName: 'Synthetic Tiger LLC', timezone: 'America/Chicago', termsVersionId: terms, confirmation: SIGNUP_CONFIRMATION }, randomUUID()])).rows[0].data;
  await q("UPDATE hon.organization_entitlements SET status='ACTIVE',effective_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1", [school.organizationId]);
  const pipeline = randomUUID(), stage = randomUUID();
  await q("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'Synthetic pipeline')", [pipeline, school.organizationId, school.schoolId]);
  await q("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [stage, school.organizationId, school.schoolId, pipeline]);

  await start('node', ['dist/main.js'], join(repo, 'apps/api'), { HON_RUNTIME_DATABASE_URL: runtime.toString(), HON_API_PORT: '3001' }, /startup\.listening/);
  await start('node', ['node_modules/next/dist/bin/next', 'start', '-p', '3000', '-H', '127.0.0.1'], join(repo, 'apps/web'), { HON_API_BASE_URL: API, NODE_ENV: 'production' }, /Ready in|started server/i);
  const cookie = issueSession({ externalSubject: subject, email, emailVerified: true }, { ...session, emitVerifiedEmail: true }, Math.floor(Date.now() / 1000));

  // The school's lead form, made and published through the existing staff form API (not by this website work).
  const staff = async (path, body) => {
    const r = await fetch(WEB + path, { method: 'POST', headers: { cookie: `${HON_SESSION_COOKIE}=${cookie}`, origin: WEB, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
      'x-hon-human-command': 'public-lead-form', 'idempotency-key': randomUUID() }, body: JSON.stringify(body) });
    const text = await r.text(); assert.equal(r.status, 200, text); return JSON.parse(text).data;
  };
  const draftForm = await staff('/api/v1/marketing/forms', { expectedVersion: 0, title: 'Free class enquiry', description: 'Tell us about you', pipelineId: pipeline, pipelineStageId: stage, campaignId: null, optionalFields: ['ageBand'] });
  const form = await staff(`/api/v1/marketing/forms/${draftForm.id}/publish`, { expectedVersion: 1 });
  assert.equal(form.status, 'PUBLISHED');
  step('synthetic school, signed session, real API and production web up; a published lead form exists');

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie, url: WEB, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); current = page;
  page.on('pageerror', e => console.error('pageerror', e.message));
  await page.goto(WEB + '/staff/marketing/website');
  await page.getByRole('heading', { name: 'Start your website' }).waitFor({ timeout: 30000 });
  await page.locator('label[data-template="HIGH_CONVERSION"]').click();
  const slug = 'synthetic-tiger-' + randomBytes(3).toString('hex');
  await page.getByLabel('Website name').fill('Synthetic Tiger Dojo');
  await page.getByLabel('Web address').fill(slug);
  await page.screenshot({ path: join(shots, '01-start.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create website' }).click();
  await page.getByText('Website created. It is not live yet.').waitFor();
  step('owner starts a website from the High conversion template');

  // Edit the main banner heading and connect the enquiry form.
  await page.locator('li[data-section-row="HERO"] button', { hasText: 'Main banner' }).click();
  await page.locator('[data-editing="hero"]').getByLabel('Heading', { exact: true }).fill('Kids karate that builds confidence');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('li[data-section-row="LEAD_FORM"] button', { hasText: 'Enquiry form' }).click();
  await page.locator('[data-editing="enquire"]').getByLabel('Form').selectOption(form.publicId);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByText('You have changes that are not saved.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Publish', exact: true }).isDisabled(), true);
  await page.locator('[data-mode="preview"] h1', { hasText: 'Kids karate that builds confidence' }).waitFor();
  await page.screenshot({ path: join(shots, '02-editor-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Phone' }).click();
  await page.locator('[data-device="mobile"]').waitFor();
  await page.screenshot({ path: join(shots, '03-editor-phone-preview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByText('Draft saved.').waitFor();
  step('owner edits a section and connects the form; the draft preview updates on computer and phone; save keeps the revision');

  await page.getByLabel('Note for your records (optional)').fill('First launch');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('Published. Your site is live.').waitFor();
  const live = await q('SELECT status,published_version FROM hon.school_websites WHERE school_id=$1', [school.schoolId]);
  assert.deepEqual(live, [{ status: 'PUBLISHED', published_version: 1 }]);
  step('owner publishes version 1');

  // A visitor (no session) opens the public address and sends the enquiry form.
  const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const site = await visitor.newPage();
  site.on('pageerror', e => console.error('pageerror', e.message));
  await site.goto(`${WEB}/sites/${slug}?utm_source=flyer&utm_campaign=fall`);
  await site.getByRole('heading', { name: 'Kids karate that builds confidence' }).waitFor();
  assert.equal(await site.title(), 'Synthetic Tiger Dojo');
  await site.screenshot({ path: join(shots, '04-public-site-phone.png'), fullPage: true });
  const leadsBefore = Number((await q('SELECT count(*) n FROM hon.crm_leads WHERE school_id=$1', [school.schoolId]))[0].n);
  const formSection = site.locator('section[data-section="LEAD_FORM"]');
  await formSection.getByLabel('Name').fill('Synthetic Visitor');
  await formSection.getByLabel('Email').fill(`visitor-${randomUUID()}@example.invalid`);
  await formSection.getByRole('checkbox').check();
  await formSection.getByRole('button', { name: 'Send' }).click();
  await site.getByText('Thank you. The school has your details').waitFor();
  await site.screenshot({ path: join(shots, '05-public-form-sent.png'), fullPage: true });
  const leads = await q("SELECT l.id,l.source_code,p.given_name||' '||p.family_name AS name FROM hon.crm_leads l JOIN hon.people p ON p.id=l.primary_person_id WHERE l.school_id=$1 ORDER BY l.created_at", [school.schoolId]);
  assert.equal(leads.length, leadsBefore + 1);
  assert.match(leads.at(-1).name, /Synthetic\s+Visitor/);
  const receipt = await q('SELECT count(*) n FROM hon.public_lead_form_receipts r JOIN hon.public_lead_forms f ON f.id=r.form_id WHERE f.public_id=$1', [form.publicId]);
  assert.equal(receipt[0].n, '1');
  step('a visitor submits the form on the public site and an actual CRM lead is created through the 0075 intake');

  // History and rollback: change, publish v2, then put v1 live again.
  await page.getByRole('button', { name: 'Computer' }).click();
  await page.locator('li[data-section-row="HERO"] button', { hasText: 'Main banner' }).click();
  await page.locator('[data-editing="hero"]').getByLabel('Heading', { exact: true }).fill('Second headline');
  await page.getByRole('button', { name: 'Save draft' }).click(); await page.getByText('Draft saved.').waitFor();
  await page.getByRole('button', { name: 'Publish', exact: true }).click(); await page.getByText('Published. Your site is live.').waitFor();
  await page.getByRole('button', { name: 'Published versions' }).click();
  await page.locator('li[data-version="1"]').getByRole('button', { name: 'Put this version live' }).click();
  await page.getByText('Your current draft is replaced by that version').waitFor();
  await page.screenshot({ path: join(shots, '06-history-restore.png'), fullPage: true });
  await page.locator('li[data-version="1"]').getByRole('button', { name: 'Yes' }).click();
  await page.getByText('That version is live again.').waitFor();
  await site.reload(); await site.getByRole('heading', { name: 'Kids karate that builds confidence' }).waitFor();
  assert.deepEqual(await q('SELECT status,published_version FROM hon.school_websites WHERE school_id=$1', [school.schoolId]), [{ status: 'PUBLISHED', published_version: 3 }]);
  step('publish version 2, then roll back: version 1 is live again as version 3');

  await browser.close();
  console.log(`PASS: school website acceptance, screenshots in ${shots}`);
} catch (error) {
  if (current) await current.screenshot({ path: join(shots, 'zz-failure.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  for (const c of children) c.kill('SIGTERM');
  await q("UPDATE hon.hon_os_signup_program SET status='CLOSED',recorded_at=clock_timestamp() WHERE program_id=1").catch(() => undefined);
  await Promise.allSettled([admin.end(), restricted.end()]);
}
