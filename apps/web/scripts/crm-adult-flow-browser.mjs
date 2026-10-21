/** Actual production Next application, real session gate, synthetic localhost API contracts. No database/provider access. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { issueSession, verifySession, cookieValue, HON_SESSION_COOKIE } from '@hon/auth';
import { validateRegisterCrmLeadInput, validateCreateBillingAccountInput, validateCrmAdultMembershipDraftInput, validateCrmLeadRegistrationRecoveryInput, verifyCrmLeadRegistrationRecovery } from '@hon/contracts';

assert(process.env.GITHUB_ACTIONS === 'true');
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert(!process.env[key], 'No database/provider credentials allowed.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), tools = process.env.HON_CRM_TOOLS, results = process.env.HON_CRM_RESULTS;
assert(tools && results && process.env.HON_CRM_CHROME);
const requireTools = createRequire(join(tools, 'runner.cjs')), requireWeb = createRequire(join(root, 'package.json'));
const { chromium } = requireTools('playwright-core'), axe = await readFile(requireTools.resolve('axe-core/axe.min.js'), 'utf8');
await mkdir(results, { recursive: true });
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) }, date = '2026-10-20T09:00:00.000Z';
const lead = { id: id(3), primaryPersonId: id(4), pipelineStageId: id(8), givenName: 'Ari', familyName: 'Stone', status: 'WON', version: 1, createdAt: date };
const registration = { outcome: 'REGISTERED', leadId: id(3), sourceContactPersonId: id(4), registrationPath: 'ADULT', studentProfileId: id(5), familyId: null, recordedAt: date };
const account = { id: id(6), responsiblePersonId: id(4), currency: 'USD', classification: 'CANONICAL', reused: true, version: 1, createdAt: date };
const receipt = { membershipId: id(7), state: 'DRAFT', planCode: 'ADULT-MONTHLY', termStartedAt: null, termEndsAt: null, recordedAt: date };
const report = { sourceSha: process.env.HON_CRM_SOURCE_SHA, syntheticFixturesOnly: true, databaseAccess: false, providerCalls: false, checks: [], failures: [], screenshots: [], accessibility: [], requests: [], pageErrors: [] };
const probe = createServer(); await new Promise(done => probe.listen(0, '127.0.0.1', done)); const port = probe.address().port; await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`, session = { mode: 'OIDC', audience: 'hon-crm-browser-synthetic', secret: randomBytes(32).toString('hex') };
const prefix = `/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}`;
let mode, registered, accounted, drafted, keys, commands, recoveryReads;
function reset(value = 'ready') { mode = value; registered = false; accounted = false; drafted = false; keys = new Map(); commands = []; recoveryReads = [];
  if (value.startsWith('recovery-')) { const state = value.slice(9); registered = !['NOT_REGISTERED', 'NEEDS_STAFF_REVIEW'].includes(state); accounted = ['READY_FOR_DRAFT', 'CURRENT_DRAFT', 'CURRENT_DRAFT_BY_OTHER_STAFF'].includes(state); drafted = ['CURRENT_DRAFT', 'CURRENT_DRAFT_BY_OTHER_STAFF'].includes(state); }
}
reset();
function send(res, status, data, replayed = false) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ data, meta: { requestId: id(8), correlationId: id(8), replayed } })); }
const api = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:3001');
    let actor; try { actor = verifySession(cookieValue(req.headers.cookie, HON_SESSION_COOKIE) ?? '', session).externalSubject; } catch { send(res, 401, {}); return; }
    report.requests.push({ method: req.method, path: url.pathname });
    if (url.pathname === '/v1/me/language-preference') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify({ data: { preference: null, schoolDefault: null, effective: { language: 'en', source: 'SYSTEM_DEFAULT' }, supportedLanguages: ['en', 'ko', 'es'] } })); return; }
    if (actor !== 'crm-staff-synthetic' || !url.pathname.startsWith(prefix + '/')) { send(res, 403, { secret: 'private-canary' }); return; }
    if (req.method === 'GET' && url.pathname === `${prefix}/crm/leads`) { send(res, 200, [lead]); return; }
    const step = url.pathname === `${prefix}/crm/leads/${id(3)}/registration-recovery` ? 'recover'
      : url.pathname === `${prefix}/crm/leads/${id(3)}/register` ? 'register'
      : url.pathname === `${prefix}/billing/accounts` ? 'account'
      : url.pathname === `${prefix}/billing/crm-adult-membership-drafts/preparation` ? 'prepare'
      : url.pathname === `${prefix}/billing/crm-adult-membership-drafts/confirmation` ? 'confirm'
      : url.pathname === `${prefix}/billing/crm-adult-membership-drafts` ? 'draft' : null;
    const markers = { recover: 'crm-lead-registration-recovery', register: 'crm-lead-register', account: 'billing.account.create', prepare: 'crm-adult-membership-prepare', draft: 'crm-adult-membership-draft', confirm: 'crm-adult-membership-draft-confirmation' };
    if (!step || req.method !== 'POST' || url.search || req.headers.origin !== origin || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['x-hon-human-command'] !== markers[step] || !/^application\/json/.test(req.headers['content-type'] ?? '')) { send(res, 403, {}); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 2000) { send(res, 400, {}); return; } }
    const input = JSON.parse(raw), key = req.headers['idempotency-key'];
    if (['register', 'account', 'draft'].includes(step)) {
      if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key)) { send(res, 400, {}); return; }
      commands.push({ step, key, raw });
      if (keys.has(key)) { const prior = keys.get(key); if (prior.step !== step || prior.raw !== raw) send(res, 409, {}); else send(res, 200, prior.data, true); return; }
    } else if (key !== undefined) { send(res, 400, {}); return; }
    let data;
    if (step === 'recover') {
      validateCrmLeadRegistrationRecoveryInput(input); assert.equal(key, undefined); recoveryReads.push({ raw, key });
      if (mode === 'deny-recovery') { send(res, 403, { secret: 'private-canary' }); return; }
      if (mode === 'missing-recovery') { send(res, 404, { secret: 'private-canary' }); return; }
      if (mode === 'conflict-recovery' || mode === 'unavailable-recovery') { send(res, mode === 'conflict-recovery' ? 409 : 503, { secret: 'private-canary' }); return; }
      const state = mode === 'recovery-NEEDS_STAFF_REVIEW' ? 'NEEDS_STAFF_REVIEW' : !registered ? 'NOT_REGISTERED' : !accounted ? 'BILLING_ACCOUNT_REQUIRED' : !drafted ? 'READY_FOR_DRAFT' : mode === 'recovery-CURRENT_DRAFT_BY_OTHER_STAFF' ? 'CURRENT_DRAFT_BY_OTHER_STAFF' : 'CURRENT_DRAFT';
      data = { leadId: lead.id, workflowState: state };
      if (!['NOT_REGISTERED', 'NEEDS_STAFF_REVIEW'].includes(state)) data.historicalRegistrationReceipt = registration;
      if (['READY_FOR_DRAFT', 'CURRENT_DRAFT', 'CURRENT_DRAFT_BY_OTHER_STAFF'].includes(state)) data.billingAccount = { classification: 'CANONICAL', currency: 'USD' };
      if (state === 'CURRENT_DRAFT') data.currentMembershipDraft = { state: 'RECORDED_DRAFT', receipt };
      if (state === 'CURRENT_DRAFT_BY_OTHER_STAFF') data.currentMembershipDraft = { state: 'RECORDED_DRAFT' };
      verifyCrmLeadRegistrationRecovery(data, lead.id);
      if (mode === 'slow-recovery') await new Promise(done => setTimeout(done, 450));
      send(res, 200, data); return;
    }
    if (step === 'register') {
      validateRegisterCrmLeadInput(input); assert.equal(input.registrationPath, 'ADULT');
      if (mode === 'review' || registered) { send(res, 200, { outcome: 'NEEDS_STAFF_REVIEW' }); return; }
      registered = true; data = registration;
    } else if (step === 'account') {
      validateCreateBillingAccountInput(input); assert.equal(input.responsiblePersonId, id(4)); assert(registered);
      if (mode === 'deny-account') { send(res, 403, { secret: 'private-canary' }); return; }
      if (input.currency !== 'USD') { send(res, 409, {}); return; } accounted = true; data = account;
    } else {
      assert.deepEqual(Object.keys(input).sort(), step === 'draft' ? ['confirmation', 'planCode', 'studentProfileId'] : ['studentProfileId']); assert.equal(input.studentProfileId, id(5));
      if (!accounted) { send(res, 404, {}); return; }
      if (step === 'prepare') data = { studentDisplayName: 'Ari Stone', currency: 'USD', readiness: 'READY_FOR_DRAFT' };
      else if (step === 'draft') { validateCrmAdultMembershipDraftInput(input); assert.equal(input.planCode, receipt.planCode); drafted = true; data = receipt; }
      else { if (!drafted || mode === 'drift') { send(res, 404, {}); return; } data = { state: 'RECORDED_DRAFT', receipt }; }
    }
    if (key) keys.set(key, { step, raw, data });
    if (mode === 'unknown' && step === 'register') { mode = 'ready'; send(res, 503, {}); return; }
    if (mode === 'slow' && step === 'register') await new Promise(done => setTimeout(done, 450));
    send(res, step === 'account' && !account.reused ? 201 : 200, data);
  } catch { send(res, 400, {}); }
});
await new Promise((done, reject) => { api.once('error', reject); api.listen(3001, '127.0.0.1', done); });
const app = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HON_API_BASE_URL: 'http://127.0.0.1:3001', HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; app.stdout.on('data', d => { log += d; }); app.stderr.on('data', d => { log += d; });
let browser;
async function check(name, run) { try { await run(); report.checks.push(name); } catch (e) { report.failures.push({ name, error: e.message }); } }
async function open(viewport, actor = 'crm-staff-synthetic') {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (actor) await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: actor }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); page.on('pageerror', e => report.pageErrors.push(e.message));
  await page.goto(`${origin}/staff/crm/leads?${new URLSearchParams(scope)}&leadId=${id(99)}`);
  return { context, page };
}
async function choose(page) {
  assert.equal(commands.length, 0); await page.getByLabel('Status filter').selectOption('WON'); await page.getByRole('button', { name: 'Load CRM leads', exact: true }).click();
  await page.getByRole('button', { name: 'Set up adult membership', exact: true }).focus(); await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: 'Set up Ari Stone' }); await heading.waitFor(); assert(await heading.evaluate(e => e === document.activeElement), 'Opening setup must transfer keyboard focus to its heading');
  assert(await page.getByRole('button', { name: 'Load CRM leads', exact: true }).isDisabled()); assert.equal(commands.length, 0);
}
async function resume(page) {
  const count = recoveryReads.length;
  await page.getByLabel('Status filter').selectOption('WON'); await page.getByRole('button', { name: 'Load CRM leads', exact: true }).click();
  assert.equal(recoveryReads.length, count, 'Loading a list must never recover automatically');
  await page.getByRole('button', { name: 'Resume setup', exact: true }).focus(); await page.keyboard.press('Enter');
}
async function register(page) { await page.getByLabel('Date of birth', { exact: true }).fill('1990-01-02'); await page.getByRole('checkbox', { name: /reviewed this lead/ }).check(); await page.getByRole('button', { name: 'Register adult', exact: true }).click(); }
async function accountStep(page) { await page.getByRole('checkbox', { name: /responsible for their own billing/ }).check(); await page.getByRole('button', { name: 'Create or reuse account', exact: true }).click(); await page.getByText('Existing account reused', { exact: false }).waitFor(); }
async function draftStep(page) { await page.getByRole('button', { name: 'Check DRAFT readiness', exact: true }).click(); await page.getByLabel('Membership plan code').fill('ADULT-MONTHLY'); await page.getByRole('checkbox', { name: /confirm this adult/ }).check(); await page.getByRole('button', { name: 'Create membership DRAFT', exact: true }).click(); await page.getByRole('heading', { name: 'Membership DRAFT creation receipt' }).waitFor(); }
async function visual(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
  await page.addScriptTag({ content: axe }); const result = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
  const violations = result.violations.map(v => ({ id: v.id, impact: v.impact })); report.accessibility.push({ name, violations }); assert.equal(violations.filter(v => ['serious', 'critical'].includes(v.impact)).length, 0, JSON.stringify(violations));
  await page.screenshot({ path: join(results, `${name}.png`), fullPage: true }); report.screenshots.push(`${name}.png`);
}
try {
  let started = false; for (let i = 0; i < 100; i++) { try { await fetch(origin); started = true; break; } catch {} await new Promise(done => setTimeout(done, 250)); } assert(started, log.slice(-1200));
  browser = await chromium.launch({ executablePath: process.env.HON_CRM_CHROME, headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await check(`${name}: connected registration/account/DRAFT/current confirmation; keyboard and accessibility`, async () => {
      reset(); const { context, page } = await open(viewport);
      try { await choose(page); await visual(page, `${name}-registration`); await register(page); await accountStep(page); await visual(page, `${name}-account`); await draftStep(page);
        assert.equal(await page.getByText('Current DRAFT verified.', { exact: false }).count(), 0);
        await page.getByRole('button', { name: 'Check current DRAFT', exact: true }).focus(); await page.keyboard.press('Enter'); await page.getByText('Current DRAFT verified.', { exact: false }).waitFor();
        assert.equal(commands.length, 3); assert.equal(new Set(commands.map(c => c.key)).size, 3); assert.deepEqual(commands.map(c => c.step), ['register', 'account', 'draft']); await visual(page, `${name}-confirmed`);
        mode = 'drift'; await page.getByRole('button', { name: 'Check current DRAFT', exact: true }).click(); await page.getByRole('main').getByRole('alert').waitFor(); assert.equal(await page.getByText('Current DRAFT verified.', { exact: false }).count(), 0);
      } finally { await context.close(); }
    });
  }
  for (const scenario of ['unknown', 'review', 'deny-account', 'slow']) await check(`${scenario}: truthful retry, review, denied or stale state`, async () => {
    reset(scenario); const { context, page } = await open({ width: 390, height: 844 });
    try { await choose(page); await register(page);
      if (scenario === 'unknown') { await page.getByRole('button', { name: 'Retry exact request' }).waitFor(); assert.equal(commands.length, 1); await page.getByRole('button', { name: 'Retry exact request' }).click(); await page.getByRole('heading', { name: /Create or reuse this adult/ }).waitFor(); assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]); }
      if (scenario === 'review') { await page.getByText(/Staff review required/).waitFor(); assert.equal(await page.getByRole('button', { name: 'Create or reuse account' }).count(), 0); }
      if (scenario === 'deny-account') { await page.getByRole('heading', { name: /Create or reuse this adult/ }).waitFor(); await page.getByRole('checkbox', { name: /responsible for their own billing/ }).check(); await page.getByRole('button', { name: 'Create or reuse account' }).click(); await page.getByRole('main').getByRole('alert').waitFor(); assert.equal(await page.getByRole('heading', { name: 'Set up Ari Stone' }).count(), 0); assert.equal(await page.getByLabel('School UUID', { exact: true }).inputValue(), ''); assert(!(await page.locator('body').innerText()).includes('private-canary')); }
      if (scenario === 'slow') { await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.waitForTimeout(650); assert.equal(await page.getByRole('heading', { name: 'Set up Ari Stone' }).count(), 0); assert.equal(await page.getByText(/Registration recorded for this adult/).count(), 0); }
    } finally { await context.close(); }
  });
  for (const actor of [null, 'family-synthetic', 'hq-synthetic', 'foreign-school-synthetic']) await check(`${actor ?? 'anonymous'}: authentication and API authorization remain required`, async () => {
    reset(); const { context, page } = await open({ width: 390, height: 844 }, actor);
    try { if (!actor) await page.waitForURL(`${origin}/auth/login`); else { await page.getByRole('button', { name: 'Load CRM leads', exact: true }).click(); await page.getByRole('main').getByRole('alert').waitFor(); assert.equal(await page.getByRole('button', { name: 'Set up adult membership' }).count(), 0); } assert.equal(commands.length, 0); } finally { await context.close(); }
  });
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const state of ['NOT_REGISTERED', 'NEEDS_STAFF_REVIEW', 'BILLING_ACCOUNT_REQUIRED', 'READY_FOR_DRAFT', 'CURRENT_DRAFT', 'CURRENT_DRAFT_BY_OTHER_STAFF']) {
      await check(`${size}: recovery ${state}`, async () => {
        reset('recovery-' + state); const { context, page } = await open(viewport);
        try {
          assert.equal(recoveryReads.length, 0); await resume(page);
          await page.getByRole('heading', { name: 'Set up Ari Stone', exact: true }).waitFor();
          assert.equal(recoveryReads.length, 1); assert.equal(commands.length, 0);
          const body = await page.getByRole('main').innerText();
          if (state === 'NOT_REGISTERED') await page.getByRole('button', { name: 'Register adult', exact: true }).waitFor();
          if (state === 'NEEDS_STAFF_REVIEW') { assert(body.includes('Staff review required')); assert(!body.includes(id(5))); }
          if (state === 'BILLING_ACCOUNT_REQUIRED') { assert(body.includes('Historical registration receipt')); await page.getByRole('button', { name: 'Create or reuse account', exact: true }).waitFor(); }
          if (state === 'READY_FOR_DRAFT') { assert(body.includes('No account identifier was returned')); assert.equal(await page.getByRole('button', { name: 'Create membership DRAFT', exact: true }).count(), 0); await page.getByRole('button', { name: 'Check DRAFT readiness', exact: true }).waitFor(); }
          if (state === 'CURRENT_DRAFT') assert(body.includes('Current DRAFT verified.'));
          if (state === 'CURRENT_DRAFT_BY_OTHER_STAFF') {
            assert(body.includes('A current DRAFT exists, created by another staff member'));
            for (const hidden of [receipt.membershipId, receipt.planCode, registration.studentProfileId]) assert(!body.includes(hidden));
            assert.equal(await page.getByRole('button', { name: /^(Register adult|Create or reuse account|Check DRAFT readiness|Create membership DRAFT|Check current DRAFT)$/ }).count(), 0);
          }
          await visual(page, `${size}-recovery-${state.toLowerCase()}`);
          if (state === 'NOT_REGISTERED') { await register(page); await accountStep(page); await draftStep(page); assert.deepEqual(commands.map(c => c.step), ['register', 'account', 'draft']); }
          if (state === 'BILLING_ACCOUNT_REQUIRED') { await accountStep(page); await draftStep(page); assert.deepEqual(commands.map(c => c.step), ['account', 'draft']); }
          if (state === 'READY_FOR_DRAFT') { await draftStep(page); assert.deepEqual(commands.map(c => c.step), ['draft']); }
          assert.equal(new Set(commands.map(c => c.key)).size, commands.length);
          const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
          for (const secret of [id(4), id(5), id(6), id(7)]) assert(!stored.includes(secret));
          if (state === 'CURRENT_DRAFT' || state === 'CURRENT_DRAFT_BY_OTHER_STAFF') {
            await page.getByRole('button', { name: 'Refresh saved setup', exact: true }).click();
            await page.getByRole('heading', { name: 'Set up Ari Stone', exact: true }).waitFor(); assert.equal(recoveryReads.length, 2); assert.equal(commands.length, 0);
          }
        } finally { await context.close(); }
      });
    }
  }
  for (const scenario of ['deny-recovery', 'missing-recovery', 'conflict-recovery', 'unavailable-recovery', 'slow-recovery']) await check(`${scenario}: no assumed facts, explicit retry and late-response protection`, async () => {
    reset(scenario); registered = true; const { context, page } = await open({ width: 390, height: 844 });
    try {
      await resume(page);
      if (scenario === 'slow-recovery') { await page.getByRole('button', { name: 'Close adult setup', exact: true }).click(); await page.waitForTimeout(600); assert.equal(await page.getByRole('heading', { name: 'Set up Ari Stone' }).count(), 0); }
      else {
        await page.getByRole('main').getByRole('alert').waitFor(); assert(!(await page.getByRole('main').innerText()).includes('private-canary'));
        if (scenario === 'deny-recovery') { assert.equal(await page.getByLabel('School UUID', { exact: true }).inputValue(), ''); }
        else if (scenario === 'missing-recovery') { assert(await page.getByRole('button', { name: 'Resume setup', exact: true }).isDisabled()); }
        else { mode = 'ready'; await page.getByRole('button', { name: 'Retry setup read', exact: true }).click(); await page.getByRole('button', { name: 'Create or reuse account', exact: true }).waitFor(); assert.equal(recoveryReads.length, 2); }
      }
      assert.equal(commands.length, 0);
    } finally { await context.close(); }
  });
  await check('refresh, navigation and new signed session recover without duplicate commands', async () => {
    reset(); const { context, page } = await open({ width: 390, height: 844 });
    try {
      await choose(page); await register(page); await page.getByRole('button', { name: 'Create or reuse account', exact: true }).waitFor();
      await page.reload(); assert.equal(recoveryReads.length, 0); await resume(page); await page.getByRole('button', { name: 'Create or reuse account', exact: true }).waitFor();
      await page.goto(`${origin}/staff/search`); await page.goto(`${origin}/staff/crm/leads?${new URLSearchParams(scope)}`); await resume(page);
      await page.getByRole('button', { name: 'Create or reuse account', exact: true }).waitFor();
      await context.clearCookies(); await page.reload(); await page.waitForURL(`${origin}/auth/login`);
      await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: 'crm-staff-synthetic' }, session), url: origin, httpOnly: true, sameSite: 'Lax' }]);
      await page.goto(`${origin}/staff/crm/leads?${new URLSearchParams(scope)}`); await resume(page); await page.getByRole('button', { name: 'Create or reuse account', exact: true }).waitFor();
      assert.equal(commands.length, 1); assert.equal(commands[0].step, 'register'); assert.equal(recoveryReads.length, 3);
    } finally { await context.close(); }
  });
  assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors)); assert.equal(report.failures.length, 0, JSON.stringify(report.failures));
} finally { await browser?.close(); app.kill('SIGTERM'); await new Promise(done => api.close(done)); await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(`PASS: ${report.checks.length} browser checks; ${report.screenshots.length} actual application screenshots; synthetic API verification only.`);
