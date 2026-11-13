// 0243 communication delivery and provider receipts: worker claim/lease/record, quiet hours, consent and
// address re-checks at send time, retry backoff and exhaustion, lease expiry and late results as UNKNOWN,
// idempotent forward-only receipts, recipient opt-out, forced RLS reads and exact role boundaries; 0248 school
// senders and STOP/START/HELP; 0249 missed-call routing and one text-back per caller per day.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Client } = pg;
for (const key of ['DATABASE_URL', 'HON_RUNTIME_DATABASE_URL', 'HON_COMMUNICATION_WORKER_DATABASE_URL']) {
  if (!process.env[key]) throw new Error(`${key} is required for communication delivery integrity tests.`);
}
const local = (url) => {
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.port !== '5432') throw new Error('Disposable localhost:5432 target required.');
  return { connectionString: url, ssl: false };
};
const admin = new Client(local(process.env.DATABASE_URL));
const runtime = new Client(local(process.env.HON_RUNTIME_DATABASE_URL));
const worker = new Client(local(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL));
// Second sessions for the 0250 concurrency proofs.
const runtime2 = new Client(local(process.env.HON_RUNTIME_DATABASE_URL));
const worker2 = new Client(local(process.env.HON_COMMUNICATION_WORKER_DATABASE_URL));

let passed = 0;
function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed += 1;
}
async function expectError(code, work, message) {
  try { await work(); } catch (error) {
    if (error?.code === code) { passed += 1; return; }
    throw new Error(`FAIL: ${message} (got ${error?.code ?? error?.message})`);
  }
  throw new Error(`FAIL: ${message} (no error)`);
}

