import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LinkError, agreementLinkApi, keepLinkForRetry, linkErrorFor, newLinkToken, publicAgreementLinkApi, signingLinkUrl } from '../src/components/agreement-link/http';
import { SendPanelView, channelBlock, type SendPanelViewProps } from '../src/components/agreement-link/send-panel';
import { SigningView, nameOk, type SigningViewProps } from '../src/components/agreement-link/signing-page';
import { agreementLinkText } from '../src/components/agreement-link/copy';
import { id } from './account-status-fixtures';

// 0499: staff send a one-time agreement link by email and/or text from a student's person card; the family signs at /agreement/<token>.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const school = id(2), student = id(30), hana = id(31), joon = id(32), mina = id(40), jun = id(41), link = id(50), msg = id(60), version = id(70), key = id(77);
const TOKEN = 'A'.repeat(42) + 'B';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as LinkError; } throw new Error('expected a failure'); };
const AT = '2026-11-18T08:00:00Z', LATER = '2026-12-02T08:00:00Z';
const guardians = [
  { personId: hana, givenName: 'Hana', familyName: 'Park', email: { address: true, consent: true }, text: { address: true, consent: false } },
  { personId: joon, givenName: 'Joon', familyName: 'Park', email: { address: false, consent: false }, text: { address: true, consent: true } }];
const read = { current: { versionId: version, number: 1 }, familyId: id(20), guardians, children: [{ studentProfileId: jun, givenName: 'Jun', familyName: 'Park' }, { studentProfileId: mina, givenName: 'Mina', familyName: 'Park' }], latestLink: null };
const summary = { linkId: link, state: 'OPEN' as const, recipientPersonId: hana, studentProfileIds: [jun, mina], createdAt: AT, expiresAt: LATER, closedAt: null };

it('reads with a plain same-origin GET and refuses an answer that is not exactly the read', async () => {
  const f = stub(json({ data: read }));
  expect((await agreementLinkApi.read(school, student, signal(), () => true)).guardians).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/school/schools/${school}/people/${student}/membership-agreement-link`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: { ...read, extra: 1 } }));
  expect((await fails(agreementLinkApi.read(school, student, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' }, 403));
  expect((await fails(agreementLinkApi.read(school, student, signal(), () => true))).kind).toBe('DENIED');
});

it('sends one closed body with the link command and key, and checks the receipt matches what was asked', async () => {
  const request = agreementLinkApi.prepare(school, student, hana, ['EMAIL', 'SMS'], TOKEN, key);
  const f = stub(json({ data: { record: { ...summary, deliveries: [{ channel: 'EMAIL', outcome: 'QUEUED', messageId: msg }, { channel: 'SMS', outcome: 'NO_CONSENT', messageId: null }] }, replayed: false } }));
  const out = await agreementLinkApi.send(request, signal(), () => true);
  expect(out.deliveries.map(d => d.outcome)).toEqual(['QUEUED', 'NO_CONSENT']);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/membership-agreement-link/send');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'membership-agreement-link', 'Idempotency-Key': key });
  expect(JSON.parse(String(init.body))).toEqual({ schoolId: school, personId: student, recipientPersonId: hana, channels: ['EMAIL', 'SMS'], token: TOKEN, confirmation: 'I_CONFIRM_SEND_MEMBERSHIP_AGREEMENT_LINK' });
  stub(json({ data: { record: { ...summary, recipientPersonId: joon, deliveries: [{ channel: 'EMAIL', outcome: 'QUEUED', messageId: msg }, { channel: 'SMS', outcome: 'NO_CONSENT', messageId: null }] }, replayed: false } }));
  expect((await fails(agreementLinkApi.send(request, signal(), () => true))).kind).toBe('UNKNOWN');
  expect(() => agreementLinkApi.prepare(school, student, hana, ['EMAIL'], 'short', key)).toThrow(LinkError);
});

it('maps refusals exactly; only an unknown or busy outcome keeps the request for Try again', () => {
  expect(linkErrorFor(400, 'MEMBERSHIP_AGREEMENT_NOT_PUBLISHED').kind).toBe('NOT_PUBLISHED');
  expect(linkErrorFor(400, 'MEMBERSHIP_AGREEMENT_NOTHING_TO_SIGN').kind).toBe('NOTHING');
  expect(linkErrorFor(400, 'MEMBERSHIP_AGREEMENT_RECIPIENT_NOT_ALLOWED').kind).toBe('RECIPIENT');
  expect(linkErrorFor(503, 'MEMBERSHIP_AGREEMENT_LINK_ORIGIN_NOT_CONFIGURED').kind).toBe('ORIGIN');
  expect(linkErrorFor(500, null).kind).toBe('UNKNOWN');
  expect(keepLinkForRetry(new LinkError('UNKNOWN'))).toBe(true); expect(keepLinkForRetry(new LinkError('BUSY'))).toBe(true);
  expect(keepLinkForRetry(new LinkError('DENIED'))).toBe(false);
});

it('makes a 43-character base64url token and the family link on this site', () => {
  const token = newLinkToken(b => b.fill(255));
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(token).toBe('_'.repeat(42) + '8');
  expect(signingLinkUrl('https://app.example.test/', TOKEN)).toBe(`https://app.example.test/agreement/${TOKEN}`);
});

const view = (over: Partial<SendPanelViewProps> = {}) => renderToStaticMarkup(<SendPanelView language="en" read={{ state: 'READY', read }} recipient={hana}
  channels={['EMAIL']} outcome={null} canRetry={false} copied={false} {...over}/>);
