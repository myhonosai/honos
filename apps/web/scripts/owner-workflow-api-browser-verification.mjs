/** Native mounted CRM -> durable membership -> dates -> booking -> attendance.
 * Signed synthetic HON cookies are NOT external OIDC or owner-device acceptance.
 * No API mock, request-header mutation, scope override, AppModule or worker. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireOwnerWorkflowRun, nativeTransportObservation, NativeWorkflowTransportFailure } from './owner-workflow-support.mjs';
import { seedOwnerWorkflowFixture } from './owner-workflow-fixture.mjs';
import { requireFlexibleBillingAccountsLocalUrls, flexibleBillingAccountsFixture } from '../../../packages/database/scripts/flexible-billing-accounts-local-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const config = requireOwnerWorkflowRun(process.env, sourceSha);
const urls = await requireFlexibleBillingAccountsLocalUrls(); // Validates private descriptor and refuses provider/PG overrides before any client.
await mkdir(config.results, { recursive: true });
const apiRequire = createRequire(join(root, 'apps/api/package.json')), webRequire = createRequire(join(root, 'apps/web/package.json'));
const toolRequire = createRequire(join(config.tools, 'runner.cjs'));
const { issueSession, HON_SESSION_COOKIE } = await import('@hon/auth');
const contracts = await import('@hon/contracts');
const { Client } = createRequire(join(root, 'packages/database/package.json'))('pg');
const { chromium } = toolRequire('playwright-core');
apiRequire('reflect-metadata');
const { Test } = apiRequire('@nestjs/testing'), { ValidationPipe } = apiRequire('@nestjs/common');
const origin = 'http://127.0.0.1:3000', apiOrigin = 'http://127.0.0.1:3001';
const auth = { mode: 'OIDC', audience: 'hon-native-owner-workflow-disposable', secret: randomBytes(32).toString('hex') };
Object.assign(process.env, { HON_AUTH_MODE: auth.mode, HON_SESSION_AUDIENCE: auth.audience, HON_SESSION_JWT_SECRET: auth.secret, HON_PUBLIC_ORIGIN: origin });
const owner = new Client({ connectionString: urls.DATABASE_URL, ssl: false });
const q = (sql, values = []) => owner.query(sql, values);
const report = { sourceSha, evidence: 'NATIVE_BROWSER_NEXT_NEST_IAM_RESTRICTED_DISPOSABLE_POSTGRES', passed: false,
  signedSyntheticHonSession: true, externalOidcLogin: false, ownerDeviceAcceptance: false, apiResponsesMocked: false,
  browserHeadersModified: false, authorizationOrScopeOverridden: false, fullAppModule: false, workersStarted: false,
  externalProviderCalls: 0, blockedExternalOrigins: [], nativeBrowserRequests: [], nestIngress: [], cases: [], screenshots: [] };
let stage = 'load-canonical-components', app, database, next, browser, ownerConnected = false;
async function loadClasses() {
  const files = ['foundation/runtime-database.service', 'foundation/hon-identity.guard', 'foundation/hon-identity.service',
    'preferences/language-preferences.controller', 'crm/lead.controller', 'crm/lead.service', 'crm/lead-create-human-ui.guard',
    'crm/lead-registration.service', 'crm/guardian-child-enrollment.service', 'billing/billing-account.service', 'billing/membership-plan.service',
    'billing/membership.controller', 'billing/membership.service', 'billing/membership-activation-human-ui.guard',
    'billing/membership-date-revision.controller', 'billing/membership-date-revision.service', 'billing/crm-lead-memberships.controller', 'billing/crm-lead-memberships.service',
    ...['class-sessions-read.controller', 'class-sessions-read.service', 'class-sessions-read-human-ui.guard', 'class-booking.controller', 'class-booking.service', 'class-booking-human-ui.guard', 'attendance.controller', 'attendance.service', 'attendance-human-ui.guard'].map(name => `schedule/${name}`)];
  const classes = {};
  for (const file of files) Object.assign(classes, await import(pathToFileURL(join(root, 'apps/api/dist', file + '.js')).href));
  return classes;
}
async function snapshot(tables) {
  const values = {};
  for (const table of tables) {
    assert.match(table, /^[a-z][a-z0-9_]*$/);
    values[table] = (await q(`SELECT count(*)::int n,md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) hash FROM hon.${table} t`)).rows[0];
  }
  return values;
}
async function stopNext() {
  if (!next || next.exitCode !== null || next.signalCode !== null) return;
  await new Promise(done => {
    const timer = setTimeout(() => next.kill('SIGKILL'), 5000);
    next.once('exit', () => { clearTimeout(timer); done(); }); next.kill('SIGTERM');
  });
}
try {
  const classes = await loadClasses();
  stage = 'verify-marked-disposable-database';
  await owner.connect(); ownerConnected = true;
  assert.deepEqual((await q("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0],
    { owner: flexibleBillingAccountsFixture.owner, marker: 'HON disposable flexible billing accounts validation' });
  const runtime = new Client({ connectionString: urls.HON_RUNTIME_DATABASE_URL, ssl: false });
  try {
    await runtime.connect();
    assert.deepEqual((await runtime.query('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
      { role: flexibleBillingAccountsFixture.runtime, rolsuper: false, rolbypassrls: false });
  } finally { await runtime.end(); }
  // Reuse accepted canonical Class Sessions verifier, with only the existing disposable role alias substitution.
  const verifier = (await readFile(join(root, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8'))
    .split('-- Class Sessions current-school read exact verification:')[1]?.split('-- End Class Sessions current-school read exact verification.')[0];
  assert(verifier, 'Canonical Class Sessions verification block is required.');
  await q(verifier.replaceAll('hon_runtime', flexibleBillingAccountsFixture.runtime));
  database = new classes.RuntimeDatabaseService();
  const controllers = ['MyLanguagePreferenceController', 'LeadController', 'MembershipController', 'MembershipDateRevisionController', 'CrmLeadMembershipsController', 'ClassSessionsReadController', 'ClassBookingController', 'AttendanceController'];
  const providers = Object.entries(classes).filter(([name]) => name !== 'RuntimeDatabaseService' && (name.endsWith('Service') || name.endsWith('Guard'))).map(([, value]) => value);
  const module = await Test.createTestingModule({ controllers: controllers.map(name => { assert(classes[name], name); return classes[name]; }),
    providers: [...new Set(providers), { provide: classes.RuntimeDatabaseService, useValue: database }] }).compile();
  stage = 'seed-through-canonical-domain-services';
  const fixture = await seedOwnerWorkflowFixture({ q, database, contracts, services: {
    registrations: module.get(classes.LeadRegistrationService), accounts: module.get(classes.BillingAccountService),
    plans: module.get(classes.MembershipPlanService), family: module.get(classes.GuardianChildEnrollmentService), memberships: module.get(classes.MembershipService),
  } });
  report.syntheticFixture = { adultActiveMemberships: 2, childActiveMemberships: 2, canonicalServiceActivation: true, triggerBypass: false, paidAccessActivation: false };
  const allowedChanges = new Set(['class_bookings', 'attendance_records', 'attendance_record_history', 'idempotency_records', 'audit_events', 'outbox_events']);
  const protectedTables = (await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).rows.map(row => row.tablename).filter(table => !allowedChanges.has(table));
  const before = await snapshot(protectedTables);
  report.protectedTableCount = protectedTables.length;
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1');
  app.use((req, res, done) => {
    if (req.url.startsWith('/v1/')) report.nestIngress.push(nativeTransportObservation(req.method, req.url, req.headers, origin));
    done(); // Observation only: no header, identity, scope, response or service substitution.
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  stage = 'start-real-nest-and-production-next';
  await app.listen(3001, '127.0.0.1');
  next = spawn(process.execPath, [webRequire.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3000'], {
    cwd: join(root, 'apps/web'), env: { PATH: process.env.PATH, NODE_ENV: 'production', HON_DEPLOYMENT_ENVIRONMENT: 'preview', NEXT_TELEMETRY_DISABLED: '1',
      HON_AUTH_MODE: auth.mode, HON_SESSION_AUDIENCE: auth.audience, HON_SESSION_JWT_SECRET: auth.secret, HON_API_BASE_URL: apiOrigin }, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (next.exitCode !== null || next.signalCode !== null) break;
    try { await fetch(origin + '/auth/login', { redirect: 'manual', signal: AbortSignal.timeout(1000) }); ready = true; break; } catch { await new Promise(done => setTimeout(done, 100)); }
  }
  assert(ready, 'Production Next did not become available.');
  browser = await chromium.launch({ executablePath: config.chrome, headless: true, args: ['--no-sandbox'] });
  const axe = await readFile(toolRequire.resolve('axe-core/axe.min.js'), 'utf8');
  for (const c of fixture.cases) {
    const result = { width: c.width, registration: c.kind, language: 'en', completed: false, responses: [], stages: [] };
    report.cases.push(result);
    const context = await browser.newContext({ viewport: { width: c.width, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await context.addCookies([{ name: HON_SESSION_COOKIE, value: issueSession({ externalSubject: fixture.subject, displayName: 'Synthetic workflow staff' }, auth), url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue(); // No response fulfilment or request/header overrides.
      if (!report.blockedExternalOrigins.includes(url.origin)) report.blockedExternalOrigins.push(url.origin);
      return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    let pageErrors = 0; page.on('pageerror', () => pageErrors++);
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/')) report.nativeBrowserRequests.push(nativeTransportObservation(request.method(), request.url(), request.headers(), origin));
    });
    async function action(label, suffix, work, method = 'GET') {
      stage = `${c.width}/${c.kind}/${label}`;
      const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix)), work()]);
      const value = { stage: label, method, path: new URL(response.url()).pathname, status: response.status() }; result.responses.push(value);
      if (!response.ok()) throw new NativeWorkflowTransportFailure(stage, method, value.path, response.status());
      result.stages.push(label); return response;
    }
    const recovery = () => page.locator('[data-membership-recovery]');
    async function loadRecovery() {
      await recovery().getByRole('heading', { name: 'Saved CRM memberships', exact: true }).waitFor();
      await action('discover-memberships', `/crm/leads/${c.leadId}/memberships`, () => recovery().getByRole('button', { name: 'Verify access and find memberships', exact: true }).click());
      await recovery().getByRole('button', { name: 'Review current dates and history · 1', exact: true }).waitFor();
      assert.equal(await recovery().locator('ol > li').count(), 1);
      assert((await recovery().innerText()).includes(c.studentProfileId));
    }
    async function openOperations() {
      await recovery().getByRole('button', { name: 'Classes and attendance · 1', exact: true }).click();
      const ops = page.locator('[data-student-operations]');
      await ops.getByRole('heading', { name: 'Classes and attendance', exact: true }).waitFor();
      await action('native-session-selector', '/schedule/sessions', () => ops.getByRole('button', { name: 'Load class sessions', exact: true }).click());
      await ops.getByRole('button', { name: `Select class · ${c.label}`, exact: true }).click(); return ops;
    }
    async function readAttendance(ops, expected) {
      const response = await action('read-attendance', `/${c.sessionId}/attendance`, () => ops.getByRole('button', { name: 'Refresh current attendance', exact: true }).click());
      const data = (await response.json()).data;
      if (!expected) { assert.equal(data, null); await ops.getByText('The server returned no attendance record for this student and class.', { exact: true }).waitFor(); }
      else { assert.equal(data.studentProfileId, c.studentProfileId); assert.equal(data.classSessionId, c.sessionId); assert.equal(data.status, 'PRESENT'); assert.equal(data.version, 1); }
    }
    try {
      stage = `${c.width}/${c.kind}/open-crm`;
      const start = `${origin}/staff/crm/journey?${new URLSearchParams({ organizationId: fixture.organizationId, schoolId: fixture.schoolId })}`;
      await page.goto(start); await page.getByTestId('load').waitFor();
      await action('open-crm-lead', '/crm/leads', () => page.getByTestId('load').click());
      await page.getByTestId('lead-select').selectOption(c.leadId); await page.getByTestId('membership-recovery').click(); await loadRecovery();
      await recovery().getByRole('button', { name: 'Review current dates and history · 1', exact: true }).click();
      const dates = page.locator('[data-membership-dates]');
      await action('current-dates-history', `/${c.membershipId}/effective-period/history`, () => dates.getByRole('button', { name: 'Load membership dates', exact: true }).click(), 'POST');
      await dates.getByRole('heading', { name: 'Verified current membership', exact: true }).waitFor();
      await dates.getByRole('button', { name: 'Back to saved memberships', exact: true }).click(); await loadRecovery();
      let ops = await openOperations();
      await ops.getByLabel('Booking kind', { exact: true }).selectOption('REGULAR');
      await ops.getByLabel('I confirm this student, class and booking kind.', { exact: true }).check();
      await action('explicit-canonical-booking', `/${c.sessionId}/bookings`, () => ops.getByRole('button', { name: 'Confirm booking', exact: true }).click(), 'POST');
      await ops.getByRole('heading', { name: 'Server-confirmed booking receipt', exact: true }).waitFor();
      await readAttendance(ops, false);
      await ops.getByLabel('Attendance status', { exact: true }).selectOption('PRESENT');
      await ops.getByLabel('Participation category', { exact: true }).selectOption('REGULAR_PARTICIPANT');
      await ops.getByLabel('I confirm this attendance record. Opening this view does not mark attendance.', { exact: true }).check();
      await action('explicit-canonical-attendance', `/${c.sessionId}/attendance`, () => ops.getByRole('button', { name: 'Save attendance', exact: true }).click(), 'POST');
      await ops.getByRole('status').filter({ hasText: 'Attendance confirmed by the server.' }).waitFor();
      await readAttendance(ops, true);
      assert(!page.url().includes(c.studentProfileId) && !page.url().includes(c.membershipId));
      assert(await page.evaluate(ids => !JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).match(new RegExp(ids.join('|'))), [c.studentProfileId, c.membershipId]));
      // Full document destruction removes mounted selections; the lead URL alone cannot restore facts.
      stage = `${c.width}/${c.kind}/reload-without-student-id`; await page.reload();
      await recovery().getByRole('button', { name: 'Verify access and find memberships', exact: true }).waitFor();
      assert.equal(await recovery().locator('ol > li').count(), 0); await loadRecovery(); ops = await openOperations(); await readAttendance(ops, true);
      const rows = (await q("SELECT (SELECT count(*)::int FROM hon.class_bookings WHERE class_session_id=$1 AND student_profile_id=$2 AND booking_kind='REGULAR' AND status='BOOKED') bookings,(SELECT count(*)::int FROM hon.attendance_records WHERE class_session_id=$1 AND student_profile_id=$2 AND status='PRESENT' AND version=1) attendance", [c.sessionId, c.studentProfileId])).rows[0];
      assert.deepEqual(rows, { bookings: 1, attendance: 1 });
      await page.addScriptTag({ content: axe });
      const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      result.axeViolations = scan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })); assert.deepEqual(result.axeViolations, []);
      assert.equal(pageErrors, 0); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      result.completed = true;
    } catch (error) {
      result.failure = error instanceof NativeWorkflowTransportFailure ? error.finding : { stage, type: error.name, message: 'Native workflow did not complete; no synthetic response or header repair attempted.' };
    } finally {
      result.pageErrors = pageErrors;
      const name = `native-workflow-${c.kind}-${c.width}${result.completed ? '' : '-failure'}.png`;
      await page.screenshot({ path: join(config.results, name), fullPage: true }).then(() => report.screenshots.push(name)).catch(() => {});
      await context.close();
    }
  }
  stage = 'verify-protected-tables-unchanged'; assert.deepEqual(await snapshot(protectedTables), before);
  report.protectedTablesUnchanged = true;
  assert(report.blockedExternalOrigins.every(value => ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(value)), 'Unexpected external request blocked.');
  report.passed = report.cases.length === 4 && report.cases.every(c => c.completed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.exitCode = 1;
  report.failure = { stage, type: error.name, message: 'Guarded native verification failed; no execution claim or transport repair.' };
} finally {
  await browser?.close(); await stopNext();
  if (app) await app.close(); else await database?.onModuleDestroy();
  if (ownerConnected) await owner.end();
  await writeFile(join(config.results, 'owner-workflow-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ sourceSha, passed: report.passed, completedFlows: report.cases.filter(c => c.completed).length,
    findings: report.cases.filter(c => !c.completed).map(c => c.failure), failure: report.failure ?? null,
    nativeHeadersUnchanged: true, apiMocked: false, externalOidcOrOwnerDeviceAcceptance: false }));
}
