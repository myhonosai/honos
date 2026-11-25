/**
 * Staff agent natural voices (0652) through the real API service, the restricted runtime role and the S4 spend controls on a
 * fresh disposable AI-0 fixture. Each clip is begun, prepared under the budget lock, made by a counted in-process fake
 * speech provider and settled to the provider-reported cost. Nothing leaves the machine and fetch is refused. Synthetic
 * names only.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID as K } from 'node:crypto';
import pg from 'pg';
import { AI0_OWNER_ROLE as ownerRole, AI0_RUNTIME_ROLE as runtimeRole, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

assertNoLibpqOverrides(process.env);
const ownerUrl = assertDisposableTarget(process.env.DATABASE_URL, ownerRole);
const runtimeUrl = assertDisposableTarget(process.env.HON_RUNTIME_DATABASE_URL, runtimeRole);
process.env.HON_RUNTIME_DATABASE_URL = runtimeUrl;
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|TWILIO|SUPABASE|AWS|SHOPIFY|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|SHOPIFY|AGENT))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`Refusing provider or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AgentSpeechService } = await import('../../../apps/api/dist/agent-speech/agent-speech.service.js');
const { SpeechProviderRuntimeError, OpenRouterAgentSpeechRuntime, pcmToWav } = await import('../../../apps/api/dist/agent-speech/agent-speech-runtime.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const runtime = new pg.Client({ connectionString: runtimeUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const code = (r) => r.error?.getResponse?.().code;
const status = (r) => r.error?.getStatus?.();
let groups = 0; const pass = (name) => console.log(`PASS AS1 ${++groups} ${name}`);

const VOICES = { hon: 'Kore', maya: 'Leda', chad: 'Puck', kai: 'Charon', alex: 'Orus', jordan: 'Iapetus', marcus: 'Fenrir', claire: 'Despina', lena: 'Aoede' };
const WAV = pcmToWav(Buffer.alloc(4800));
const fake = { ready: 'READY', calls: [], next: [], costs: new Map(), defaultCost: 300, costReads: 0 };
const provider = {
  readiness: () => fake.ready,
  synthesize: async (input) => { fake.calls.push(input); const step = fake.next.shift(); return step ? step(input) : { audio: WAV, generationId: `gen-tts-${K()}` }; },
  cost: async (generationId) => { fake.costReads += 1; return fake.costs.has(generationId) ? fake.costs.get(generationId) : fake.defaultCost; },
};
const db = new RuntimeDatabaseService();
const speech = new AgentSpeechService(db, provider, [0]);
const ctx = (p) => ({ organizationId: p.id, schoolId: p.school, principalId: p.principal, externalSubject: p.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K() });
const clip = (p, key) => row('SELECT * FROM hon.agent_speech_clips WHERE requested_by=$1 AND idempotency_key=$2', [p.principal, key]);
/** Speaks and waits for the background settlement, as the API does after it returned the audio. */
async function say(p, agent, text, key = K()) {
  const r = await settle(speech.speak(ctx(p), agent, { text }, key));
  for (let i = 0; i < 50; i += 1) { const c = await clip(p, key); if (!c || c.status !== 'SENDING' || r.error) break; await new Promise((res) => setTimeout(res, 20)); }
  return { ...r, key, row: await clip(p, key) };
}

