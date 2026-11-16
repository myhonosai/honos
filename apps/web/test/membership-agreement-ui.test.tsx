import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MEMBERSHIP_AGREEMENT_BLOCKERS, MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND, MEMBERSHIP_AGREEMENT_SEND_COMMAND, MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION,
  MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION, MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION, verifyMembershipAgreementCard, verifyMembershipAgreementLink,
  verifyMembershipAgreementTemplate,
} from '@hon/contracts';
import { AGREEMENT_COPY } from '../src/components/membership-agreement/copy';
import {
  AgreementPanelView, agreementBlocksStart, agreementProblem, canSendAgreement, defaultSigner, type AgreementPanelViewProps,
} from '../src/components/membership-agreement/card-panel';
import { AgreementEditorView, formFrom, saveInput } from '../src/components/membership-agreement/editor';
import {
  AgreementError, newSigningToken, prepareAgreementSave, prepareAgreementSend, readAgreementCard, readSigningLink, sendAgreementLink, sendAgreementSave,
  signAgreement, signingUrl,
} from '../src/components/membership-agreement/http';
import { SigningView, addPoint, formatPrice, initialSigningForm, pickLanguage, signInput } from '../src/components/membership-agreement/signing';
import { START_COPY } from '../src/components/people/start-membership';
import { id } from './account-status-fixtures';

// The digital membership agreement (slice E, 0410).
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), membership = id(410), adult = id(411), guardian = id(412), req1 = id(420), req2 = id(421);
const scope = { organizationId: org, schoolId: school };
const at = '2026-11-16T18:00:00.000Z', later = '2026-11-30T18:00:00.000Z';
const request = (over: Record<string, unknown> = {}) => ({ requestId: req1, state: 'OPEN', signerPersonId: adult, signerRelation: 'SELF', textVersion: 2, createdAt: at,
  expiresAt: later, signature: null, ...over });
const rawCard = (over: Record<string, unknown> = {}) => ({ membershipId: membership, membershipState: 'DRAFT', agreementVersion: 2, signatureRequired: true, signed: false,
  signers: [{ personId: adult, givenName: 'Avery', familyName: 'Able', relation: 'SELF' }], requests: [], ...over });
const card = (over: Record<string, unknown> = {}) => verifyMembershipAgreementCard(rawCard(over), membership);
const TOKEN = 'A'.repeat(42) + 'w';
const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers } });
const requestId = '77777777-7777-4777-8777-777777777777';

it('the start waits only while a required agreement is unsigned; links go to allowed signers of a membership that has not started', () => {
  expect(agreementBlocksStart(card())).toBe(true);
  expect(agreementBlocksStart(card({ signatureRequired: false }))).toBe(false);
  expect(agreementBlocksStart(card({ agreementVersion: null, signatureRequired: false }))).toBe(false);
  expect(agreementBlocksStart(card({ membershipState: 'ACTIVE' }))).toBe(false);
  const signed = card({ signed: true, requests: [request({ state: 'SIGNED', signature: { signedName: 'Avery Able', relationship: 'SELF', language: 'en', signedAt: at } })] });
  expect(agreementBlocksStart(signed)).toBe(false);
  expect(canSendAgreement(card())).toBe(true);
  expect(canSendAgreement(signed)).toBe(false);
  expect(canSendAgreement(card({ signers: [] }))).toBe(false);
  const two = card({ signers: [{ personId: adult, givenName: 'A', familyName: 'B', relation: 'GUARDIAN' }, { personId: guardian, givenName: 'G', familyName: 'B', relation: 'GUARDIAN' }],
    requests: [request({ signerPersonId: guardian, signerRelation: 'GUARDIAN' })] });
  expect(defaultSigner(two)).toBe(guardian);
  expect(defaultSigner(card())).toBe(adult);
});

