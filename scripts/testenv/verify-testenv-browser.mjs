// End-to-end check of a RUNNING private test environment with a real browser.
//
// Usage (environment already started with `pnpm testenv:up`):
//   HON_TESTENV_PLAYWRIGHT=/path/to/node_modules/playwright node scripts/testenv/verify-testenv-browser.mjs [results-dir]
//
// Everything goes through the actual application: real sign-in, real HQ and school-owner UI,
// real API authorization and the private PostgreSQL database. It creates (or reuses) the
// non-production schools "Test Dojo A" and "Test Dojo B" and binds the two test school owners.
// Browser traffic to anything other than https://localhost:3443 is blocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateDirectory, TESTENV } from './testenv.mjs';
import { signIn } from './session-client.mjs';

const { ORIGIN } = TESTENV;
const playwrightPath = process.env.HON_TESTENV_PLAYWRIGHT;
if (!playwrightPath) throw new Error('Set HON_TESTENV_PLAYWRIGHT to an installed playwright package directory.');
const { chromium } = createRequire(import.meta.url)(resolve(playwrightPath));
const results = resolve(process.argv[2] ?? join(stateDirectory(), 'verification'));
mkdirSync(results, { recursive: true });
const dir = stateDirectory();
const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
const caFile = join(dir, 'tls', 'ca.pem');
const report = {
  origin: ORIGIN, startedAt: new Date().toISOString(), checks: [], screenshots: [],
  evidenceScope: 'Real login/provisioning/invitation smoke only; not all seven operating journeys.',
  realProviderCalls: null,
  providerEvidence: 'Browser foreign-origin traffic blocked; server provider egress is not measured by this verifier.',
  staffPlaneIsolationVerified: false,
};
const check = (name, detail = '') => { report.checks.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

const browser = await chromium.launch({ headless: true });
async function browserAs(identityName, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, serviceWorkers: 'block' });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === ORIGIN ? route.continue() : route.abort()));
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${ORIGIN}/auth/login`);
  await page.getByLabel(identityName, { exact: false }).check();
  await page.getByLabel('Private access code').fill(secrets.accessCode);
  await page.getByRole('button', { name: 'Sign in to HON OS' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/__test-idp'));
  return { context, page };
}
async function shot(page, name) {
  await page.screenshot({ path: join(results, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
}
async function ensureSchool(name) {
  const hq = await signIn({ origin: ORIGIN, caFile, identityKey: 'hq-owner', accessCode: secrets.accessCode });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const response = await hq.api('POST', '/api/v1/hq/organizations', { headers: { 'Idempotency-Key': `testenv-create-school-${slug}` }, json: { legalName: `${name} (non-production test) LLC`, displayName: name, schoolName: `${name} — Main`, schoolSlug: slug, timezone: 'America/Los_Angeles', initialTier: 'CORE' } });
  assert.ok([200, 201].includes(response.status), `provision ${name}: HTTP ${response.status}`);
  return response.data.data.schoolId;
}

async function persistenceOnly() {
  // After a full stop/start: nothing is re-created; the earlier records must still be there.
  const hq = await browserAs('HQ Owner (test)');
  await hq.page.goto(`${ORIGIN}/hq/schools`);
  await hq.page.getByText('Test Dojo A', { exact: false }).first().waitFor({ timeout: 20000 });
  await hq.page.getByText('Test Dojo B', { exact: false }).first().waitFor();
  await shot(hq.page, 'after-restart-hq-schools-directory');
  await hq.context.close();
  check('After a full restart the HQ directory still lists both schools from the private database');
  const hqApi = await signIn({ origin: ORIGIN, caFile, identityKey: 'hq-owner', accessCode: secrets.accessCode });
  const directory = await hqApi.api('GET', '/api/v1/hq/schools');
  assert.equal(directory.status, 200);
  for (const name of ['Test Dojo A', 'Test Dojo B']) {
    const school = directory.data.data.directory.schools.find((row) => row.organizationDisplayName === name);
    assert.ok(school, `${name} in directory`);
    const list = await hqApi.api('GET', `/api/v1/hq/schools/${school.schoolId}/owner-invitations`);
    assert.equal(list.status, 200, `${name} invitations HTTP ${list.status}`);
    assert.ok(list.data.data.some((row) => row.status === 'ACCEPTED'), `${name} has an accepted owner invitation`);
  }
  check('After a full restart both accepted school-owner invitations are still recorded as ACCEPTED');
}

try {
  if (process.env.HON_TESTENV_VERIFY_PERSISTENCE === '1') { await persistenceOnly(); report.finishedAt = new Date().toISOString(); console.log(`PASS persistence verification: ${report.checks.length} checks`); }
  else {
  // 1. Sign-in is real and grants nothing by itself.
  const visitor = await signIn({ origin: ORIGIN, caFile, identityKey: 'unprovisioned', accessCode: secrets.accessCode });
  const visitorHq = await visitor.api('GET', '/api/v1/hq/session');
  assert.ok([401, 403].includes(visitorHq.status), `unprovisioned HQ session HTTP ${visitorHq.status}`);
  const visitorProvision = await visitor.api('POST', '/api/v1/hq/organizations', { headers: { 'Idempotency-Key': 'testenv-visitor-attempt' }, json: { legalName: 'Refused LLC', displayName: 'Refused', schoolName: 'Refused', schoolSlug: 'refused', timezone: 'UTC', initialTier: 'CORE' } });
  assert.equal(visitorProvision.status, 403);
  check('Unprovisioned identity signs in for real but is refused HQ access and HQ provisioning', `HTTP ${visitorHq.status} / ${visitorProvision.status}`);

  // 2. HQ owner, real HQ workspace with database-backed facts.
  const schoolA = await ensureSchool('Test Dojo A');
  const schoolB = await ensureSchool('Test Dojo B');
  check('HQ owner provisions two non-production schools through the real HQ provisioning API', `${schoolA} / ${schoolB}`);
  const hq = await browserAs('HQ Owner (test)');
  await hq.page.goto(`${ORIGIN}/hq`);
  await hq.page.getByText('Company at a glance', { exact: false }).waitFor();
  await shot(hq.page, 'hq-overview');
  await hq.page.goto(`${ORIGIN}/hq/schools`);
  await hq.page.getByText('Test Dojo A', { exact: false }).first().waitFor({ timeout: 20000 });
  await hq.page.getByText('Test Dojo B', { exact: false }).first().waitFor();
  await shot(hq.page, 'hq-schools-directory');
  check('HQ owner sees both schools in the real HQ school directory');

  // 3. HQ invites each school owner through the real invitation UI.
  const invitations = {};
  for (const [schoolId, email, key] of [[schoolA, 'school-a-owner@hon-testenv.invalid', 'a'], [schoolB, 'school-b-owner@hon-testenv.invalid', 'b']]) {
    const page = hq.page;
    await page.goto(`${ORIGIN}/hq/school-owner-invitations`);
    await page.getByRole('button', { name: 'Verify access', exact: true }).click();
    await page.getByText('Access verified.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Load approved schools' }).click();
    await page.getByLabel('Approved school').selectOption(schoolId);
    await page.getByLabel('Owner email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Generate private token' }).click();
    const token = await page.getByLabel('Private invitation token', { exact: true }).inputValue();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    await page.getByRole('button', { name: 'Record owner invitation' }).click();
    await page.getByText('Invitation recorded.', { exact: false }).waitFor({ timeout: 20000 }).catch(async (error) => { await shot(page, `failure-invitation-${key}`); console.error((await page.innerText('main')).slice(0, 3000)); throw error; });
    const body = await page.innerText('main');
    const ids = [...body.matchAll(new RegExp(`${email.replace('.', '\\.')} — PENDING[\\s\\S]*?Invitation ID: ([0-9a-f-]{36})`, 'g'))].map((m) => m[1]);
    assert.ok(ids.length > 0, `pending invitation for ${email} listed`);
    invitations[key] = { id: ids[ids.length - 1], token, email, schoolId };
    if (key === 'a') await shot(page, 'hq-owner-invitation-recorded');
  }
  check('HQ owner records school-owner invitations through the real HQ invitation screen');
  await hq.context.close();

  // 4. Each school owner accepts with their own identity, then works in their own school only.
  for (const [key, name] of [['a', 'School A Owner (test)'], ['b', 'School B Owner (test)']]) {
    const owner = await browserAs(name);
    const page = owner.page;
    await page.goto(`${ORIGIN}/account/owner-invitation`);
    await page.getByRole('button', { name: 'Verify access', exact: true }).click();
    await page.getByText('Access verified.', { exact: false }).waitFor();
    await page.getByLabel('Invitation ID', { exact: true }).fill(invitations[key].id);
    await page.getByLabel('Private invitation token', { exact: true }).fill(invitations[key].token);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await page.getByText('School-owner account bound.', { exact: false }).waitFor({ timeout: 20000 });
    if (key === 'a') await shot(page, 'owner-a-invitation-accepted');
    await page.goto(`${ORIGIN}/staff/dashboard`);
    await page.waitForTimeout(4000);
    await shot(page, `owner-${key}-staff-dashboard`);
    const ownerHq = await page.request.get(`${ORIGIN}/api/v1/hq/session`);
    assert.ok([401, 403].includes(ownerHq.status()), `school owner HQ HTTP ${ownerHq.status()}`);
    const other = key === 'a' ? invitations.b.schoolId : invitations.a.schoolId;
    const otherInvitations = await page.request.get(`${ORIGIN}/api/v1/hq/schools/${other}/owner-invitations`);
    assert.ok([401, 403].includes(otherInvitations.status()), `cross-school HTTP ${otherInvitations.status()}`);
    check(`School ${key.toUpperCase()} owner accepts the invitation and is refused HQ and the other school`, `HQ ${ownerHq.status()}, other school ${otherInvitations.status()}`);
    await owner.context.close();
  }
  report.finishedAt = new Date().toISOString();
  report.invitationSchools = { a: invitations.a.schoolId, b: invitations.b.schoolId };
  console.log(`PASS private test environment browser verification: ${report.checks.length} checks, ${report.screenshots.length} screenshots`);
  }
} finally {
  await browser.close();
  writeFileSync(join(results, 'testenv-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
