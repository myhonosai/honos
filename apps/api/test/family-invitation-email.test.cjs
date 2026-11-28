const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { SchoolFamilyAccessInvitationService } = require('../dist/accounts/school-family-access-invitation.service.js');
const { familyInvitationEmail, familyInviteOrigin } = require('../dist/accounts/family-invitation-email.js');
const { SendGridEmailProvider } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const c = require('@hon/contracts');

const ids = { invitationId: randomUUID(), organizationId: randomUUID(), schoolId: randomUUID() };
const token = randomBytes(32).toString('base64url');
const grant = (over = {}) => ({ ...ids, email: 'parent@example.invalid', schoolName: 'Riverside <Dojo> & "Friends"', familyName: 'Rivera family', expiresAt: '2026-12-05T10:00:00.000Z', emailNumber: 1, replayed: false, ...over });
const body = (over = {}) => ({ schoolId: ids.schoolId, invitationId: ids.invitationId, token, language: 'en', ...over });
const req = () => ({ honIdentity: { externalSubject: 'oidc:fixture:staff-' + randomUUID() }, headers: {}, res: { setHeader() {} } });
const adapter = (send, readiness = 'READY') => ({ provider: 'FAKE', channel: 'EMAIL', readiness: () => readiness, send });
async function withOrigin(value, work) { const saved = process.env.HON_PUBLIC_ORIGIN; if (value === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = value;
  try { return await work(); } finally { if (saved === undefined) delete process.env.HON_PUBLIC_ORIGIN; else process.env.HON_PUBLIC_ORIGIN = saved; } }

test('the invitation email has one button to the fixed page with the invitation in the fragment only, and escapes the school name', () => {
  const mail = familyInvitationEmail({ origin: 'https://app.hon.example', invitationId: ids.invitationId, token, schoolName: grant().schoolName, expiresAt: grant().expiresAt, language: 'en' });
  assert.equal(mail.link, `https://app.hon.example/family-invite#i=${ids.invitationId}&c=${token}`);
  assert.equal(new URL(mail.link).search, '');
  assert.equal(mail.html.split('<a href=').length, 2);
  assert(mail.html.includes(`<a href="${mail.link.replace(/&/g, '&amp;')}"`));
  assert(mail.html.includes('Riverside &lt;Dojo&gt; &amp; &quot;Friends&quot;') && !mail.html.includes('<Dojo>'));
  assert(mail.text.includes(mail.link) && mail.text.includes('December 5, 2026') && mail.text.includes('Activate my family access'));
  assert(mail.subject.length <= 150 && !/[\r\n]/.test(mail.subject) && mail.subject.includes('invited you to the HON Family app'));
  assert.equal(familyInvitationEmail({ origin: 'https://app.hon.example', invitationId: ids.invitationId, token, schoolName: 'Bad\r\nBcc: x@example.invalid', expiresAt: grant().expiresAt, language: 'en' }).subject.includes('\n'), false);
  for (const language of ['ko', 'es']) assert.notEqual(familyInvitationEmail({ origin: 'https://app.hon.example', invitationId: ids.invitationId, token, schoolName: 'Dojo', expiresAt: grant().expiresAt, language }).subject, mail.subject);
  for (const good of ['https://app.myhonos.com', 'http://localhost:3000']) assert.equal(familyInviteOrigin(good), good);
  for (const bad of [undefined, '', 'http://app.myhonos.com', 'https://app.myhonos.com/', 'https://app.myhonos.com/x', 'javascript:alert(1)']) assert.equal(familyInviteOrigin(bad), null);
});

test('email input is closed: no address, family, role or extra field can be supplied', () => {
  assert.deepEqual(c.validateFamilyInvitationEmailInput(body()), body());
  for (const patch of [{ email: 'other@example.invalid' }, { familyId: randomUUID() }, { language: 'fr' }, { token: 'short' }, { schoolId: 'x' }, { invitationId: undefined }])
    assert.throws(() => c.validateFamilyInvitationEmailInput({ ...body(), ...patch }));
  assert.throws(() => c.validateFamilyInvitationEmailGrant({ ...grant(), token }));
  assert.throws(() => c.validateFamilyInvitationEmailGrant(grant({ emailNumber: 4 })));
  assert.throws(() => c.validateFamilyInvitationEmailReceipt({ invitationId: ids.invitationId, email: 'parent@example.invalid', emailNumber: 1, delivery: 'QUEUED' }));
});

test('nothing is recorded or sent while email sending is off or the public origin is missing', async () => {
  for (const [adapters, origin] of [[[], 'https://app.hon.example'], [[adapter(async () => { throw new Error('never'); }, 'CONFIGURATION_REQUIRED')], 'https://app.hon.example'],
    [[adapter(async () => { throw new Error('never'); })], undefined], [[adapter(async () => { throw new Error('never'); })], 'http://not-https.example']]) {
    const calls = [], service = new SchoolFamilyAccessInvitationService({ callSchoolFamilyAccount: async (...args) => { calls.push(args); return grant(); } }, adapters);
    await withOrigin(origin, () => assert.rejects(() => service.email(req(), body(), randomUUID()), e => e.status === 503 && e.response.code === 'ACCOUNT_EMAIL_OFF' && e.response.outcome === 'NOT_SUBMITTED'));
    assert.equal(calls.length, 0);
  }
});

test('the database decides the address; the code reaches SQL only as its hash and the provider only inside the link', async () => {
  const calls = [], sends = [], key = randomUUID();
  const service = new SchoolFamilyAccessInvitationService({ callSchoolFamilyAccount: async (...args) => { calls.push(args); return grant(); } }, [adapter(async request => { sends.push(request); return { providerMessageId: 'x', sentAs: 'EMAIL' }; })]);
  const identity = req();
  const receipt = await withOrigin('https://app.hon.example', () => service.email(identity, body({ language: 'es' }), key));
  assert.deepEqual(receipt, { invitationId: ids.invitationId, email: 'parent@example.invalid', emailNumber: 1, delivery: 'SENT' });
  assert.equal(calls[0][0], 'email'); assert.equal(calls[0][1][0], identity.honIdentity.externalSubject); assert.equal(calls[0][1][2], key);
  assert.deepEqual(JSON.parse(calls[0][1][1]), { schoolId: ids.schoolId, invitationId: ids.invitationId, tokenHash: createHash('sha256').update(token).digest('hex') });
  assert(!JSON.stringify(calls).includes(token));
  assert.equal(sends.length, 1);
  const sent = sends[0];
  assert.equal(sent.recipientAddress, 'parent@example.invalid'); assert.equal(sent.purpose, 'ACCOUNT'); assert.equal(sent.channel, 'EMAIL'); assert.equal(sent.deliveryId, key);
  assert(sent.content.includes(`#i=${ids.invitationId}&c=${token}`) && sent.html.includes(token) && sent.subject.includes('HON Family'));
  for (const bad of [{ ...body(), email: 'attacker@example.invalid' }, { ...body(), token: 'x' }, null]) await withOrigin('https://app.hon.example', () => assert.rejects(() => service.email(req(), bad, randomUUID()), e => e.status === 400));
  await withOrigin('https://app.hon.example', () => assert.rejects(() => service.email(req(), body(), 'not-a-key'), e => e.status === 400));
  assert.equal(sends.length, 1);
});

test('a replayed request sends nothing; provider refusals and uncertainty are reported, never thrown', async () => {
  const run = async (data, send) => { const sends = []; const service = new SchoolFamilyAccessInvitationService({ callSchoolFamilyAccount: async () => data }, [adapter(async request => { sends.push(request); return send(); })]);
    return { receipt: await withOrigin('https://app.hon.example', () => service.email(req(), body(), randomUUID())), sends }; };
  const replay = await run(grant({ replayed: true, emailNumber: 2 }), () => { throw new Error('never'); });
  assert.equal(replay.receipt.delivery, 'ALREADY_REQUESTED'); assert.equal(replay.receipt.emailNumber, 2); assert.equal(replay.sends.length, 0);
  assert.equal((await run(grant(), () => { throw new CommunicationProviderError('FAILED', 'INVALID_ADDRESS'); })).receipt.delivery, 'NOT_SENT');
  assert.equal((await run(grant(), () => { throw new CommunicationProviderError('RETRYABLE', 'PROVIDER_FAILED'); })).receipt.delivery, 'NOT_SENT');
  assert.equal((await run(grant(), () => { throw new CommunicationProviderError('UNKNOWN'); })).receipt.delivery, 'UNKNOWN');
  assert.equal((await run(grant(), () => { throw new Error('socket'); })).receipt.delivery, 'UNKNOWN');
});

test('database refusals map to closed codes: forbidden, unavailable, the three-email limit, and a malformed answer', async () => {
  const fail = code => new SchoolFamilyAccessInvitationService({ callSchoolFamilyAccount: async () => { throw Object.assign(new Error('x'), { code }); } }, [adapter(async () => { throw new Error('never'); })]);
  for (const [sqlstate, status, code] of [['42501', 403, 'ACCOUNT_FORBIDDEN'], ['P0002', 404, 'ACCOUNT_UNAVAILABLE'], ['54000', 429, 'ACCOUNT_EMAIL_LIMIT'], ['23505', 409, 'ACCOUNT_CONFLICT'], ['XX000', 503, 'ACCOUNT_UNAVAILABLE']])
    await withOrigin('https://app.hon.example', () => assert.rejects(() => fail(sqlstate).email(req(), body(), randomUUID()), e => e.status === status && e.response.code === code));
  const odd = new SchoolFamilyAccessInvitationService({ callSchoolFamilyAccount: async () => ({ ...grant(), token }) }, [adapter(async () => { throw new Error('never'); })]);
  await withOrigin('https://app.hon.example', () => assert.rejects(() => odd.email(req(), body(), randomUUID()), e => e.status === 503));
});

test('SendGrid sends an ACCOUNT email as text plus the given HTML, tagged so school receipts ignore it, with click tracking off', () => {
  const provider = new SendGridEmailProvider(() => ({ SENDGRID_API_KEY: 'SG.test', HON_EMAIL_FROM: 'notices@hon.example', HON_EMAIL_SEND_APPROVED: 'true' }));
  const base = { deliveryId: randomUUID(), messageId: ids.invitationId, organizationId: ids.organizationId, schoolId: ids.schoolId, channel: 'EMAIL', recipientAddress: 'parent@example.invalid', content: 'text part', schoolName: 'Dojo', attempt: 1, subject: 'Dojo invited you' };
  const account = provider.requestBody({ ...base, purpose: 'ACCOUNT', html: '<p>html part</p>' });
  assert.deepEqual(account.content, [{ type: 'text/plain', value: 'text part' }, { type: 'text/html', value: '<p>html part</p>' }]);
  assert.equal(account.personalizations[0].custom_args.hon_purpose, 'ACCOUNT'); assert.equal(account.subject, 'Dojo invited you');
  assert.equal(account.tracking_settings.click_tracking.enable, false);
  // A school delivery never gets an HTML part from this field.
  assert.deepEqual(provider.requestBody({ ...base, html: '<p>html part</p>' }).content, [{ type: 'text/plain', value: 'text part' }]);
});