const hourIn = (zone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const zones = ['Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/Berlin', 'UTC', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Pago_Pago'];
const dayZone = zones.find((zone) => hourIn(zone) >= 10 && hourIn(zone) <= 18);
const nightZone = zones.find((zone) => hourIn(zone) >= 23 || hourIn(zone) <= 5);
if (!dayZone || !nightZone) throw new Error('No suitable day/night time zones for the quiet-hours proof.');

const ids = Object.fromEntries(['org', 'schoolA', 'schoolB', 'schoolC', 'user', 'principal', 'hqUser', 'hqPrincipal', 'role', 'readerUser', 'readerPrincipal'].map((key) => [key, randomUUID()]));
const person = {};
const message = {};

async function addPerson(key, school, email, phone) {
  person[key] = randomUUID();
  await admin.query('INSERT INTO hon.people (id, organization_id, school_id, given_name, family_name, email, phone_e164) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [person[key], ids.org, school, 'Test', key, email, phone]);
}
async function consent(key, school, channel, status) {
  await admin.query(`INSERT INTO hon.communication_consents (organization_id, school_id, person_id, channel, status, source, captured_at, updated_by_principal_id)
    VALUES ($1,$2,$3,$4,$5,'STAFF',now(),$6) ON CONFLICT (person_id, channel) DO UPDATE SET status = EXCLUDED.status, source = 'STAFF'`,
    [ids.org, school, person[key], channel, status, ids.principal]);
}
async function queued(key, school, personKey, channel, content, scheduledAt = null) {
  message[key] = randomUUID();
  await admin.query(`INSERT INTO hon.communication_messages (id, organization_id, school_id, recipient_person_id, channel, content, lifecycle, scheduled_at, created_by_principal_id, queued_by_principal_id, version)
    VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7,$8,$8,2)`, [message[key], ids.org, school, person[personKey], channel, content, scheduledAt, ids.principal]);
}
const delivery = async (key) => (await admin.query('SELECT * FROM hon.communication_deliveries WHERE message_id = $1', [message[key]])).rows[0];
const claim = async (channels = ['EMAIL', 'SMS'], limit = 100, lease = 60) =>
  (await worker.query('SELECT * FROM hon.claim_communication_deliveries($1::text[], $2, $3)', [channels, limit, lease])).rows
    .filter((row) => row.organization_id === ids.org);
const record = async (row, outcome, extra = {}) => (await worker.query(
  'SELECT * FROM hon.record_communication_send_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
  [row.delivery_id, row.lease_token, outcome, extra.provider ?? 'FAKE', extra.providerMessageId ?? null, extra.sentAs ?? null,
    extra.segments ?? null, extra.encoding ?? null, extra.failureCode ?? null, extra.retryAfter ?? null])).rows[0];
const receipt = async (eventId, providerMessageId, type, extra = {}) => (await worker.query(
  'SELECT * FROM hon.record_communication_provider_event($1,$2,$3,$4,$5,$6,$7)',
  [extra.provider ?? 'FAKE', eventId, providerMessageId, extra.honDeliveryId ?? null, type, extra.occurredAt ?? new Date().toISOString(), extra.cost ?? null])).rows[0];

async function cleanup() {
  await admin.query('BEGIN');
  try {
    await admin.query('DELETE FROM hon.communication_delivery_events WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.communication_deliveries WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.outbox_events WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.audit_events WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.communication_messages WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.inbound_text_keywords WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.missed_calls WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.zernio_lead_receipts WHERE organization_id = $1', [ids.org]);
    await admin.query('ALTER TABLE hon.crm_lead_attributions DISABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.crm_lead_attributions WHERE organization_id = $1', [ids.org]);
    await admin.query('ALTER TABLE hon.crm_lead_attributions ENABLE TRIGGER USER');
    await admin.query('DELETE FROM hon.crm_leads WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.zernio_lead_forms WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.crm_pipeline_stages WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.crm_pipelines WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.organization_entitlements WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.school_text_senders WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.hq_operator_grants WHERE principal_id = $1', [ids.hqPrincipal]);
    await admin.query('DELETE FROM hon.communication_consents WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.people WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.principal_role_grants WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.role_permissions WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.roles WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.principals WHERE id = ANY($1::uuid[])', [[ids.principal, ids.hqPrincipal, ids.readerPrincipal]]);
    await admin.query('DELETE FROM hon.users WHERE id = ANY($1::uuid[])', [[ids.user, ids.hqUser, ids.readerUser]]);
    await admin.query('DELETE FROM hon.schools WHERE organization_id = $1', [ids.org]);
    await admin.query('DELETE FROM hon.organizations WHERE id = $1', [ids.org]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

await Promise.all([admin.connect(), runtime.connect(), worker.connect(), runtime2.connect(), worker2.connect()]);
try {
  await admin.query("INSERT INTO hon.organizations (id, legal_name, display_name) VALUES ($1, 'Delivery Org', 'Delivery Org')", [ids.org]);
  await admin.query('INSERT INTO hon.schools (id, organization_id, name, slug, timezone) VALUES ($1,$2,$3,$4,$5), ($6,$2,$7,$8,$9)',
    [ids.schoolA, ids.org, 'Day School', `day-${ids.schoolA.slice(0, 8)}`, dayZone, ids.schoolB, 'Night School', `night-${ids.schoolB.slice(0, 8)}`, nightZone]);
  await admin.query("INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, 'staff@example.test', 'Staff')", [ids.user, `delivery-${ids.user}`]);
  await admin.query("INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, 'Staff')", [ids.principal, ids.user]);
  await addPerson('ada', ids.schoolA, 'ada@example.test', '+15555550101');
  await addPerson('noEmail', ids.schoolA, null, '+15555550102');
  await addPerson('revoked', ids.schoolA, 'revoked@example.test', '+15555550103');
  await addPerson('night', ids.schoolB, 'night@example.test', '+15555550104');
  for (const key of ['ada', 'noEmail', 'revoked']) { await consent(key, ids.schoolA, 'EMAIL', 'OPTED_IN'); await consent(key, ids.schoolA, 'SMS', 'OPTED_IN'); }
  await consent('night', ids.schoolB, 'SMS', 'OPTED_IN');
  await consent('night', ids.schoolB, 'EMAIL', 'OPTED_IN');
  // 0248: each school texts from its own ACTIVE sender.
  const sid = (n) => `MG${String(n).repeat(32).slice(0, 32)}`;
  await admin.query(`INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, mms_converter_confirmed, set_by_principal_id)
    VALUES ($1,$2,'+15555559001',$3,'ACTIVE',true,$5), ($1,$4,'+15555559002',$6,'ACTIVE',true,$5)`, [ids.org, ids.schoolA, sid(1), ids.schoolB, ids.principal, sid(2)]);

  // 1. Role boundaries.
  await expectError('42501', () => runtime.query("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'], 1, 60)"), 'runtime cannot claim deliveries');
  await expectError('42501', () => runtime.query("SELECT * FROM hon.record_communication_provider_event('FAKE','e','m',NULL,'DELIVERED',now(),NULL)"), 'runtime cannot record provider events');
  await expectError('42501', () => runtime.query('INSERT INTO hon.communication_deliveries (organization_id, school_id, message_id, channel) VALUES ($1,$2,$3,$4)', [ids.org, ids.schoolA, randomUUID(), 'EMAIL']), 'runtime cannot write deliveries');
  await expectError('42501', () => worker.query('SELECT 1 FROM hon.communication_deliveries LIMIT 1'), 'worker cannot read the delivery table');
  await expectError('42501', () => worker.query('SELECT 1 FROM hon.people LIMIT 1'), 'worker cannot read people');
  await expectError('42501', () => worker.query("SELECT hon.communication_record_recipient_opt_out($1,$2,$3,'EMAIL',now())", [ids.org, ids.schoolA, randomUUID()]), 'worker cannot call the opt-out helper directly');
  const workerRole = (await worker.query('SELECT rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = current_user')).rows[0];
  check(!workerRole.rolsuper && !workerRole.rolbypassrls && !workerRole.rolinherit, 'worker is not superuser, has no BYPASSRLS and does not inherit');
  await expectError('22023', () => worker.query("SELECT * FROM hon.claim_communication_deliveries(ARRAY['PUSH'], 1, 60)"), 'PUSH cannot be claimed');
  await expectError('22023', () => worker.query("SELECT * FROM hon.claim_communication_deliveries(ARRAY['EMAIL'], 101, 60)"), 'claim limit is bounded');

  // 2. Claim: one lease per due message, address and body only for the leased send; future schedule waits.
  await queued('email1', ids.schoolA, 'ada', 'EMAIL', 'Welcome to class');
  await queued('future', ids.schoolA, 'ada', 'EMAIL', 'Later', new Date(Date.now() + 3600_000).toISOString());
  await queued('noAddress', ids.schoolA, 'noEmail', 'EMAIL', 'Hello');
  await queued('revoked', ids.schoolA, 'revoked', 'EMAIL', 'Hello');
  await consent('revoked', ids.schoolA, 'EMAIL', 'OPTED_OUT'); // consent withdrawn after queueing
  await queued('smsDay', ids.schoolA, 'ada', 'SMS', 'Class at 5pm');
  await queued('smsNight', ids.schoolB, 'night', 'SMS', 'Class tomorrow');
  const emailOnly = await claim(['EMAIL']);
  check(emailOnly.length === 1 && emailOnly[0].message_id === message.email1, 'only the due, consented, addressed email is leased');
  check(emailOnly[0].recipient_address === 'ada@example.test' && emailOnly[0].content === 'Welcome to class' && emailOnly[0].school_name === 'Day School' && emailOnly[0].attempt === 1, 'leased row carries address, body, school name and attempt');
  check(!(await delivery('future')), 'a future scheduled message gets no delivery yet');
  check((await delivery('noAddress')).status === 'SUPPRESSED' && (await delivery('noAddress')).failure_code === 'ADDRESS_MISSING', 'missing address is SUPPRESSED/ADDRESS_MISSING');
  check((await delivery('revoked')).status === 'SUPPRESSED' && (await delivery('revoked')).failure_code === 'CONSENT_MISSING', 'consent withdrawn after queueing is SUPPRESSED/CONSENT_MISSING');
  check(!(await delivery('smsDay')), 'an SMS is not claimed when only EMAIL is ready');
  check((await claim(['EMAIL'])).length === 0, 'a leased delivery is not claimed twice');

  // 3. Quiet hours: the night school's text waits for 08:00 local; the day school's text is leased.
  const sms = await claim(['SMS']);
  check(sms.length === 1 && sms[0].message_id === message.smsDay && sms[0].recipient_address === '+15555550101', 'day-time text is leased to the phone number');
  check(sms[0].sender_address === '+15555559001' && sms[0].sender_service_id === sid(1), 'the leased text carries the school ACTIVE sender (0248)');
  const night = await delivery('smsNight');
  check(night.status === 'PENDING' && night.hold_reason === 'QUIET_HOURS' && new Date(night.next_attempt_at) > new Date(), 'night-time text is held for quiet hours');
  const localWake = new Intl.DateTimeFormat('en-US', { timeZone: nightZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date(night.next_attempt_at));
  check(localWake === '08:00', `quiet-hours hold ends at 08:00 school time (got ${localWake})`);
  const nightVersion = night.version;
  const heldEvidence = async () => (await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE entity_id = $1 AND action_code = 'communication.delivery.held'", [night.id])).rows[0].n;
  check(await heldEvidence() === 1, 'the quiet-hours hold is evidenced once');
  await admin.query('UPDATE hon.communication_deliveries SET next_attempt_at = now() WHERE id = $1', [night.id]);
  await claim(['SMS']);
  check((await delivery('smsNight')).version === nightVersion && await heldEvidence() === 1, 'a repeated quiet-hours check neither churns versions nor repeats evidence');
  check(new Date((await delivery('smsNight')).next_attempt_at).getTime() === new Date(night.next_attempt_at).getTime(), 'a repeated check keeps the 08:00 wake time');

  // 4. Results: accepted, then stale lease and replays refused.
  const accepted = await record(emailOnly[0], 'ACCEPTED', { providerMessageId: 'fake-msg-1', sentAs: 'EMAIL' });
  check(accepted.status === 'ACCEPTED' && accepted.accepted === true, 'accepted send is recorded');
  const again = await record(emailOnly[0], 'ACCEPTED', { providerMessageId: 'fake-msg-1', sentAs: 'EMAIL' });
  check(again.accepted === false && again.status === 'ACCEPTED', 'a second result on a used lease is not accepted');
  await expectError('22023', () => record(sms[0], 'ACCEPTED', {}), 'accepted needs a provider message id');
  await expectError('22023', () => record(sms[0], 'FAILED', { failureCode: 'BOUNCED' }), 'failed needs a closed send failure code');
  const smsAccepted = await record(sms[0], 'ACCEPTED', { providerMessageId: 'fake-sms-1', sentAs: 'MMS', segments: 3, encoding: 'UCS2' });
  check(smsAccepted.status === 'ACCEPTED', 'text accepted as MMS');
  const smsRow = await delivery('smsDay');
  check(smsRow.sent_as === 'MMS' && smsRow.segments === 3 && smsRow.encoding === 'UCS2', 'sent-as, pieces and encoding are measured per delivery');

  // 5. Retry backoff, exhaustion, permanent failure and UNKNOWN.
  await queued('retry', ids.schoolA, 'ada', 'EMAIL', 'Retry me');
  let lease = (await claim(['EMAIL']))[0];
  const retry1 = await record(lease, 'RETRYABLE');
  const retryRow = await delivery('retry');
  check(retry1.status === 'PENDING' && retryRow.hold_reason === 'RETRY_WAIT' && new Date(retryRow.next_attempt_at) > new Date(Date.now() + 100_000), 'retryable failure waits with backoff');
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    await admin.query('UPDATE hon.communication_deliveries SET next_attempt_at = now() WHERE message_id = $1', [message.retry]);
    lease = (await claim(['EMAIL']))[0];
    check(lease?.attempt === attempt, `retry attempt ${attempt} is leased`);
    await record(lease, 'RETRYABLE');
  }
  const exhausted = await delivery('retry');
  check(exhausted.status === 'FAILED' && exhausted.failure_code === 'RETRIES_EXHAUSTED' && exhausted.attempt_count === 5, 'five retryable failures end as FAILED/RETRIES_EXHAUSTED');
  await queued('reject', ids.schoolA, 'ada', 'EMAIL', 'Bad');
  lease = (await claim(['EMAIL']))[0];
  check((await record(lease, 'FAILED', { failureCode: 'INVALID_ADDRESS' })).status === 'FAILED', 'permanent rejection is FAILED');
  await queued('unknown', ids.schoolA, 'ada', 'EMAIL', 'Lost answer');
  const unknownLease = (await claim(['EMAIL']))[0];
  check((await record(unknownLease, 'UNKNOWN')).status === 'UNKNOWN', 'lost provider answer is UNKNOWN');
  await admin.query('UPDATE hon.communication_deliveries SET next_attempt_at = now() WHERE message_id = $1', [message.unknown]);
  check((await claim(['EMAIL'])).length === 0, 'UNKNOWN is never retried automatically');

  // 6. Lease expiry and late results become UNKNOWN, never success.
  await queued('expire', ids.schoolA, 'ada', 'EMAIL', 'Slow worker');
  const slow = (await claim(['EMAIL'], 100, 15))[0];
  await admin.query("UPDATE hon.communication_deliveries SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [slow.delivery_id]);
  const late = await record(slow, 'ACCEPTED', { providerMessageId: 'fake-late', sentAs: 'EMAIL' });
  check(late.status === 'UNKNOWN' && late.accepted === false, 'a late ACCEPTED after lease expiry is UNKNOWN and not accepted');
  await queued('sweep', ids.schoolA, 'ada', 'EMAIL', 'Crashed worker');
  const crashed = (await claim(['EMAIL'], 100, 15))[0];
  await admin.query("UPDATE hon.communication_deliveries SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [crashed.delivery_id]);
  check(Number((await worker.query('SELECT hon.reconcile_expired_communication_leases(10) AS n')).rows[0].n) >= 1, 'expired lease is reconciled');
  check((await delivery('sweep')).status === 'UNKNOWN' && (await delivery('sweep')).failure_code === 'LEASE_EXPIRED', 'crashed worker lease is UNKNOWN/LEASE_EXPIRED');

  // 7. Provider receipts: idempotent, forward-only, UNKNOWN resolved by HON delivery id, unmatched writes nothing.
  check((await receipt('evt-1', 'fake-msg-1', 'DELIVERED')).delivery_status === 'DELIVERED', 'DELIVERED receipt moves ACCEPTED to DELIVERED');
  check((await receipt('evt-1', 'fake-msg-1', 'DELIVERED')).outcome === 'REPLAYED', 'redelivered receipt is a replay');
  check((await receipt('evt-2', 'fake-msg-1', 'DEFERRED')).delivery_status === 'DELIVERED', 'a late DEFERRED never undoes DELIVERED');
  check((await receipt('evt-3', 'fake-msg-1', 'BOUNCED')).delivery_status === 'DELIVERED', 'a terminal status is not replaced by another terminal status');
  const events = (await admin.query('SELECT count(*)::int AS n FROM hon.communication_delivery_events e JOIN hon.communication_deliveries d ON d.id = e.delivery_id WHERE d.message_id = $1', [message.email1])).rows[0].n;
  check(events === 3, 'each distinct receipt is stored once');
  const resolved = await receipt('evt-4', 'fake-late-2', 'DELIVERED', { honDeliveryId: unknownLease.delivery_id });
  check(resolved.outcome === 'RECORDED' && resolved.delivery_status === 'DELIVERED', 'a provider DELIVERED receipt with the HON delivery id resolves an UNKNOWN send');
  check((await receipt('evt-5', 'no-such-message', 'DELIVERED')).outcome === 'UNMATCHED', 'an unknown provider message id is UNMATCHED');
  check((await receipt('evt-6', 'other', 'DELIVERED', { honDeliveryId: (await delivery('reject')).id })).outcome === 'UNMATCHED', 'a HON delivery id cannot attach a different provider message to a FAILED delivery');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.communication_delivery_events WHERE provider_event_id IN ('evt-5','evt-6')")).rows[0].n === 0, 'unmatched receipts write nothing');
  await expectError('22023', () => receipt('evt-7', 'fake-msg-1', 'OPENED'), 'opens are not a stored event type');
  await expectError('22023', () => receipt('evt-8', 'fake-msg-1', 'DELIVERED', { occurredAt: '2001-01-01T00:00:00Z' }), 'ancient event time is refused');
  check((await receipt('evt-9', 'fake-sms-1', 'SENT', { cost: 22000 })).delivery_status === 'ACCEPTED', 'SENT keeps ACCEPTED');
  check(Number((await delivery('smsDay')).provider_cost_microunits) === 22000, 'measured provider cost is stored per delivery');
  check((await receipt('evt-10', 'fake-sms-1', 'UNDELIVERED')).delivery_status === 'FAILED' && (await delivery('smsDay')).failure_code === 'UNDELIVERED', 'UNDELIVERED is FAILED/UNDELIVERED');

  // 8. Recipient unsubscribe records OPTED_OUT with source RECIPIENT, once, and blocks the next send.
  check((await receipt('evt-11', 'fake-msg-1', 'UNSUBSCRIBED')).outcome === 'RECORDED', 'unsubscribe receipt recorded');
  const optOut = (await admin.query("SELECT status::text, source::text, updated_by_principal_id FROM hon.communication_consents WHERE person_id = $1 AND channel = 'EMAIL'", [person.ada])).rows[0];
  check(optOut.status === 'OPTED_OUT' && optOut.source === 'RECIPIENT' && optOut.updated_by_principal_id === '00000000-0000-4000-8000-00000000c043', 'unsubscribe records OPTED_OUT/RECIPIENT by the delivery principal');
  await receipt('evt-12', 'fake-msg-1', 'SPAM_REPORT');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE action_code = 'communication.consent.recipient_opt_out' AND organization_id = $1", [ids.org])).rows[0].n === 1, 'a second opt-out signal records nothing new');
  check((await admin.query("SELECT status::text FROM hon.communication_consents WHERE person_id = $1 AND channel = 'SMS'", [person.ada])).rows[0].status === 'OPTED_IN', 'an email unsubscribe does not change text consent');
  await queued('afterOptOut', ids.schoolA, 'ada', 'EMAIL', 'After unsubscribe');
  await claim(['EMAIL']);
  check((await delivery('afterOptOut')).status === 'SUPPRESSED', 'the next email after unsubscribe is SUPPRESSED');

  // 9. Inactive school: held, not sent, not failed.
  await queued('inactive', ids.schoolB, 'night', 'EMAIL', 'Suspended school');
  await admin.query("UPDATE hon.schools SET status = 'SUSPENDED' WHERE id = $1", [ids.schoolB]);
  check((await claim(['EMAIL'])).length === 0, 'a suspended school is not sent');
  check((await delivery('inactive')).hold_reason === 'SCHOOL_INACTIVE' && (await delivery('inactive')).status === 'PENDING', 'a suspended school is held as SCHOOL_INACTIVE');
  await admin.query("UPDATE hon.schools SET status = 'ACTIVE' WHERE id = $1", [ids.schoolB]);

  // 10. Evidence and forced RLS: school staff read only their own school's deliveries.
  const evidence = (await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE entity_type = 'COMMUNICATION_DELIVERY' AND organization_id = $1 AND actor_principal_id = '00000000-0000-4000-8000-00000000c043'", [ids.org])).rows[0].n;
  const outbox = (await admin.query("SELECT count(*)::int AS n FROM hon.outbox_events WHERE aggregate_type = 'COMMUNICATION_DELIVERY' AND organization_id = $1", [ids.org])).rows[0].n;
  check(evidence > 20 && evidence === outbox, `every delivery transition has one audit row and one outbox event (${evidence}/${outbox})`);
  await runtime.query('BEGIN');
  await runtime.query("SELECT set_config('app.hon_organization_id', $1, true), set_config('app.hon_school_id', $2, true)", [ids.org, ids.schoolA]);
  const visible = (await runtime.query('SELECT school_id FROM hon.communication_deliveries')).rows;
  const visibleEvents = (await runtime.query('SELECT school_id FROM hon.communication_delivery_events')).rows;
  await runtime.query('ROLLBACK');
  check(visible.length > 0 && visible.every((row) => row.school_id === ids.schoolA), 'runtime sees only the current school deliveries');
  check(visibleEvents.length > 0 && visibleEvents.every((row) => row.school_id === ids.schoolA), 'runtime sees only the current school receipts');
  check((await runtime.query('SELECT count(*)::int AS n FROM hon.communication_deliveries')).rows[0].n === 0, 'no tenant context sees nothing');

  // 11. API end to end: the dispatcher (worker login) sends through the fake provider and the school reads the result.
  const { CommunicationDispatcher } = await import('../../../apps/api/dist/communication/delivery/communication-dispatcher.js');
  const { CommunicationWorkerDatabase } = await import('../../../apps/api/dist/communication/delivery/communication-worker-database.js');
  const { FakeCommunicationProvider } = await import('../../../apps/api/dist/communication/delivery/fake-communication-provider.js');
  const { CommunicationMessageService } = await import('../../../apps/api/dist/communication/communication-message.service.js');
  const { RuntimeDatabaseService } = await import('../../../apps/api/dist/foundation/runtime-database.service.js');
  await consent('ada', ids.schoolA, 'EMAIL', 'OPTED_IN');
  await queued('api', ids.schoolA, 'ada', 'EMAIL', 'Sent through the dispatcher');
  const workerDb = new CommunicationWorkerDatabase();
  const fakeEnv = () => ({ HON_COMMUNICATION_FAKE_PROVIDER: '1' });
  const fakeEmail = new FakeCommunicationProvider('EMAIL', fakeEnv);
  const off = await new CommunicationDispatcher(workerDb, [new FakeCommunicationProvider('EMAIL', () => ({}))]).runOnce();
  check(off.claimed === 0 && !(await delivery('api')), 'with no READY provider nothing is claimed and the message stays QUEUED without a delivery');
  const dispatched = await new CommunicationDispatcher(workerDb, [fakeEmail]).runOnce(100);
  check(dispatched.accepted >= 1 && fakeEmail.sent.some((sent) => sent.messageId === message.api && sent.content === 'Sent through the dispatcher'), 'dispatcher sends the queued email through the fake provider');
  const apiRow = await delivery('api');
  check(apiRow.status === 'ACCEPTED' && apiRow.provider === 'FAKE' && apiRow.provider_message_id === `fake-${apiRow.id}-1`, 'the accepted send is recorded with the fake provider message id');
  const receiptResult = await workerDb.recordReceipt({ provider: 'FAKE', providerEventId: 'api-evt-1', providerMessageId: apiRow.provider_message_id, eventType: 'DELIVERED', occurredAt: new Date().toISOString() });
  check(receiptResult.outcome === 'RECORDED' && receiptResult.deliveryStatus === 'DELIVERED', 'the worker store records a provider receipt');
  const service = new CommunicationMessageService(new RuntimeDatabaseService());
  const ctx = (school) => ({ organizationId: ids.org, schoolId: school, principalId: ids.principal, principalType: 'HUMAN_USER', requestId: randomUUID() });
  const view = await service.readDelivery(ctx(ids.schoolA), message.api);
  check(view.status === 'DELIVERED' && view.channel === 'EMAIL' && view.attempts === 1 && view.receipts.length === 1 && view.receipts[0].type === 'DELIVERED', 'school read shows DELIVERED with its receipt timeline');
  check(!JSON.stringify(view).includes('ada@example.test') && !JSON.stringify(view).includes('fake-'), 'school read carries no address and no provider id');
  const nightView = await service.readDelivery(ctx(ids.schoolB), message.smsNight);
  check(nightView.status === 'PENDING' && nightView.holdReason === 'QUIET_HOURS' && typeof nightView.nextAttemptAt === 'string', 'school read shows a quiet-hours hold with its next attempt');
  await queued('notStarted', ids.schoolA, 'ada', 'SMS', 'Waiting for a text provider');
  check((await service.readDelivery(ctx(ids.schoolA), message.notStarted)).status === 'NOT_STARTED', 'a queued message without a delivery reads NOT_STARTED');
  let foreign = false;
  try { await service.readDelivery(ctx(ids.schoolB), message.api); } catch (error) { foreign = error?.getStatus?.() === 404; }
  check(foreign, 'another school cannot read this school delivery (404)');
  await workerDb.onModuleDestroy();

  // 12. SendGrid end to end with a stub transport (no network): send, then a signed Event Webhook through the controller.
  const { SendGridEmailProvider, SendGridEventWebhookVerifier } = await import('../../../apps/api/dist/communication/delivery/sendgrid-email-provider.js');
  const { CommunicationWebhookController } = await import('../../../apps/api/dist/communication/delivery/communication-webhook.controller.js');
  const { generateKeyPairSync, sign } = await import('node:crypto');
  await consent('ada', ids.schoolA, 'EMAIL', 'OPTED_IN');
  await queued('sendgrid', ids.schoolA, 'ada', 'EMAIL', 'Sent through SendGrid');
  const sgEnv = () => ({ SENDGRID_API_KEY: 'SG.test-only', HON_EMAIL_FROM: 'notices@hon.example', HON_EMAIL_SEND_APPROVED: 'true' });
  const sgCalls = [];
  const sendgrid = new SendGridEmailProvider(sgEnv, async (url, init) => { sgCalls.push({ url, body: JSON.parse(init.body) }); return { status: 202, headers: new Headers({ 'x-message-id': `sgmsg${sgCalls.length}` }) }; });
  const sgWorker = new CommunicationWorkerDatabase();
  await new CommunicationDispatcher(sgWorker, [sendgrid, new FakeCommunicationProvider('EMAIL', fakeEnv)]).runOnce(100);
  const sgRow = await delivery('sendgrid');
  const sgCall = sgCalls.find((call) => call.body.personalizations[0].custom_args.hon_delivery_id === sgRow.id);
  check(sgRow.status === 'ACCEPTED' && sgRow.provider === 'SENDGRID' && sgCall && sgCall.body.mail_settings.sandbox_mode.enable === true, 'an approved SendGrid adapter wins over the fake and sends in sandbox mode with the HON delivery id');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verifierEnv = () => ({ SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  const { TwilioWebhookVerifier: SgTwilioVerifier } = await import('../../../apps/api/dist/communication/delivery/twilio-text-provider.js');
  const controller = new CommunicationWebhookController(sgWorker, new SendGridEventWebhookVerifier(verifierEnv), new SgTwilioVerifier(() => ({})));
  const post = async (events) => {
    const body = Buffer.from(JSON.stringify(events)); const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign('sha256', Buffer.concat([Buffer.from(ts), body]), { key: pair.privateKey, dsaEncoding: 'der' }).toString('base64');
    return controller.sendgridEvents({ body }, signature, ts);
  };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sgEvent = (type, id) => ({ event: type, sg_event_id: id, sg_message_id: `${sgRow.provider_message_id}.filterdrecv-1`, hon_delivery_id: sgRow.id, timestamp: nowSeconds, email: 'ada@example.test' });
  const posted = await post([sgEvent('processed', 'sg-e1'), sgEvent('delivered', 'sg-e2'), sgEvent('open', 'sg-e3'), sgEvent('unsubscribe', 'sg-e4')]);
  check(posted.recorded === 3 && posted.ignored === 1, 'a signed SendGrid batch records three receipts and ignores the open');
  check((await delivery('sendgrid')).status === 'DELIVERED', 'the SendGrid delivered event marks the delivery DELIVERED');
  check((await admin.query("SELECT status::text, source::text FROM hon.communication_consents WHERE person_id = $1 AND channel = 'EMAIL'", [person.ada])).rows[0].source === 'RECIPIENT', 'the SendGrid unsubscribe records OPTED_OUT from the recipient');
  check((await post([sgEvent('delivered', 'sg-e2')])).replayed === 1, 'a redelivered SendGrid batch is a replay');
  let rejected = false;
  try { await controller.sendgridEvents({ body: Buffer.from('[]') }, 'AAAAAAAAAAAAAAAAAAAAAAAA', String(nowSeconds)); } catch (error) { rejected = error?.getStatus?.() === 400; }
  check(rejected, 'an unsigned SendGrid batch is refused with 400');
  let retry = false;
  try { await post([{ ...sgEvent('delivered', 'sg-e9'), sg_message_id: 'unknownmsg.filter', hon_delivery_id: randomUUID() }]); } catch (error) { retry = error?.getStatus?.() === 503; }
  check(retry, 'a receipt for an unknown HON delivery asks SendGrid to redeliver (503) and writes nothing');
  await sgWorker.onModuleDestroy();

  // 13. 0248 senders and inbound keywords.
  await admin.query('INSERT INTO hon.schools (id, organization_id, name, slug, timezone) VALUES ($1,$2,$3,$4,$5)', [ids.schoolC, ids.org, 'No Number School', `nonum-${ids.schoolC.slice(0, 8)}`, dayZone]);
  await addPerson('carl', ids.schoolC, 'carl@example.test', '+15555550105');
  await consent('carl', ids.schoolC, 'SMS', 'OPTED_IN');
  await queued('noSender', ids.schoolC, 'carl', 'SMS', 'No number yet');
  await claim(['SMS']);
  check((await delivery('noSender')).status === 'PENDING' && (await delivery('noSender')).hold_reason === 'SENDER_NOT_READY', 'a text from a school without an ACTIVE sender waits as SENDER_NOT_READY');
  await expectError('42501', () => runtime.query("SELECT hon.set_school_text_sender_from_hq($1,$2,'+15555559003',$3,'ACTIVE',true,NULL)", [`delivery-${ids.user}`, ids.schoolC, sid(3)]), 'a school staff member cannot set a text sender');
  await admin.query("INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, 'hq@example.test', 'HQ Owner')", [ids.hqUser, `hq-${ids.hqUser}`]);
  await admin.query("INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, 'HQ Owner')", [ids.hqPrincipal, ids.hqUser]);
  await admin.query("INSERT INTO hon.hq_operator_grants (principal_id, hq_role) VALUES ($1, 'HON_HQ_OWNER')", [ids.hqPrincipal]);
  const setSender = (version, phone = '+15555559003', status = 'ACTIVE', mms = true) => runtime.query('SELECT hon.set_school_text_sender_from_hq($1,$2,$3,$4,$5,$6,$7) AS data', [`hq-${ids.hqUser}`, ids.schoolC, phone, sid(3), status, mms, version]);
  await expectError('22023', () => setSender(null, '+15555559003', 'ACTIVE', false), 'a sender cannot be ACTIVE until the HQ owner confirms the MMS Converter is on');
  await expectError('23514', () => admin.query("INSERT INTO hon.school_text_senders (organization_id, school_id, phone_e164, messaging_service_sid, status, set_by_principal_id) VALUES ($1,$2,'+15555559009',$3,'ACTIVE',$4)", [ids.org, ids.schoolC, sid(9), ids.hqPrincipal]), 'the table itself refuses an ACTIVE sender without the MMS Converter confirmed');
  const created = (await setSender(null)).rows[0].data;
  check(created.status === 'ACTIVE' && created.mmsConverterConfirmed === true && created.version === 1 && created.phoneE164 === '+15555559003', 'the HQ owner sets a school text sender');
  await expectError('40001', () => setSender(null), 'a second create without the version conflicts');
  await expectError('23505', () => runtime.query('SELECT hon.set_school_text_sender_from_hq($1,$2,$3,$4,$5,$6,$7)', [`hq-${ids.hqUser}`, ids.schoolC, '+15555559001', sid(3), 'ACTIVE', true, 1]), 'another school number cannot be reused');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE action_code = 'communication.text_sender.set' AND school_id = $1", [ids.schoolC])).rows[0].n === 1, 'setting a sender is audited once');
  await admin.query('UPDATE hon.communication_deliveries SET next_attempt_at = now() WHERE message_id = $1', [message.noSender]);
  const released = (await claim(['SMS'])).find((row) => row.message_id === message.noSender);
  check(released?.sender_address === '+15555559003', 'once the sender is ACTIVE the held text is leased from that number');
  await record(released, 'ACCEPTED', { providerMessageId: 'fake-sms-carl', sentAs: 'SMS', segments: 1, encoding: 'GSM7' });
  check((await setSender(1, '+15555559003', 'DISABLED')).rows[0].data.status === 'DISABLED', 'the HQ owner can disable a sender');

  const keyword = (to, from, word, sidSuffix) => worker.query('SELECT * FROM hon.record_inbound_text_keyword($1,$2,$3,$4,now())', [to, from, word, `SM${sidSuffix.padEnd(32, '0')}`]).then((r) => r.rows[0]);
  await addPerson('adaTwin', ids.schoolB, 'ada-b@example.test', '+15555550101');
  await consent('adaTwin', ids.schoolB, 'SMS', 'OPTED_IN');
  await consent('ada', ids.schoolA, 'SMS', 'OPTED_IN');
  const stop = await keyword('+15555559001', '+15555550101', 'STOP', 'a1');
  check(stop.outcome === 'RECORDED' && stop.consents_changed === 1 && stop.school_name === 'Day School', 'STOP to school A records one opt-out');
  const smsConsent = async (key) => (await admin.query("SELECT status::text, source::text FROM hon.communication_consents WHERE person_id = $1 AND channel = 'SMS'", [person[key]])).rows[0];
  check((await smsConsent('ada')).status === 'OPTED_OUT' && (await smsConsent('ada')).source === 'RECIPIENT', 'STOP records OPTED_OUT/RECIPIENT for that school person');
  check((await smsConsent('adaTwin')).status === 'OPTED_IN', 'the same number in another school is not changed');
  check((await keyword('+15555559001', '+15555550101', 'STOP', 'a1')).outcome === 'REPLAYED', 'a redelivered keyword is a replay');
  check((await keyword('+15555559001', '+15555550101', 'HELP', 'a2')).consents_changed === 0, 'HELP changes nothing');
  const start = await keyword('+15555559001', '+15555550101', 'START', 'a3');
  check(start.consents_changed === 1 && (await smsConsent('ada')).status === 'OPTED_IN', 'START re-opens consent the person withdrew by text');
  await consent('ada', ids.schoolA, 'SMS', 'OPTED_OUT'); // staff-recorded opt-out (source STAFF)
  check((await keyword('+15555559001', '+15555550101', 'START', 'a4')).consents_changed === 0 && (await smsConsent('ada')).status === 'OPTED_OUT', 'START never re-opens a staff-recorded opt-out');
  check((await keyword('+15555559999', '+15555550101', 'STOP', 'a5')).outcome === 'UNROUTED', 'a keyword to an unknown number is UNROUTED');
  check((await keyword('+15555559003', '+15555550105', 'START', 'a6')).outcome === 'UNROUTED', 'START or HELP to a DISABLED number is UNROUTED');
  check((await keyword('+15555559003', '+15555550105', 'STOP', 'a7')).outcome === 'RECORDED', 'STOP to a DISABLED number is still honored and recorded');
  check((await admin.query('SELECT count(*)::int AS n FROM hon.inbound_text_keywords WHERE organization_id = $1', [ids.org])).rows[0].n === 5, 'only routed keywords are stored, without the sender number');
  await expectError('42501', () => runtime.query("SELECT * FROM hon.record_inbound_text_keyword('+15555559001','+15555550101','STOP',$1,now())", [`SM${'b'.repeat(32)}`]), 'runtime cannot record inbound keywords');

  // 14. Twilio end to end with a stub transport and signed callbacks through the controller.
  const { TwilioTextProvider, TwilioWebhookVerifier } = await import('../../../apps/api/dist/communication/delivery/twilio-text-provider.js');
  const { createHmac } = await import('node:crypto');
  const twEnv = () => ({ TWILIO_ACCOUNT_SID: `AC${'c'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'test-token', HON_PUBLIC_API_ORIGIN: 'https://api.hon.example', HON_SMS_SEND_APPROVED: 'true' });
  await consent('ada', ids.schoolA, 'SMS', 'OPTED_IN');
  await queued('twilio', ids.schoolA, 'ada', 'SMS', '내일 오후 5시 수업이 있습니다. 늦지 마세요! 도복과 띠를 꼭 챙겨 오세요. 질문이 있으시면 언제든지 연락 주세요. 감사합니다. 오늘도 좋은 하루 되세요!');
  const twCalls = [];
  const twSid = `SM${'d'.repeat(32)}`;
  const twilio = new TwilioTextProvider(twEnv, async (url, init) => { twCalls.push({ url, form: new URLSearchParams(init.body) }); return { status: 201, json: async () => ({ sid: twSid, num_segments: '2' }) }; });
  const twWorker = new CommunicationWorkerDatabase();
  if (hourIn(dayZone) >= 10 && hourIn(dayZone) <= 19) {
    await new CommunicationDispatcher(twWorker, [twilio]).runOnce(100);
    const twRow = await delivery('twilio');
    check(twRow.status === 'ACCEPTED' && twRow.provider === 'TWILIO' && twRow.encoding === 'UCS2' && twRow.segments === 2, 'a Korean text is sent through Twilio and measured as UCS-2 pieces');
    check(twCalls[0].form.get('MessagingServiceSid') === sid(1) && twCalls[0].form.get('StatusCallback') === 'https://api.hon.example/v1/communications/webhooks/twilio/status', 'Twilio gets the school Messaging Service and the HON status callback');
    const controller = new CommunicationWebhookController(twWorker, new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(twEnv));
    const signedForm = (path, fields) => {
      const params = new URLSearchParams(fields);
      const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), `https://api.hon.example${path}`);
      return { body: Buffer.from(params.toString()), signature: createHmac('sha1', 'test-token').update(data).digest('base64') };
    };
    const status = signedForm('/v1/communications/webhooks/twilio/status', { AccountSid: `AC${'c'.repeat(32)}`, MessageSid: twSid, MessageStatus: 'delivered' });
    check((await controller.twilioStatus({ body: status.body }, status.signature)).recorded === 1 && (await delivery('twilio')).status === 'DELIVERED', 'a signed Twilio delivered callback marks the text DELIVERED');
    let forged = false;
    try { await controller.twilioStatus({ body: status.body }, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=') } catch (error) { forged = error?.getStatus?.() === 400; }
    check(forged, 'an unsigned Twilio callback is refused');
    const inbound = signedForm('/v1/communications/webhooks/twilio/inbound', { AccountSid: `AC${'c'.repeat(32)}`, MessageSid: `SM${'e'.repeat(32)}`, From: '+15555550101', To: '+15555559001', Body: ' stop ' });
    const twiml = await controller.twilioInbound({ body: inbound.body }, inbound.signature);
    check(twiml.includes('<Response></Response>') && (await smsConsent('ada')).status === 'OPTED_OUT', 'a signed inbound STOP through the controller opts the person out and answers empty TwiML');
  } else {
    console.log('Twilio end-to-end skipped: the day zone left sending hours during the run.');
  }
  await twWorker.onModuleDestroy();

  // 15. 0249 missed calls: HQ-owner settings, signed routing, one reply per caller per day, opt-outs, quiet hours, lease rules, RLS.
  const senderVersion = async (school) => (await admin.query('SELECT version FROM hon.school_text_senders WHERE school_id = $1', [school])).rows[0].version;
  const setMissed = (school, forward, on, version) => runtime.query('SELECT hon.set_school_missed_call_settings_from_hq($1,$2,$3,$4,$5) AS data', [`hq-${ids.hqUser}`, school, forward, on, version]);
  await expectError('42501', () => runtime.query('SELECT hon.set_school_missed_call_settings_from_hq($1,$2,NULL,true,1)', [`delivery-${ids.user}`, ids.schoolA]), 'school staff cannot change missed-call settings');
  await expectError('22023', async () => setMissed(ids.schoolA, '+15555559001', true, await senderVersion(ids.schoolA)), 'a school number cannot forward to itself');
  await expectError('40001', () => setMissed(ids.schoolA, '+15555550199', true, 999), 'a stale settings version conflicts');
  await expectError('P0002', () => setMissed(randomUUID(), '+15555550199', true, 1), 'a school without a sender has no missed-call settings');
  const settings = (await setMissed(ids.schoolA, '+15555550199', true, await senderVersion(ids.schoolA))).rows[0].data;
  check(settings.forwardSet === true && settings.missedCallTextBack === true && !JSON.stringify(settings).includes('5555550199'), 'the HQ owner turns on forwarding and text-back; the answer carries no phone number');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE action_code = 'communication.missed_call_settings.set' AND school_id = $1", [ids.schoolA])).rows[0].n === 1, 'missed-call settings are audited');
  await setMissed(ids.schoolB, null, true, await senderVersion(ids.schoolB));
  const route = async (to) => (await worker.query('SELECT * FROM hon.read_missed_call_route($1)', [to])).rows[0];
  check((await route('+15555559001')).routed && (await route('+15555559001')).forward_phone_e164 === '+15555550199', 'a call to school A forwards to the school phone');
  check((await route('+15555559002')).routed && (await route('+15555559002')).forward_phone_e164 === null, 'school B has no forwarding phone');
  check(!(await route('+15555559003')).routed && !(await route('+15555558888')).routed, 'a DISABLED or unknown number is not routed');
  await expectError('42501', () => runtime.query("SELECT * FROM hon.read_missed_call_route('+15555559001')"), 'runtime cannot read call routing');
  await expectError('42501', () => runtime.query("SELECT * FROM hon.record_missed_call('+15555559001','+15555550201',$1,'busy',now())", [`CA${'0'.repeat(32)}`]), 'runtime cannot record missed calls');
  await expectError('42501', () => worker.query('SELECT 1 FROM hon.missed_calls LIMIT 1'), 'worker cannot read missed calls directly');
  let callN = 0;
  const callId = () => `CA${(++callN).toString(16).padStart(32, '0')}`;
  const missed = async (to, from, status = 'no-answer', sidValue = callId(), at = new Date().toISOString()) =>
    ({ sid: sidValue, ...(await worker.query('SELECT * FROM hon.record_missed_call($1,$2,$3,$4,$5)', [to, from, sidValue, status, at])).rows[0] });
  const first = await missed('+15555559001', '+15555550201');
  check(first.outcome === 'RECORDED' && first.text_back_status === 'PENDING', 'an unanswered call to school A queues one text-back');
  check((await missed('+15555559001', '+15555550201', 'no-answer', first.sid)).outcome === 'REPLAYED', 'a redelivered call result is a replay');
  check((await missed('+15555559001', '+15555550201', 'busy')).text_back_status === 'RECENTLY_SENT', 'a second missed call from the same caller within a day gets no second text');
  await consent('ada', ids.schoolA, 'SMS', 'OPTED_OUT');
  check((await missed('+15555559001', '+15555550101')).text_back_status === 'OPTED_OUT', 'a caller who opted out of school texts gets no text-back');
  check((await missed('+15555558888', '+15555550201')).outcome === 'UNROUTED', 'a call to an unknown number is not recorded');
  await expectError('22023', () => missed('+15555559001', '+15555550209', 'completed'), 'an answered call is not a missed call');
  await expectError('22023', () => missed('+15555559001', '+15555550209', 'busy', callId(), new Date(Date.now() - 2 * 86_400_000).toISOString()), 'a call older than a day is refused');
  await expectError('23514', () => missed('+15555559001', '+15555550209', 'busy', 'CA-not-a-sid'), 'a malformed call id is refused');
  const twoDays = await missed('+15555559002', '+15555550301');
  check(twoDays.text_back_status === 'PENDING', 'school B with no forwarding phone still records the missed call');
  const claimCalls = async (lease = 60) => (await worker.query('SELECT * FROM hon.claim_missed_call_text_backs(100, $1)', [lease])).rows.filter((row) => row.organization_id === ids.org);
  const callRow = async (sidValue) => (await admin.query('SELECT * FROM hon.missed_calls WHERE provider_call_id = $1', [sidValue])).rows[0];
  const callResult = async (row, outcome, providerId = null) => (await worker.query('SELECT * FROM hon.record_missed_call_text_back_result($1,$2,$3,$4)', [row.missed_call_id, row.lease_token, outcome, providerId])).rows[0];
  if (hourIn(dayZone) >= 10 && hourIn(dayZone) <= 19) {
    const leased = await claimCalls();
    const mine = leased.find((row) => row.caller_e164 === '+15555550201');
    check(leased.length === 1 && mine?.school_name === 'Day School' && mine.language === 'en' && mine.sender_service_id === sid(1) && mine.attempt === 1, 'only the day school text-back is leased, with school name, language and sender');
    const night = await callRow(twoDays.sid);
    check(night.text_back_status === 'PENDING' && night.next_attempt_at > new Date(), 'the night school text-back waits for 08:00 local');
    check((await callResult(mine, 'ACCEPTED', `SM${'f'.repeat(32)}`)).text_back_status === 'ACCEPTED', 'an accepted text-back is recorded');
    check((await callResult(mine, 'ACCEPTED', `SM${'f'.repeat(32)}`)).accepted === false, 'a replayed result on a finished text-back is refused');
    const retry = await missed('+15555559001', '+15555550202');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await admin.query('UPDATE hon.missed_calls SET next_attempt_at = now() WHERE provider_call_id = $1', [retry.sid]);
      const row = (await claimCalls()).find((r) => r.caller_e164 === '+15555550202');
      check(row?.attempt === attempt, `text-back attempt ${attempt} is leased`);
      const result = await callResult(row, 'RETRYABLE');
      check(result.text_back_status === (attempt < 3 ? 'PENDING' : 'FAILED'), attempt < 3 ? 'a retryable failure waits with backoff' : 'the third retryable failure ends as FAILED');
    }
    const lost = await missed('+15555559001', '+15555550203');
    const lostRow = (await claimCalls(15)).find((r) => r.caller_e164 === '+15555550203');
    await admin.query("UPDATE hon.missed_calls SET lease_expires_at = now() - interval '1 second' WHERE provider_call_id = $1", [lost.sid]);
    await claimCalls();
    check((await callRow(lost.sid)).text_back_status === 'UNKNOWN', 'an expired lease becomes UNKNOWN and is not sent again');
    check((await callResult(lostRow, 'ACCEPTED', `SM${'e'.repeat(32)}`)).accepted === false && (await callRow(lost.sid)).text_back_status === 'UNKNOWN', 'a late result after the lease expired is refused');
    check((await missed('+15555559001', '+15555550203')).text_back_status === 'RECENTLY_SENT', 'an UNKNOWN text-back still counts as sent today');
    const consentLater = await missed('+15555559001', '+15555550204');
    await addPerson('caller204', ids.schoolA, null, '+15555550204');
    await consent('caller204', ids.schoolA, 'SMS', 'OPTED_OUT');
    await claimCalls();
    check((await callRow(consentLater.sid)).text_back_status === 'OPTED_OUT', 'an opt-out recorded after the call is re-checked before sending');
    const switched = await missed('+15555559001', '+15555550205');
    await setMissed(ids.schoolA, '+15555550199', false, await senderVersion(ids.schoolA));
    await claimCalls();
    check((await callRow(switched.sid)).text_back_status === 'OFF', 'turning text-back off stops a waiting reply');
    check((await missed('+15555559001', '+15555550206')).text_back_status === 'OFF', 'with text-back off a missed call is only recorded');
    await setMissed(ids.schoolA, '+15555550199', true, await senderVersion(ids.schoolA));

    // API end to end: signed voice webhooks through the controller, then the text-back dispatcher through the fake provider.
    const { MissedCallTextBackDispatcher, missedCallTextBackBody } = await import('../../../apps/api/dist/communication/delivery/missed-call-text-back.js');
    const callWorker = new CommunicationWorkerDatabase();
    const voiceEnv = { ...twEnv() };
    const priorEnv = { HON_PUBLIC_API_ORIGIN: process.env.HON_PUBLIC_API_ORIGIN };
    process.env.HON_PUBLIC_API_ORIGIN = voiceEnv.HON_PUBLIC_API_ORIGIN;
    try {
      const voiceController = new CommunicationWebhookController(callWorker, new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => voiceEnv));
      const signedVoice = (path, fields) => {
        const params = new URLSearchParams({ AccountSid: `AC${'c'.repeat(32)}`, ...fields });
        const data = [...new Set(params.keys())].sort().reduce((acc, name) => acc + name + params.get(name), `https://api.hon.example${path}`);
        return { body: Buffer.from(params.toString()), signature: createHmac('sha1', 'test-token').update(data).digest('base64') };
      };
      const apiCall = callId();
      const ring = signedVoice('/v1/communications/webhooks/twilio/voice', { CallSid: apiCall, From: '+15555550207', To: '+15555559001' });
      const answer = await voiceController.twilioVoice({ body: ring.body }, ring.signature);
      check(answer.includes('<Number>+15555550199</Number>') && answer.includes('action="https://api.hon.example/v1/communications/webhooks/twilio/voice-result"'), 'a signed call to school A is forwarded to the school phone');
      const unknown = signedVoice('/v1/communications/webhooks/twilio/voice', { CallSid: callId(), From: '+15555550207', To: '+15555558888' });
      check((await voiceController.twilioVoice({ body: unknown.body }, unknown.signature)).includes('<Reject/>'), 'a call to an unknown number is rejected');
      const noForward = signedVoice('/v1/communications/webhooks/twilio/voice', { CallSid: callId(), From: '+15555550302', To: '+15555559002' });
      check((await voiceController.twilioVoice({ body: noForward.body }, noForward.signature)).includes('<Hangup/>'), 'school B without a forwarding phone hangs up');
      check((await admin.query("SELECT count(*)::int AS n FROM hon.missed_calls WHERE caller_e164 = '+15555550302' AND dial_status = 'no-forward'")).rows[0].n === 1, 'and records the call as missed');
      const result = signedVoice('/v1/communications/webhooks/twilio/voice-result', { CallSid: apiCall, From: '+15555550207', To: '+15555559001', DialCallStatus: 'no-answer' });
      await voiceController.twilioVoiceResult({ body: result.body }, result.signature);
      check((await callRow(apiCall))?.text_back_status === 'PENDING', 'a signed no-answer result records the missed call');
      let forgedVoice = false;
      try { await voiceController.twilioVoiceResult({ body: result.body }, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='); } catch (error) { forgedVoice = error?.getStatus?.() === 400; }
      check(forgedVoice, 'an unsigned call result is refused');
      const fakeSms = new FakeCommunicationProvider('SMS', fakeEnv);
      check((await new MissedCallTextBackDispatcher(callWorker, [new FakeCommunicationProvider('SMS', () => ({}))]).runOnce()).claimed === 0, 'no READY text provider means no text-back is claimed');
      const sentBack = await new MissedCallTextBackDispatcher(callWorker, [fakeSms]).runOnce(100);
      const apiRow = await callRow(apiCall);
      check(sentBack.accepted >= 1 && apiRow.text_back_status === 'ACCEPTED' && apiRow.provider_message_id === `fake-${apiRow.id}-1`, 'the dispatcher sends the text-back through the fake provider and records it');
      check(fakeSms.sent.some((sent) => sent.deliveryId === apiRow.id && sent.content === missedCallTextBackBody('en', 'Day School')), 'the text-back carries the fixed school wording with STOP');
    } finally {
      if (priorEnv.HON_PUBLIC_API_ORIGIN === undefined) delete process.env.HON_PUBLIC_API_ORIGIN; else process.env.HON_PUBLIC_API_ORIGIN = priorEnv.HON_PUBLIC_API_ORIGIN;
      await callWorker.onModuleDestroy();
    }
  } else {
    console.log('Missed-call text-back sending skipped: the day zone left sending hours during the run.');
  }
  // B6A: the school list is a definer read for signed-in staff with communication.message.read at an entitled school.
  const reader = `missed-reader-${ids.readerUser}`;
  await admin.query("INSERT INTO hon.users (id, external_subject, email, display_name) VALUES ($1, $2, 'reader@example.test', 'Reader')", [ids.readerUser, reader]);
  await admin.query("INSERT INTO hon.principals (id, principal_type, user_id, display_name) VALUES ($1, 'HUMAN_USER', $2, 'Reader')", [ids.readerPrincipal, ids.readerUser]);
  await admin.query("INSERT INTO hon.roles (id, organization_id, code, name, is_system_role) VALUES ($1, $2, 'FRONT_DESK', 'Front desk', false)", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.role_permissions (role_id, organization_id, permission_code) VALUES ($1, $2, 'communication.message.read')", [ids.role, ids.org]);
  await admin.query("INSERT INTO hon.principal_role_grants (organization_id, school_id, principal_id, role_id, granted_by_principal_id, effective_from) VALUES ($1, $2, $3, $4, $3, clock_timestamp() - interval '1 hour')",
    [ids.org, ids.schoolA, ids.readerPrincipal, ids.role]);
  const list = async (school, subject = reader) => (await runtime.query('SELECT hon.read_school_missed_calls($1, $2, 100) AS data', [subject, school])).rows[0].data;
  await expectError('42501', () => list(ids.schoolA), 'staff at a school without an entitlement in effect read no missed calls');
  await admin.query("INSERT INTO hon.organization_entitlements (organization_id, tier, status, effective_from) VALUES ($1, 'COMPLETE', 'SUSPENDED', now() - interval '1 day')", [ids.org]);
  await expectError('42501', () => list(ids.schoolA), 'staff at a suspended school read no missed calls');
  await admin.query("UPDATE hon.organization_entitlements SET status = 'ACTIVE', effective_until = now() - interval '1 minute' WHERE organization_id = $1", [ids.org]);
  await expectError('42501', () => list(ids.schoolA), 'staff at a school whose entitlement lapsed read no missed calls');
  await admin.query("UPDATE hon.organization_entitlements SET effective_until = NULL WHERE organization_id = $1", [ids.org]);
  const listA = await list(ids.schoolA);
  check(listA.length > 0 && listA.every((row) => row.callerE164 !== '+15555550301' && row.callerE164 !== '+15555550302'), 'school A staff see only their own missed calls');
  check(Object.keys(listA[0]).sort().join() === 'callerE164,dialStatus,id,receivedAt,textBack', 'the school list carries no provider ids or lease data');
  await expectError('42501', () => list(ids.schoolB), 'school A staff cannot read another school\'s missed calls');
  await expectError('42501', () => list(ids.schoolA, `delivery-${ids.user}`), 'staff without communication.message.read read no missed calls');
  await expectError('42501', () => runtime.query('SELECT count(*) FROM hon.missed_calls'), 'the runtime cannot read the missed-call table directly');

  // 16. 0250 Zernio lead intake: HQ-owner form mapping, exact routing, automatic CRM lead, dedupe, refusals, RLS.
  const pipe = {};
  for (const [key, school] of [['A', ids.schoolA], ['B', ids.schoolB]]) {
    pipe[key] = randomUUID(); pipe[`${key}open`] = randomUUID(); pipe[`${key}won`] = randomUUID();
    await admin.query('INSERT INTO hon.crm_pipelines (id, organization_id, school_id, name) VALUES ($1,$2,$3,$4)', [pipe[key], ids.org, school, `Leads ${key}`]);
    await admin.query("INSERT INTO hon.crm_pipeline_stages (id, organization_id, school_id, pipeline_id, name, position, terminal_status) VALUES ($1,$2,$3,$4,'New',1,NULL), ($5,$2,$3,$4,'Won',2,'WON')",
      [pipe[`${key}open`], ids.org, school, pipe[key], pipe[`${key}won`]]);
  }
  // The missed-call section above left the organization's entitlement ACTIVE and in effect; intake uses CORE.
  await admin.query("UPDATE hon.organization_entitlements SET tier = 'CORE', status = 'ACTIVE', effective_until = NULL WHERE organization_id = $1", [ids.org]);
  const mapForm = (school, account, form, stageKey, status = 'ACTIVE', version = null, fieldMap = null) =>
    runtime.query('SELECT hon.set_zernio_lead_form_from_hq($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS data',
      [`hq-${ids.hqUser}`, school, account, form, pipe[stageKey[0]], pipe[stageKey], fieldMap === null ? null : JSON.stringify(fieldMap), status, version]).then((r) => r.rows[0].data);
  await expectError('42501', () => runtime.query('SELECT hon.set_zernio_lead_form_from_hq($1,$2,$3,$4,$5,$6,NULL,$7,NULL)', [`delivery-${ids.user}`, ids.schoolA, '12345', '777', pipe.A, pipe.Aopen, 'ACTIVE']), 'school staff cannot map a Zernio form');
  await expectError('22023', () => mapForm(ids.schoolA, '12345', '777', 'Awon'), 'a form cannot route into a terminal stage');
  await expectError('22023', () => runtime.query('SELECT hon.set_zernio_lead_form_from_hq($1,$2,$3,$4,$5,$6,NULL,$7,NULL)', [`hq-${ids.hqUser}`, ids.schoolA, '12345', '777', pipe.B, pipe.Bopen, 'ACTIVE']), "another school's pipeline cannot be used");
  await expectError('22023', () => mapForm(ids.schoolA, '12345', '777', 'Aopen', 'ACTIVE', null, { email: 'email' }), 'a field map needs a name key');
  const formA = await mapForm(ids.schoolA, '12345', '777', 'Aopen');
  check(formA.status === 'ACTIVE' && formA.version === 1 && formA.fieldMap.fullName === 'full_name', 'the HQ owner maps a Facebook account form to school A with the standard Meta field keys');
  await expectError('23505', () => mapForm(ids.schoolB, '12345', '777', 'Bopen'), 'the same form can never be mapped to a second school');
  await expectError('40001', () => mapForm(ids.schoolA, '12345', '777', 'Aopen'), 'changing a mapping needs its version');
  const formB = await mapForm(ids.schoolB, '12345', '888', 'Bopen', 'ACTIVE', null, { givenName: 'first_name', familyName: 'last_name', phone: 'phone' });
  check(formB.version === 1, 'the same account can map a different form to school B');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.audit_events WHERE action_code = 'integration.zernio_lead_form.set' AND organization_id = $1", [ids.org])).rows[0].n === 2, 'form mappings are audited');
  await expectError('42501', () => runtime.query("SELECT * FROM hon.record_zernio_lead('e','1','12345','777','{}','{}')"), 'runtime cannot record Zernio leads');
  await expectError('42501', () => worker.query('SELECT 1 FROM hon.zernio_lead_forms LIMIT 1'), 'worker cannot read form mappings directly');
  const zlead = async (eventId, leadgenId, account, form, fields, ad = {}) =>
    (await worker.query('SELECT * FROM hon.record_zernio_lead($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [eventId, leadgenId, account, form, JSON.stringify(fields), JSON.stringify(ad)])).rows[0];
  const zCreated = await zlead('evt_1', '9001', '12345', '777', { full_name: '  Ada   King Lovelace ', email: 'ADA@Example.test', phone_number: '+1 (555) 555-0111', note: 'ignored' }, { adId: '55', campaignId: '77', isOrganic: false });
  check(zCreated.outcome === 'CREATED' && zCreated.lead_id, 'a signed lead on a mapped form becomes a CRM lead');
  const leadRow = (await admin.query('SELECT l.*, p.given_name, p.family_name, p.email::text AS email, p.phone_e164 FROM hon.crm_leads l JOIN hon.people p ON p.id = l.primary_person_id WHERE l.id = $1', [zCreated.lead_id])).rows[0];
  check(leadRow.school_id === ids.schoolA && leadRow.pipeline_stage_id === pipe.Aopen && leadRow.source_code === 'ZERNIO_META', 'the lead lands in school A at the mapped stage with source ZERNIO_META');
  check(leadRow.given_name === 'Ada' && leadRow.family_name === 'King Lovelace' && leadRow.email === 'ada@example.test' && leadRow.phone_e164 === '+15555550111', 'name, email and phone are normalized from the mapped keys');
  check(leadRow.attribution.zernio.formId === '777' && leadRow.attribution.zernio.adCampaignId === '77' && !JSON.stringify(leadRow.attribution).includes('ignored'), 'attribution carries form and ad ids, never unmapped answers');
  check((await admin.query('SELECT count(*)::int AS n FROM hon.crm_lead_attributions WHERE lead_id = $1', [zCreated.lead_id])).rows[0].n === 1, 'the immutable lead attribution is captured');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.communication_consents WHERE person_id = $1", [leadRow.primary_person_id])).rows[0].n === 0, 'an ad lead records no message consent');
  check((await zlead('evt_1', '9001', '12345', '777', { full_name: 'Ada', email: 'ada@example.test' })).outcome === 'REPLAYED', 'a redelivered event is a replay');
  const sameLead = await zlead('evt_2', '9001', '12345', '777', { full_name: 'Ada', email: 'ada@example.test' });
  check(sameLead.outcome === 'REPLAYED' && sameLead.lead_id === zCreated.lead_id, 'the same Meta lead under a new event id is still one lead');
  check((await zlead('evt_3', '9002', '12345', '999', { full_name: 'Eve', email: 'eve@example.test' })).outcome === 'UNROUTED', 'an unmapped form creates nothing');
  check((await zlead('evt_4', '9003', '54321', '777', { full_name: 'Eve', email: 'eve@example.test' })).outcome === 'UNROUTED', 'the same form id under another account creates nothing');
  check((await zlead('evt_5', '9004', '12345', '888', { first_name: 'Bo', last_name: 'Kim', phone: '+15555550222' })).outcome === 'CREATED', 'a custom field map works for school B');
  check((await zlead('evt_6', '9005', '12345', '777', { full_name: 'No Contact', email: 'not-an-email', phone_number: '5550123' })).outcome === 'INVALID_CONTACT', 'a lead without a valid email or E.164 phone is refused');
  check((await zlead('evt_7', '9006', '12345', '777', { email: 'nameless@example.test' })).outcome === 'INVALID_CONTACT', 'a lead without a name is refused');
  await expectError('22023', () => zlead('bad id', '9007', '12345', '777', { full_name: 'X', email: 'x@example.test' }), 'a malformed event id is refused');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.zernio_lead_receipts WHERE organization_id = $1 AND outcome = 'INVALID_CONTACT' AND lead_id IS NULL", [ids.org])).rows[0].n === 2, 'refused leads keep only an outcome receipt');
  await mapForm(ids.schoolA, '12345', '777', 'Aopen', 'DISABLED', 1);
  check((await zlead('evt_8', '9008', '12345', '777', { full_name: 'Late', email: 'late@example.test' })).outcome === 'UNROUTED', 'a disabled mapping creates nothing');
  await mapForm(ids.schoolA, '12345', '777', 'Aopen', 'ACTIVE', 2);
  await admin.query("UPDATE hon.organization_entitlements SET status = 'SUSPENDED' WHERE organization_id = $1", [ids.org]).catch(async () => {
    await admin.query("UPDATE hon.organization_entitlements SET effective_until = clock_timestamp() WHERE organization_id = $1", [ids.org]);
  });
  check((await zlead('evt_9', '9009', '12345', '777', { full_name: 'Lapsed', email: 'lapsed@example.test' })).outcome === 'SCHOOL_INACTIVE', 'without an active CRM entitlement no lead is created');
  check((await admin.query("SELECT count(*)::int AS n FROM hon.crm_leads WHERE organization_id = $1 AND source_code = 'ZERNIO_META'", [ids.org])).rows[0].n === 2, 'exactly two Zernio leads exist');
  const zEvidence = (await admin.query("SELECT count(*)::int AS n FROM hon.outbox_events WHERE event_type = 'marketing.zernio.lead_received' AND organization_id = $1", [ids.org])).rows[0].n;
  check(zEvidence === 2, 'each created lead writes one internal outbox event');
  // 0250 review P3s: two-session proofs for the per-form mapping lock and the per-form hourly limit, and the intake principal.
  await admin.query("UPDATE hon.organization_entitlements SET status = 'ACTIVE', effective_until = NULL WHERE organization_id = $1", [ids.org]);
  const mapArgs = (form) => [`hq-${ids.hqUser}`, ids.schoolA, '12345', form, pipe.A, pipe.Aopen, null, 'ACTIVE', null];
  const mapSql = 'SELECT hon.set_zernio_lead_form_from_hq($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) AS data';
  await runtime.query('BEGIN');
  await runtime.query(mapSql, mapArgs('4242'));
  const secondMap = runtime2.query(mapSql, mapArgs('4242')).then(() => 'OK', (error) => error.code);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await runtime.query('COMMIT');
  check(await secondMap === '40001', 'a concurrent first mapping of the same form by the same school is a version conflict, not another-school');
  const rateForm = (await admin.query("SELECT id, version FROM hon.zernio_lead_forms WHERE account_id = '12345' AND form_id = '4242'")).rows[0];
  await admin.query(`INSERT INTO hon.zernio_lead_receipts (organization_id, school_id, form_mapping_id, form_mapping_version, event_id, leadgen_id, outcome)
    SELECT $1, $2, $3, $4, 'evt_seed_' || n, 'seed' || n, 'INVALID_CONTACT' FROM generate_series(1, 299) n`, [ids.org, ids.schoolA, rateForm.id, rateForm.version]);
  const leadSql = 'SELECT * FROM hon.record_zernio_lead($1,$2,$3,$4,$5::jsonb,$6::jsonb)';
  await worker.query('BEGIN');
  const firstRate = (await worker.query(leadSql, ['evt_r1', '9301', '12345', '4242', JSON.stringify({ full_name: 'Rate One', email: 'r1@example.test' }), '{}'])).rows[0];
  const secondRate = worker2.query(leadSql, ['evt_r2', '9302', '12345', '4242', JSON.stringify({ full_name: 'Rate Two', email: 'r2@example.test' }), '{}']).then((r) => r.rows[0].outcome);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await worker.query('COMMIT');
  check(firstRate.outcome === 'CREATED' && await secondRate === 'RATE_LIMITED', 'two concurrent leads at 299 in the hour: exactly one is created, the other is rate limited (HTTP 429)');
  await admin.query("UPDATE hon.principals SET is_active = false WHERE id = '00000000-0000-4000-8000-00000000c050'");
  try {
    await expectError('55000', () => zlead('evt_p1', '9401', '12345', '888', { first_name: 'Pat', phone: '+15555550333' }), 'an inactive intake principal creates nothing (the webhook answers 503 and Zernio retries)');
  } finally { await admin.query("UPDATE hon.principals SET is_active = true WHERE id = '00000000-0000-4000-8000-00000000c050'"); }
  await expectError('42501', () => runtime.query('SELECT form_id FROM hon.zernio_lead_forms'), 'the runtime cannot read Zernio form mappings directly');
  await expectError('42501', () => runtime.query('SELECT school_id FROM hon.zernio_lead_receipts'), 'the runtime cannot read Zernio receipts directly');
  const bReceipts = (await admin.query('SELECT r.school_id FROM hon.zernio_lead_receipts r JOIN hon.zernio_lead_forms f ON f.id = r.form_mapping_id WHERE r.organization_id = $1 AND f.form_id = $2', [ids.org, '888'])).rows;
  check(bReceipts.length === 1 && bReceipts[0].school_id === ids.schoolB, "school B's form records its receipt against school B only");

  console.log(`PASS: communication delivery integrity (${passed} checks; day zone ${dayZone}, night zone ${nightZone}).`);
} finally {
  await cleanup();
  await Promise.all([admin.end(), runtime.end(), worker.end(), runtime2.end(), worker2.end()]);
}
