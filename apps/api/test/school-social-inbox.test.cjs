const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const { SchoolSocialInboxService } = require('../dist/marketing/social/school-social-inbox.service.js');
const { FakeZernioSocialAdapter, ZernioHttpSocialAdapter, SocialProviderError, zernioInboxApproved, zernioSocialAdapterFactory } = require('../dist/marketing/social/zernio-social-adapter.js');
const { ZernioLeadWebhookVerifier, ZernioWebhookError, zernioInboxEventsReady } = require('../dist/communication/delivery/zernio-lead-webhook.js');
const { CommunicationWebhookController } = require('../dist/communication/delivery/communication-webhook.controller.js');
const { SendGridEventWebhookVerifier } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { TwilioWebhookVerifier } = require('../dist/communication/delivery/twilio-text-provider.js');

// Mocked boundary tests for the 0349 inbox API, Zernio inbox calls and inbound events. Authority, leases, the reply
// window and evidence are proven against PostgreSQL by test-school-social-inbox.mjs. Nothing reaches Zernio: the HTTP
// adapter gets a stub fetch and the service gets the deterministic fake or a stub.
const KEY = 'sk_' + 'c'.repeat(64);
const secret = 'w'.repeat(40);
const at = '2026-11-14T05:00:00.000Z';
const scope = { organizationId: randomUUID(), schoolId: randomUUID(), principalId: randomUUID() };
const context = (patch = {}) => ({ ...scope, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: randomUUID(), correlationId: randomUUID(), idempotencyKey: 'inbox-key', externalSubject: 'verified-human', ...patch });
const readContext = () => context({ idempotencyKey: '' });
const status = (value, code) => (error) => { assert.equal(error.getStatus(), value, JSON.stringify(error.getResponse?.())); if (code) assert.equal(error.getResponse().code, code); return true; };
const conversationId = randomUUID(), accountId = randomUUID(), messageId = randomUUID(), actionId = randomUUID(), leaseToken = randomUUID();
const conversation = (patch = {}) => ({ conversationId, accountId, platform: 'FACEBOOK', accountName: 'Synthetic Dojo Page', kind: 'DM', participantName: 'Synthetic Parent',
  lastInboundAt: at, lastMessageAt: at, unread: 1, assignedPrincipalId: null, linkedLeadId: null, linkedPersonId: null, commentHidden: false, inboxOn: true,
  replyWindowOpen: true, preview: 'Do you have kids classes?', version: 2, ...patch });
const message = (patch = {}) => ({ messageId, direction: 'OUTBOUND', text: 'Yes, Saturdays at 10.', status: 'SENDING', sentByPerson: true, resolvedByPerson: false, occurredAt: at, version: 1, ...patch });
const replySend = (patch = {}) => ({ messageId, leaseToken, platform: 'FACEBOOK', kind: 'DM', providerAccountId: 'fb1', providerConversationId: 'conv_1', ...patch });
const commentSend = (patch = {}) => ({ actionId, leaseToken, platform: 'FACEBOOK', providerAccountId: 'fb1', providerCommentId: 'cmt_1', hidden: true, ...patch });