it('says each refusal in plain words, in every language', () => {
  expect(agreementProblem(new AgreementError('BLOCKED', 409, ['ALREADY_SIGNED']))).toEqual(['b_ALREADY_SIGNED']);
  expect(agreementProblem(new AgreementError('BLOCKED', 409, []))).toEqual(['p_BLOCKED']);
  expect(agreementProblem(new Error('x'))).toEqual(['p_UNKNOWN']);
  for (const b of MEMBERSHIP_AGREEMENT_BLOCKERS) expect(AGREEMENT_COPY.en[`b_${b}`]).toBeTruthy();
  for (const language of ['ko', 'es'] as const) expect(Object.keys(AGREEMENT_COPY[language]).sort()).toEqual(Object.keys(AGREEMENT_COPY.en).sort());
  for (const language of ['en', 'ko', 'es'] as const) expect(START_COPY[language].p_AGREEMENT).toBeTruthy();
});

const panel = (over: Partial<AgreementPanelViewProps> = {}): string => renderToStaticMarkup(<AgreementPanelView language="en" state={{ kind: 'READY', card: card() }}
  signer={adult} fresh={null} notices={[]} busy={false} canRetry={false} copied={false} {...over}/>);

it('card panel: required, waiting, the fresh link once, signed', () => {
  const first = panel();
  expect(first).toContain('A signed agreement is needed before this membership can start.');
  expect(first).toContain('Create signing link');
  expect(first).toContain('Avery Able (the student)');
  const waiting = { kind: 'READY' as const, card: card({ requests: [request()] }) };
  const hidden = panel({ state: waiting });
  expect(hidden).toContain('Link sent to Avery Able.');
  expect(hidden).toContain('Create a new link');
  expect(hidden).toContain('shown only right after it is made');
  const fresh = panel({ state: waiting, fresh: { requestId: req1, url: `https://school.test/agreement/${TOKEN}` } });
  expect(fresh).toContain(`https://school.test/agreement/${TOKEN}`);
  expect(fresh).toContain('Copy link');
  // A fresh link for a request that is no longer the open one is never shown.
  expect(panel({ state: waiting, fresh: { requestId: req2, url: `https://school.test/agreement/${TOKEN}` } })).not.toContain(TOKEN);
  const signed = panel({ state: { kind: 'READY', card: card({ signed: true, requests: [request({ state: 'SIGNED', signature: { signedName: 'Avery Able', relationship: 'SELF', language: 'ko', signedAt: at } })] }) } });
  expect(signed).toContain('Signed by Avery Able (self)');
  expect(signed).not.toContain('Create');
  expect(panel({ state: { kind: 'READY', card: card({ agreementVersion: null, signatureRequired: false }) } })).toContain('no membership agreement yet');
  expect(panel({ state: { kind: 'READY', card: card() }, notices: ['p_UNKNOWN'], canRetry: true, onRetry: () => {} })).toContain('Try again');
  expect(renderToStaticMarkup(<AgreementPanelView language="ko" state={{ kind: 'READY', card: card() }} signer={adult} fresh={null} notices={[]} busy={false}
    canRetry={false} copied={false}/>)).toContain('서명 링크 만들기');
});

