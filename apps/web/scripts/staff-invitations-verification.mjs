/** Actual frontend transport + mounted Next -> signed-session Nest/IAM -> guarded disposable PostgreSQL.
 * Every identity, school and account change is synthetic. No OIDC/provider/delivery connection. */
import assert from 'node:assert/strict';
import { randomUUID as K, randomBytes, createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted'); assert.equal(process.env.HON_STAFF_INVITATIONS_TEST, '1');
let owner, runtime; try { owner = new URL(process.env.DATABASE_URL ?? ''); runtime = new URL(process.env.HON_RUNTIME_DATABASE_URL ?? ''); } catch { throw new Error('Staff frontend disposable fixture target refused.'); }
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
assert.match(sourceSha, /^[a-f0-9]{40}$/); assert.equal(sourceSha, process.env.HON_STAFF_INVITATIONS_SHA);
for (const [url, user] of [[owner, 'hon_champions_owner'], [runtime, 'hon_champions_runtime']]) {
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost'); assert.equal(url.port, '5432'); assert.equal(url.pathname, '/hon_champions_validation');
  assert.equal(url.username, user); assert(url.password); assert.equal(url.search, ''); assert.equal(url.hash, '');
}
for (const key of Object.keys(process.env)) assert(!/^(?:PG[A-Z_]*|STRIPE.*|SQUARE.*|TWILIO.*|ZERNIO.*|OPENAI.*|ANTHROPIC.*|OPENROUTER.*|DIRECT_LLM_API.*|SUPABASE.*|AWS.*|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER).*)$/i.test(key));
const apiRequire = createRequire(join(repo, 'apps/api/package.json')), webRequire = createRequire(join(repo, 'apps/web/package.json')), dbRequire = createRequire(join(repo, 'packages/database/package.json'));
apiRequire('reflect-metadata'); const { Test } = apiRequire('@nestjs/testing'), { Client } = dbRequire('pg'), ts = webRequire('typescript');
const auth = webRequire('@hon/auth'), contracts = webRequire('@hon/contracts'), design = webRequire('@hon/design-system');
const { issueSession, HON_SESSION_COOKIE } = auth;
const load = path => import(pathToFileURL(join(repo, 'apps/api/dist', path + '.js')).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service'), { HonIdentityGuard } = await load('foundation/hon-identity.guard'), { HonIdentityService } = await load('foundation/hon-identity.service');
const { SchoolStaffInvitationService } = await load('accounts/school-staff-invitation.service'), { SchoolStaffInvitationController, SchoolStaffAccountHumanGuard } = await load('accounts/school-staff-invitation.controller');
const { StaffRoleController } = await load('staff-roles/staff-role.controller'), { StaffRoleService } = await load('staff-roles/staff-role.service'), { StaffRoleHumanUiGuard } = await load('staff-roles/staff-role-human-ui.guard');
const session = { mode: 'OIDC', audience: 'hon-staff-frontend-disposable', secret: randomBytes(32).toString('hex'), emitVerifiedEmail: true };
const origin = 'http://127.0.0.1:3000';
Object.assign(process.env, { HON_AUTH_MODE: session.mode, HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret, HON_PUBLIC_ORIGIN: origin });
const database = new RuntimeDatabaseService(), admin = new Client({ connectionString: owner.href, ssl: false });
const actualFetch = globalThis.fetch, groups = [], browserCases = []; let app, next, browser, actor, lostResponse = false, nextLog = '', sends = [];
const results = process.env.HON_STAFF_INVITATIONS_RESULTS; assert(results && resolve(results) === results && !results.startsWith(repo + '/'));
await mkdir(results, { recursive: true });
const pass = name => { groups.push(name); console.log('PASS STAFF FRONTEND ' + name); };
const person = label => ({ externalSubject: `oidc:staff-ui:${label}:${K()}`, email: `${label}-${K()}@example.invalid`, emailVerified: true });
const cookie = (who, expired = false) => `${HON_SESSION_COOKIE}=${issueSession(who, session, expired ? Math.floor(Date.now() / 1000) - 50000 : undefined)}`;
const q = async (sql, values = []) => (await admin.query(sql, values)).rows;
const human = async who => { const user = K(), principal = K(); await q('INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,$4)', [user, who.externalSubject, who.email, 'Synthetic staff UI']);
  await q("INSERT INTO hon.principals(id,user_id,principal_type,display_name) VALUES($1,$2,'HUMAN_USER','Synthetic staff UI')", [principal, user]); return principal; };
async function setup(label) {
  const organizationId = K(), schoolId = K(), who = person(label), principal = await human(who), managerRole = K(), targetRole = K();
  await q("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Synthetic staff UI','Synthetic staff UI')", [organizationId]);
  await q("INSERT INTO hon.schools(id,organization_id,name,slug) VALUES($1,$2,'Synthetic staff UI',$3)", [schoolId, organizationId, `staff-ui-${schoolId}`]);
  await q("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [organizationId]);
  for (const [roleId, code] of [[managerRole, 'CUSTOM_STAFF_MANAGER'], [targetRole, 'CUSTOM_FRONT_DESK']]) {
    await q('INSERT INTO hon.roles(id,organization_id,management_school_id,code,name) VALUES($1,$2,$3,$4,$5)', [roleId, organizationId, schoolId, code, code === 'CUSTOM_FRONT_DESK' ? 'Front desk' : 'Staff manager']);
    for (const permission of code === 'CUSTOM_FRONT_DESK' ? ['school.view'] : ['iam.staff_role.manage', 'iam.staff_role.grant', 'school.view']) await q('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,$3)', [roleId, organizationId, permission]);
  }
  const grantId = (await q("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day') RETURNING id", [organizationId, schoolId, principal, managerRole]))[0].id;
  return { organizationId, schoolId, who, principal, targetRole, grantId };
}
async function compile(path, imports = {}) {
  let code = ts.transpileModule(await readFile(join(repo, path), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [from, to] of Object.entries(imports)) for (const quote of ["'", '"']) code = code.replaceAll('from ' + quote + from + quote, 'from ' + JSON.stringify(to));
  return 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
}
try {
  await admin.connect();
  assert.deepEqual((await q("SELECT pg_get_userbyid(datdba) owner,shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()"))[0], { owner: 'hon_champions_owner', marker: 'HON disposable Champions Club validation' });
  const A = await setup('a'), B = await setup('b'), matrices = {};
  for (const language of ['en', 'ko', 'es']) matrices[language] = await setup(`matrix-${language}`);
  const module = await Test.createTestingModule({ controllers: [SchoolStaffInvitationController, StaffRoleController], providers: [SchoolStaffInvitationService, SchoolStaffAccountHumanGuard, HonIdentityGuard, HonIdentityService, StaffRoleService, StaffRoleHumanUiGuard, { provide: RuntimeDatabaseService, useValue: database }] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('v1'); await app.listen(3001, '127.0.0.1');
  next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3000'], { cwd: join(repo, 'apps/web'), env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HON_DEPLOYMENT_ENVIRONMENT: 'preview', HON_AUTH_MODE: session.mode,
    HON_SESSION_AUDIENCE: session.audience, HON_SESSION_JWT_SECRET: session.secret, HON_PUBLIC_ORIGIN: origin, HON_API_BASE_URL: 'http://127.0.0.1:3001' }, stdio: ['ignore', 'pipe', 'pipe'] });
  next.stdout.on('data', b => { nextLog = (nextLog + b).slice(-2000); }); next.stderr.on('data', b => { nextLog = (nextLog + b).slice(-2000); });
  let ready = false; for (let i = 0; i < 120; i++) { try { const r = await actualFetch(origin + '/staff/team/invitations', { redirect: 'manual' }); if ([200, 303, 307].includes(r.status)) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert(ready, 'Actual Next application failed to start.');
  const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname='hon' ORDER BY tablename")).map(x => x.tablename);
  const allowed = new Set(['users', 'principals', 'principal_role_grants', 'school_staff_invitations', 'school_staff_account_events', 'school_account_requests']);
  const protectedTables = tables.filter(x => !allowed.has(x));
  const snapshot = async () => { const out = {}; for (const t of protectedTables) { assert.match(t, /^[a-z_0-9]+$/); out[t] = createHash('sha256').update(JSON.stringify(await q(`SELECT to_jsonb(t)::text r FROM hon.${t} t ORDER BY 1`))).digest('hex'); } return out; };
  const before = await snapshot();
  const invalidation = await compile('apps/web/src/components/session-invalidation.ts');
  const httpUrl = await compile('apps/web/src/components/staff-invitations/http.ts', { '@hon/contracts': pathToFileURL(webRequire.resolve('@hon/contracts')).href, '../session-invalidation': invalidation });
  const { staffInvitationApi: api } = await import(httpUrl);
  const { StaffInvitationController } = await import(await compile('apps/web/src/components/staff-invitations/controller.ts', { '@hon/contracts': pathToFileURL(webRequire.resolve('@hon/contracts')).href, './http': httpUrl, '../session-invalidation': invalidation }));
  globalThis.fetch = async (path, options = {}) => {
    assert.match(String(path), /^\/api\/(?:identity\/me|v1\/(?:school\/(?:staff-invitations(?:\/revoke)?|schools\/[a-f0-9-]+\/staff-invitations)|account\/staff-invitations\/accept|organizations\/[a-f0-9-]+\/schools\/[a-f0-9-]+\/staff-roles\/custom\/[a-f0-9-]+))$/);
    if (options.method === 'POST') sends.push({ path, body: options.body, key: options.headers['Idempotency-Key'] });
    const r = await actualFetch(origin + path, { ...options, headers: { ...options.headers, Cookie: actor ? cookie(actor) : '', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'empty' } });
    if (lostResponse && options.method === 'POST' && r.ok) { lostResponse = false; await r.text(); throw new Error('Synthetic post-commit response loss'); }
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  actor = A.who; const manager = new StaffInvitationController(A.who.externalSubject); await manager.verify(A); await manager.loadRole(A.targetRole, manager.snapshot().revision); assert.equal(manager.snapshot().phase, 'READY');
  assert.equal(manager.snapshot().role.id, A.targetRole); pass('real frontend current identity, exact-school invitation list and existing custom-role lookup');
  const invitee = person('invitee'), token = randomBytes(32).toString('base64url'); lostResponse = true;
  await manager.invite({ email: invitee.email, token, ttlHours: 24 }, manager.snapshot().revision, true); assert.equal(manager.snapshot().outcome, 'UNKNOWN'); const original = sends.at(-1);
  manager.conceal(); assert.equal(manager.snapshot().receipt, null); await manager.verify(A); assert.equal(sends.length, 1); await manager.retry(manager.snapshot().revision);
  assert.equal(manager.snapshot().outcome, 'SUCCESS'); assert(sends.at(-1).path === original.path && sends.at(-1).body === original.body && sends.at(-1).key === original.key, 'Original exact request was replaced'); assert.equal((await q('SELECT count(*) n FROM hon.school_staff_invitations WHERE school_id=$1 AND email=$2', [A.schoolId, invitee.email]))[0].n, '1');
  const receipt = manager.snapshot().receipt; assert(!JSON.stringify(receipt).includes(token)); pass('actual committed invitation, lost response and exact URL/body/key replay create one private hashed-token invitation');
  actor = B.who; await assert.rejects(api.list(A, AbortSignal.timeout(12000)), e => e.status === 403); await assert.rejects(api.role(A, A.targetRole, AbortSignal.timeout(12000)), e => e.status === 403);
  actor = null; await assert.rejects(api.list(A, AbortSignal.timeout(12000)), e => e.status === 401); pass('independent other-organization and absent-session principals cannot read staff data');
  actor = invitee; const accept = new StaffInvitationController(invitee.externalSubject, true); await accept.verify(); const count = sends.length;
  await accept.accept(receipt.invitationId, token, accept.snapshot().revision, false); assert.equal(sends.length, count);
  await accept.accept(receipt.invitationId, token, accept.snapshot().revision, true); assert.equal(accept.snapshot().receipt.accountStatus, 'STAFF_ROLE_BOUND');
  assert.equal((await q('SELECT count(*) n FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1 AND g.school_id=$2 AND g.role_id=$3', [invitee.externalSubject, A.schoolId, A.targetRole]))[0].n, '1');
  pass('actual verified-email acceptance creates precisely the invited school role once, without commercial activation'); accept.dispose();
  actor = A.who; assert(manager.abandon(manager.snapshot().revision, true)); await manager.verify(A); await manager.loadRole(A.targetRole, manager.snapshot().revision);
  const revokedPerson = person('revoked'), revokedToken = randomBytes(32).toString('base64url'); await manager.invite({ email: revokedPerson.email, token: revokedToken, ttlHours: 24 }, manager.snapshot().revision, true);
  const revokeId = manager.snapshot().receipt.invitationId; assert(manager.abandon(manager.snapshot().revision, true)); await manager.verify(A); await manager.revoke(revokeId, manager.snapshot().revision, true); assert.equal(manager.snapshot().receipt.status, 'REVOKED');
  actor = revokedPerson; const revoked = new StaffInvitationController(revokedPerson.externalSubject, true); await revoked.verify(); await revoked.accept(revokeId, revokedToken, revoked.snapshot().revision, true); assert.notEqual(revoked.snapshot().outcome, 'SUCCESS'); revoked.dispose();
  pass('real pending invitation revocation persists and revoked acceptance never creates a success receipt');
  actor = A.who; await q('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1', [A.grantId]);
  const denied = new StaffInvitationController(A.who.externalSubject); await denied.verify(A); assert.equal(denied.snapshot().phase, 'DENIED'); assert.deepEqual(denied.snapshot().items, []); denied.dispose();
  await q('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1', [A.grantId]); pass('actual live manager-authority expiry denies protected frontend restoration'); manager.dispose();
  globalThis.fetch = actualFetch;

  const { chromium } = createRequire(join(process.env.HON_STAFF_INVITATIONS_TOOLS, 'package.json'))('playwright-core');
  const axe = await readFile(join(process.env.HON_STAFF_INVITATIONS_TOOLS, 'node_modules/axe-core/axe.min.js'), 'utf8');
  browser = await chromium.launch({ executablePath: process.env.HON_STAFF_INVITATIONS_CHROME, headless: true });
  const { staffInvitationText: t } = await import(await compile('apps/web/src/components/staff-invitations/copy.ts'));
  const blockedFonts = new Set();
  for (const language of ['en', 'ko', 'es']) for (const mode of ['modern', 'classic', 'big']) for (const width of [390, 834, 1440]) {
    const school = matrices[language], context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const scope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, school.who.externalSubject])).digest('hex');
    await context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie(school.who).split('=')[1], url: origin, httpOnly: true, sameSite: 'Lax' }, { name: design.localeCookieName(scope), value: encodeURIComponent(JSON.stringify({ ...design.DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
    const requests = [], errors = []; await context.route('**/*', async route => { const u = new URL(route.request().url()); if (u.origin !== origin) { await route.abort(); assert(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(u.origin), 'Unexpected external operation'); blockedFonts.add(u.origin); return; }
      requests.push({ path: u.pathname, method: route.request().method() }); await route.continue(); });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin + '/staff/team/invitations');
    await page.getByTestId('staff-org').fill(school.organizationId); await page.getByTestId('staff-school').fill(school.schoolId);
    await page.getByRole('button', { name: t(language, 'verify'), exact: true }).click(); await page.getByTestId('staff-account-status').filter({ hasText: t(language, 'READY') }).waitFor();
    await page.getByTestId('staff-role-id').fill(school.targetRole); await page.getByRole('button', { name: t(language, 'loadRole'), exact: true }).click(); await page.getByText('Front desk', { exact: true }).waitFor();
    const beforeModes = requests.filter(r => r.path.includes('staff-invitations') && r.method === 'GET').length;
    await page.getByRole('button', { name: t(language, mode), exact: true }).click(); assert.equal(await page.getByTestId('staff-invitations').getAttribute('data-interface-theme'), mode);
    assert.equal(requests.filter(r => r.path.includes('staff-invitations') && r.method === 'GET').length, beforeModes);
    const email = page.getByTestId('staff-email'); await email.focus(); await page.keyboard.press('Shift'); assert(await email.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (width === 390 && mode === 'modern') {
      const recipient = person(`browser-${language}`); await email.fill(recipient.email); await page.getByRole('button', { name: t(language, 'newToken'), exact: true }).click(); await page.getByTestId('staff-confirm').check();
      const exactPosts = []; let drop = language === 'en';
      await context.route('**/api/v1/school/staff-invitations', async route => {
        const request = route.request(); assert.equal(new URL(request.url()).origin, origin);
        if (request.method() !== 'POST') return route.continue(); exactPosts.push({ body: request.postData(), key: request.headers()['idempotency-key'] });
        if (drop) { drop = false; const r = await route.fetch(); assert.equal(r.status(), 200); await route.abort('failed'); } else await route.continue();
      });
      await page.getByRole('button', { name: t(language, 'invite'), exact: true }).click();
      if (language === 'en') { await page.getByText(t(language, 'unknown'), { exact: true }).waitFor(); await page.getByRole('button', { name: t(language, 'retry'), exact: true }).click(); }
      await page.getByRole('heading', { name: t(language, 'success'), exact: true }).waitFor();
      if (language === 'en') { assert.equal(exactPosts.length, 2); assert(exactPosts[1].body === exactPosts[0].body && exactPosts[1].key === exactPosts[0].key, 'Browser exact request was replaced'); }
      assert.equal((await q('SELECT count(*) n FROM hon.school_staff_invitations WHERE school_id=$1 AND email=$2', [school.schoolId, recipient.email]))[0].n, '1');
      assert(await page.evaluate(() => { const area = document.querySelector('[data-testid="staff-account-private"]'); window.dispatchEvent(new Event('blur')); return area.hidden && area.inert; }));
      await page.getByRole('button', { name: t(language, 'restore'), exact: true }).click(); await page.getByRole('heading', { name: t(language, 'success'), exact: true }).waitFor();
      await page.getByRole('button', { name: t(language, 'show'), exact: true }).click(); const handoff = page.locator('input[readonly]'); assert(await handoff.count() >= 2);
      const inviteId = await handoff.nth(0).inputValue(), privateToken = await handoff.nth(1).inputValue();
      const acceptContext = await browser.newContext({ viewport: { width: 390, height: 1000 }, serviceWorkers: 'block' });
      const recipientScope = createHmac('sha256', session.secret).update(JSON.stringify(['hon-local-presentation-v1', session.mode, session.audience, recipient.externalSubject])).digest('hex');
      await acceptContext.addCookies([{ name: HON_SESSION_COOKIE, value: cookie(recipient).split('=')[1], url: origin, httpOnly: true, sameSite: 'Lax' }, { name: design.localeCookieName(recipientScope), value: encodeURIComponent(JSON.stringify({ ...design.DEFAULT_LOCALE, language })), url: origin, sameSite: 'Lax' }]);
      await acceptContext.route('**/*', async route => { const u = new URL(route.request().url()); if (u.origin === origin) return route.continue(); await route.abort(); assert(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(u.origin)); });
      const acceptPage = await acceptContext.newPage(); await acceptPage.goto(origin + '/account/staff-invitation');
      await acceptPage.getByRole('button', { name: t(language, 'verifyAccept'), exact: true }).click(); await acceptPage.getByTestId('staff-invitation-id').fill(inviteId); await acceptPage.getByTestId('staff-token').fill(privateToken); await acceptPage.getByTestId('staff-confirm').check();
      await acceptPage.getByRole('button', { name: t(language, 'accept'), exact: true }).click(); await acceptPage.getByRole('heading', { name: t(language, 'success'), exact: true }).waitFor();
      assert.equal((await q('SELECT count(*) n FROM hon.principal_role_grants g JOIN hon.principals p ON p.id=g.principal_id JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject=$1 AND g.school_id=$2 AND g.role_id=$3', [recipient.externalSubject, school.schoolId, school.targetRole]))[0].n, '1');
      await acceptPage.addScriptTag({ content: axe }); const acceptanceScan = await acceptPage.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })); assert.deepEqual(acceptanceScan.violations.map(v => v.id), []);
      await acceptPage.screenshot({ path: join(results, `staff-acceptance-${language}-390.png`), fullPage: true }); await acceptContext.close();
      // Capture receipts with the private handoff concealed; no token belongs in an artifact.
      await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.getByRole('button', { name: t(language, 'restore'), exact: true }).click(); await page.getByRole('heading', { name: t(language, 'success'), exact: true }).waitFor();
    }
    await page.addScriptTag({ content: axe }); const scan = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
    assert.deepEqual(scan.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []); assert.deepEqual(errors, []);
    await page.screenshot({ path: join(results, `staff-invitations-${language}-${mode}-${width}.png`), fullPage: true });
    browserCases.push({ language, mode, width, actualApiAndDatabase: true, axeViolations: 0, pageErrors: 0 }); await context.close();
  }
  pass('27 mounted real-API/database language/view/viewport combinations preserve keyboard, privacy and accessibility');
  {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const setActor = who => context.addCookies([{ name: HON_SESSION_COOKIE, value: cookie(who).split('=')[1], url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await setActor(A.who); await context.route('**/*', async route => { const u = new URL(route.request().url()); if (u.origin === origin) return route.continue(); await route.abort(); assert(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(u.origin)); });
    const page = await context.newPage(); await page.goto(origin + '/staff/team/invitations');
    await page.getByTestId('staff-org').fill(A.organizationId); await page.getByTestId('staff-school').fill(A.schoolId); await page.getByRole('button', { name: t('en', 'verify'), exact: true }).click();
    await page.getByTestId('staff-role-id').fill(A.targetRole); await page.getByRole('button', { name: t('en', 'loadRole'), exact: true }).click(); await page.getByText('Front desk', { exact: true }).waitFor();
    const recipient = person('silent-session-switch'), exact = []; let switchSession = true;
    await context.route('**/api/v1/school/staff-invitations', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      exact.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
      if (!switchSession) return route.continue(); switchSession = false;
      const response = await route.fetch(); assert.equal(response.status(), 200); await setActor(B.who); await route.fulfill({ response });
    });
    await page.getByTestId('staff-email').fill(recipient.email); await page.getByRole('button', { name: t('en', 'newToken'), exact: true }).click(); await page.getByTestId('staff-confirm').check();
    await page.getByRole('button', { name: t('en', 'invite'), exact: true }).click(); await page.getByTestId('staff-account-status').filter({ hasText: t('en', 'IDENTITY') }).waitFor();
    assert(await page.getByTestId('staff-account-private').isHidden()); assert.equal(await page.getByRole('heading', { name: t('en', 'success'), exact: true }).count(), 0);
    assert.equal((await q('SELECT count(*) n FROM hon.school_staff_invitations WHERE school_id=$1 AND email=$2', [A.schoolId, recipient.email]))[0].n, '1');
    await setActor(A.who); await page.getByRole('button', { name: t('en', 'restore'), exact: true }).click(); await page.getByText(t('en', 'unknown'), { exact: true }).waitFor();
    assert.equal(exact.length, 1); await page.getByRole('button', { name: t('en', 'retry'), exact: true }).click(); await page.getByRole('heading', { name: t('en', 'success'), exact: true }).waitFor();
    assert.equal(exact.length, 2); assert(exact[1].body === exact[0].body && exact[1].key === exact[0].key, 'Silent-switch recovery replaced the original request');
    await page.evaluate(() => { window.__staffSessionSignals = 0; window.addEventListener('hon:session-invalidated', () => { window.__staffSessionSignals++; }); });
    await context.clearCookies(); await page.getByRole('button', { name: t('en', 'verify'), exact: true }).click(); await page.getByTestId('staff-account-status').filter({ hasText: t('en', 'SESSION') }).waitFor();
    assert(await page.getByTestId('staff-account-private').isHidden()); assert.equal(await page.evaluate(() => window.__staffSessionSignals), 1);
    await setActor(A.who); await page.getByRole('button', { name: t('en', 'restore'), exact: true }).click(); await page.getByRole('heading', { name: t('en', 'success'), exact: true }).waitFor(); assert.equal(exact.length, 2);
    await q('UPDATE hon.principal_role_grants SET effective_until=clock_timestamp() WHERE id=$1', [A.grantId]);
    await page.getByRole('button', { name: t('en', 'verify'), exact: true }).click(); await page.getByTestId('staff-account-status').filter({ hasText: t('en', 'DENIED') }).waitFor();
    assert(await page.getByTestId('staff-account-private').isHidden()); assert.equal(await page.evaluate(() => window.__staffSessionSignals), 1); assert.equal(exact.length, 2);
    await q('UPDATE hon.principal_role_grants SET effective_until=NULL WHERE id=$1', [A.grantId]); await context.close();
  }
  pass('mounted silent cookie identity switch, original-actor exact recovery, real 401 session expiry and real 403 revocation keep private receipts concealed');
  assert.deepEqual(await snapshot(), before); pass('every unrelated business table unchanged; no payment, entitlement, messaging, provider or AI effects');
  await writeFile(join(results, 'staff-invitations-report.json'), JSON.stringify({ sourceSha, groups, browserCases, protectedTables: protectedTables.length, actualNextNestSignedSessionsAndPostgres: true, externalOidcLoginVerified: false, syntheticFixtureDataOnly: true,
    screenshots: browserCases.length + 3, acceptanceBrowserFlows: 3, localePreferenceSource: 'Scoped synthetic locale cookie and actual unavailable-remote fallback; server language persistence not exercised', blockedStaticFonts: [...blockedFonts], externalPageRequestsAllowed: 0, providerCalls: 0, deliveryPerformed: false }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, groups: groups.length, browserCases: browserCases.length, protectedTables: protectedTables.length }));
} finally {
  globalThis.fetch = actualFetch;
  try { await browser?.close(); } finally {
    try { if (next && next.exitCode === null) { const stopped = new Promise(resolve => next.once('exit', resolve)); next.kill('SIGTERM'); await stopped; } }
    finally { try { if (app) await app.close(); else await database.onModuleDestroy(); } finally { await admin.end(); } }
  }
}
