/**
 * P7 (0647): a Chad follow-up draft with a send plan is queued for sending, exactly once, when a second person approves it (by
 * button or by voice). Runs the real API services against the restricted runtime role on a fresh disposable AI-0 fixture. The
 * provider is a counted in-process fake and fetch is refused: nothing leaves the machine. The delivery worker's claim function is
 * called directly to show that a queued draft still goes through its consent check (STOP after approval stops it). Synthetic data only.
 */
import assert from 'node:assert/strict';
import { randomUUID as K } from 'node:crypto';
import pg from 'pg';
import { AI0_DATABASE as database, AI0_OWNER_ROLE as ownerRole, AI0_RUNTIME_ROLE as runtimeRole, assertDisposableTarget, assertNoLibpqOverrides } from './ai-spend-baseline-target.mjs';

assertNoLibpqOverrides(process.env);
const ownerUrl = assertDisposableTarget(process.env.DATABASE_URL, ownerRole);
process.env.HON_RUNTIME_DATABASE_URL = assertDisposableTarget(process.env.HON_RUNTIME_DATABASE_URL, runtimeRole);
const forbidden = Object.keys(process.env).filter((k) => /^(?:OPENAI|ANTHROPIC|OPENROUTER|STRIPE|TWILIO|SENDGRID|SUPABASE|AWS|SHOPIFY|HON_(?:PROVIDER|AI|ACTION|EXTERNAL|PAYMENT|WORKER|SHOPIFY))(?:_|$)/i.test(k));
if (forbidden.length) throw new Error(`Refusing provider or execution variables (${forbidden.join(', ')}).`);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };

const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
const { AiInvocationPlanService } = await import('../../../apps/api/dist/ai/ai-invocation-plan.service.js');
const { ActionEngineService } = await import('../../../apps/api/dist/action/action-engine.service.js');
const { ChadFollowUpAssistantService } = await import('../../../apps/api/dist/chad-follow-up-assistant/chad-follow-up-assistant.service.js');

const admin = new pg.Client({ connectionString: ownerUrl, ssl: false });
const row = async (sql, args = []) => (await admin.query(sql, args)).rows[0];
const rows = async (sql, args = []) => (await admin.query(sql, args)).rows;
const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));
const status = (r) => r.error?.getStatus?.();
const code = (r) => r.error?.getResponse?.().code;
let groups = 0; const pass = (name) => console.log(`PASS CAS1 ${++groups} ${name}`);

const draft = { subject: 'A friendly check-in', content: 'CAS1_DRAFT_TEXT Hi, we would love to see you at a trial class this week. Reply any time.' };
let fakeCalls = 0;
const provider = { readiness: () => 'READY', generate: async () => { fakeCalls += 1; return { draft, inputTokens: 200, outputTokens: 100, providerCostMicrounits: 600 }; } };
const db = new RuntimeDatabaseService(), plans = new AiInvocationPlanService(db), actions = new ActionEngineService(db);
const chad = new ChadFollowUpAssistantService(db, plans, actions, provider);
const catalog = K();
const ctx = (o, patch = {}) => ({ organizationId: o.id, schoolId: o.school, principalId: o.principal, externalSubject: o.subject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: K(), correlationId: K(), idempotencyKey: K(), ...patch });
const binding = (r) => ({ actionRequestId: r.id, actionCode: r.actionCode, requestedByPrincipalId: r.requestedByPrincipalId, payloadHash: r.payloadHash, policyVersion: r.policyVersion, approvalExpiresAt: r.approvalExpiresAt, effectiveAuthorityMode: 'CONFIRM' });
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const CHAD = ['crm.lead.read', 'crm.assistant.follow_up_draft', 'ai.invocation.plan', 'ai.agent.chad.use'];

