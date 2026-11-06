// Bounded verification of an ALREADY RUNNING private owner test environment.
// Usage: HON_TESTENV_PLAYWRIGHT=/installed/playwright [HON_TESTENV_CHROME=/installed/chrome]
//   node scripts/testenv/verify-testenv-browser.mjs [private-results-dir]
// Real passcode site gate -> test-IdP OIDC login -> actual Next/Nest/IAM/database.
// All commands use native UI; the server, never this script, issues gate/session cookies.
// No fabricated cookies, API mocks, header repairs, access grants or staff/A-G proof.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateDirectory, TESTENV } from './testenv.mjs';
import { TEST_IDENTITIES, honExternalSubject } from './identities.mjs';

const { ORIGIN } = TESTENV;
const playwrightPath = process.env.HON_TESTENV_PLAYWRIGHT;
if (!playwrightPath) throw new Error('Set HON_TESTENV_PLAYWRIGHT to an installed playwright package directory.');
const { chromium } = createRequire(import.meta.url)(resolve(playwrightPath));
const dir = stateDirectory();
const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
const results = resolve(process.argv[2] ?? join(dir, 'verification'));
mkdirSync(results, { recursive: true, mode: 0o700 });
const reportPath = join(results, 'testenv-browser-report.json');
// Prior canonical IDs are only comparison evidence; fresh server reads still authorize every use.
const previous = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
const report = {
  origin: ORIGIN, startedAt: new Date().toISOString(), passed: false, checks: [], screenshots: [], schools: {},
  evidenceScope: 'Real private test-IdP OIDC login, HQ form provisioning/directory, and two school-owner invitation/binding attempts only. Not full A-G, staff operations or owner-device acceptance.',
  creationReceipts: [], responses: [], ownerInvitations: {}, blockedExternalOrigins: [],
  realProviderCalls: null,
  providerEvidence: 'Foreign-origin browser traffic blocked; server provider egress is not measured.',
  staffPlaneIsolationVerified: false, staffOperationalAccessVerified: false, sevenJourneysVerified: false,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const specs = [
  { key: 'a', name: 'Test Dojo A', identity: 'school-owner-a' },
  { key: 'b', name: 'Test Dojo B', identity: 'school-owner-b' },
];
let browser, stage = 'launch-browser';
const check = (name, detail = '') => {
  report.checks.push({ name, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
};
function closed(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
  return value;
}
function identity(key) {
  const value = TEST_IDENTITIES.find(row => row.key === key);
  assert.ok(value, 'Known private test identity required');
  return value;
}
function matches(response, method, path) {
  const url = new URL(response.url());
  return url.origin === ORIGIN && url.pathname === path && !url.search && response.request().method() === method;
}
async function responseData(response, method, path) {
  const status = response.status();
  report.responses.push({ stage, method, path, status });
  // Never log raw bodies, subjects, invitation tokens, session/IdP material or request headers.
  assert.ok(response.ok(), `${stage}: ${method} ${path} HTTP ${status}; no retry or access bypass attempted`);
  return response.json();
}
async function action(page, method, path, work) {
  const [response] = await Promise.all([page.waitForResponse(r => matches(r, method, path)), work()]);
  return { response, value: await responseData(response, method, path) };
}
async function nativeRead(page, path) {
  assert.ok(path.startsWith('/api/'), 'Fixed same-origin API read required');
  const value = await page.evaluate(async path => {
    const response = await fetch(path, {
      method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
      redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, value: await response.json().catch(() => null) };
  }, path);
  report.responses.push({ stage, method: 'GET', path, status: value.status });
  return value;
}
async function browserAs(key) {
  stage = `oidc-login-${key}`;
  const person = identity(key);
  const context = await browser.newContext({ ignoreHTTPSErrors: ORIGIN.startsWith('https://localhost:'), viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => {
      const origin = new URL(route.request().url()).origin;
      if (origin === ORIGIN) return route.continue(); // No request/header override or response substitution.
      if (!report.blockedExternalOrigins.includes(origin)) report.blockedExternalOrigins.push(origin);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    // Only the actual invitation confirmation is accepted; unexpected dialogs cannot authorize a command.
    page.on('dialog', dialog => dialog.message() === 'Invite this email as owner of the selected school?'
      ? dialog.accept() : dialog.dismiss());
    stage = `private-site-gate-${key}`;
    assert.ok(typeof secrets.gatePasscode === 'string' && secrets.gatePasscode.length >= 32, 'Parent-provided private site passcode required');
    await page.goto(`${ORIGIN}/__private-access`);
    await page.getByLabel('Private site passcode', { exact: true }).fill(secrets.gatePasscode);
    const [gateResponse] = await Promise.all([
      page.waitForResponse(r => matches(r, 'POST', '/__private-access')),
      page.getByRole('button', { name: 'Unlock test site', exact: true }).click(),
    ]);
    report.responses.push({ stage, method: 'POST', path: '/__private-access', status: gateResponse.status() });
    assert.ok([302, 303].includes(gateResponse.status()), 'Actual site gate must accept and redirect; no gate cookie fabricated');
    await page.waitForURL(url => url.origin === ORIGIN && url.pathname !== '/__private-access');
    stage = `oidc-login-${key}`;
    await page.goto(`${ORIGIN}/auth/login`);
    await page.waitForURL(url => url.origin === ORIGIN && url.pathname.startsWith('/__test-idp/'));
    await page.getByLabel(person.name, { exact: false }).check();
    await page.getByLabel('Private access code', { exact: true }).fill(secrets.accessCode);
    await Promise.all([
      page.waitForURL(url => url.origin === ORIGIN && ['/hq', '/staff/entry', '/auth/access'].includes(url.pathname)),
      page.getByRole('button', { name: 'Sign in to HON OS', exact: true }).click(),
    ]);
    const me = await nativeRead(page, '/api/identity/me');
    assert.equal(me.status, 200, 'Actual signed OIDC identity must be readable');
    assert.equal(me.value?.data?.externalSubject, honExternalSubject(TESTENV.ISSUER, person.sub));
    check(`${person.name} completes actual OIDC browser login`);
    return { context, page };
  } catch (error) { await context.close(); throw error; }
}
async function shot(page, name) {
  const path = join(results, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  chmodSync(path, 0o600);
  report.screenshots.push(`${name}.png`);
}
async function directory(page) {
  stage = 'explicit-hq-directory-read';
  await page.goto(`${ORIGIN}/hq/schools`);
  const area = page.locator('[data-hq-directory]');
  await area.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-hq-directory]')?.getAttribute('data-hq-directory-busy') === 'false');
  // Exercise the real privacy lifecycle, then the explicit authorized read. Never assume
  // an automatic heading/directory survives login, navigation or privacy concealment.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.ok(await page.locator('[data-hq-directory-facts]').evaluate(node => node.hidden && node.inert));
  const { value } = await action(page, 'GET', '/api/v1/hq/schools', () =>
    area.getByRole('button', { name: 'Verify and read school directory', exact: true }).click());
  closed(value, ['data']); closed(value.data, ['directory']); closed(value.data.directory, ['schools']);
  assert.ok(Array.isArray(value.data.directory.schools));
  await page.waitForFunction(() => document.querySelector('[data-hq-directory]')?.getAttribute('data-hq-directory-busy') === 'false');
  const facts = page.locator('[data-hq-directory-facts]');
  assert.ok(await facts.evaluate(node => !node.hidden && !node.inert), 'Pre/post-principal checked directory is visible');
  for (const row of value.data.directory.schools) {
    closed(row, ['schoolId', 'organizationDisplayName', 'schoolDisplayName', 'organizationOperationalStatus', 'schoolOperationalStatus', 'entitlementTier', 'createdAt']);
    assert.match(row.schoolId, UUID);
  }
  return value.data.directory.schools;
}
function assertSchool(rows, spec, schoolId) {
  const row = rows.find(value => value.schoolId === schoolId);
  assert.ok(row, `${spec.name}: canonical school ID in fresh directory`);
  assert.equal(row.organizationDisplayName, spec.name);
  assert.equal(row.schoolDisplayName, `${spec.name} — Main`);
  return row;
}
async function provisionSchool(page, spec) {
  stage = `hq-form-provision-${spec.key}`;
  const panel = page.locator('[data-school-create]');
  const { value: scope } = await action(page, 'GET', '/api/v1/hq/session', () =>
    panel.getByRole('button', { name: 'Verify HQ-owner access', exact: true }).click());
  closed(scope, ['data']); closed(scope.data, ['principalId', 'hqRole']);
  assert.equal(scope.data.hqRole, 'HON_HQ_OWNER'); assert.match(scope.data.principalId, UUID);
  const fields = [
    ['Legal organization name', `${spec.name} (non-production test) LLC`],
    ['School-facing organization name', spec.name], ['First school name', `${spec.name} — Main`],
    ['School slug', spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')], ['School timezone', 'America/Los_Angeles'],
  ];
  await panel.getByLabel('Legal organization name', { exact: true }).waitFor();
  for (const [label, value] of fields) await panel.getByLabel(label, { exact: true }).fill(value);
  assert.ok(await panel.getByRole('button', { name: 'Create school', exact: true }).isDisabled());
  await panel.getByLabel('I reviewed these details and confirm creating this organization and first school without operating access.', { exact: true }).check();
  const { response, value } = await action(page, 'POST', '/api/v1/hq/organizations', () =>
    panel.getByRole('button', { name: 'Create school', exact: true }).click());
  closed(value, ['data', 'meta']); closed(value.meta, ['replayed']);
  const receipt = closed(value.data, ['organizationId', 'schoolId', 'ownerRoleId', 'replayed', 'actorPrincipalId', 'entitlementStatus']);
  for (const key of ['organizationId', 'schoolId', 'ownerRoleId', 'actorPrincipalId']) assert.match(receipt[key], UUID);
  assert.equal(receipt.actorPrincipalId.toLowerCase(), scope.data.principalId.toLowerCase());
  assert.equal(receipt.entitlementStatus, 'SUSPENDED');
  assert.equal(receipt.replayed, false); assert.equal(value.meta.replayed, false); assert.equal(response.status(), 201);
  assert.equal(new Set([receipt.organizationId, receipt.schoolId, receipt.ownerRoleId]).size, 3);
  report.creationReceipts.push({ key: spec.key, ...receipt });
  report.schools[spec.key] = { schoolId: receipt.schoolId, organizationId: receipt.organizationId, source: 'actual-hq-form-receipt' };
  // Observe (do not manufacture) the native form's protected command headers.
  const headers = await response.request().allHeaders();
  assert.equal(headers['x-hon-human-command'], 'hq-school-provisioning');
  assert.equal(headers['x-hon-expected-principal']?.toLowerCase(), scope.data.principalId.toLowerCase());
  assert.match(headers['idempotency-key'], UUID);
  assert.equal(headers.origin, ORIGIN);
  // Playwright interception does not expose every browser-generated Fetch Metadata header.
  // Preserve observed-value checks; the actual unmodified Nest guard requires all three
  // exact values before the real 201 actor-bound receipt above can be returned.
  const metadata = {};
  for (const [name, expected] of [['sec-fetch-site', 'same-origin'], ['sec-fetch-mode', 'same-origin'], ['sec-fetch-dest', 'empty']]) {
    metadata[name] = headers[name] ?? null;
    if (headers[name] !== undefined) assert.equal(headers[name], expected);
  }
  (report.nativeMetadata ??= []).push({ key: spec.key, browserObserved: metadata,
    serverEvidence: 'Actual 201 from unchanged exact-head Nest direct-human guard; mandatory Origin/Fetch Metadata/expected-principal gates enforced independently.' });
  assert.equal(headers.authorization, undefined);
  assert.ok(!Object.keys(headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-')));
  const sent = closed(response.request().postDataJSON(), ['legalName', 'displayName', 'schoolName', 'schoolSlug', 'timezone', 'initialTier']);
  assert.equal(sent.initialTier, 'COMPLETE'); // Native suspended placeholder, not an access grant.
  assert.equal(sent.displayName, spec.name); assert.equal(sent.schoolName, `${spec.name} — Main`);
  await panel.getByRole('heading', { name: 'School creation receipt', exact: true }).waitFor();
  await panel.getByText(receipt.schoolId, { exact: true }).waitFor();
  const post = await nativeRead(page, '/api/v1/hq/session');
  assert.equal(post.status, 200); assert.equal(post.value?.data?.principalId?.toLowerCase(), receipt.actorPrincipalId.toLowerCase());
  await shot(page, `hq-school-${spec.key}-creation-receipt`);
  check(`${spec.name} created by the native protected HQ form with an actor-bound SUSPENDED receipt`);
  return receipt.schoolId;
}
async function invite(page, spec) {
  stage = `hq-owner-invitation-${spec.key}`;
  await page.goto(`${ORIGIN}/hq/school-owner-invitations`);
  const panel = page.getByRole('region', { name: 'School-owner invitations', exact: true });
  await panel.getByRole('button', { name: 'Verify access', exact: true }).click();
  await panel.getByText('Access verified.', { exact: false }).waitFor();
  const { value } = await action(page, 'GET', '/api/v1/hq/schools', () =>
    panel.getByRole('button', { name: 'Load approved schools', exact: true }).click());
  const schoolId = report.schools[spec.key].schoolId;
  assertSchool(value.data.directory.schools, spec, schoolId);
  // The current wrapping label contains option text. Scope by label prefix plus
  // native select, as opposed to relying on a stale exact accessible name.
  await panel.locator('label').filter({ hasText: /^Approved school/ }).locator('select').selectOption(schoolId);
  const email = identity(spec.identity).email;
  await panel.getByLabel('Owner email', { exact: true }).fill(email);
  await panel.getByRole('button', { name: 'Generate private token', exact: true }).click();
  const token = await panel.getByLabel('Private invitation token', { exact: true }).inputValue();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const { value: receipt } = await action(page, 'POST', '/api/v1/hq/school-owner-invitations', () =>
    panel.getByRole('button', { name: 'Record owner invitation', exact: true }).click());
  closed(receipt, ['data']);
  closed(receipt.data, ['invitationId', 'organizationId', 'schoolId', 'email', 'expiresAt', 'status']);
  assert.equal(receipt.data.schoolId, schoolId); assert.equal(receipt.data.email, email);
  assert.equal(receipt.data.status, 'PENDING'); assert.match(receipt.data.invitationId, UUID);
  assert.match(receipt.data.organizationId, UUID);
  await panel.getByText('Invitation recorded.', { exact: false }).waitFor();
  await panel.getByText(`Invitation ID: ${receipt.data.invitationId}`, { exact: true }).waitFor();
  // Do not capture this page: it displays the manual-delivery token.
  check(`${spec.name} owner invitation recorded through the real HQ screen`);
  return { id: receipt.data.invitationId, token, schoolId, organizationId: receipt.data.organizationId };
}
async function accept(spec, invitation) {
  const owner = await browserAs(spec.identity);
  try {
    stage = `school-owner-accept-${spec.key}`;
    const page = owner.page;
    await page.goto(`${ORIGIN}/account/owner-invitation`);
    const panel = page.getByRole('region', { name: 'Accept school-owner invitation', exact: true });
    await panel.getByRole('button', { name: 'Verify access', exact: true }).click();
    await panel.getByText('Access verified.', { exact: false }).waitFor();
    await panel.getByLabel('Invitation ID', { exact: true }).fill(invitation.id);
    await panel.getByLabel('Private invitation token', { exact: true }).fill(invitation.token);
    await panel.getByLabel('I am the invited school owner and explicitly accept this account invitation.', { exact: true }).check();
    const { value } = await action(page, 'POST', '/api/v1/account/school-owner-invitations/accept', () =>
      panel.getByRole('button', { name: 'Accept invitation', exact: true }).click());
    closed(value, ['data']);
    closed(value.data, ['invitationId', 'organizationId', 'schoolId', 'accountStatus', 'accessGranted', 'billingActivated', 'aiCreditsGranted']);
    assert.equal(value.data.invitationId, invitation.id); assert.equal(value.data.organizationId, invitation.organizationId);
    assert.equal(value.data.schoolId, invitation.schoolId);
    assert.equal(value.data.accountStatus, 'OWNER_BOUND');
    for (const key of ['accessGranted', 'billingActivated', 'aiCreditsGranted']) assert.equal(value.data[key], false);
    await panel.getByText('School-owner account bound.', { exact: false }).waitFor();
    report.ownerInvitations[spec.key] = { schoolId: invitation.schoolId, invitationId: invitation.id, accepted: true };
    // Account binding is not an operating-access receipt. Do not enter staff modules.
    const hq = await nativeRead(page, '/api/v1/hq/session');
    assert.ok([401, 403].includes(hq.status), 'School-owner identity cannot acquire HQ authority');
    check(`${spec.name} owner receives a real account-binding receipt and is refused HQ`, `HQ HTTP ${hq.status}; operating access unverified`);
  } finally { invitation.token = ''; await owner.context.close(); }
}
async function verifyAccepted(page, spec) {
  stage = `hq-reload-invitations-${spec.key}`;
  await page.goto(`${ORIGIN}/hq/school-owner-invitations`);
  const panel = page.getByRole('region', { name: 'School-owner invitations', exact: true });
  await panel.getByRole('button', { name: 'Verify access', exact: true }).click();
  await panel.getByText('Access verified.', { exact: false }).waitFor();
  await action(page, 'GET', '/api/v1/hq/schools', () => panel.getByRole('button', { name: 'Load approved schools', exact: true }).click());
  const schoolId = report.schools[spec.key].schoolId;
  await panel.locator('label').filter({ hasText: /^Approved school/ }).locator('select').selectOption(schoolId);
  const { value } = await action(page, 'GET', `/api/v1/hq/schools/${schoolId}/owner-invitations`, () =>
    panel.getByRole('button', { name: 'Review invitations (latest 50)', exact: true }).click());
  assert.ok(Array.isArray(value.data));
  const recorded = report.ownerInvitations[spec.key] ?? previous?.ownerInvitations?.[spec.key];
  assert.ok(recorded?.accepted && recorded.schoolId === schoolId, 'Prior actual accepted receipt required');
  const accepted = value.data.find(row => row.invitationId === recorded.invitationId && row.schoolId === schoolId && row.status === 'ACCEPTED');
  assert.ok(accepted, 'Exact invitation is ACCEPTED in fresh authorized read');
  assert.match(accepted.organizationId, UUID);
  report.schools[spec.key].organizationId = accepted.organizationId;
  report.ownerInvitations[spec.key] = recorded;
  check(`${spec.name} exact accepted invitation survives a new UI/read`);
}

try {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.HON_TESTENV_CHROME ? { executablePath: process.env.HON_TESTENV_CHROME } : {}) });
  if (process.env.HON_TESTENV_VERIFY_PERSISTENCE !== '1') {
    const visitor = await browserAs('unprovisioned');
    try {
      stage = 'unprovisioned-hq-refusal';
      const hq = await nativeRead(visitor.page, '/api/v1/hq/session');
      assert.ok([401, 403].includes(hq.status));
      check('Unprovisioned real-login identity is refused HQ scope', `HTTP ${hq.status}; no unauthorized command fabricated`);
    } finally { await visitor.context.close(); }
  }
  const hq = await browserAs('hq-owner');
  try {
    let rows = await directory(hq.page);
    for (const spec of specs) {
      const existing = rows.filter(row => row.organizationDisplayName === spec.name && row.schoolDisplayName === `${spec.name} — Main`);
      assert.ok(existing.length <= 1, 'Ambiguous test school requires owner review');
      if (existing.length) {
        const schoolId = existing[0].schoolId;
        if (previous?.schools?.[spec.key]) assert.equal(schoolId, previous.schools[spec.key].schoolId, 'Canonical school identity survives reload/restart');
        report.schools[spec.key] = { schoolId, source: 'fresh-authorized-directory-read' };
        check(`${spec.name} reuses a canonical school from an actual directory read`, 'No new creation receipt or current operating access inferred');
      } else {
        assert.notEqual(process.env.HON_TESTENV_VERIFY_PERSISTENCE, '1', 'Persistence mode never recreates schools');
        await provisionSchool(hq.page, spec);
        rows = await directory(hq.page);
        assertSchool(rows, spec, report.schools[spec.key].schoolId);
      }
    }
    rows = await directory(hq.page); // Full document navigation plus explicit pre/post-principal checked read.
    for (const spec of specs) {
      const row = assertSchool(rows, spec, report.schools[spec.key].schoolId);
      await hq.page.locator('[data-hq-directory-facts]').getByText(row.schoolDisplayName, { exact: true }).waitFor();
    }
    await shot(hq.page, 'hq-schools-reloaded-directory');
    check('Reloaded explicitly authorized HQ directory returns both canonical school IDs');
    if (process.env.HON_TESTENV_VERIFY_PERSISTENCE === '1') {
      for (const spec of specs) await verifyAccepted(hq.page, spec);
    } else {
      // Keep the two owner invocations independent; a refused first invitation must
      // not masquerade as success or erase the other actual invocation's finding.
      report.invocationFailures = [];
      for (const spec of specs) {
        let invitation;
        try {
          invitation = await invite(hq.page, spec);
          await accept(spec, invitation);
          await verifyAccepted(hq.page, spec);
        } catch (error) {
          report.invocationFailures.push({ key: spec.key, stage, type: error.name,
            message: 'Owner invitation/binding did not complete. Suspended provisioning grants no access; no entitlement/policy workaround or retry was performed.' });
        } finally { if (invitation) invitation.token = ''; }
      }
      assert.equal(report.invocationFailures.length, 0, 'One or more real owner invitation/binding invocations failed; consult sanitized response statuses');
    }
    stage = 'read-only-testing-governance-preflight';
    const policy = await nativeRead(hq.page, '/api/v1/hq/saas/access-exception-policy');
    assert.equal(policy.status, 200); report.exceptionPolicy = policy.value?.data;
    report.testingAccess = {}; report.testingTerms = {};
    for (const spec of specs) {
      const organization = report.schools[spec.key].organizationId;
      assert.match(organization, UUID);
      const access = await nativeRead(hq.page, `/api/v1/hq/saas/organizations/${organization}/access-exceptions`);
      assert.equal(access.status, 200); report.testingAccess[spec.key] = access.value?.data;
      const terms = await nativeRead(hq.page, `/api/v1/hq/saas/access/${organization}`);
      assert.equal(terms.status, 200); report.testingTerms[spec.key] = terms.value?.data;
    }
    report.passed = true;
  } finally { await hq.context.close(); }
} catch (error) {
  process.exitCode = 1;
  report.failure = { stage, type: error.name, message: 'Bounded native verification incomplete; no fabricated success, transport repair, automatic retry or access bypass.' };
  report.failure.location = String(error.stack ?? '').split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4);
  console.error(`FAIL ${stage}; consult sanitized response statuses in the private report.`);
} finally {
  try { await browser?.close(); }
  finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(reportPath, 0o600);
  }
}
console.log(`${report.passed ? 'PASS' : 'INCOMPLETE'} bounded private browser verification: ${report.checks.length} checks; not staff/A-G acceptance.`);
