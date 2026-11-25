const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SendGridEmailProvider } = require('../dist/communication/delivery/sendgrid-email-provider.js');
const { CommunicationProviderError } = require('../dist/communication/delivery/communication-provider.js');
const { verifyEmailPictures, renderEmailWithPictures, pictureOrigin } = require('../dist/communication/delivery/email-pictures.js');

// 0653 pictures inside email blasts: the worker's picture list, the text and HTML parts, and the SendGrid request.
// Which pictures are listed (READY, same school, in the blast body, lease holder only) is proven against PostgreSQL by
// packages/database/scripts/test-school-blast-pictures-integrity.mjs.
const A = '3f0c8d0e-4b8a-4c1e-9b7a-2d6f5e4c3b2a', B = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', GONE = '0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e';
const TOKEN = 'T'.repeat(43);
const picture = (over = {}) => ({ assetId: A, kind: 'IMAGE', token: TOKEN, title: 'Open "house" <2026>', width: 1200, height: 800, ...over });
const ORIGIN = 'https://app.example.test';
const approved = (over = {}) => ({ SENDGRID_API_KEY: 'SG.test', HON_EMAIL_FROM: 'notices@hon.example', HON_EMAIL_SEND_APPROVED: 'true', HON_PUBLIC_ORIGIN: ORIGIN, ...over });
const request = (over = {}) => ({
  deliveryId: '11111111-1111-4111-8111-111111111111', messageId: '55555555-5555-4555-8555-555555555555',
  organizationId: '33333333-3333-4333-8333-333333333333', schoolId: '44444444-4444-4444-8444-444444444444',
  channel: 'EMAIL', recipientAddress: 'ada@example.test', content: `Hi Ada,\n{{picture:${A}}}\nSee you <soon> & bring water.\n\n{{picture:${GONE}}}\nBye`,
  schoolName: 'Day School', attempt: 1, ...over,
});

test('the worker picture list is checked: null is text only, anything malformed lists no picture', () => {
  assert.equal(verifyEmailPictures(null), null);
  assert.deepEqual(verifyEmailPictures([picture()]), [picture()]);
  for (const bad of [[picture({ token: 'short' })], [picture({ objectKey: 'media/x' })], [picture({ assetId: 'A' })], [picture({ width: 0 })], [picture({ title: ' x' })],
    'x', Array.from({ length: 11 }, () => picture())]) {
    assert.deepEqual(verifyEmailPictures(bad), [], JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(pictureOrigin('https://app.example.test'), ORIGIN);
  for (const bad of [undefined, '', 'http://app.example.test', 'https://app.example.test/', 'https://a.test/x', 'javascript:alert(1)']) assert.equal(pictureOrigin(bad), null);
});

test('picture lines become links in the text part and images in the HTML part; unknown picture lines are dropped; text is escaped', () => {
  const { text, html } = renderEmailWithPictures(request().content, [picture()], ORIGIN);
  assert.equal(text, `Hi Ada,\n${ORIGIN}/m/${TOKEN}\nSee you <soon> & bring water.\n\nBye`);
  assert.match(html, new RegExp(`<img src="${ORIGIN}/m/${TOKEN}" alt="Open &quot;house&quot; &lt;2026&gt;" width="600" height="400"`));
  assert.match(html, /See you &lt;soon&gt; &amp; bring water\./);
  assert.equal(html.includes(GONE), false);
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.equal(html.includes('<script'), false);
  // A picture line only counts as a whole line.
  const inline = renderEmailWithPictures(`See {{picture:${A}}} here`, [picture()], ORIGIN);
  assert.equal(inline.text, `See {{picture:${A}}} here`); assert.equal(inline.html.includes('<img'), false);
  // A small picture keeps its size.
  assert.match(renderEmailWithPictures(`{{picture:${A}}}`, [picture({ width: 320, height: 200 })], ORIGIN).html, /width="320" height="200"/);
});

test('BL2: HON checkout and video page links in the message become links in the HTML part; other addresses stay text', () => {
  const pid = 'a1'.repeat(24), vtok = 'V'.repeat(43);
  const content = `{{picture:${A}}}\nJoin: ${ORIGIN}/checkout/${pid} today\nWatch ${ORIGIN}/v/${vtok}\nNot ours: https://evil.example/checkout/${pid}\nToo long: ${ORIGIN}/checkout/${pid}ff\nQuote: ${ORIGIN}/checkout/${pid}"><script>`;
  const { text, html } = renderEmailWithPictures(content, [picture()], ORIGIN);
  assert.ok(text.includes(`Join: ${ORIGIN}/checkout/${pid} today`), 'the text part keeps the plain link');
  assert.ok(html.includes(`Join: <a href="${ORIGIN}/checkout/${pid}" style="color:#1f2933">${ORIGIN}/checkout/${pid}</a> today`));
  assert.ok(html.includes(`Watch <a href="${ORIGIN}/v/${vtok}" style="color:#1f2933">${ORIGIN}/v/${vtok}</a>`));
  assert.equal(html.includes('href="https://evil.example'), false);
  assert.equal(html.includes(`href="${ORIGIN}/checkout/${pid}ff"`), false);
  assert.equal((html.match(/<a href=/g) ?? []).length, 3, 'two links plus the quoted one, which stops before the quote');
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;')); assert.equal(html.includes('<script'), false);
});

test('SendGrid sends text and HTML for a blast email with pictures, and text only otherwise', async () => {
  let seen;
  const adapter = new SendGridEmailProvider(() => approved(), async (_url, init) => { seen = JSON.parse(init.body); return { status: 202, headers: new Headers({ 'x-message-id': 'abc123' }) }; });
  await adapter.send(request({ pictures: [picture()] }));
  assert.deepEqual(seen.content.map(c => c.type), ['text/plain', 'text/html']);
  assert.equal(seen.content[0].value.includes(`${ORIGIN}/m/${TOKEN}`), true);
  assert.equal(seen.tracking_settings.open_tracking.enable, false); assert.equal(seen.tracking_settings.click_tracking.enable, false);
  await adapter.send(request());
  assert.deepEqual(seen.content, [{ type: 'text/plain', value: request().content }]);
  // HQ mail never gets the picture treatment.
  await adapter.send(request({ pictures: [picture()], origin: 'HQ', senderEmail: 'hq@hon.example', senderName: 'HON' }));
  assert.deepEqual(seen.content.map(c => c.type), ['text/plain']);
});

test('a blast email with pictures is retried later, never sent half-built, when the site origin is not set', async () => {
  let calls = 0;
  const adapter = new SendGridEmailProvider(() => approved({ HON_PUBLIC_ORIGIN: undefined }), async () => { calls += 1; return { status: 202, headers: new Headers() }; });
  await assert.rejects(adapter.send(request({ pictures: [picture()] })), (e) => e instanceof CommunicationProviderError && e.outcome === 'RETRYABLE');
  assert.equal(calls, 0);
});