async function makeOrg(label) {
  const o = { label, id: K(), school: K(), policy: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.organizations(id,legal_name,display_name) VALUES($1,'CAS1 synthetic organization','CAS1 synthetic organization')", [o.id]);
  await admin.query("INSERT INTO hon.schools(id,organization_id,name,slug,timezone) VALUES($1::uuid,$2,'Synthetic Dojo',$1::uuid::text,'UTC')", [o.school, o.id]);
  await admin.query("INSERT INTO hon.organization_entitlements(organization_id,tier,status,effective_from) VALUES($1,'COMPLETE','ACTIVE',clock_timestamp()-interval '1 day')", [o.id]);
  await admin.query("INSERT INTO hon.hq_ai_routing_policies(policy_id,organization_id,school_id,capability,active,minimum_tier,max_cost_micros,effective_from) VALUES($1,$2,$3,'TEXT',true,'COMPLETE',100000,'2020-01-01')", [o.policy, o.id, o.school]);
  await admin.query('INSERT INTO hon.hq_ai_routing_candidates(policy_id,ordinal,catalog_id) VALUES($1,0,$2)', [o.policy, catalog]);
  await admin.query("INSERT INTO hon.action_policies(organization_id,school_id,action_code,authority_mode,policy_version,effective_from) VALUES($1,$2,'crm.follow_up_draft.propose','CONFIRM',1,clock_timestamp()-interval '1 day')", [o.id, o.school]);
  await admin.query('COMMIT');
  return o;
}
async function addStaff(o, label, permissions) {
  const st = { id: o.id, school: o.school, user: K(), principal: K(), role: K(), subject: `cas1-${label}-${K()}` };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.users(id,external_subject,email,display_name) VALUES($1::uuid,$2,$1::uuid::text||'@example.test','CAS1 synthetic staff')", [st.user, st.subject]);
  await admin.query("INSERT INTO hon.principals(id,principal_type,user_id,display_name) VALUES($1,'HUMAN_USER',$2,'CAS1 synthetic staff')", [st.principal, st.user]);
  await admin.query("INSERT INTO hon.roles(id,organization_id,code,name,is_system_role) VALUES($1,$2,$3,'CAS1 synthetic staff',false)", [st.role, o.id, 'CAS1_' + label.toUpperCase()]);
  await admin.query('INSERT INTO hon.role_permissions(role_id,organization_id,permission_code) SELECT $1,$2,code FROM hon.permissions WHERE code=ANY($3::text[])', [st.role, o.id, permissions]);
  await admin.query("INSERT INTO hon.principal_role_grants(organization_id,school_id,principal_id,role_id,granted_by_principal_id,effective_from) VALUES($1,$2,$3,$4,$3,clock_timestamp()-interval '1 day')", [o.id, o.school, st.principal, st.role]);
  await admin.query('COMMIT');
  return st;
}
async function addLead(o, { phone = null, email = 'lead@example.test' } = {}) {
  const l = { person: K(), lead: K(), pipeline: K(), stage: K() };
  await admin.query('BEGIN');
  await admin.query("INSERT INTO hon.people(id,organization_id,school_id,given_name,family_name,email,phone_e164) VALUES($1,$2,$3,'Robin','Synthlead',$4,$5)", [l.person, o.id, o.school, email, phone]);
  await admin.query("INSERT INTO hon.crm_pipelines(id,organization_id,school_id,name) VALUES($1,$2,$3,'CAS1 pipeline')", [l.pipeline, o.id, o.school]);
  await admin.query("INSERT INTO hon.crm_pipeline_stages(id,organization_id,school_id,pipeline_id,name,position) VALUES($1,$2,$3,$4,'New',1)", [l.stage, o.id, o.school, l.pipeline]);
  await admin.query("INSERT INTO hon.crm_leads(id,organization_id,school_id,primary_person_id,pipeline_id,pipeline_stage_id,status,source_code) VALUES($1,$2,$3,$4,$5,$6,'OPEN','CAS1_SOURCE')", [l.lead, o.id, o.school, l.person, l.pipeline, l.stage]);
  await admin.query('COMMIT');
  return l;
}
async function consent(o, person, channel, value, by) {
  await admin.query(`INSERT INTO hon.communication_consents(organization_id,school_id,person_id,channel,status,source,captured_at,updated_by_principal_id) VALUES($1,$2,$3,$4,$5,'STAFF',now(),$6)
    ON CONFLICT (person_id,channel) DO UPDATE SET status=EXCLUDED.status,version=hon.communication_consents.version+1,updated_at=now()`, [o.id, o.school, person, channel, value, by]);
}
const newDraft = async (st, lead) => { const v = await chad.submit(ctx(st), { leadId: lead.lead, expectedLeadVersion: 1, purpose: 'CHECK_IN' }); assert.equal(v.status, 'AWAITING_APPROVAL', JSON.stringify(v)); return v; };
// The reviewer reads the send plan on the approvals route (as the approvals screen does) and the approval is bound to that version.
const seenPlan = async (st, actionRequestId) => (await actions.chadSendForReview(ctx(st), actionRequestId)).plan?.version ?? null;
const approve = async (st, d, patch = {}) => { const review = await actions.getForReview(ctx(st), d.actionRequestId);
  return actions.decide(ctx(st), { actionRequestId: review.id, decision: 'APPROVED', binding: binding(review), sendPlanVersion: await seenPlan(st, review.id), ...patch }); };
const sends = (id) => row('SELECT * FROM hon.ai_draft_sends WHERE source_id=$1', [id]);
const messagesFor = (id) => rows("SELECT * FROM hon.communication_messages WHERE origin_kind='AI_APPROVED_DRAFT' AND origin_id=$1", [id]);

try {
  await admin.connect();
  assert.equal((await row('SELECT current_database() d')).d, database);

  // 1. Custody.
  for (const t of ['ai_draft_send_plans', 'ai_draft_sends']) {
    const c = await row("SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE oid=('hon.'||$1)::regclass", [t]);
    assert.deepEqual([c.r, c.f], [true, true], t);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal((await row('SELECT has_table_privilege($1,$2,$3) ok', [runtimeRole, `hon.${t}`, priv])).ok, false, `${t} ${priv}`);
  }
  const expected = { 'hon.set_chad_draft_send_plan(text,uuid,jsonb,text)': true, 'hon.read_chad_draft_send(text,uuid)': true, 'hon.cancel_chad_draft_send(text,uuid)': true,
    'hon.transition_chad_follow_up_draft(uuid,text)': true, 'hon.read_chad_draft_send_for_review(uuid)': true, 'hon.ai_draft_reachable(uuid,text)': false, 'hon.chad_draft_send_view(uuid)': false, 'hon.guard_ai_draft_send_rows()': false };
  for (const [f, ok] of Object.entries(expected)) {
    assert.equal((await row("SELECT has_function_privilege($1,$2::regprocedure,'EXECUTE') ok", [runtimeRole, f])).ok, ok, f);
    assert.equal((await row("SELECT coalesce(bool_or(a.grantee=0),false) pub FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid=$1::regprocedure", [f])).pub, false, f);
  }
  assert.match((await row("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='communication_messages_origin_kind_check'")).d, /AI_APPROVED_DRAFT/);
  pass('custody: two forced-RLS tables with no runtime access; runtime executes only plan/read/cancel and the approval transition; messages accept origin AI_APPROVED_DRAFT');

  await admin.query("INSERT INTO hon.hq_ai_provider_connections(provider_id,display_name,state,credential_secret_ref) VALUES('OPENROUTER','CAS1 synthetic route','HEALTHY',$1) ON CONFLICT (provider_id) DO NOTHING", [`hon-secret:${K()}`]);
  await admin.query("INSERT INTO hon.hq_ai_model_catalog(catalog_id,provider_id,model_id,display_name,capabilities,modalities,active,minimum_tier,unit_cost_micros,cost_unit,effective_from) VALUES($1,'OPENROUTER','approved/cas1-synthetic','CAS1 synthetic model',ARRAY['TEXT'],ARRAY['TEXT'],true,'COMPLETE',2,'TOKEN','2020-01-01')", [catalog]);
  const a = await makeOrg('a');
  const requester = await addStaff(a, 'requester', CHAD);
  const reviewer = await addStaff(a, 'reviewer', [...CHAD, 'action.approve']);
  const bystander = await addStaff(a, 'bystander', CHAD);
  const lead = await addLead(a);
  await consent(a, lead.person, 'EMAIL', 'OPTED_IN', reviewer.principal);
  const sentBefore = Number((await row('SELECT count(*) n FROM hon.communication_messages')).n);

  // 2. No plan: approving behaves exactly as before 0647 (no message, no send row).
  const plain = await newDraft(requester, lead);
  assert.equal((await approve(reviewer, plain)).executionTriggered, false);
  assert.equal((await chad.read(ctx(requester), plain.id)).status, 'APPROVED');
  assert.equal(await sends(plain.id), undefined); assert.deepEqual(await messagesFor(plain.id), []);
  pass('no plan: approval records the decision only; nothing is queued');

  // 3. Plan rules.
  const d1 = await newDraft(requester, lead);
  const sms = await settle(chad.setSendPlan(ctx(requester), d1.id, { channel: 'SMS', sendAt: null }));
  assert.equal(code(sms), 'CHAD_SEND_PLAN_NO_CONSENT', JSON.stringify(sms.error?.getResponse?.()));
  await consent(a, lead.person, 'SMS', 'OPTED_IN', reviewer.principal);
  assert.equal(code(await settle(chad.setSendPlan(ctx(requester), d1.id, { channel: 'SMS', sendAt: null }))), 'CHAD_SEND_PLAN_NO_ADDRESS');
  for (const bad of [{ channel: 'EMAIL', sendAt: iso(Date.now() + 31 * 864e5) }, { channel: 'FAX', sendAt: null }, { channel: 'EMAIL' }, { channel: 'NONE', sendAt: iso(Date.now() + 864e5) }, { channel: 'EMAIL', sendAt: '2026-01-01' }]) {
    assert.equal(status(await settle(chad.setSendPlan(ctx(requester), d1.id, bad))), 400, JSON.stringify(bad));
  }
  assert.equal(code(await settle(chad.setSendPlan(ctx(requester, { idempotencyKey: '' }), d1.id, { channel: 'EMAIL', sendAt: null }))), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(status(await settle(chad.setSendPlan(ctx(bystander), d1.id, { channel: 'EMAIL', sendAt: null }))), 404, 'only the requester sets the plan');
  assert.equal(status(await settle(chad.setSendPlan(ctx(reviewer), d1.id, { channel: 'EMAIL', sendAt: null }))), 404, 'the reviewer does not set the plan');
  const later = iso(Date.now() + 2 * 864e5), key = K();
  const p1 = await chad.setSendPlan(ctx(requester, { idempotencyKey: key }), d1.id, { channel: 'EMAIL', sendAt: later });
  assert.deepEqual([p1.plan, p1.send, p1.replayed], [{ version: 1, channel: 'EMAIL', sendAt: later }, null, false]);
  assert.equal((await chad.setSendPlan(ctx(requester, { idempotencyKey: key }), d1.id, { channel: 'EMAIL', sendAt: later })).replayed, true);
  assert.equal(code(await settle(chad.setSendPlan(ctx(requester, { idempotencyKey: key }), d1.id, { channel: 'EMAIL', sendAt: null }))), 'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual((await chad.readSend(ctx(reviewer), d1.id)).plan, p1.plan, 'a qualified reviewer sees the plan before approving');
  assert.equal(status(await settle(chad.readSend(ctx(bystander), d1.id))), 404, 'other staff do not');
  pass('plan: requester only, while awaiting approval; consent and address checked; 30-day limit; closed shape; idempotent; reviewer sees it before deciding');

  // 4. Button approval queues exactly one scheduled message, created by the reviewer, with who/when/how recorded.
  await approve(reviewer, d1);
  const s1 = await sends(d1.id), [m1] = await messagesFor(d1.id);
  assert.deepEqual([s1.outcome, s1.channel, s1.approved_by, s1.approval_method, s1.voice_turn_id, s1.plan_version], ['QUEUED', 'EMAIL', reviewer.principal, 'BUTTON', null, 1]);
  assert.equal(s1.message_id, m1.id);
  assert.deepEqual([m1.lifecycle, m1.channel, m1.recipient_person_id, m1.content, m1.email_subject, m1.created_by_principal_id, m1.queued_by_principal_id],
    ['QUEUED', 'EMAIL', lead.person, draft.content, draft.subject, reviewer.principal, reviewer.principal]);
  assert.equal(m1.scheduled_at.toISOString(), later);
  assert.equal(code(await settle(chad.setSendPlan(ctx(requester), d1.id, { channel: 'NONE', sendAt: null }))), 'CHAD_SEND_PLAN_CLOSED');
  const viewAfter = await chad.readSend(ctx(reviewer), d1.id);
  assert.deepEqual([viewAfter.send.outcome, viewAfter.send.approvalMethod, viewAfter.send.approvedBy, viewAfter.send.delivery], ['QUEUED', 'BUTTON', reviewer.principal, null]);
  pass('button: one QUEUED email at the planned time, created by the reviewer; approved by/at/how recorded; plan closed after review');

  // 5. Voice approval, sent now; voice validation.
  const d2 = await newDraft(requester, lead);
  await chad.setSendPlan(ctx(requester), d2.id, { channel: 'EMAIL', sendAt: null });
  const reviewD2 = await actions.getForReview(ctx(reviewer), d2.actionRequestId);
  for (const bad of [{ approvalMethod: 'VOICE' }, { approvalMethod: 'VOICE', voiceTurnId: 'not-a-uuid' }, { approvalMethod: 'BUTTON', voiceTurnId: K() }, { approvalMethod: 'PHONE' }]) {
    assert.equal(status(await settle(actions.decide(ctx(reviewer), { actionRequestId: reviewD2.id, decision: 'APPROVED', binding: binding(reviewD2), ...bad }))), 400, JSON.stringify(bad));
  }
  assert.equal(status(await settle(actions.decide(ctx(reviewer), { actionRequestId: reviewD2.id, decision: 'DENIED', binding: binding(reviewD2), approvalMethod: 'VOICE', voiceTurnId: K() }))), 400);
  const turn = K();
  await actions.decide(ctx(reviewer), { actionRequestId: reviewD2.id, decision: 'APPROVED', binding: binding(reviewD2), approvalMethod: 'VOICE', voiceTurnId: turn, sendPlanVersion: await seenPlan(reviewer, reviewD2.id) });
  const s2 = await sends(d2.id), [m2] = await messagesFor(d2.id);
  assert.deepEqual([s2.outcome, s2.approval_method, s2.voice_turn_id], ['QUEUED', 'VOICE', turn]);
  assert.ok(Math.abs(m2.scheduled_at.getTime() - Date.now()) < 60000, 'a plan with no time sends as soon as approved');
  pass('voice: VOICE needs a voice turn id and an approval; the turn id is recorded with the send');

  // 6. Self-approval refused; denial and a NONE plan queue nothing.
  const d3 = await newDraft(requester, lead);
  await chad.setSendPlan(ctx(requester), d3.id, { channel: 'EMAIL', sendAt: null });
  assert.equal(status(await settle(approve(requester, d3))), 403, 'the requester never approves their own draft');
  const reviewD3 = await actions.getForReview(ctx(reviewer), d3.actionRequestId);
  await actions.decide(ctx(reviewer), { actionRequestId: reviewD3.id, decision: 'DENIED', binding: binding(reviewD3) });
  assert.equal(await sends(d3.id), undefined); assert.deepEqual(await messagesFor(d3.id), []);
  const d4 = await newDraft(requester, lead);
  await chad.setSendPlan(ctx(requester), d4.id, { channel: 'EMAIL', sendAt: null });
  assert.equal((await chad.setSendPlan(ctx(requester), d4.id, { channel: 'NONE', sendAt: null })).plan.version, 2);
  await approve(reviewer, d4);
  assert.equal(await sends(d4.id), undefined); assert.deepEqual(await messagesFor(d4.id), []);
  pass('no send: the requester cannot approve their own draft; a denial or a plan cleared to NONE queues nothing');

  // 7. Daily cap: at most 3 approved-draft messages per contact per 24 hours (a cancelled one still counts).
  const d5 = await newDraft(requester, lead); await chad.setSendPlan(ctx(requester), d5.id, { channel: 'EMAIL', sendAt: null }); await approve(reviewer, d5);
  const d6 = await newDraft(requester, lead); await chad.setSendPlan(ctx(requester), d6.id, { channel: 'EMAIL', sendAt: null }); await approve(reviewer, d6);
  assert.equal((await sends(d5.id)).outcome, 'QUEUED');
  assert.deepEqual([(await sends(d6.id)).outcome, (await messagesFor(d6.id)).length], ['DAILY_CAP', 0]);
  assert.equal((await chad.read(ctx(requester), d6.id)).status, 'APPROVED', 'the approval itself stands');
  pass('cap: the fourth approved draft to one contact in 24 hours is recorded as DAILY_CAP and nothing is queued');

  // 8. Cancel before the worker claims it; the worker sends nothing early; STOP after approval still stops it.
  assert.equal(status(await settle(chad.cancelSend(ctx(bystander), d1.id))), 404);
  const c1 = await chad.cancelSend(ctx(requester), d1.id);
  assert.deepEqual([c1.send.cancelled, c1.replayed], [true, false]);
  assert.equal((await chad.cancelSend(ctx(reviewer), d1.id)).replayed, true);
  assert.equal((await row('SELECT lifecycle FROM hon.communication_messages WHERE id=$1', [m1.id])).lifecycle, 'CANCELLED');
  assert.equal(code(await settle(chad.cancelSend(ctx(requester), d6.id))), 'CHAD_SEND_NOT_CANCELLABLE');
  await consent(a, lead.person, 'EMAIL', 'OPTED_OUT', reviewer.principal);
  await admin.query("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'],100,60)");
  const deliveries = await rows('SELECT message_id, status::text, failure_code FROM hon.communication_deliveries WHERE message_id=ANY($1::uuid[]) ORDER BY message_id', [[m1.id, m2.id, (await sends(d5.id)).message_id]]);
  assert.deepEqual(deliveries.map((d) => [d.status, d.failure_code]), [['SUPPRESSED', 'CONSENT_MISSING'], ['SUPPRESSED', 'CONSENT_MISSING']]);
  assert.equal(deliveries.some((d) => d.message_id === m1.id), false, 'a cancelled message is never claimed');
  assert.equal(code(await settle(chad.cancelSend(ctx(requester), d2.id))), 'CHAD_SEND_NOT_CANCELLABLE', 'once the worker has it, cancel is refused');
  assert.equal((await chad.readSend(ctx(requester), d2.id)).send.delivery, 'SUPPRESSED');
  pass('cancel and worker: cancel before the worker claims it; the worker still checks consent at send time, so STOP after approval stops the message');

  // 9. Consent withdrawn between plan and approval: recorded, nothing queued.
  const lead2 = await addLead(a, { email: 'second@example.test' });
  await consent(a, lead2.person, 'EMAIL', 'OPTED_IN', reviewer.principal);
  const d7 = await newDraft(requester, lead2); await chad.setSendPlan(ctx(requester), d7.id, { channel: 'EMAIL', sendAt: null });
  await consent(a, lead2.person, 'EMAIL', 'OPTED_OUT', reviewer.principal);
  await approve(reviewer, d7);
  assert.deepEqual([(await sends(d7.id)).outcome, (await messagesFor(d7.id)).length], ['NO_CONSENT', 0]);
  pass('re-check: consent is checked again at approval; a contact who opted out after planning gets nothing');

  // 10. Isolation, immutability, audit.
  const b = await makeOrg('b'); const foreign = await addStaff(b, 'foreign', [...CHAD, 'action.approve']);
  // Each call starts only when awaited, so an early rejection is never left unhandled while an earlier one is pending.
  for (const op of [() => chad.readSend(ctx(foreign), d2.id), () => chad.cancelSend(ctx(foreign), d5.id), () => chad.setSendPlan(ctx(foreign), d7.id, { channel: 'EMAIL', sendAt: null })]) assert.equal(status(await settle(op())), 404);
  await assert.rejects(admin.query('UPDATE hon.ai_draft_send_plans SET channel=channel WHERE source_id=$1', [d1.id]), /AI_DRAFT_SEND_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query("UPDATE hon.ai_draft_sends SET approval_method='VOICE', voice_turn_id=$2 WHERE source_id=$1", [d1.id, K()]), /AI_DRAFT_SEND_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('UPDATE hon.ai_draft_sends SET cancelled_at=now() WHERE source_id=$1', [d1.id]), /AI_DRAFT_SEND_ROWS_IMMUTABLE/);
  await assert.rejects(admin.query('DELETE FROM hon.ai_draft_sends WHERE source_id=$1', [d2.id]), /AI_DRAFT_SEND_ROWS_IMMUTABLE/);
  const audit = await rows("SELECT action_code, actor_principal_id, next_state FROM hon.audit_events WHERE entity_type='CHAD_FOLLOW_UP' AND organization_id=$1 ORDER BY occurred_at", [a.id]);
  const queued = audit.filter((x) => x.action_code === 'chad.follow_up_draft.send_queued');
  assert.equal(queued.length, 5); assert.ok(queued.every((x) => x.actor_principal_id === reviewer.principal));
  assert.deepEqual(queued.map((x) => x.next_state.approvalMethod).sort(), ['BUTTON', 'BUTTON', 'BUTTON', 'BUTTON', 'VOICE']);
  assert.equal(audit.filter((x) => x.action_code === 'chad.follow_up_draft.send_plan_set').length, 8);
  assert.equal(audit.filter((x) => x.action_code === 'chad.follow_up_draft.send_cancelled').length, 1);
  assert.equal(JSON.stringify(audit).includes('CAS1_DRAFT_TEXT'), false, 'audit never holds the message text');
  assert.equal(Number((await row('SELECT count(*) n FROM hon.communication_messages')).n) - sentBefore, 3, 'exactly three messages were ever queued (the cap and the opt-out queued nothing)');
  pass('isolation, evidence: another school sees nothing; plans never change and a send row changes only by one cancel; audit names the reviewer and method, never the text');

  // 11. The approval is bound to the send plan the reviewer saw; a reviewer with only action.approve can read it.
  const lead3 = await addLead(a, { email: 'third@example.test' });
  await consent(a, lead3.person, 'EMAIL', 'OPTED_IN', reviewer.principal);
  const approverOnly = await addStaff(a, 'approver', ['action.approve']);
  const d8 = await newDraft(requester, lead3);
  const r8 = await actions.getForReview(ctx(approverOnly), d8.actionRequestId);
  assert.equal(await seenPlan(approverOnly, r8.id), null, 'no plan yet');
  await chad.setSendPlan(ctx(requester), d8.id, { channel: 'EMAIL', sendAt: null });
  const stale = await settle(actions.decide(ctx(approverOnly), { actionRequestId: r8.id, decision: 'APPROVED', binding: binding(r8), sendPlanVersion: null }));
  assert.equal(stale.error?.getResponse?.().code, 'CHAD_SEND_PLAN_CHANGED', 'a plan added after the reviewer looked refuses the approval');
  const blind = await settle(actions.decide(ctx(approverOnly), { actionRequestId: r8.id, decision: 'APPROVED', binding: binding(r8) }));
  assert.equal(blind.error?.getResponse?.().code, 'CHAD_SEND_PLAN_CHANGED', 'a decision that did not say which plan it saw never queues a message');
  assert.equal(status(await settle(chad.readSend(ctx(approverOnly), d8.id))), 403, 'the Chad route still needs Chad access');
  assert.equal((await row('SELECT status FROM hon.chad_follow_up_invocations WHERE id=$1', [d8.id])).status, 'AWAITING_APPROVAL');
  assert.equal((await messagesFor(d8.id)).length, 0);
  await chad.setSendPlan(ctx(requester), d8.id, { channel: 'EMAIL', sendAt: null });
  assert.equal(status(await settle(actions.decide(ctx(approverOnly), { actionRequestId: r8.id, decision: 'APPROVED', binding: binding(r8), sendPlanVersion: 1 }))), 409, 'version 1 was replaced by version 2');
  await approve(approverOnly, d8);
  assert.deepEqual([(await sends(d8.id)).outcome, (await sends(d8.id)).plan_version, (await messagesFor(d8.id)).length], ['QUEUED', 2, 1]);
  assert.equal(status(await settle(actions.chadSendForReview(ctx(requester), d8.actionRequestId))), 403, 'the review read needs action.approve');
  pass('binding: an approval names the plan version it saw; a plan added or changed after review, or no version with a plan, refuses the decision and sends nothing; a reviewer with only action.approve reads the plan on the approvals route');

  { const verify = await (await import('node:fs/promises')).readFile(new URL('../../../infra/postgres/011_verify_supabase_hon_runtime.sql', import.meta.url), 'utf8');
    const section = verify.split('-- Chad approved-draft send exact verification (0647)')[1]?.split('-- End Chad approved-draft send exact verification.')[0];
    assert.ok(section, '0647 verify section present');
    await admin.query(section.slice(section.indexOf('\nDO $$')).replaceAll('hon_runtime', runtimeRole));
    await admin.query(verify.replaceAll('hon_runtime', runtimeRole)); }
  pass('011: the 0647 exact verification and the whole canonical 011 pass');
  assert.equal(networkCalls, 0);
  console.log(`CAS1 Chad approved-draft send: ${groups} groups passed, ${fakeCalls} fake provider calls, 0 network calls`);
} finally {
  await admin.end().catch(() => {});
  await db.onModuleDestroy?.().catch?.(() => {});
}