function fixture(options = {}) {
  const queries = [];
  const answer = (name, fallback) => { const v = options[name] ?? fallback; if (v instanceof Error) throw v; return { rows: [{ data: typeof v === 'function' ? v() : v }] }; };
  const db = {
    async transaction(c, work, readOnly) {
      return work({ query: async (sql, args = []) => {
        queries.push({ sql, args, readOnly });
        if (/^SET LOCAL/.test(sql) || /set_config\('app\.hon_source','HUMAN_UI'/.test(sql)) return { rows: [] };
        if (options.error) throw options.error;
        if (/read_school_social_inbox\(/.test(sql)) return answer('list', { conversations: [conversation()], checkedAt: at });
        if (/read_school_social_conversation\(/.test(sql)) return answer('detail', { conversation: conversation(), messages: [message({ direction: 'INBOUND', status: 'RECEIVED', sentByPerson: false })], checkedAt: at });
        if (/change_school_social_conversation\(/.test(sql)) return answer('change', { record: conversation({ unread: 0, version: 3 }), replayed: false });
        if (/start_school_social_reply\(/.test(sql)) return answer('start', { record: { conversation: conversation({ unread: 0, version: 3 }), message: message() }, replayed: false, send: replySend() });
        if (/record_school_social_reply_result\(/.test(sql)) return answer('record', () => ({ message: message({ status: args[3] === 'SENT' ? 'SENT' : args[3], version: 2 }), accepted: true }));
        if (/resolve_school_social_message\(/.test(sql)) return answer('resolve', { record: message({ status: 'SENT', resolvedByPerson: true, version: 3 }), replayed: false });
        if (/start_school_social_comment_action\(/.test(sql)) return answer('startComment', { record: { conversation: conversation({ kind: 'COMMENT' }), actionId, action: 'HIDE', status: 'SENDING' }, replayed: false, send: commentSend() });
        if (/record_school_social_comment_action_result\(/.test(sql)) return answer('recordComment', () => ({ conversation: conversation({ kind: 'COMMENT', commentHidden: args[3] === 'DONE', version: 3 }), actionId, action: 'HIDE', status: args[3], accepted: true }));
        throw new Error('Unexpected SQL: ' + sql);
      } });
    },
    withTenantTransaction(c, work) { return this.transaction(c, work, false); },
    withTenantReadOnlyTransaction(c, work) { return this.transaction(c, work, true); },
  };
  return { db, queries };
}
const fake = () => new FakeZernioSocialAdapter(() => ({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'development' }));
const off = { inboxReady: () => false, sendReply: async () => { throw new Error('must not send'); }, setCommentHidden: async () => { throw new Error('must not send'); } };

test('switches: the inbox needs a well-formed key AND the exact approval; it turns on neither connecting nor publishing', () => {
  assert.equal(zernioInboxApproved({}), false);
  assert.equal(zernioInboxApproved({ ZERNIO_API_KEY: KEY }), false);
  assert.equal(zernioInboxApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_INBOX_APPROVED: 'yes' }), false);
  assert.equal(zernioInboxApproved({ ZERNIO_API_KEY: 'zrk_short', HON_ZERNIO_INBOX_APPROVED: 'true' }), false);
  assert.equal(zernioInboxApproved({ ZERNIO_API_KEY: KEY, HON_ZERNIO_INBOX_APPROVED: 'true' }), true);
  assert.equal(zernioSocialAdapterFactory({ ZERNIO_API_KEY: KEY, HON_ZERNIO_INBOX_APPROVED: 'true' }).kind, 'ZERNIO');
  const real = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY, HON_ZERNIO_INBOX_APPROVED: 'true' }));
  assert.deepEqual([real.inboxReady(), real.publishReady(), real.ready()], [true, false, false]);
  const publishOnly = new ZernioHttpSocialAdapter(() => ({ ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true' }));
  assert.equal(publishOnly.inboxReady(), false);
  assert.equal(zernioSocialAdapterFactory({}).inboxReady(), false);
  assert.equal(new FakeZernioSocialAdapter(() => ({ HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'staging' })).inboxReady(), false);
});

test('inbox reads: view ALL by default, UNREAD/MINE and before only; one read-only call each; report whether replying is on', async () => {
  const { db, queries } = fixture();
  const service = new SchoolSocialInboxService(db, off);
  const list = await service.list(readContext(), {});
  assert.deepEqual([list.conversations.length, list.inboxEnabled], [1, false]);
  assert.deepEqual(queries.find(q => /read_school_social_inbox/.test(q.sql)).args, ['verified-human', '{"view":"ALL"}']);
  await service.list(readContext(), { view: 'MINE', before: '2026-11-13T00:00:00Z' });
  assert.deepEqual(queries.filter(q => /read_school_social_inbox/.test(q.sql)).at(-1).args[1], '{"view":"MINE","before":"2026-11-13T00:00:00Z"}');
  assert.ok(queries.filter(q => /read_school_social/.test(q.sql)).every(q => q.readOnly));
  for (const query of [{ view: 'SPAM' }, { view: ['ALL'] }, { before: 'yesterday' }, { schoolId: randomUUID() }, { view: 'ALL', limit: '500' }]) {
    await assert.rejects(service.list(readContext(), query), status(400, 'SOCIAL_INVALID'), JSON.stringify(query));
  }
  const detail = await new SchoolSocialInboxService(fixture().db, fake()).conversation(readContext(), conversationId.toUpperCase());
  assert.deepEqual([detail.messages.length, detail.inboxEnabled, detail.messages[0].status], [1, true, 'RECEIVED']);
  // A read for one conversation that answers with another is refused.
  const other = fixture({ detail: { conversation: conversation({ conversationId: randomUUID() }), messages: [], checkedAt: at } });
  await assert.rejects(new SchoolSocialInboxService(other.db, off).conversation(readContext(), conversationId), /Unverified|SOCIAL_UNAVAILABLE/);
  // Reads take no idempotency key; commands need one.
  await assert.rejects(service.list(context(), {}), status(403, 'SOCIAL_FORBIDDEN'));
  await assert.rejects(service.change(readContext(), conversationId, { expectedVersion: 2, read: true }), status(403, 'SOCIAL_FORBIDDEN'));
  await assert.rejects(service.list({ ...readContext(), source: 'AI_ACTION' }, {}), status(403, 'SOCIAL_FORBIDDEN'));
});

test('conversation change: strict body, exact arguments, the same conversation back, no provider call', async () => {
  const { db, queries } = fixture();
  const service = new SchoolSocialInboxService(db, off);
  const lead = randomUUID();
  const out = await service.change(context(), conversationId, { expectedVersion: 2, read: true, linkedLeadId: lead });
  assert.deepEqual([out.conversation.unread, out.replayed], [0, false]);
  const call = queries.find(q => /change_school_social_conversation/.test(q.sql));
  assert.equal(call.readOnly, false);
  assert.deepEqual(call.args.slice(0, 4), ['verified-human', conversationId, JSON.stringify({ expectedVersion: 2, read: true, linkedLeadId: lead }), 'inbox-key']);
  for (const body of [{}, { expectedVersion: 2 }, { expectedVersion: 2, read: false }, { expectedVersion: 0, read: true }, { expectedVersion: 2, read: true, schoolId: randomUUID() },
    { expectedVersion: 2, assignedPrincipalId: 'someone' }, null, []]) {
    await assert.rejects(service.change(context(), conversationId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
  const wrong = fixture({ change: { record: conversation({ conversationId: randomUUID() }), replayed: false } });
  await assert.rejects(new SchoolSocialInboxService(wrong.db, off).change(context(), conversationId, { expectedVersion: 2, read: true }), /Unverified|SOCIAL_UNAVAILABLE/);
});

test('reply: refused before anything is recorded while the inbox is off; sent once with the message id as key; outcomes recorded under the lease', async () => {
  const offFixture = fixture();
  await assert.rejects(new SchoolSocialInboxService(offFixture.db, off).reply(context(), conversationId, { text: 'Hi' }), status(503, 'SOCIAL_INBOX_NOT_ENABLED'));
  assert.equal(offFixture.queries.length, 0);
  // Sent: one provider call with the recorded message id as idempotency key; then SENT with the provider id.
  const provider = fake(), { db, queries } = fixture();
  const out = await new SchoolSocialInboxService(db, provider).reply(context(), conversationId, { text: 'Yes, Saturdays at 10.' });
  assert.equal(provider.replies.length, 1);
  assert.deepEqual({ ...provider.replies[0], providerMessageId: undefined },
    { providerAccountId: 'fb1', platform: 'FACEBOOK', kind: 'DM', providerConversationId: 'conv_1', text: 'Yes, Saturdays at 10.', idempotencyKey: messageId, providerMessageId: undefined });
  const record = queries.find(q => /record_school_social_reply_result/.test(q.sql));
  assert.deepEqual(record.args.slice(0, 5), ['verified-human', messageId, leaseToken, 'SENT', provider.replies[0].providerMessageId]);
  assert.deepEqual([out.reply.message.status, out.reply.conversation.conversationId, out.replayed], ['SENT', conversationId, false]);
  // Each provider failure: only a definite refusal is FAILED; anything that may have gone out is UNKNOWN.
  for (const [failure, outcome] of [['REJECTED', 'FAILED'], ['RATE_LIMITED', 'FAILED'], ['UNKNOWN', 'UNKNOWN'], ['UNAVAILABLE', 'UNKNOWN']]) {
    const p = fake(); p.failNext.sendReply = failure;
    const f = fixture();
    const r = await new SchoolSocialInboxService(f.db, p).reply(context(), conversationId, { text: 'Hello' });
    assert.equal(f.queries.find(q => /record_school_social_reply_result/.test(q.sql)).args[3], outcome, failure);
    assert.equal(f.queries.find(q => /record_school_social_reply_result/.test(q.sql)).args[4], null);
    assert.equal(r.reply.message.status, outcome);
  }
  // Recording the answer fails after the send: the reply reads UNKNOWN and is not sent again.
  const lost = fake(), lostFixture = fixture({ record: new Error('connection lost') });
  const r = await new SchoolSocialInboxService(lostFixture.db, lost).reply(context(), conversationId, { text: 'Hello' });
  assert.deepEqual([r.reply.message.status, lost.replies.length], ['UNKNOWN', 1]);
  // A replayed command sends nothing.
  const again = fake(), replay = fixture({ start: { record: { conversation: conversation(), message: message({ status: 'SENT', version: 2 }) }, replayed: true } });
  const rr = await new SchoolSocialInboxService(replay.db, again).reply(context(), conversationId, { text: 'Hello' });
  assert.deepEqual([rr.replayed, again.replies.length, replay.queries.some(q => /record_school_social_reply_result/.test(q.sql))], [true, 0, false]);
  // A first start must carry exactly one send for the same message; a replay must not carry one.
  for (const start of [{ record: { conversation: conversation(), message: message() }, replayed: false },
    { record: { conversation: conversation(), message: message() }, replayed: false, send: replySend({ messageId: randomUUID() }) },
    { record: { conversation: conversation(), message: message() }, replayed: false, send: replySend({ kind: 'COMMENT' }) },
    { record: { conversation: conversation(), message: message() }, replayed: true, send: replySend() }]) {
    const p = fake();
    await assert.rejects(new SchoolSocialInboxService(fixture({ start }).db, p).reply(context(), conversationId, { text: 'Hello' }), /Unverified|SOCIAL_UNAVAILABLE/);
    assert.equal(p.replies.length, 0);
  }
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(2001) }, { text: 'bell\u0007' }, { text: 'hi', conversationId }]) {
    await assert.rejects(new SchoolSocialInboxService(fixture().db, fake()).reply(context(), conversationId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
});

test('resolve and comment actions: strict bodies; hide/unhide sent once under its own key; only a refusal is FAILED', async () => {
  const { db, queries } = fixture();
  const resolved = await new SchoolSocialInboxService(db, off).resolve(context(), messageId, { expectedVersion: 2, outcome: 'SENT' });
  assert.deepEqual([resolved.message.status, resolved.message.resolvedByPerson], ['SENT', true]);
  assert.deepEqual(queries.find(q => /resolve_school_social_message/.test(q.sql)).args.slice(1, 3), [messageId, '{"expectedVersion":2,"outcome":"SENT"}']);
  for (const body of [{ outcome: 'SENT' }, { expectedVersion: 2, outcome: 'MAYBE' }, { expectedVersion: 2, outcome: 'SENT', resend: true }]) {
    await assert.rejects(new SchoolSocialInboxService(fixture().db, off).resolve(context(), messageId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
  const offComment = fixture();
  await assert.rejects(new SchoolSocialInboxService(offComment.db, off).comment(context(), conversationId, { action: 'HIDE' }), status(503, 'SOCIAL_INBOX_NOT_ENABLED'));
  assert.equal(offComment.queries.length, 0);
  const provider = fake(), f = fixture();
  const hidden = await new SchoolSocialInboxService(f.db, provider).comment(context(), conversationId, { action: 'HIDE' });
  assert.deepEqual(provider.commentActions, [{ providerCommentId: 'cmt_1', hidden: true, idempotencyKey: actionId }]);
  assert.deepEqual([hidden.result.status, hidden.result.conversation.commentHidden], ['DONE', true]);
  assert.deepEqual(f.queries.find(q => /record_school_social_comment_action_result/.test(q.sql)).args.slice(0, 4), ['verified-human', actionId, leaseToken, 'DONE']);
  for (const [failure, outcome] of [['REJECTED', 'FAILED'], ['UNKNOWN', 'UNKNOWN']]) {
    const p = fake(); p.failNext.setCommentHidden = failure;
    const g = fixture();
    const r = await new SchoolSocialInboxService(g.db, p).comment(context(), conversationId, { action: 'HIDE' });
    assert.equal(r.result.status, outcome, failure);
  }
  const lost = await new SchoolSocialInboxService(fixture({ recordComment: new Error('gone') }).db, fake()).comment(context(), conversationId, { action: 'HIDE' });
  assert.equal(lost.result.status, 'UNKNOWN');
  // The send must match the action asked for.
  await assert.rejects(new SchoolSocialInboxService(fixture({ startComment: { record: { conversation: conversation({ kind: 'COMMENT' }), actionId, action: 'HIDE', status: 'SENDING' }, replayed: false,
    send: commentSend({ hidden: false }) } }).db, fake()).comment(context(), conversationId, { action: 'HIDE' }), /Unverified|SOCIAL_UNAVAILABLE/);
  for (const body of [{}, { action: 'DELETE' }, { action: 'HIDE', commentId: 'x' }]) {
    await assert.rejects(new SchoolSocialInboxService(fixture().db, fake()).comment(context(), conversationId, body), status(400, 'SOCIAL_INVALID'), JSON.stringify(body));
  }
});

test('database refusals map to closed codes with no SQL text', async () => {
  const cases = [['SOCIAL_FORBIDDEN', '42501', 403], ['SOCIAL_CONVERSATION_NOT_FOUND', 'P0002', 404], ['SOCIAL_LINK_NOT_FOUND', 'P0002', 422],
    ['SOCIAL_ASSIGNEE_INVALID', '22023', 422], ['SOCIAL_INBOX_OFF', '23514', 409], ['SOCIAL_REPLY_WINDOW_CLOSED', '55000', 409],
    ['SOCIAL_INBOX_STATE', '55000', 409], ['SOCIAL_VERSION_CONFLICT', '40001', 409], ['SOCIAL_BUSY', '55P03', 409], ['IDEMPOTENCY_KEY_REUSED', '23505', 409]];
  for (const [message, code, httpStatus] of cases) {
    const error = Object.assign(new Error(message), { code });
    await assert.rejects(new SchoolSocialInboxService(fixture({ error }).db, off).change(context(), conversationId, { expectedVersion: 2, read: true }), status(httpStatus, message), message);
  }
  const leak = Object.assign(new Error('relation hon.school_social_messages does not exist'), { code: '42P01' });
  await assert.rejects(new SchoolSocialInboxService(fixture({ error: leak }).db, off).list(readContext(), {}),
    (e) => e.getStatus() === 503 && !JSON.stringify(e.getResponse()).includes('school_social_messages'));
});

test('HTTP adapter inbox calls: refuse unless the inbox is approved; exact paths and bodies; idempotency key; 4xx rejected, 5xx unknown; no leaks', async () => {
  const calls = [], routes = [];
  const reply = (code, body, type = 'application/json') => new Response(body === undefined ? null : JSON.stringify(body), { status: code, headers: { 'content-type': type } });
  const send = async (url, init) => { calls.push({ url, init }); const r = routes.shift(); return typeof r === 'function' ? r() : r; };
  let env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_CONNECT_APPROVED: 'true', HON_ZERNIO_PUBLISH_APPROVED: 'true' };
  const adapter = new ZernioHttpSocialAdapter(() => env, send);
  const dm = { providerAccountId: 'fb1', platform: 'FACEBOOK', kind: 'DM', providerConversationId: 'conv_1', text: 'Hello', idempotencyKey: messageId };
  await assert.rejects(adapter.sendReply(dm), e => e instanceof SocialProviderError && e.failure === 'NOT_ENABLED');
  await assert.rejects(adapter.setCommentHidden({ providerAccountId: 'fb1', providerCommentId: 'cmt_1', hidden: true, idempotencyKey: actionId }), e => e.failure === 'NOT_ENABLED');
  assert.equal(calls.length, 0);
  env = { ZERNIO_API_KEY: KEY, HON_ZERNIO_INBOX_APPROVED: 'true' };
  routes.push(reply(201, { message: { id: 'mid_1' } }));
  assert.deepEqual(await adapter.sendReply(dm), { providerMessageId: 'mid_1' });
  let call = calls.at(-1);
  assert.equal(call.url, 'https://zernio.com/api/v1/inbox/conversations/conv_1/messages'); assert.equal(call.init.headers['Idempotency-Key'], messageId);
  assert.equal(call.init.redirect, 'error'); assert.deepEqual(JSON.parse(call.init.body), { accountId: 'fb1', message: 'Hello' });
  routes.push(reply(201, { comment: { _id: 'cmt_9' } }));
  assert.deepEqual(await adapter.sendReply({ ...dm, kind: 'COMMENT', providerConversationId: 'cmt_1' }), { providerMessageId: 'cmt_9' });
  assert.equal(calls.at(-1).url, 'https://zernio.com/api/v1/inbox/comments/cmt_1/reply');
  routes.push(reply(204));
  await adapter.setCommentHidden({ providerAccountId: 'fb1', providerCommentId: 'cmt_1', hidden: true, idempotencyKey: actionId });
  call = calls.at(-1);
  assert.equal(call.url, 'https://zernio.com/api/v1/inbox/comments/cmt_1/hide'); assert.equal(call.init.headers['Idempotency-Key'], actionId);
  routes.push(reply(200, {}));
  await adapter.setCommentHidden({ providerAccountId: 'fb1', providerCommentId: 'cmt_1', hidden: false, idempotencyKey: actionId });
  assert.equal(calls.at(-1).url, 'https://zernio.com/api/v1/inbox/comments/cmt_1/unhide');
  const before = calls.length;
  await assert.rejects(adapter.sendReply({ ...dm, providerConversationId: '../accounts' }), e => e.failure === 'REJECTED');
  assert.equal(calls.length, before);
  for (const [r, failure] of [[reply(400, { error: 'bad ' + KEY }), 'REJECTED'], [reply(403, {}), 'REJECTED'], [reply(429, {}), 'RATE_LIMITED'], [reply(409, {}), 'UNKNOWN'],
    [reply(500, {}), 'UNKNOWN'], [reply(201, {}), 'UNKNOWN'], [reply(204), 'UNKNOWN'], [reply(201, '<html>', 'text/html'), 'UNKNOWN'], [() => { throw new Error('socket ' + KEY); }, 'UNKNOWN']]) {
    routes.push(r);
    await assert.rejects(adapter.sendReply(dm), e => e instanceof SocialProviderError && e.failure === failure && !e.message.includes(KEY), failure);
  }
});

const sign = (body, key = secret) => createHmac('sha256', key).update(body).digest('hex');
const raw = (value) => Buffer.from(JSON.stringify(value));
const reason = (fn) => { try { fn(); return 'OK'; } catch (error) { return error instanceof ZernioWebhookError ? error.reason : error.message; } };
const inboxEnv = (over = {}) => ({ ZERNIO_WEBHOOK_SECRET: secret, ZERNIO_API_KEY: KEY, HON_ZERNIO_INBOX_APPROVED: 'true', ...over });
const dmEvent = (patch = {}, item = {}) => ({ id: 'evt_m1', event: 'message.received', account: { id: 'fb1', platform: 'facebook', accessToken: 'x' }, conversation: { id: 'conv_1' },
  message: { id: 'mid_1', text: 'Do you have kids classes?', createdAt: '2026-11-14T04:59:00Z', from: { name: 'Synthetic Parent', email: 'ignored@example.test' }, ...item }, ...patch });
const commentEvent = (item = {}) => ({ id: 'evt_c1', event: 'comment.received', account: { _id: 'ig9', platform: 'instagram' },
  comment: { _id: 'cmt_2', text: 'How much?', createdAt: '2026-11-14T04:58:00Z', parentId: 'cmt_1', postId: 'igpost_1', from: { id: 'u77', name: 'Synthetic Student' }, ...item } });

test('inbound events: only while the inbox is on; signed; echoes and media-only messages dropped; text cleaned; other fields ignored', () => {
  assert.equal(zernioInboxEventsReady({}), false);
  assert.equal(zernioInboxEventsReady(inboxEnv({ ZERNIO_WEBHOOK_SECRET: 'short' })), false);
  assert.equal(zernioInboxEventsReady(inboxEnv({ HON_ZERNIO_INBOX_APPROVED: 'TRUE' })), false);
  assert.equal(zernioInboxEventsReady(inboxEnv()), true);
  assert.equal(zernioInboxEventsReady({ ZERNIO_WEBHOOK_SECRET: secret, HON_ZERNIO_FAKE_PROVIDER: '1', HON_DEPLOYMENT_ENVIRONMENT: 'production' }), false);
  const verifier = new ZernioLeadWebhookVerifier(() => inboxEnv());
  let body = raw(dmEvent());
  assert.deepEqual(verifier.receive(body, sign(body)), { kind: 'INBOX', event: { eventId: 'evt_m1', eventType: 'message.received', platform: 'FACEBOOK', providerAccountId: 'fb1',
    providerConversationId: 'conv_1', providerMessageId: 'mid_1', providerPostId: null, participantName: 'Synthetic Parent', text: 'Do you have kids classes?', occurredAt: '2026-11-14T04:59:00.000Z' } });
  body = raw(commentEvent());
  assert.deepEqual(verifier.receive(body, sign(body)).event, { eventId: 'evt_c1', eventType: 'comment.received', platform: 'INSTAGRAM', providerAccountId: 'ig9',
    providerConversationId: 'cmt_1', providerMessageId: 'cmt_2', providerPostId: 'igpost_1', participantName: 'Synthetic Student', text: 'How much?', occurredAt: '2026-11-14T04:58:00.000Z' });
  // A top-level comment is its own conversation.
  body = raw(commentEvent({ parentId: undefined }));
  assert.equal(verifier.receive(body, sign(body)).event.providerConversationId, 'cmt_2');
  assert.equal(reason(() => verifier.receive(body, sign(body, 'z'.repeat(40)))), 'SIGNATURE_INVALID');
  // Control characters are removed, text capped at 2000, names default by platform.
  body = raw(dmEvent({}, { text: 'hi\u0007 there' + 'x'.repeat(3000), from: {} }));
  const cleaned = verifier.receive(body, sign(body)).event;
  assert.deepEqual([cleaned.text.slice(0, 8), cleaned.text.length, cleaned.participantName], ['hi there', 2000, 'Facebook user']);
  for (const dropped of [dmEvent({}, { isEcho: true }), dmEvent({}, { direction: 'outgoing' }), dmEvent({}, { text: '' }), dmEvent({}, { text: undefined, attachments: [{}] }),
    commentEvent({ from: { id: 'ig9', name: 'Synthetic Dojo' } }), { ...dmEvent(), test: true }]) {
    const b = raw(dropped); assert.equal(verifier.receive(b, sign(b)), null, JSON.stringify(dropped));
  }
  for (const bad of [dmEvent({ id: 'bad id!' }), dmEvent({ conversation: {} }), dmEvent({}, { id: undefined }), dmEvent({ account: { id: 'fb1', platform: 'tiktok' } }),
    commentEvent({ postId: undefined }), commentEvent({ parentId: '../x' })]) {
    const b = raw(bad); assert.equal(reason(() => verifier.receive(b, sign(b))), 'MALFORMED', JSON.stringify(bad));
  }
  // Inbox off (publishing on): DMs and comments are acknowledged and not stored.
  const publishOnly = new ZernioLeadWebhookVerifier(() => ({ ZERNIO_WEBHOOK_SECRET: secret, ZERNIO_API_KEY: KEY, HON_ZERNIO_PUBLISH_APPROVED: 'true' }));
  body = raw(dmEvent()); assert.equal(publishOnly.receive(body, sign(body)), null);
  // Nothing on at all: refused before the signature is read.
  assert.equal(reason(() => new ZernioLeadWebhookVerifier(() => ({ ZERNIO_WEBHOOK_SECRET: secret })).receive(body, sign(body))), 'NOT_CONFIGURED');
});

test('webhook controller: inbound events go to the worker store once; bad input 422; database trouble 503', async () => {
  const events = [];
  const store = (result) => ({ isConfigured: () => true, recordZernioLead: async () => { throw new Error('not a lead'); }, recordSocialPostEvent: async () => { throw new Error('not a post'); },
    recordSocialInboxEvent: async (event) => { events.push(event); if (result instanceof Error) throw result; return { outcome: result }; } });
  const run = async (result, value) => {
    const controller = new CommunicationWebhookController(store(result), new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => ({})), new ZernioLeadWebhookVerifier(() => inboxEnv()));
    const body = raw(value);
    try { return { status: 200, body: await controller.zernioLead({ body }, sign(body)) }; } catch (error) { return { status: error.getStatus() }; }
  };
  for (const outcome of ['APPLIED', 'IGNORED', 'UNMATCHED', 'DUPLICATE', 'REPLAYED']) assert.deepEqual(await run(outcome, dmEvent()), { status: 200, body: { received: true } });
  assert.equal((await run(new Error('connection lost'), dmEvent())).status, 503);
  assert.equal((await run(Object.assign(new Error('bad'), { code: '22023' }), dmEvent())).status, 422);
  assert.equal(events[0].providerMessageId, 'mid_1');
  const before = events.length;
  assert.deepEqual(await run('APPLIED', dmEvent({}, { isEcho: true })), { status: 200, body: { received: true } });
  assert.equal(events.length, before);
  const noStore = new CommunicationWebhookController({ isConfigured: () => true }, new SendGridEventWebhookVerifier(() => ({})), new TwilioWebhookVerifier(() => ({})), new ZernioLeadWebhookVerifier(() => inboxEnv()));
  const body = raw(dmEvent());
  await assert.rejects(noStore.zernioLead({ body }, sign(body)), (e) => e.getStatus() === 503);
});