it('HTTP: one human command per call; the token goes once in the body and never in the path; only known blockers; unverified answers are unknown', async () => {
  const fetch = vi.fn(async () => json(200, { data: rawCard(), meta: { requestId } }));
  vi.stubGlobal('fetch', fetch);
  expect((await readAgreementCard(scope, membership)).signers).toHaveLength(1);
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/memberships/${membership}/agreement`);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe(MEMBERSHIP_AGREEMENT_CARD_READ_COMMAND);
  expect(init.credentials).toBe('same-origin');

  const key = id(430);
  const prepared = prepareAgreementSend(scope, membership, adult, TOKEN, key);
  expect(prepared.path).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/memberships/${membership}/agreement/send`);
  expect(JSON.parse(prepared.body)).toEqual({ signerPersonId: adult, token: TOKEN, confirmation: MEMBERSHIP_AGREEMENT_SEND_CONFIRMATION });
  expect(() => prepareAgreementSend(scope, membership, adult, 'short', key)).toThrow();
  fetch.mockImplementationOnce(async () => json(201, { data: { ...request(), membershipId: membership }, meta: { requestId, replayed: false } }));
  expect((await sendAgreementLink(prepared)).requestId).toBe(req1);
  const [, sent] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(sent.headers).toMatchObject({ 'X-HON-Human-Command': MEMBERSHIP_AGREEMENT_SEND_COMMAND, 'Idempotency-Key': key });
  fetch.mockImplementationOnce(async () => json(409, { code: 'MEMBERSHIP_AGREEMENT_BLOCKED', blockers: ['SIGNER_NOT_ALLOWED', '<script>'] }));
  await expect(sendAgreementLink(prepared)).rejects.toMatchObject({ problem: 'BLOCKED', blockers: ['SIGNER_NOT_ALLOWED'] });
  fetch.mockImplementationOnce(async () => json(201, { data: { ...request({ signerPersonId: guardian }), membershipId: membership }, meta: { requestId, replayed: false } }));
  await expect(sendAgreementLink(prepared)).rejects.toMatchObject({ problem: 'UNKNOWN' });
  fetch.mockImplementationOnce(async () => { throw new TypeError('network'); });
  await expect(sendAgreementLink(prepared)).rejects.toMatchObject({ problem: 'UNKNOWN' });
  fetch.mockImplementationOnce(async () => json(403, { code: 'MEMBERSHIP_AGREEMENT_FORBIDDEN' }));
  await expect(sendAgreementLink(prepared)).rejects.toMatchObject({ problem: 'DENIED' });

  const texts = { en: { title: 'Agreement', body: 'Rules.' } };
  const save = prepareAgreementSave(scope, { expectedVersion: 1, texts, signatureRequired: true, confirmation: MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION }, key);
  fetch.mockImplementationOnce(async () => json(201, { data: { textVersion: 2, signatureRequired: true, texts, updatedAt: at }, meta: { requestId, replayed: false } }));
  expect((await sendAgreementSave(save)).textVersion).toBe(2);
  fetch.mockImplementationOnce(async () => json(201, { data: { textVersion: 2, signatureRequired: false, texts, updatedAt: at }, meta: { requestId, replayed: false } }));
  await expect(sendAgreementSave(save)).rejects.toMatchObject({ problem: 'UNKNOWN' });
  fetch.mockImplementationOnce(async () => json(409, { code: 'MEMBERSHIP_AGREEMENT_STALE' }));
  await expect(sendAgreementSave(save)).rejects.toMatchObject({ problem: 'STALE' });
});

it('the browser makes a 43-character random token; the link is built from it', () => {
  const token = newSigningToken(b => { b.fill(255); return b; });
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(token).toBe(Buffer.alloc(32, 255).toString('base64url'));
  expect(newSigningToken()).not.toBe(newSigningToken());
  expect(signingUrl('https://school.test/', TOKEN)).toBe(`https://school.test/agreement/${TOKEN}`);
  expect(() => signingUrl('https://school.test', '../x')).toThrow();
});

