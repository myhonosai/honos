/**
 * Eian natural voice proof (E-V2, 0638) over signed HTTP (HON session cookie -> HonIdentityGuard + Eian guards -> EianController
 * -> EianSpeechService -> the 0638 definer functions on the restricted runtime role with forced RLS), on the guarded
 * disposable CRM-close fixture only. The speech provider is an in-process fake; no network call is made and no sound is
 * made. Synthetic names only.
 */
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
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
const { Test } = apiRequire('@nestjs/testing');
const { ValidationPipe } = apiRequire('@nestjs/common');
const { HttpAdapterHost } = apiRequire('@nestjs/core');
const { json } = apiRequire('express');
const { issueSession, HON_SESSION_COOKIE } = await import(pathToFileURL(apiRequire.resolve('@hon/auth')).href);
const load = (path) => import(pathToFileURL(resolve(repo, 'apps/api/dist', path)).href);
const { RuntimeDatabaseService } = await load('foundation/runtime-database.service.js');
const { HonIdentityGuard } = await load('foundation/hon-identity.guard.js');
const { HonIdentityService } = await load('foundation/hon-identity.service.js');
const { HonExceptionFilter } = await load('observability/http-telemetry.js');
const { EianService } = await load('eian/eian.service.js');
const { EIAN_PROVIDER_RUNTIME, EianProviderRuntimeError } = await load('eian/eian-provider-runtime.js');
const { EianController, EianAskGuard, EianReadGuard, EianSpeakGuard } = await load('eian/eian.controller.js');
const { EianSpeechService, EIAN_SPEECH_COST_DELAYS } = await load('eian/eian-speech.service.js');
const { EIAN_SPEECH_RUNTIME } = await load('eian/eian-speech-runtime.js');
const { ParentClassBookingService } = await load('families/parent-class-booking.service.js');
const { ParentSchoolBookingService } = await load('families/parent-school-bookings.service.js');
const { ParentBillingViewService } = await load('families/parent-billing-view.service.js');
const { ParentClassPassViewService } = await load('families/parent-classpass-view.service.js');
const { FamilyMessagesService } = await load('families/family-messages.service.js');
const { ParentTestingStatusService } = await load('testing/parent-testing-status.service.js');
const { ParentFamilyKnowledgeService } = await load('knowledge/parent-family-knowledge.service.js');

const admin = new pg.Client(targets.owner);
await admin.connect();
await verifyCrmCloseProofConnection(admin, CRM_CLOSE_OWNER_ROLE);
const runtime = new pg.Client(targets.runtime);
await runtime.connect();
await verifyCrmCloseProofConnection(runtime, CRM_CLOSE_RUNTIME_ROLE);

const session = { mode: 'OIDC', audience: 'hon-eian-natural-voice', secret: randomBytes(32).toString('hex') };
process.env.HON_AUTH_MODE = session.mode; process.env.HON_SESSION_AUDIENCE = session.audience; process.env.HON_SESSION_JWT_SECRET = session.secret;

const ids = Object.fromEntries(['organization', 'coreOrganization', 'school', 'coreSchool', 'family', 'otherFamily', 'coreFamily']
  .map((key) => [key, randomUUID()]));
const PREFIX = `eianv-${ids.organization}`;
const sql = (text, values = []) => admin.query(text, values);
const one = async (text, values = []) => (await sql(text, values)).rows[0];
let checks = 0;
const ok = (condition, message) => { checks += 1; assert.ok(condition, message); };
const database = new RuntimeDatabaseService();