it('offers only channels the guardian agreed to and has an address for, and lists who the link covers', () => {
  expect(channelBlock(guardians[0]!, 'SMS')).toBe('noConsent_SMS');expect(channelBlock(guardians[1]!, 'EMAIL')).toBe('noAddress_EMAIL');expect(channelBlock(guardians[0]!, 'EMAIL')).toBeNull();
  const html = view();
  expect(html).toContain('The link covers: Jun, Mina');expect(html).toContain('Text message (has not agreed to texts)');
  expect(html).toMatch(/disabled="" data-testid="agreement-link-SMS"/);expect(html).toContain('Make link and send');
  expect(view({ channels: [] })).toContain('Make link to copy');
  expect(view({ read: { state: 'READY', read: { ...read, current: null, children: [] } } })).toContain('has not published');
  expect(view({ read: { state: 'READY', read: { ...read, children: [] } } })).toContain('has signed the current agreement');
  expect(view({ read: { state: 'DENIED' } })).toContain('does not include sending');
  expect(view({ read: { state: 'READY', read: { ...read, latestLink: summary } } })).toContain('is waiting to be signed. Sending again replaces it.');
});
it('shows each channel\'s result and the link once, and offers Try again only for a kept request', () => {
  const result = { link: summary, deliveries: [{ channel: 'EMAIL', outcome: 'QUEUED', messageId: msg }, { channel: 'SMS', outcome: 'NO_ADDRESS', messageId: null }], replayed: false } as const;
  const html = view({ outcome: { kind: 'SENT', result, url: `https://app.example.test/agreement/${TOKEN}` } });
  expect(html).toContain('Link made for Hana');expect(html).toContain('Email: queued to send');expect(html).toContain('Text message: not sent (no address)');
  expect(html).toContain(`value="https://app.example.test/agreement/${TOKEN}"`);
  expect(view({ outcome: { kind: 'UNKNOWN' }, canRetry: true })).toContain('Try again');
  expect(view({ outcome: { kind: 'DENIED' } })).not.toContain('Try again');
});

const open = { state: 'OPEN', schoolName: 'Link school', recipientGivenName: 'Joon', expiresAt: LATER, children: [{ studentProfileId: jun, givenName: 'Jun' }, { studentProfileId: mina, givenName: 'Mina' }],
  agreement: { versionId: version, number: 1, publishedAt: AT, texts: [{ language: 'en', title: 'Membership agreement', body: 'Synthetic text.', digest: 'a'.repeat(64) },
    { language: 'ko', title: '회원 약관', body: '합성 문구.', digest: 'b'.repeat(64) }] } } as const;
const page = (over: Partial<SigningViewProps> = {}) => renderToStaticMarkup(<SigningView uiLanguage="en" state={{ kind: 'READ', read: open }}
  form={{ language: 'en', children: [jun, mina], name: '', esign: false }} busy={false} notice={null} {...over}/>);
it('the family page shows the agreement, who they sign for, and signs only with a name and e-sign consent', () => {
  const html = page();
  expect(html).toContain('Hello Joon. Link school asks you to read and sign');expect(html).toContain('Synthetic text.');expect(html).toContain('Jun');
  expect(html).toMatch(/disabled="" data-testid="agreement-signing-submit"/);
  expect(page({ form: { language: 'en', children: [jun], name: 'Joon Park', esign: true } })).not.toMatch(/disabled="" data-testid="agreement-signing-submit"/);
  expect(page({ form: { language: 'ko', children: [jun], name: 'Joon Park', esign: true } })).toContain('합성 문구.');
  expect(page({ state: { kind: 'READ', read: { state: 'EXPIRED', schoolName: 'Link school' } } })).toContain('has expired');
  expect(page({ state: { kind: 'READ', read: 'GONE' } })).toContain('not valid');
  expect(page({ state: { kind: 'SIGNED' } })).toContain('Signed. Thank you.');
  expect(page()).not.toMatch(/pay|card number|\$/i);
  expect(nameOk('Joon Park')).toBe(true);expect(nameOk(' x')).toBe(false);expect(nameOk('<b>')).toBe(false);
  expect(agreementLinkText('es-MX', 'signButton')).toBe('Firmar');
});

it('the public calls carry no cookie or command header, and anything but the server\'s closed words is unavailable', async () => {
  const f = stub(json({ data: open }));
  expect(await publicAgreementLinkApi.read(TOKEN, signal())).toMatchObject({ state: 'OPEN' });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/public/membership-agreement-links/${TOKEN}`);expect(init.credentials).toBe('omit');
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ result: 'GONE' }, 404)); expect(await publicAgreementLinkApi.read(TOKEN, signal())).toBe('GONE');
  expect(await publicAgreementLinkApi.read('bad', signal())).toBe('GONE');
  const s = stub(json({ result: 'SIGNED' }, 201));
  expect(await publicAgreementLinkApi.sign(TOKEN, { versionId: version, language: 'en', digest: 'a'.repeat(64), signerName: 'Joon Park', eSignConsent: true, studentProfileIds: [jun] }, signal())).toBe('SIGNED');
  expect((s.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe(`/api/v1/public/membership-agreement-links/${TOKEN}/sign`);
  stub(json({ result: 'SOMETHING' }, 500));
  expect(await publicAgreementLinkApi.sign(TOKEN, { versionId: version, language: 'en', digest: 'a'.repeat(64), signerName: 'Joon Park', eSignConsent: true, studentProfileIds: [jun] }, signal())).toBe('UNAVAILABLE');
});

it('the signing page is listed in the route manifest and never cached or indexed', () => {
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter(r => r.path === '/agreement/:token')).toHaveLength(1);
  const source = readFileSync('src/app/agreement/[token]/page.tsx', 'utf8');
  expect(source).toContain("robots: { index: false, follow: false }");expect(source).toContain("referrer: 'no-referrer'");
});