it('editor: English required, a language is both fields or neither, the check box is ticked, and the version is the one read', () => {
  const empty = formFrom(verifyMembershipAgreementTemplate({ textVersion: null, signatureRequired: false, texts: null, updatedAt: null }));
  expect(empty.signatureRequired).toBe(true);
  expect(saveInput({ ...empty, checked: true }, null)).toEqual({ problem: 'e_EN_REQUIRED' });
  const en = { title: ' Agreement ', body: 'Rules.' };
  expect(saveInput({ ...empty, checked: true, texts: { ...empty.texts, en, ko: { title: '약정서', body: '' } } }, null)).toEqual({ problem: 'e_BOTH', language: 'ko' });
  expect(saveInput({ ...empty, texts: { ...empty.texts, en } }, null)).toEqual({ problem: 'e_UNCHECKED' });
  expect(saveInput({ ...empty, checked: true, texts: { ...empty.texts, en } }, 3)).toEqual({ expectedVersion: 3, texts: { en: { title: 'Agreement', body: 'Rules.' } },
    signatureRequired: true, confirmation: MEMBERSHIP_AGREEMENT_TEXT_CONFIRMATION });
  const read = verifyMembershipAgreementTemplate({ textVersion: 3, signatureRequired: false, texts: { en: { title: 'A', body: 'B' } }, updatedAt: at });
  const html = renderToStaticMarkup(<AgreementEditorView language="en" load={{ kind: 'READY', template: read }} form={formFrom(read)} notice={null} busy={false} canRetry={false}/>);
  expect(html).toContain('Version 3');
  expect(html).toContain('English (required)');
  expect(html).toContain('not part of checkout');
  expect(renderToStaticMarkup(<AgreementEditorView language="en" load={{ kind: 'NO_SCHOOL' }} form={formFrom(read)} notice={null} busy={false} canRetry={false}/>))
    .toContain('Open your school workspace first.');
});

const hash = (n: string) => n.repeat(64);
const rawLink = (over: Record<string, unknown> = {}) => ({ state: 'OPEN', schoolName: 'Tiger School', signerRelation: 'GUARDIAN', signerGivenName: 'Gale', expiresAt: later,
  languages: { en: { title: 'Membership agreement', body: 'I agree to the rules.', documentHash: hash('a') }, ko: { title: '회원 약정서', body: '동의합니다.', documentHash: hash('b') } },
  terms: { studentName: 'Kit Able', payerName: 'Gale Able', planName: 'Taekwondo yearly', planCode: 'TKD-12', priceMinor: 15000, currency: 'USD', billingFrequency: 'MONTHLY',
    termKind: 'FIXED_MONTHS', termMonths: 12, startDate: '2026-11-16', endDate: '2027-11-15' }, ...over });
const openLink = () => verifyMembershipAgreementLink(rawLink()) as Extract<ReturnType<typeof verifyMembershipAgreementLink>, { state: 'OPEN' }>;

it('signing: the family language when the agreement has it; the exact hash of what is shown; a guardian signs as parent or legal guardian', () => {
  const link = openLink();
  expect(pickLanguage(link, ['ko-KR', 'en'])).toBe('ko');
  expect(pickLanguage(link, ['es-MX'])).toBe('en');
  const form = initialSigningForm(link, ['ko']);
  expect(form).toEqual({ language: 'ko', name: '', relationship: 'PARENT', agreed: false, strokes: [] });
  expect(signInput(link, form)).toBe('s_INVALID');
  expect(signInput(link, { ...form, name: 'Gale Able', agreed: true })).toBe('needSignature');
  expect(signInput(link, { ...form, name: ' Gale Able ', agreed: true, strokes: [[1, 2, 3, 4]] })).toEqual({ language: 'ko', documentHash: hash('b'), signerName: 'Gale Able',
    relationship: 'PARENT', strokes: [[1, 2, 3, 4]], confirmation: MEMBERSHIP_AGREEMENT_SIGN_CONFIRMATION });
  expect(initialSigningForm(verifyMembershipAgreementLink(rawLink({ signerRelation: 'SELF' })) as typeof link, []).relationship).toBe('SELF');
  expect(formatPrice('en', 'USD', 15000)).toBe('$150.00');
  expect(formatPrice('en', 'KRW', 15000)).toBe('₩15,000');
});