async function makeOrg(label, tier = 'COMPLETE') {
  const o = { label, id: K(), school: K(), user: K(), principal: K(), role: K(), subject: `as1-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'AS1 synthetic organization','AS1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,$2,'ACTIVE',clock_timestamp()-interval '1 day')", [o.id, tier]);
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','Avery Synthowner')", [o.user, o.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'Avery Synthowner')", [o.principal, o.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,'OWNER','AS1 synthetic owner',true)", [o.role, o.id]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions', [o.role, o.id]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '3 days')", [o.id, o.school, o.principal, o.role]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const st = { ...o, user: K(), principal: K(), role: K(), subject: `as1-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AS1 synthetic staff')", [st.user, st.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'AS1 synthetic staff')", [st.principal, st.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'AS1 synthetic staff',false)", [st.role, o.id, 'AS1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code=ANY($3::text[])', [st.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$5,clock_timestamp()-interval '2 days')", [o.id, o.school, st.principal, st.role, o.principal]);
  await admin.query('COMMIT');
  return st;
}
async function hqOperator() {
  const h = { user: K(), principal: K(), subject: `as1-hq-${K()}` };
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','AS1 synthetic HQ')", [h.user, h.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'AS1 synthetic HQ')", [h.principal, h.user]);
  await admin.query("INSERT INTO hon.hq_operator_grants(principal_id,hq_role,permission_codes) VALUES($1,'HON_HQ_OWNER',ARRAY['hq.dashboard.view']::text[])", [h.principal]);
  return h;
}

await admin.connect(); await runtime.connect();
try {
  const A = await makeOrg('a'), CORE = await makeOrg('core', 'CORE'), B = await makeOrg('b');
  const kaiOnly = await addStaff(A, 'kaionly', ['teaching.assistant.use', 'ai.agent.kai.use']);
  const switchOnly = await addStaff(A, 'switchonly', ['ai.agent.kai.use']);
  const capOnly = await addStaff(A, 'caponly', ['teaching.assistant.use']);
  const HQ = await hqOperator();

  // 1. Status: the natural voice only with both agent keys, Complete, the server ready and no pause.
  assert.deepEqual(await speech.status(ctx(A), 'hon'), { voice: 'NATURAL', reason: null });
  assert.deepEqual(await speech.status(ctx(kaiOnly), 'kai'), { voice: 'NATURAL', reason: null });
  for (const [p, agent] of [[kaiOnly, 'hon'], [switchOnly, 'kai'], [capOnly, 'kai'], [CORE, 'hon']]) {
    assert.deepEqual(await speech.status(ctx(p), agent), { voice: 'BROWSER', reason: 'NOT_INCLUDED' }, `${p.label}/${agent}`);
  }
  fake.ready = 'CONFIGURATION_REQUIRED';
  assert.deepEqual(await speech.status(ctx(A), 'hon'), { voice: 'BROWSER', reason: 'NOT_CONFIGURED' });
  fake.ready = 'READY';
  assert.equal(code(await settle(speech.status(ctx(A), 'eian'))), 'VALIDATION_FAILED');
  assert.equal(code(await settle(speech.status(ctx(A), 'HON'))), 'VALIDATION_FAILED');
  pass('status: natural only with both agent keys and Complete; browser voice with a closed reason otherwise');

  // 2. Every agent speaks in its own fixed voice; the words reach the provider only, the database a digest and a length.
  for (const agent of Object.keys(VOICES)) {
    const before = fake.calls.length;
    const r = await say(A, agent, `Hello from ${agent}. Write to coach@example.test about 0b6c9b4e-8f1a-4c38-9d8e-2b7a2d6f1a11 please.`);
    assert.ok(r.value, `${agent}: ${r.error?.message}`);
    assert.equal(r.value.mime, 'audio/wav'); assert.equal(Buffer.from(r.value.audio, 'base64').subarray(0, 4).toString('latin1'), 'RIFF');
    const call = fake.calls[before];
    assert.equal(fake.calls.length, before + 1);
    assert.equal(call.voice, VOICES[agent]); assert.equal(call.modelId, 'google/gemini-3.8-flash-lite-tts'); assert.equal(call.providerId, 'OPENROUTER');
    assert.equal(call.text, `Hello from ${agent}. Write to an email address about an id please.`);
    assert.equal(call.maxCostMicrounits, 20000);
    assert.equal(r.row.agent_key, agent); assert.equal(r.row.status, 'COMPLETED'); assert.equal(r.row.reserved_credits, 0);
    assert.equal(r.row.text_digest, createHash('sha256').update(call.text, 'utf8').digest('hex')); assert.equal(r.row.characters, call.text.length);
    const u = await row('SELECT * FROM hon.ai_usage_ledger WHERE id=$1', [r.row.usage_id]);
    assert.equal(u.modality, 'VOICE_OUTPUT'); assert.equal(u.spend_class, 'AGENT_INFERENCE'); assert.equal(Number(u.customer_credits), 1);
    assert.equal(Number(u.input_units), call.text.length); assert.equal(Number(u.provider_cost_microunits), 300); assert.equal(u.model_code, 'google/gemini-3.8-flash-lite-tts');
  }
  const cols = (await rows("SELECT attname FROM pg_attribute WHERE attrelid='hon.agent_speech_clips'::regclass AND attnum>0 AND NOT attisdropped ORDER BY 1")).map((x) => x.attname);
  assert.ok(!cols.some((c) => /text$|words|audio|sound/.test(c) && c !== 'text_digest'), cols.join(','));
  pass('nine agents, nine fixed Gemini voices; one ledger row each at the reported cost; no words or sound stored');

  // 3. Replays: the same key never calls again; another text or agent under the key is refused.
  const first = await say(A, 'maya', 'Three students may need a check-in.');
  const calls = fake.calls.length;
  assert.equal(code(await settle(speech.speak(ctx(A), 'maya', { text: 'Three students may need a check-in.' }, first.key))), 'AGENT_SPEECH_ALREADY_MADE');
  assert.equal(code(await settle(speech.speak(ctx(A), 'maya', { text: 'Something else.' }, first.key))), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(code(await settle(speech.speak(ctx(A), 'chad', { text: 'Three students may need a check-in.' }, first.key))), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(fake.calls.length, calls);
  pass('replay: one key, one clip, never sent twice');

  // 4. Authority: both keys at this school, a human, the session school; another school's clip is invisible.
  for (const [p, agent] of [[kaiOnly, 'hon'], [switchOnly, 'kai'], [capOnly, 'kai'], [CORE, 'hon']]) {
    const r = await say(p, agent, 'Not for you.');
    assert.equal(code(r), 'AGENT_SPEECH_FORBIDDEN', `${p.label}/${agent}: ${code(r)}`); assert.equal(r.row, undefined);
  }
  assert.ok((await say(kaiOnly, 'kai', 'Warm up with ten jumping jacks.')).value);
  assert.equal(code(await settle(speech.speak({ ...ctx(A), source: 'AUTOMATION' }, 'hon', { text: 'Hi.' }, K()))), 'HUMAN_COMMAND_REQUIRED');
  for (const text of ['', '   ', 'x'.repeat(1001), 'See https://example.test', 'Bad \u0007 bell']) {
    assert.equal(code(await settle(speech.speak(ctx(A), 'hon', { text }, K()))), 'VALIDATION_FAILED', JSON.stringify(text));
  }
  assert.equal(code(await settle(speech.speak(ctx(A), 'hon', { text: 'Hi.', extra: 1 }, K()))), 'VALIDATION_FAILED');
  assert.equal(code(await settle(speech.speak(ctx(A), 'hon', { text: 'Hi.' }, ''))), 'IDEMPOTENCY_KEY_REQUIRED');
  const lapsedKey = K();
  await admin.query('UPDATE hon.organization_entitlements SET effective_until=clock_timestamp() WHERE organization_id=$1', [B.id]);
  assert.equal(code(await settle(speech.speak(ctx(B), 'hon', { text: 'After the plan ended.' }, lapsedKey))), 'AGENT_SPEECH_FORBIDDEN');
  assert.deepEqual(await speech.status(ctx(B), 'hon'), { voice: 'BROWSER', reason: 'NOT_INCLUDED' });
  await admin.query('UPDATE hon.organization_entitlements SET effective_until=NULL WHERE organization_id=$1', [B.id]);
  pass('authority: both agent keys, Complete, a direct human; text and key checks before anything is begun');

  // 5. Not configured: nothing reserved, nothing called; the key stays refused.
  fake.ready = 'CONFIGURATION_REQUIRED';
  const before5 = fake.calls.length;
  const nc = await say(A, 'hon', 'Not configured yet.');
  assert.equal(code(nc), 'AGENT_SPEECH_UNAVAILABLE'); assert.equal(nc.row.status, 'CONFIGURATION_REQUIRED'); assert.equal(nc.row.reserved_credits, 0);
  fake.ready = 'READY';
  assert.equal(code(await settle(speech.speak(ctx(A), 'hon', { text: 'Not configured yet.' }, nc.key))), 'AGENT_SPEECH_ALREADY_MADE');
  assert.equal(fake.calls.length, before5);
  pass('not configured: no reservation, no call, the key is spent');

  // 6. Provider outcomes: rejected releases the hold; unknown keeps it for HQ; audio without a cost goes UNKNOWN.
  fake.next.push(() => { throw new SpeechProviderRuntimeError('FAILED', 'PROVIDER_REJECTED'); });
  const rej = await say(A, 'jordan', 'Rejected clip.');
  assert.equal(code(rej), 'AGENT_SPEECH_UNAVAILABLE'); assert.equal(rej.row.status, 'FAILED'); assert.equal(rej.row.reserved_credits, 0); assert.equal(rej.row.usage_id, null);
  fake.next.push(() => { throw new Error('socket closed'); });
  const unk = await say(A, 'alex', 'Lost answer.');
  assert.equal(code(unk), 'AGENT_SPEECH_OUTCOME_UNKNOWN'); assert.equal(unk.row.status, 'UNKNOWN'); assert.equal(unk.row.reserved_credits, 1);
  fake.next.push(() => ({ audio: WAV, generationId: 'gen-tts-no-cost' })); fake.costs.set('gen-tts-no-cost', null);
  const noCost = await say(A, 'lena', 'No cost record.');
  assert.ok(noCost.value); assert.equal(noCost.row.status, 'UNKNOWN'); assert.equal(noCost.row.reserved_credits, 1); assert.equal(noCost.row.usage_id, null);
  fake.next.push(() => ({ audio: WAV, generationId: 'gen-tts-over' })); fake.costs.set('gen-tts-over', 25000);
  const over = await say(A, 'claire', 'Costly clip.');
  assert.ok(over.value); assert.equal(over.row.status, 'FAILED'); assert.equal(over.row.reason, 'RESULT_BUDGET_EXCEEDED'); assert.ok(over.row.usage_id);
  const holds = await row('SELECT hon.ai_org_committed_credits($1,clock_timestamp())::int c', [A.id]);
  const ledgerCredits = await row("SELECT coalesce(sum(customer_credits),0)::int c FROM hon.ai_usage_ledger WHERE organization_id=$1 AND spend_class='AGENT_INFERENCE'", [A.id]);
  assert.equal(holds.c, ledgerCredits.c + 2, 'the two open holds count against the budget');
  pass('provider outcomes: released, held for HQ, or recorded and marked; open holds count');

  // 7. HQ: the open clips are in the queue as AGENT_SPEECH, usage is attributed, and HQ resolves a clip as speech.
  const queue = (await runtime.query('SELECT hon.read_ai_unknown_invocations_from_hq($1) d', [HQ.subject])).rows[0].d;
  assert.ok([unk.row.id, noCost.row.id].every((id) => queue.open.some((o) => o.agent === 'AGENT_SPEECH' && o.invocationId === id)));
  const usage = (await runtime.query("SELECT hon.read_ai_school_usage_from_hq($1,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 hour') d", [HQ.subject])).rows[0].d;
  const school = usage.schools.find((s) => s.schoolId === A.school);
  assert.ok(school.byClass.AGENT_INFERENCE.byAgent.AGENT_SPEECH.entries >= 11, JSON.stringify(school.byClass.AGENT_INFERENCE.byAgent));
  assert.equal(school.unreconciledInvocations, 2);
  const resolve = (id, input) => runtime.query('SELECT hon.resolve_ai_unknown_invocation($1,$2,$3,$4::jsonb,$5,$6,$7) d', [HQ.subject, 'AGENT_SPEECH', id, JSON.stringify(input), K(), K(), K()]);
  await resolve(unk.row.id, { decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider log, no charge.', evidence: { providerLookupReference: 'lookup-1' } });
  await resolve(noCost.row.id, { decision: 'RECORD_PROVIDER_COST', reason: 'Cost read from the provider activity page.', evidence: { providerGenerationId: 'gen-tts-no-cost', inputTokens: 15, outputTokens: 0, providerCostMicrounits: 280 } });
  const resolved = await clip(A, noCost.key), rl = await row('SELECT * FROM hon.ai_usage_ledger WHERE id=$1', [resolved.usage_id]);
  assert.equal((await clip(A, unk.key)).reserved_credits, 0);
  assert.equal(rl.modality, 'VOICE_OUTPUT'); assert.equal(rl.model_code, 'google/gemini-3.8-flash-lite-tts'); assert.equal(Number(rl.provider_cost_microunits), 280);
  assert.match((await settle(resolve(first.row.id, { decision: 'NO_PROVIDER_CHARGE', reason: 'Checked the provider log, no charge.', evidence: { providerLookupReference: 'lookup-2' } }))).error.message, /AI_UNKNOWN_NOT_RESOLVABLE/);
  pass('HQ: queue, usage under AGENT_SPEECH, resolution as speech; a finished clip is not resolvable');

  // 8. Limits: 30 new clips per person in 10 minutes, 200 a day; replays never count; a refused clip does not count to the day.
  const burster = await addStaff(A, 'burst', ['ai.invocation.plan', 'ai.agent.hon.use']);
  for (let i = 0; i < 30; i += 1) assert.ok((await say(burster, 'hon', `Answer ${i}.`)).value, `clip ${i}`);
  const busy = await say(burster, 'hon', 'One too many.');
  assert.equal(code(busy), 'AGENT_SPEECH_BUSY'); assert.equal(status(busy), 429); assert.equal(busy.row, undefined);
  const daily = await addStaff(A, 'daily', ['ai.invocation.plan', 'ai.agent.hon.use']);
  await admin.query('ALTER TABLE hon.agent_speech_clips DISABLE TRIGGER USER');
  await admin.query(`INSERT INTO hon.agent_speech_clips(organization_id,school_id,agent_key,requested_by,idempotency_key,text_digest,characters,status,created_at)
    SELECT $1,$2,'hon',$3,'old-'||g,repeat('a',64),5,'COMPLETED',greatest(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', clock_timestamp()-interval '9 hours')+interval '1 second'
      FROM generate_series(1,199) g WHERE clock_timestamp() - (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') > interval '11 minutes'`, [A.id, A.school, daily.principal]);
  await admin.query('ALTER TABLE hon.agent_speech_clips ENABLE TRIGGER USER');
  const seeded = Number((await row('SELECT count(*) n FROM hon.agent_speech_clips WHERE requested_by=$1', [daily.principal])).n);
  if (seeded === 199) {
    assert.ok((await say(daily, 'hon', 'Clip two hundred.')).value);
    assert.equal(code(await say(daily, 'hon', 'Clip two hundred and one.')), 'AGENT_SPEECH_DAILY_LIMIT');
  } else console.log('AS1 note: within 11 minutes of UTC midnight, the daily-limit sub-check is skipped');
  pass('limits: 30 per person per 10 minutes, 200 per person per UTC day');

  // 9. Database posture: no table access for the runtime, closed inputs, no cross-school clip.
  for (const sql of ['SELECT 1 FROM hon.agent_speech_clips', "UPDATE hon.agent_speech_clips SET status='COMPLETED'", 'DELETE FROM hon.agent_speech_clips']) {
    assert.match((await settle(runtime.query(sql))).error.message, /permission denied/);
  }
  for (const f of ['hon.agent_speech_limits()', "hon.agent_speech_actor('x','hon')"]) {
    assert.match((await settle(runtime.query(`SELECT ${f}`))).error.message, /permission denied/);
  }
  const asRuntime = async (p, work) => {
    await runtime.query('BEGIN');
    try {
      await runtime.query(`SELECT set_config('app.hon_organization_id',$1,true),set_config('app.hon_school_id',$2,true),set_config('app.hon_principal_id',$3,true),
        set_config('app.hon_principal_type','HUMAN_USER',true),set_config('app.hon_request_id',$4,true),set_config('app.hon_source','HUMAN_UI',true),
        set_config('app.hon_external_subject',$5,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)`, [p.id, p.school, p.principal, K(), p.subject]);
      return await work();
    } finally { await runtime.query('ROLLBACK'); }
  };
  const bClip = await say(B, 'hon', 'School B clip.');
  assert.match((await asRuntime(A, () => settle(runtime.query('SELECT hon.prepare_agent_speech($1,$2,true)', [A.subject, bClip.row.id])))).error.message, /AGENT_SPEECH_NOT_FOUND/);
  assert.match((await asRuntime(A, () => settle(runtime.query('SELECT hon.begin_agent_speech($1,$2,$3,$4,$5)', [A.subject, 'eian', K(), 'a'.repeat(64), 5])))).error.message, /VALIDATION_FAILED/);
  assert.match((await asRuntime(A, () => settle(runtime.query('SELECT hon.begin_agent_speech($1,$2,$3,$4,$5)', [A.subject, 'hon', K(), 'a'.repeat(64), 1001])))).error.message, /VALIDATION_FAILED/);
  assert.match((await asRuntime(A, () => settle(runtime.query('SELECT hon.record_agent_speech_result($1,$2,$3::jsonb)', [A.subject, first.row.id, '{"characters":5,"providerCostMicrounits":1}'])))).error.message, /AGENT_SPEECH_OUTCOME_REPLAY/);
  assert.match((await asRuntime(A, () => settle(runtime.query('SELECT hon.fail_agent_speech($1,$2,$3,$4)', [A.subject, first.row.id, 'LOST', 'PROVIDER_UNKNOWN'])))).error.message, /INVALID_AGENT_SPEECH_OUTCOME/);
  pass('posture: no table access, closed inputs, no cross-school clip, no second result');

  // 10. The provider runtime: off unless all three switches; PCM is wrapped as WAV; one attempt, voice only (no instructions).
  const env = { OPENROUTER_API_KEY: 'test-key', OPENROUTER_PAID_CALL_APPROVED: 'true', HON_AGENT_NATURAL_VOICE_APPROVED: 'true' };
  assert.equal(new OpenRouterAgentSpeechRuntime(() => ({ ...env, HON_AGENT_NATURAL_VOICE_APPROVED: 'yes' })).readiness(), 'CONFIGURATION_REQUIRED');
  assert.equal(new OpenRouterAgentSpeechRuntime(() => ({ ...env, OPENROUTER_PAID_CALL_APPROVED: undefined })).readiness(), 'CONFIGURATION_REQUIRED');
  const sent = [];
  const transport = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), redirect: init.redirect });
    return new Response(Buffer.alloc(9600), { status: 200, headers: { 'content-type': 'audio/pcm;rate=24000;channels=1', 'x-generation-id': 'gen-tts-1' } }); };
  const live = new OpenRouterAgentSpeechRuntime(() => env, transport);
  const made = await live.synthesize({ providerId: 'OPENROUTER', modelId: 'google/gemini-3.8-flash-lite-tts', voice: 'Kore', providerRequestId: K(), text: 'Hi there.', maxCostMicrounits: 20000 });
  assert.equal(made.audio.length, 9644); assert.equal(made.audio.subarray(0, 4).toString('latin1'), 'RIFF'); assert.equal(made.audio.readUInt32LE(24), 24000);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['input', 'model', 'provider', 'response_format', 'voice']);
  assert.equal(sent[0].body.input, 'Hi there.'); assert.equal(sent[0].body.voice, 'Kore'); assert.equal(sent[0].body.response_format, 'pcm'); assert.equal(sent[0].redirect, 'error');
  const mp3 = new OpenRouterAgentSpeechRuntime(() => env, async () => new Response(Buffer.alloc(9600), { status: 200, headers: { 'content-type': 'audio/mpeg', 'x-generation-id': 'gen-tts-2' } }));
  assert.equal((await settle(mp3.synthesize({ providerId: 'OPENROUTER', modelId: 'google/gemini-3.8-flash-lite-tts', voice: 'Kore', providerRequestId: K(), text: 'Hi.', maxCostMicrounits: 20000 }))).error.outcome, 'UNKNOWN');
  assert.equal((await settle(live.synthesize({ providerId: 'OPENROUTER', modelId: 'google/gemini-3.8-flash-lite-tts', voice: 'kore; drop', providerRequestId: K(), text: 'Hi.', maxCostMicrounits: 20000 }))).error.outcome, 'PRE_SEND');
  const costed = new OpenRouterAgentSpeechRuntime(() => env, async () => new Response(JSON.stringify({ data: { id: 'gen-tts-1', model: 'google/gemini-3.8-flash-lite-tts-20260922', api_type: 'tts', total_cost: 0.000231 } }), { status: 200 }));
  assert.equal(await costed.cost('gen-tts-1', 'google/gemini-3.8-flash-lite-tts'), 231);
  assert.equal(await costed.cost('gen-tts-1', 'fish-audio/drama-3'), null);
  pass('runtime: three switches, PCM to WAV, voice name only, unverified audio is UNKNOWN, cost read by generation');

  // 11. The 0652 exact 011 section and the whole canonical 011.
  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Staff agent speech exact verification (0652)')[1]?.split('-- End staff agent speech exact verification.')[0];
    assert.ok(section, '0652 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0652 exact verification and the whole canonical 011 pass');
  assert.equal(networkCalls, 0);
  console.log(`AS1 staff agent speech: ${groups} groups passed, ${fake.calls.length} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {}); await runtime.end().catch(() => {});
}