function send(target, method, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    const request = http.request(target, { method, headers }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => { try { resolvePromise({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
async function cleanup() {
  const tables = (await sql(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped
    WHERE c.relnamespace='hon'::regnamespace AND c.relkind='r' ORDER BY 1`)).rows.map((row) => row.relname);
  const orgs = [ids.organization, ids.coreOrganization];
  await sql('BEGIN');
  try {
    for (let pass = 0; pass < 8; pass += 1) {
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
    await sql('DELETE FROM hon.hq_operator_grants WHERE principal_id IN (SELECT p.id FROM hon.principals p JOIN hon.users u ON u.id=p.user_id WHERE u.external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.principals WHERE user_id IN (SELECT id FROM hon.users WHERE external_subject LIKE $1)', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.users WHERE external_subject LIKE $1', [`${PREFIX}-%`]);
    await sql('DELETE FROM hon.schools WHERE organization_id = ANY($1::uuid[])', [orgs]);
    await sql('DELETE FROM hon.organizations WHERE id = ANY($1::uuid[])', [orgs]);
    await sql('COMMIT');
  } catch (error) { await sql('ROLLBACK'); throw error; }
}
async function person(label) {
  const user = randomUUID(), principal = randomUUID(), subject = `${PREFIX}-${label}`;
  await sql("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1,$2,$3,'Person')", [user, subject, `${label}-${user.slice(0, 8)}@example.test`]);
  await sql("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Person')", [principal, user]);
  return { subject, principal, user };
}
async function grant(actor, family, school, org, level = 'PRIMARY_GUARDIAN') {
  await sql("INSERT INTO hon.family_access_grants(organization_id,school_id,family_id,principal_id,access_level,effective_from,granted_by_principal_id) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '1 day',$4)",
    [org, school, family, actor.principal, level]);
}
async function child(given, family, school, org) {
  const personId = randomUUID();
  await sql("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name) VALUES($1,$2,$3,$4,'Kim')", [personId, org, school, given]);
  await sql("INSERT INTO hon.family_members(organization_id,school_id,family_id,person_id,member_role) VALUES($1,$2,$3,$4,'STUDENT')", [org, school, family, personId]);
  await sql("INSERT INTO hon.student_profiles(organization_id,school_id,person_id,primary_family_id,status) VALUES($1,$2,$3,$4,'ACTIVE')", [org, school, personId, family]);
}
/** Runs SQL on the runtime role inside a rolled-back transaction bound to the parent's verified tenant. */
async function asParent(actor, org, school, work) {
  await runtime.query('BEGIN');
  try {
    await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
      set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
      set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`,
      [org, school, actor.principal, randomUUID(), actor.subject]);
    return await work((text, values) => runtime.query(text, values));
  } finally { await runtime.query('ROLLBACK'); }
}
async function sqlRefused(work, message, label) {
  await assert.rejects(work, (e) => { assert.equal(e.message, message, `${label}: ${e.message}`); return true; });
  ok(true, label);
}

/** The fake speech provider: each call runs the next scripted behavior; the cost record is scripted per generation. */
const AUDIO = Buffer.concat([Buffer.from('ID3'), randomBytes(600)]);
const fake = { ready: 'READY', calls: [], next: [], costs: new Map(), costReads: 0, defaultCost: 900 };
const provider = {
  readiness: () => fake.ready,
  synthesize: async (input) => {
    fake.calls.push(input);
    const step = fake.next.shift() ?? (() => ({ audio: AUDIO, generationId: `gen-${randomUUID()}` }));
    return step(input);
  },
  cost: async (generationId) => { fake.costReads += 1; return fake.costs.has(generationId) ? fake.costs.get(generationId) : fake.defaultCost; },
};
const textProvider = { readiness: () => 'CONFIGURATION_REQUIRED', generate: async () => { throw new EianProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED'); } };

let app, origin;
async function startApp() {
  const module = await Test.createTestingModule({
    controllers: [EianController],
    providers: [HonIdentityGuard, HonIdentityService, EianService, EianSpeechService, EianAskGuard, EianReadGuard, EianSpeakGuard,
      ParentClassBookingService, ParentSchoolBookingService, ParentBillingViewService, ParentClassPassViewService, FamilyMessagesService, ParentTestingStatusService, ParentFamilyKnowledgeService,
      { provide: EIAN_PROVIDER_RUNTIME, useValue: textProvider }, { provide: EIAN_SPEECH_RUNTIME, useValue: provider }, { provide: EIAN_SPEECH_COST_DELAYS, useValue: [0] },
      { provide: RuntimeDatabaseService, useValue: database }],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  app.use(json({ limit: '64kb', strict: true }));
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new HonExceptionFilter(app.get(HttpAdapterHost).httpAdapter));
  await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  process.env.HON_PUBLIC_ORIGIN = origin;
}
function call(actor, method, path, { body, key, command = 'parent.eian.speak', headers = {} } = {}) {
  const sent = {
    Cookie: `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: actor.subject }, session)}`,
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', Accept: 'application/json',
    ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Hon-Human-Command': command, ...(key ? { 'Idempotency-Key': key } : {}) } : {}),
    ...headers,
  };
  return send(new URL(`${origin}/v1/parent/eian/${path}`), method, sent, body === undefined ? undefined : JSON.stringify(body));
}
const status = (actor, options) => call(actor, 'GET', 'speech/status', options);
const speak = (actor, text, key = randomUUID(), options = {}) => call(actor, 'POST', 'speech', { body: { text }, key, ...options });
async function expect(read, code, label) {
  const { status: got, body } = await read;
  assert.equal(got, code, `${label}: expected ${code}, got ${got} ${JSON.stringify(body).slice(0, 400)}`);
  ok(true, label);
  return body;
}
async function refused(read, code, errorCode, label) {
  const body = await expect(read, code, label);
  assert.equal(body.code, errorCode, `${label}: expected ${errorCode}, got ${JSON.stringify(body).slice(0, 300)}`);
  ok(!('data' in body), `${label}: no data`);
}
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const clipByKey = (actor, key) => one('SELECT * FROM hon.eian_speech_clips WHERE requested_by=$1 AND idempotency_key=$2', [actor.principal, key]);
const clipsOf = async (actor) => Number((await one('SELECT count(*) n FROM hon.eian_speech_clips WHERE requested_by=$1', [actor.principal])).n);
/** The cost is recorded after the audio is returned: wait until the clip has left SENDING. */
async function settled(actor, key) {
  for (let i = 0; i < 200; i += 1) {
    const row = await clipByKey(actor, key);
    if (row && row.status !== 'SENDING') return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('clip never settled');
}
async function quiet() {
  for (let i = 0; i < 400; i += 1) {
    if (Number((await one("SELECT count(*) n FROM hon.eian_speech_clips WHERE organization_id=$1 AND status='SENDING'", [ids.organization])).n) === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('clips still SENDING');
}

let PARENT, PARTNERS = [], OTHER, CORE_PARENT, STAFF, NOBODY, HQ;
async function seed() {
  await sql("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'Voice Org','Voice Org'),($2,'Voice Core Org','Voice Core Org')", [ids.organization, ids.coreOrganization]);
  await sql("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day'),($2,'CORE','ACTIVE',clock_timestamp()-interval '1 day')", [ids.organization, ids.coreOrganization]);
  await sql("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1,$2,'Voice Dojo',$3,'America/Los_Angeles'),($4,$5,'Voice Core Dojo',$6,'America/Los_Angeles')",
    [ids.school, ids.organization, `eianv-${ids.school.slice(0, 8)}`, ids.coreSchool, ids.coreOrganization, `eianv-c-${ids.coreSchool.slice(0, 8)}`]);
  await sql("INSERT INTO hon.families(id,organization_id,school_id,display_name) VALUES($1,$2,$3,'Kim Family'),($4,$2,$3,'Lee Family'),($5,$6,$7,'Core Family')",
    [ids.family, ids.organization, ids.school, ids.otherFamily, ids.coreFamily, ids.coreOrganization, ids.coreSchool]);
  PARENT = await person('parent'); OTHER = await person('other'); CORE_PARENT = await person('core'); STAFF = await person('staff'); NOBODY = await person('nobody'); HQ = await person('hq');
  await grant(PARENT, ids.family, ids.school, ids.organization);
  for (let i = 0; i < 4; i += 1) { const p = await person(`partner${i}`); await grant(p, ids.family, ids.school, ids.organization, 'SECONDARY_GUARDIAN'); PARTNERS.push(p); }
  await grant(OTHER, ids.otherFamily, ids.school, ids.organization);
  await grant(CORE_PARENT, ids.coreFamily, ids.coreSchool, ids.coreOrganization);
  const role = randomUUID();
  await sql("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'EIANV_STAFF','Staff',false)", [role, ids.organization]);
  await sql("INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) VALUES($1,$2,'ai.invocation.plan')", [role, ids.organization]);
  await sql("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [ids.organization, ids.school, STAFF.principal, role]);
  await sql("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.dashboard.view']::text[])", [HQ.principal]);
}

try {
  await cleanup();
  await seed();
  await startApp();

  // 1. Scope: only a signed-in guardian with exactly one live family.
  await refused(status(NOBODY), 403, 'EIAN_FORBIDDEN', 'no family grant');
  await refused(status(STAFF), 403, 'EIAN_FORBIDDEN', 'staff are not parents');
  await refused(speak(STAFF, 'Class is at four.'), 403, 'EIAN_FORBIDDEN', 'staff cannot ask for a clip');
  const unsigned = await send(new URL(`${origin}/v1/parent/eian/speech/status`), 'GET', { Accept: 'application/json' });
  ok([401, 403].includes(unsigned.status) && !('data' in unsigned.body), 'no session is refused');

  // 2. No selectors; a closed body under its own command.
  await refused(call(PARENT, 'GET', `speech/status?familyId=${ids.otherFamily}`), 400, 'EIAN_SELECTORS_NOT_ACCEPTED', 'status selector');
  await refused(status(PARENT, { headers: { 'X-Hon-School-Id': ids.school } }), 403, 'EIAN_READ_ONLY', 'x-hon header on a read');
  await refused(call(PARENT, 'POST', `speech?familyId=${ids.otherFamily}`, { body: { text: 'Hi' }, key: randomUUID() }), 400, 'EIAN_SELECTORS_NOT_ACCEPTED', 'speak selector');
  for (const [bad, label] of [[{ text: 'Hi', familyId: ids.otherFamily }, 'extra body key'], [{ text: 'Hi', voice: 'other' }, 'voice choice'], [{ text: 'Hi', instructions: 'Whisper.' }, 'instructions'],
    [{ text: 'x'.repeat(1501) }, 'too long'], [{ text: '   ' }, 'empty'], [{ text: 'See https://example.test/a' }, 'a link'], [{ text: 'Bell\u0007' }, 'control character'], [{}, 'no text']]) {
    await refused(call(PARENT, 'POST', 'speech', { body: bad, key: randomUUID() }), 400, 'VALIDATION_FAILED', `body refused: ${label}`);
  }
  await refused(call(PARENT, 'POST', 'speech', { body: { text: 'Hi' } }), 409, 'IDEMPOTENCY_KEY_REQUIRED', 'key required');
  ok((await call(PARENT, 'POST', 'speech', { body: { text: 'Hi' }, key: randomUUID(), command: 'parent.eian.ask' })).status === 403, 'the ask command cannot make a clip');
  ok(await clipsOf(PARENT) === 0 && fake.calls.length === 0, 'refused requests write nothing and call nothing');

  // 3. The gate: Core gets the phone voice; Complete while the server is not ready gets the phone voice; ready is NATURAL.
  assert.deepEqual((await expect(status(CORE_PARENT), 200, 'core status')).data, { voice: 'PHONE', reason: 'NOT_INCLUDED' });
  await refused(speak(CORE_PARENT, 'Class is at four.'), 503, 'EIAN_SPEECH_UNAVAILABLE', 'core cannot get a clip');
  ok(await clipsOf(CORE_PARENT) === 0, 'a refused clip writes no row');
  fake.ready = 'CONFIGURATION_REQUIRED';
  assert.deepEqual((await expect(status(PARENT), 200, 'not ready status')).data, { voice: 'PHONE', reason: 'NOT_CONFIGURED' });
  const notReadyKey = randomUUID();
  await refused(speak(PARENT, 'Class is at four.', notReadyKey), 503, 'EIAN_SPEECH_UNAVAILABLE', 'not ready: no clip');
  const notReady = await clipByKey(PARENT, notReadyKey);
  ok(notReady.status === 'CONFIGURATION_REQUIRED' && notReady.reserved_credits === 0 && fake.calls.length === 0, 'not ready: nothing reserved, no call');
  fake.ready = 'READY';
  assert.deepEqual((await expect(status(PARENT), 200, 'ready status')).data, { voice: 'NATURAL', reason: null });

  // 4. One clip: the audio comes back, the provider gets only the words (name as said, no email or id), HON keeps a digest.
  const key = randomUUID();
  const words = `Hi, I'm Eian! Maya has class at 4:30. Write to coach@example.test about ${ids.family}.`;
  const said = `Hi, I'm Ian! Maya has class at 4:30. Write to an email address about an id.`;
  const made = await expect(speak(PARENT, words, key), 201, 'first clip');
  assert.deepEqual(Object.keys(made.data).sort(), ['audio', 'mime']);
  ok(made.data.mime === 'audio/mpeg' && Buffer.from(made.data.audio, 'base64').equals(AUDIO), 'the exact audio is returned');
  ok(fake.calls.length === 1, 'one provider call');
  const sent = fake.calls[0];
  assert.deepEqual(Object.keys(sent).sort(), ['maxCostMicrounits', 'modelId', 'providerId', 'providerRequestId', 'text']);
  ok(sent.providerId === 'OPENROUTER' && sent.modelId === 'fish-audio/drama-3' && sent.maxCostMicrounits === 20000 && sent.text === said, 'fixed provider, model and ceiling; only the words');
  const row = await settled(PARENT, key);
  ok(row.family_id === ids.family && row.text_digest === sha(said) && row.characters === said.length && row.provider_request_id === sent.providerRequestId, 'clip row: digest and length');
  const columns = (await sql("SELECT column_name FROM information_schema.columns WHERE table_schema='hon' AND table_name='eian_speech_clips'")).rows.map((r) => r.column_name);
  ok(!columns.some((c) => /text$|audio|words|body|content/.test(c) && c !== 'text_digest'), 'no column can hold the words or the sound');
  ok(row.status === 'COMPLETED' && row.reserved_credits === 0 && row.usage_id, 'recorded after the audio: completed, hold released');
  const ledger = await one('SELECT * FROM hon.ai_usage_ledger WHERE id=$1', [row.usage_id]);
  ok(ledger.source_invocation_id === row.id && ledger.spend_class === 'AGENT_INFERENCE' && ledger.modality === 'VOICE_OUTPUT' && ledger.provider_code === 'OPENROUTER' && ledger.model_code === 'fish-audio/drama-3'
    && Number(ledger.input_units) === said.length && Number(ledger.provider_cost_microunits) === 900 && Number(ledger.customer_credits) === 1 && ledger.initiator_principal_id === PARENT.principal, 'one ledger row with the provider-reported cost');

  // 5. Replay: the sound is not stored, so a finished key is refused and never calls again; another text under the key is refused.
  await refused(speak(PARENT, words, key), 409, 'EIAN_SPEECH_ALREADY_MADE', 'replay of a finished clip');
  await refused(speak(PARENT, 'Something else.', key), 409, 'IDEMPOTENCY_KEY_REUSED', 'key reuse');
  await refused(speak(PARENT, 'Class is at four.', notReadyKey), 409, 'EIAN_SPEECH_ALREADY_MADE', 'a refused key stays refused');
  ok(fake.calls.length === 1 && Number((await one('SELECT count(*) n FROM hon.ai_usage_ledger WHERE source_invocation_id=$1', [row.id])).n) === 1, 'replays: no call, no second ledger row');

  // 6. Outcomes.
  fake.next.push(() => { throw new EianProviderRuntimeError('UNKNOWN', 'PROVIDER_UNKNOWN'); });
  const unknownKey = randomUUID();
  await refused(speak(PARENT, 'Is there class on Friday?', unknownKey), 503, 'EIAN_SPEECH_OUTCOME_UNKNOWN', 'unknown outcome: no audio');
  const unknown = await clipByKey(PARENT, unknownKey);
  ok(unknown.status === 'UNKNOWN' && unknown.reserved_credits === 1 && unknown.held_at && unknown.usage_id === null, 'UNKNOWN keeps its hold');
  ok(Number((await one('SELECT hon.ai_org_committed_credits($1,clock_timestamp()) c', [ids.organization])).c) >= 2, 'the hold counts against the school budget');
  await refused(speak(PARENT, 'Is there class on Friday?', unknownKey), 409, 'EIAN_SPEECH_ALREADY_MADE', 'an unknown clip is never sent again');
  fake.next.push(() => { throw new EianProviderRuntimeError('FAILED', 'PROVIDER_UNAVAILABLE'); });
  const downKey = randomUUID();
  await refused(speak(PARENT, 'Voice down?', downKey), 503, 'EIAN_SPEECH_UNAVAILABLE', 'provider unavailable');
  const down = await clipByKey(PARENT, downKey);
  ok(down.status === 'FAILED' && down.reason === 'PROVIDER_UNAVAILABLE' && down.reserved_credits === 0 && down.usage_id === null, 'unavailable: released, nothing charged');
  // The audio arrived but the provider never published a cost: the parent has the audio, the clip goes to HQ with its hold.
  fake.next.push(() => ({ audio: AUDIO, generationId: 'gen-no-cost' })); fake.costs.set('gen-no-cost', null);
  const noCostKey = randomUUID();
  await expect(speak(PARENT, 'Cost never arrives.', noCostKey), 201, 'audio without a cost record');
  const noCost = await settled(PARENT, noCostKey);
  ok(noCost.status === 'UNKNOWN' && noCost.reason === 'PROVIDER_UNKNOWN' && noCost.reserved_credits === 1 && noCost.usage_id === null, 'no cost record: UNKNOWN with its hold');
  // A cost above the per-clip maximum is recorded (it was charged) and the clip is FAILED for the record.
  fake.next.push(() => ({ audio: AUDIO, generationId: 'gen-over' })); fake.costs.set('gen-over', 20001);
  const overKey = randomUUID();
  await expect(speak(PARENT, 'Over the maximum.', overKey), 201, 'cost over the maximum');
  const over = await settled(PARENT, overKey);
  ok(over.status === 'FAILED' && over.reason === 'RESULT_BUDGET_EXCEEDED' && over.usage_id && over.reserved_credits === 0, 'over the maximum: recorded and marked');
  // Access lapses while the provider is speaking: the cost is still recorded (evidence-only actor).
  fake.next.push(() => sql('UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [ids.organization]).then(() => ({ audio: AUDIO, generationId: 'gen-lapse' })));
  const lapseKey = randomUUID();
  await expect(speak(PARENT, 'Lapse mid-flight.', lapseKey), 201, 'lapse mid-flight');
  const lapsed = await settled(PARENT, lapseKey);
  ok(lapsed.status === 'COMPLETED' && lapsed.usage_id && lapsed.reserved_credits === 0, 'lapse mid-flight: the usage is still recorded');
  await refused(status(PARENT), 403, 'EIAN_FORBIDDEN', 'lapsed status');
  await refused(speak(PARENT, 'After the lapse.'), 403, 'EIAN_FORBIDDEN', 'lapsed: no clip');
  await sql('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [ids.organization]);

  // 7. HQ: the unknown clips are in the queue under their own agent, usage is attributed, and HQ resolves both ways.
  const queue = (await runtime.query('SELECT hon.read_ai_unknown_invocations_from_hq($1) d', [HQ.subject])).rows[0].d;
  ok(queue.open.some((o) => o.agent === 'EIAN_SPEECH' && o.invocationId === unknown.id) && queue.open.some((o) => o.agent === 'EIAN_SPEECH' && o.invocationId === noCost.id), 'unknown clips in the HQ queue');
  const usage = (await runtime.query("SELECT hon.read_ai_school_usage_from_hq($1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 hour') d", [HQ.subject])).rows[0].d;
  const school = usage.schools.find((s) => s.schoolId === ids.school);
  ok(school && school.byClass.AGENT_INFERENCE.byAgent.EIAN_SPEECH.entries >= 3 && school.unreconciledInvocations >= 2, 'HQ usage attributes Eian speech');
  const resolveUnknown = (id, input) => runtime.query('SELECT hon.resolve_ai_unknown_invocation($1,$2,$3,$4::jsonb,$5,$6,$7) d', [HQ.subject, 'EIAN_SPEECH', id, JSON.stringify(input), randomUUID(), randomUUID(), randomUUID()]);
  await resolveUnknown(unknown.id, { decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider log, no charge.', evidence: { providerLookupReference: 'lookup-1' } });
  ok((await clipByKey(PARENT, unknownKey)).reserved_credits === 0 && (await clipByKey(PARENT, unknownKey)).usage_id === null, 'HQ releases a clip that was never charged');
  await resolveUnknown(noCost.id, { decision: 'RECORD_PROVIDER_COST', reason: 'Cost read from the provider activity page.', evidence: { providerGenerationId: 'gen-no-cost', inputTokens: 19, outputTokens: 0, providerCostMicrounits: 700 } });
  const resolvedRow = await clipByKey(PARENT, noCostKey);
  const resolvedLedger = await one('SELECT * FROM hon.ai_usage_ledger WHERE id=$1', [resolvedRow.usage_id]);
  ok(resolvedRow.reserved_credits === 0 && resolvedLedger.modality === 'VOICE_OUTPUT' && resolvedLedger.model_code === 'fish-audio/drama-3' && Number(resolvedLedger.provider_cost_microunits) === 700, 'HQ records the cost of a clip as speech');
  await sqlRefused(resolveUnknown(row.id, { decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider log, no charge.', evidence: { providerLookupReference: 'lookup-2' } }), 'AI_UNKNOWN_NOT_RESOLVABLE', 'a finished clip cannot be resolved');

  // 8. Database refusals on the runtime role (each rolled back).
  await asParent(PARENT, ids.organization, ids.school, async (q) => {
    const digest = sha('Direct.');
    for (const [args, label] of [[[PARENT.subject, randomUUID(), 'nothex', 7], 'digest'], [[PARENT.subject, randomUUID(), digest, 0], 'zero length'], [[PARENT.subject, randomUUID(), digest, 1501], 'too long'], [[PARENT.subject, ' padded', digest, 7], 'key']]) {
      await q('SAVEPOINT v');
      await sqlRefused(q('SELECT hon.begin_eian_speech($1,$2,$3,$4)', args), 'VALIDATION_FAILED', `begin refused: ${label}`);
      await q('ROLLBACK TO SAVEPOINT v');
    }
    const begun = (await q('SELECT hon.begin_eian_speech($1,$2,$3,$4) d', [PARENT.subject, randomUUID(), digest, 7])).rows[0].d;
    ok(begun.status === 'PENDING' && begun.replayed === false, 'direct begin');
    await q('SAVEPOINT o');
    await sqlRefused(q('SELECT hon.prepare_eian_speech($1,$2,true)', [PARENT.subject, row.id.replace(/.$/, row.id.endsWith('0') ? '1' : '0')]), 'EIAN_SPEECH_NOT_FOUND', 'an unknown clip id');
    await q('ROLLBACK TO SAVEPOINT o');
    const prepared = (await q('SELECT hon.prepare_eian_speech($1,$2,true) d', [PARENT.subject, begun.clipId])).rows[0].d;
    ok(Object.keys(prepared).sort().join() === 'characters,maxCostMicrounits,modelId,providerId,providerRequestId,textDigest', 'prepare returns only the fixed provider input');
    ok((await q('SELECT hon.prepare_eian_speech($1,$2,true) d', [PARENT.subject, begun.clipId])).rows[0].d === null, 'a second prepare returns nothing');
    for (const [result, label] of [[{ characters: 7 }, 'missing cost'], [{ characters: 7, providerCostMicrounits: 1, audio: 'x' }, 'extra key'], [{ characters: 0, providerCostMicrounits: 1 }, 'zero characters'], [{ characters: 7, providerCostMicrounits: -1 }, 'negative cost'], [{ characters: 7, providerCostMicrounits: 1.5 }, 'fractional cost']]) {
      await q('SAVEPOINT r');
      await sqlRefused(q('SELECT hon.record_eian_speech_result($1,$2,$3::jsonb)', [PARENT.subject, begun.clipId, JSON.stringify(result)]), 'INVALID_EIAN_SPEECH_RESULT', `result refused: ${label}`);
      await q('ROLLBACK TO SAVEPOINT r');
    }
    for (const [outcome, reason] of [['DONE', 'PROVIDER_UNKNOWN'], ['UNKNOWN', 'PROVIDER_UNAVAILABLE'], ['FAILED', 'BECAUSE']]) {
      await q('SAVEPOINT f');
      await sqlRefused(q('SELECT hon.fail_eian_speech($1,$2,$3,$4)', [PARENT.subject, begun.clipId, outcome, reason]), 'INVALID_EIAN_SPEECH_OUTCOME', `outcome refused: ${outcome}/${reason}`);
      await q('ROLLBACK TO SAVEPOINT f');
    }
    ok((await q('SELECT hon.record_eian_speech_result($1,$2,$3::jsonb) d', [PARENT.subject, begun.clipId, JSON.stringify({ characters: 7, providerCostMicrounits: 70 })])).rows[0].d === 'COMPLETED', 'direct record');
    await q('SAVEPOINT again');
    await sqlRefused(q('SELECT hon.record_eian_speech_result($1,$2,$3::jsonb)', [PARENT.subject, begun.clipId, JSON.stringify({ characters: 7, providerCostMicrounits: 70 })]), 'EIAN_SPEECH_OUTCOME_REPLAY', 'a second record is refused');
    await q('ROLLBACK TO SAVEPOINT again');
  });
  // Another family's guardian in the same school cannot prepare, fail or record this family's clip.
  await asParent(OTHER, ids.organization, ids.school, async (q) => {
    await q('SAVEPOINT a');
    await sqlRefused(q('SELECT hon.prepare_eian_speech($1,$2,true)', [OTHER.subject, row.id]), 'EIAN_SPEECH_NOT_FOUND', 'another family cannot prepare it');
    await q('ROLLBACK TO SAVEPOINT a');
    await sqlRefused(q('SELECT hon.record_eian_speech_result($1,$2,$3::jsonb)', [OTHER.subject, unknown.id, JSON.stringify({ characters: 7, providerCostMicrounits: 70 })]), 'EIAN_SPEECH_OUTCOME_REPLAY', 'another family cannot record it');
  });
  const acl = (await runtime.query(`SELECT has_table_privilege(current_user,'hon.eian_speech_clips','SELECT') t, has_table_privilege(current_user,'hon.eian_speech_clips','INSERT') i,
    has_function_privilege(current_user,'hon.eian_speech_unavailable_reason(uuid,uuid,boolean)','EXECUTE') h, has_function_privilege(current_user,'hon.eian_speech_limits()','EXECUTE') l,
    has_function_privilege(current_user,'hon.begin_eian_speech(text,text,text,integer)','EXECUTE') b, has_function_privilege(current_user,'hon.read_eian_speech_status(text,boolean)','EXECUTE') s,
    has_function_privilege(current_user,'hon.prepare_eian_speech(text,uuid,boolean)','EXECUTE') p, has_function_privilege(current_user,'hon.fail_eian_speech(text,uuid,text,text)','EXECUTE') f,
    has_function_privilege(current_user,'hon.record_eian_speech_result(text,uuid,jsonb)','EXECUTE') r`)).rows[0];
  ok(!acl.t && !acl.i && !acl.h && !acl.l && acl.b && acl.s && acl.p && acl.f && acl.r, 'runtime: no table access, no helper access, five entry points only');

  // 9. The organization ceiling: the phone voice, and no call.
  await quiet();
  const ceiling = Number((await one('SELECT hon.ai_org_ceiling($1,clock_timestamp()) c', [ids.organization])).c);
  const calls = fake.calls.length;
  await sql("INSERT INTO hon.ai_usage_ledger(organization_id,school_id,initiator_principal_id,provider_code,model_code,modality,input_units,output_units,provider_cost_microunits,customer_credits,spend_class,correlation_id) VALUES($1,$2,$3,'OPENROUTER','approved/fixture','TEXT',1,1,0,$4,'AGENT_INFERENCE',gen_random_uuid())",
    [ids.organization, ids.school, PARENT.principal, ceiling]);
  assert.deepEqual((await expect(status(PARENT), 200, 'ceiling status')).data, { voice: 'PHONE', reason: 'BUDGET_REACHED' });
  const fullKey = randomUUID();
  await refused(speak(PARENT, 'Ceiling reached?', fullKey), 503, 'EIAN_SPEECH_UNAVAILABLE', 'ceiling reached');
  const full = await clipByKey(PARENT, fullKey);
  ok(full.status === 'BLOCKED' && full.reason === 'CUSTOMER_BUDGET_EXCEEDED' && full.reserved_credits === 0 && fake.calls.length === calls, 'ceiling reached: blocked, no call');
  await sql('DELETE FROM hon.ai_usage_ledger WHERE organization_id=$1 AND input_units=1 AND output_units=1', [ids.organization]);

  // 10. Burst: 20 new clips per guardian per 10 minutes, counted under a lock; replays never count.
  const used = await clipsOf(PARENT);
  const burst = await Promise.all(Array.from({ length: 23 - used }, (_, i) => speak(PARENT, `Burst line ${i}.`)));
  ok(await clipsOf(PARENT) === 20, `exactly 20 clips in the window under parallel requests (got ${await clipsOf(PARENT)})`);
  ok(burst.filter((r) => r.status === 429 && r.body.code === 'EIAN_SPEECH_BUSY').length === 3, 'the rest are EIAN_SPEECH_BUSY');
  await refused(speak(PARENT, words, key), 409, 'EIAN_SPEECH_ALREADY_MADE', 'a replay while busy is not counted as new');

  // 11. The family's day: 60 clips across all of its guardians (UTC day); refused clips never count.
  const dayCount = async () => Number((await one(`SELECT count(*) n FROM hon.eian_speech_clips WHERE family_id=$1 AND status NOT IN ('BLOCKED','CONFIGURATION_REQUIRED')
    AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`, [ids.family])).n);
  let p = 0;
  while (await dayCount() < 60) {
    const partner = PARTNERS[p++]; assert.ok(partner, 'enough guardians to fill the day');
    const need = Math.min(20, 60 - await dayCount());
    const batch = await Promise.all(Array.from({ length: need }, (_, i) => speak(partner, `Day line ${p}-${i}.`)));
    ok(batch.every((r) => r.status === 201), `guardian ${p} adds ${need} clips`);
  }
  ok(await dayCount() === 60, 'the family reached 60 counted clips');
  const beforeLimit = fake.calls.length;
  await refused(speak(PARTNERS[3], 'One more today.'), 429, 'EIAN_SPEECH_DAILY_LIMIT', 'the 61st clip of the family day');
  ok(fake.calls.length === beforeLimit, 'the daily limit refuses before any call');
  ok((await expect(speak(OTHER, 'Another family today.'), 201, 'another family is not limited')).data.mime === 'audio/mpeg', 'the limit is per family');
  await quiet();
  ok(Number((await one("SELECT count(*) n FROM hon.eian_speech_clips WHERE organization_id=$1 AND reserved_credits>0", [ids.organization])).n) === 0, 'no hold is left open');
  ok(fake.calls.every((c) => Object.keys(c).length === 5 && !/@|[0-9a-f]{8}-[0-9a-f]{4}-/.test(c.text)), 'no call carried anything but the words');

  // 12. The canonical 011 section.
  const canonical = await readFile(resolve(repo, 'infra/postgres/011_verify_supabase_hon_runtime.sql'), 'utf8');
  const block = canonical.split('-- Eian natural voice exact verification (0638)')[1]?.split('-- End Eian natural voice exact verification.')[0];
  ok(Boolean(block), '011 section present');
  await sql(block.slice(block.indexOf('\n') + 1).replaceAll('hon_runtime', CRM_CLOSE_RUNTIME_ROLE));
  ok(true, '011 section passes on the fixture');

  console.log(JSON.stringify({ proof: 'eian-natural-voice', checks, providerCalls: fake.calls.length, costReads: fake.costReads, networkCalls: 0 }));
  console.log(`PASS Eian natural voice (0638): ${checks} checks.`);
} finally {
  await app?.close();
  await cleanup().catch(() => null);
  await admin.end(); await runtime.end();
}