it('signature points are scaled, thinned and capped inside the server limits', () => {
  let s = addPoint([], 10.4, 20.6, true);
  expect(s).toEqual([[10, 21, 10, 21]]);
  s = addPoint(s, 12, 22, false);
  expect(s).toEqual([[10, 21, 10, 21]]);
  s = addPoint(s, 40, 60, false);
  expect(s).toEqual([[10, 21, 10, 21, 40, 60]]);
  expect(addPoint(s, 5000, -3, true).at(-1)).toEqual([1000, 0, 1000, 0]);
  let big: readonly (readonly number[])[] = [];
  for (let i = 0; i < 6000; i += 1) big = addPoint(big, (i * 37) % 1000, (i * 53) % 1000, i % 15 === 0);
  expect(big.length).toBeLessThanOrEqual(200);
  expect(JSON.stringify(big).length).toBeLessThanOrEqual(16_384);
  expect(big.every(x => x.length >= 2 && x.length <= 2000 && x.every(n => n >= 0 && n <= 1000))).toBe(true);
});

it('signing page shows the terms and the agreement, then only short answers once it is closed', () => {
  const link = openLink();
  const html = renderToStaticMarkup(<SigningView state={{ kind: 'OPEN', link }} form={initialSigningForm(link, ['en'])} notice={null} busy={false} fallbackLanguage="en"/>);
  for (const text of ['Hello Gale. Tiger School asks you to read and sign this agreement.', 'Kit Able', 'Gale Able', 'Taekwondo yearly', '$150.00 (monthly)',
    'I agree to the rules.', 'parent', 'legal guardian', 'Sign agreement']) expect(html).toContain(text);
  expect(html).not.toContain('TKD-12');
  const korean = renderToStaticMarkup(<SigningView state={{ kind: 'OPEN', link }} form={initialSigningForm(link, ['ko'])} notice={null} busy={false} fallbackLanguage="en"/>);
  expect(korean).toContain('동의합니다.');
  expect(korean).toContain('약정서 서명');
  for (const [state, text] of [[{ kind: 'CLOSED', state: 'SIGNED' }, 'has been signed'], [{ kind: 'CLOSED', state: 'REPLACED' }, 'newer link'],
    [{ kind: 'CLOSED', state: 'EXPIRED' }, 'expired'], [{ kind: 'GONE' }, 'no longer works'], [{ kind: 'DONE' }, 'Signed. Thank you']] as const) {
    expect(renderToStaticMarkup(<SigningView state={state} form={null} notice={null} busy={false} fallbackLanguage="en"/>)).toContain(text);
  }
});

it('signing HTTP: no cookies, a malformed token never leaves the page, and each answer maps to one result', async () => {
  const fetch = vi.fn(async () => json(200, { data: rawLink() }));
  vi.stubGlobal('fetch', fetch);
  expect(await readSigningLink('../../x')).toBe('gone');
  expect(fetch).not.toHaveBeenCalled();
  expect(((await readSigningLink(TOKEN)) as { state: string }).state).toBe('OPEN');
  const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/public/agreements/${TOKEN}`);
  expect(init.credentials).toBe('omit');
  fetch.mockImplementationOnce(async () => json(404, { result: 'gone' }));
  expect(await readSigningLink(TOKEN)).toBe('gone');
  const input = signInput(openLink(), { language: 'en', name: 'Gale Able', relationship: 'PARENT', agreed: true, strokes: [[1, 2, 3, 4]] });
  if (typeof input === 'string') throw new Error('input');
  for (const [status, result, expected] of [[201, 'signed', 'signed'], [400, 'invalid', 'invalid'], [410, 'gone', 'gone'], [503, 'unavailable', 'unavailable'],
    [201, 'gone', 'unavailable']] as const) {
    fetch.mockImplementationOnce(async () => json(status, { result }));
    expect(await signAgreement(TOKEN, input)).toBe(expected);
  }
  const [signPath, signInit] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(signPath).toBe(`/api/v1/public/agreements/${TOKEN}/signature`);
  expect(signInit.credentials).toBe('omit');
  fetch.mockImplementationOnce(async () => { throw new TypeError('network'); });
  expect(await signAgreement(TOKEN, input)).toBe('unavailable');
});
