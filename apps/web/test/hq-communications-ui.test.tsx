import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_COMMUNICATION_COMMANDS, hqTextPieces, validateHqCommunicationsView, validateHqMessageDetail } from '@hon/contracts';
import { CommsError, commsApi, commsCommandError, commsId } from '../src/components/hq-communications/http';
import { commsOutcomeFor } from '../src/components/hq-communications/model';
import { commsCodeKey, commsText } from '../src/components/hq-communications/copy';
import { HqCommunicationsListView, HqMessageView, PieceCounter, canOfferCancel, createInputFrom, senderInputFrom,
  type CommsListViewProps, type CommsMessageViewProps } from '../src/components/hq-communications/view';
import { HQ_NAV, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const SID = 'MG' + '0123456789abcdef'.repeat(2);
const agent = { principalId: id(50), displayName: 'Synthetic Agent' };
const summary = { pending: 0, accepted: 0, delivered: 0, suppressed: 0, failed: 0, unknown: 0 };
const msg = (patch: Record<string, unknown> = {}) => ({ messageId: id(1), organizationId: id(2), organizationDisplayName: 'Synthetic Dojo', schoolId: id(3),
  schoolDisplayName: 'Synthetic Academy', purpose: 'SUPPORT', channel: 'EMAIL', content: 'Your sign-in link was reset.', supportCaseId: null, status: 'DRAFT',
  recipientCount: 0, createdBy: agent, createdAt: T, queuedAt: null, cancelledAt: null, updatedAt: T, version: 1, deliverySummary: summary, ...patch });
const sender = (patch: Record<string, unknown> = {}) => ({ senderId: id(20), channel: 'EMAIL', status: 'ACTIVE', emailFrom: 'hello@hon.example', emailDisplayName: 'HON OS',
  smsServiceSid: null, a2pState: null, mmsConverterConfirmed: null, createdBy: agent, createdAt: T, version: 1, ...patch });
const viewRaw = (patch: Record<string, unknown> = {}) => ({ senders: { EMAIL: sender(), SMS: null }, messages: [msg()], limit: 25, nextCursor: null,
  viewer: { ...agent, purposes: ['ACCOUNT', 'SUPPORT'], canManageSenders: false }, asOf: T2, ...patch });
const delivery = (patch: Record<string, unknown> = {}) => ({ deliveryId: id(30), recipient: { principalId: id(31), displayName: 'Synthetic Owner' }, status: 'PENDING',
  holdReason: null, attempt: 0, provider: null, sentAs: null, segments: null, failureCode: null, acceptedAt: null, finalAt: null, updatedAt: T, ...patch });
const detailRaw = (patch: Record<string, unknown> = {}) => ({ message: msg(), deliveries: [], viewer: agent, asOf: T2, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];
const signal = () => new AbortController().signal;

it('counts text pieces the way carriers do and flags long texts as one MMS', () => {
  expect(hqTextPieces('')).toEqual({ characters: 0, encoding: 'GSM-7', pieces: 0, asMms: false });
  expect(hqTextPieces('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', pieces: 1, asMms: false });
  expect(hqTextPieces('a'.repeat(161))).toMatchObject({ pieces: 2, asMms: false });
  expect(hqTextPieces('a'.repeat(307))).toMatchObject({ pieces: 3, asMms: true });
  expect(hqTextPieces('€'.repeat(80))).toMatchObject({ characters: 80, encoding: 'GSM-7', pieces: 1 });
  expect(hqTextPieces('안'.repeat(70))).toMatchObject({ encoding: 'UCS-2', pieces: 1 });
  expect(hqTextPieces('안'.repeat(71))).toMatchObject({ encoding: 'UCS-2', pieces: 2 });
  expect(hqTextPieces('안'.repeat(1600))).toMatchObject({ characters: 1600, pieces: 24, asMms: true });
});

it('reads the list with only the declared query and a plain same-origin GET; refuses a page that does not fit', async () => {
  const f = stub(json({ data: viewRaw() }));
  await commsApi.list({ schoolId: id(3).toUpperCase(), cursor: { createdAt: T, messageId: id(9) } }, signal(), yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/communications?${new URLSearchParams({ schoolId: id(3), cursor: `${T}~${id(9)}`, limit: '25' })}`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  stub(json({ data: viewRaw() }));
  await expect(commsApi.list({ schoolId: id(7), cursor: null }, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ data: viewRaw({ messages: [msg({ purpose: 'BILLING' })] }) }));
  await expect(commsApi.list({ schoolId: null, cursor: null }, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // An answer carrying an address is never accepted.
  stub(json({ data: viewRaw({ messages: [{ ...msg(), recipientAddress: 'owner@example.test' }] }) }));
  await expect(commsApi.list({ schoolId: null, cursor: null }, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  for (const [answer, kind] of [[json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'], [json({}, 500), 'UNKNOWN']] as const) {
    stub(answer);
    await expect(commsApi.list({ schoolId: null, cursor: null }, signal(), yes)).rejects.toMatchObject({ kind });
  }
});

it('reads one message by a validated id only', async () => {
  const f = stub(json({ data: detailRaw() }));
  expect((await commsApi.read(id(1).toUpperCase(), signal(), yes)).message.messageId).toBe(id(1));
  expect(call(f)[0]).toBe(`/api/v1/hq/communications/messages/${id(1)}`);
  for (const bad of ['', 'senders', '../x', `${id(1)}?a=1`]) {
    expect(commsId(bad)).toBeNull();
    await expect(commsApi.read(bad, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).toHaveBeenCalledTimes(1);
  stub(json({ data: detailRaw({ message: msg({ messageId: id(4) }) }) }));
  await expect(commsApi.read(id(1), signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('sends commands with the human-command marker, JSON and the idempotency key; checks the receipt matches', async () => {
  const input = { organizationId: id(2), schoolId: id(3), purpose: 'SUPPORT' as const, channel: 'EMAIL' as const, content: 'Your sign-in link was reset.', supportCaseId: null };
  const f = stub(json({ data: { operation: 'CREATE', message: msg(), replayed: false } }));
  await commsApi.create(input, id(90), signal(), yes);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/communications/messages');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-HON-Human-Command': HQ_COMMUNICATION_COMMANDS.createMessage, 'Idempotency-Key': id(90) });
  expect(JSON.parse(String(init.body))).toEqual(input);
  stub(json({ data: { operation: 'CREATE', message: msg({ content: 'Something else.' }), replayed: false } }));
  await expect(commsApi.create(input, id(91), signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(commsApi.create({ ...input, content: '' }, id(92), signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });

  const q = stub(json({ data: { operation: 'QUEUE', message: msg({ status: 'QUEUED', version: 2, recipientCount: 2, queuedAt: T2 }), replayed: false } }));
  expect((await commsApi.queue(id(1), { expectedVersion: 1 }, id(93), signal(), yes)).message.recipientCount).toBe(2);
  expect(call(q)[0]).toBe(`/api/v1/hq/communications/messages/${id(1)}/queue`);
  expect(call(q)[1].headers).toMatchObject({ 'X-HON-Human-Command': HQ_COMMUNICATION_COMMANDS.queueMessage });
  stub(json({ data: { operation: 'QUEUE', message: msg({ status: 'QUEUED', version: 3, queuedAt: T2 }), replayed: false } }));
  await expect(commsApi.queue(id(1), { expectedVersion: 1 }, id(94), signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });

  const r = stub(json({ data: { operation: 'SENDER_RETIRE', sender: sender({ status: 'RETIRED', version: 2 }), replayed: false } }));
  await commsApi.retireSender(id(20), id(95), signal(), yes);
  expect(call(r)[0]).toBe(`/api/v1/hq/communications/senders/${id(20)}/retire`);
  expect(JSON.parse(String(call(r)[1].body))).toEqual({});
});

it('maps only definitive refusals; anything else is UNKNOWN and kept for an identical retry', () => {
  expect(commsCommandError(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(commsCommandError(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(commsCommandError(422, 'HQ_MESSAGE_NO_RECIPIENTS').kind).toBe('REFUSED');
  expect(commsCommandError(422, 'SOMETHING_NEW').kind).toBe('UNKNOWN');
  expect(commsCommandError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  expect(commsCommandError(502, null).kind).toBe('UNKNOWN');
  expect(commsOutcomeFor(new CommsError('UNKNOWN'))).toEqual({ outcome: { kind: 'UNKNOWN' }, keep: true });
  expect(commsOutcomeFor(new CommsError('REFUSED', 'HQ_MESSAGE_NOT_CANCELLABLE'))).toEqual({ outcome: { kind: 'REFUSED', code: 'HQ_MESSAGE_NOT_CANCELLABLE' }, keep: false });
  expect(commsOutcomeFor(new Error('x'))).toMatchObject({ keep: true });
});

it('builds closed requests from the forms: only purposes held, content trimmed and never shortened, MMS confirmation required', () => {
  const target = { organizationId: id(2), schoolId: id(3), supportCaseId: id(5) };
  const long = '안'.repeat(1600);
  expect(createInputFrom({ purpose: 'SUPPORT', channel: 'SMS', content: `  ${long}  ` }, target, ['SUPPORT'])).toEqual({ ...target, purpose: 'SUPPORT', channel: 'SMS', content: long });
  expect(createInputFrom({ purpose: 'SUPPORT', channel: 'SMS', content: long + '안' }, target, ['SUPPORT'])).toBeNull();
  expect(createInputFrom({ purpose: 'BILLING', channel: 'EMAIL', content: 'Hi' }, target, ['SUPPORT'])).toBeNull();
  expect(createInputFrom({ purpose: 'SUPPORT', channel: 'EMAIL', content: '   ' }, target, ['SUPPORT'])).toBeNull();
  expect(createInputFrom({ purpose: 'SUPPORT', channel: 'EMAIL', content: 'Hi' }, null, ['SUPPORT'])).toBeNull();
  const sms = { channel: 'SMS' as const, emailFrom: '', emailDisplayName: '', smsServiceSid: SID.toUpperCase().replace(/^MG/, 'MG'), a2pState: 'PENDING', mms: true };
  expect(senderInputFrom(sms)).toEqual({ channel: 'SMS', emailFrom: null, emailDisplayName: null, smsServiceSid: SID, a2pState: 'PENDING', mmsConverterConfirmed: true });
  expect(senderInputFrom({ ...sms, mms: false })).toBeNull();
  expect(senderInputFrom({ ...sms, smsServiceSid: 'PN' + SID.slice(2) })).toBeNull();
  expect(senderInputFrom({ channel: 'EMAIL', emailFrom: ' Hello@HON.example ', emailDisplayName: ' HON OS ', smsServiceSid: '', a2pState: '', mms: false }))
    .toEqual({ channel: 'EMAIL', emailFrom: 'hello@hon.example', emailDisplayName: 'HON OS', smsServiceSid: null, a2pState: null, mmsConverterConfirmed: null });
});

const listProps = (patch: Partial<CommsListViewProps> = {}): CommsListViewProps => {
  const view = validateHqCommunicationsView(viewRaw());
  return { language: 'en', formattingLocale: 'en-US', concealed: false, state: { state: 'READY', view, messages: view.messages, loadingMore: false, moreFailed: false },
    target: null, outcome: null, doneText: '', doneMessageId: null, locked: false, canRetry: false, formKey: 0, onMore() {}, onRefresh() {}, onReveal() {},
    onCompose() {}, onSetSender() {}, onRetireSender() {}, onTryAgain() {}, ...patch };
};

it('renders the list: compose only with a target, senders without an owner form for non-owners, and no address anywhere', () => {
  let html = renderToStaticMarkup(<HqCommunicationsListView {...listProps()}/>);
  expect(html).toContain('data-hq-comms="ready"');
  expect(html).toContain('or a support case and choose Message the owners.');
  expect(html).not.toContain('data-comms-form="compose"');
  expect(html).toContain(commsText('en', 'senderOwnerOnly'));
  expect(html).not.toContain('data-comms-form="sender-');
  expect(html).not.toMatch(/owner@|recipientAddress/);
  html = renderToStaticMarkup(<HqCommunicationsListView {...listProps({ target: { organizationId: id(2), schoolId: id(3), supportCaseId: id(5) } })}/>);
  expect(html).toContain('data-comms-form="compose"');
  expect(html).toContain(commsText('en', 'supportCase'));
  // Only purposes the viewer holds are offered.
  expect(html).toContain('value="SUPPORT"'); expect(html).toContain('value="ACCOUNT"'); expect(html).not.toContain('value="BILLING"');
  const owner = validateHqCommunicationsView(viewRaw({ viewer: { ...agent, purposes: ['SUPPORT', 'BILLING', 'ONBOARDING', 'ACCOUNT'], canManageSenders: true } }));
  html = renderToStaticMarkup(<HqCommunicationsListView {...listProps({ state: { state: 'READY', view: owner, messages: owner.messages, loadingMore: false, moreFailed: false } })}/>);
  expect(html).toContain('data-comms-form="sender-SMS"');
  expect(html).toContain(commsText('en', 'mmsConfirm'));
  expect(html).not.toContain('data-comms-form="sender-EMAIL"');
  html = renderToStaticMarkup(<HqCommunicationsListView {...listProps({ concealed: true })}/>);
  expect(html).toContain(commsText('en', 'concealed')); expect(html).not.toContain('Synthetic Academy');
  html = renderToStaticMarkup(<HqCommunicationsListView {...listProps({ state: { state: 'DENIED' } })}/>);
  expect(html).toContain(commsText('en', 'denied'));
});

it('shows the live counter: whole long text as one MMS, too long by a number', () => {
  expect(renderToStaticMarkup(<PieceCounter language="en" channel="SMS" content={'a'.repeat(400)}/>)).toContain('sent as one MMS');
  expect(renderToStaticMarkup(<PieceCounter language="en" channel="SMS" content={'a'.repeat(1605)}/>)).toContain('Too long by 5 characters.');
  expect(renderToStaticMarkup(<PieceCounter language="ko" channel="SMS" content="안녕하세요"/>)).toContain('UCS-2');
  expect(renderToStaticMarkup(<PieceCounter language="en" channel="EMAIL" content="Hi"/>)).toContain('2 / 4000');
});

const detailProps = (raw: Record<string, unknown>, patch: Partial<CommsMessageViewProps> = {}): CommsMessageViewProps => ({
  language: 'en', formattingLocale: 'en-US', concealed: false, state: { state: 'READY', view: validateHqMessageDetail(raw) }, busy: false, outcome: null, doneText: '',
  locked: false, canRetry: false, onRefresh() {}, onReveal() {}, onQueue() {}, onCancel() {}, onTryAgain() {}, ...patch });

it('renders one message: Send only for a draft, Cancel only while nothing reached the provider, plain delivery reasons', () => {
  let html = renderToStaticMarkup(<HqMessageView {...detailProps(detailRaw())}/>);
  expect(html).toContain(commsText('en', 'queue')); expect(html).toContain(commsText('en', 'cancel'));
  const queued = msg({ status: 'QUEUED', version: 2, recipientCount: 2, queuedAt: T2, deliverySummary: { ...summary, pending: 1, suppressed: 1 } });
  const raw = detailRaw({ message: queued, deliveries: [delivery({ holdReason: 'QUIET_HOURS' }),
    delivery({ deliveryId: id(32), status: 'SUPPRESSED', failureCode: 'CONSENT_MISSING', finalAt: T2 })] });
  html = renderToStaticMarkup(<HqMessageView {...detailProps(raw)}/>);
  expect(html).not.toContain(`>${commsText('en', 'queue')}<`);
  expect(html).toContain(commsText('en', 'cancel'));
  expect(html).toContain(commsText('en', 'h_QUIET_HOURS'));
  expect(html).toContain(commsText('en', 'f_CONSENT_MISSING'));
  const sent = detailRaw({ message: { ...queued, recipientCount: 1, deliverySummary: { ...summary, accepted: 1 } }, deliveries: [delivery({ status: 'ACCEPTED', provider: 'FAKE', sentAs: 'MMS', attempt: 1, acceptedAt: T2 })] });
  expect(canOfferCancel(validateHqMessageDetail(sent))).toBe(false);
  expect(renderToStaticMarkup(<HqMessageView {...detailProps(sent)}/>)).not.toContain(commsText('en', 'cancel'));
  expect(commsCodeKey('f_', 'SOMETHING_NEW')).toBe('f_OTHER');
  expect(commsCodeKey('r_', 'HQ_MESSAGE_NOT_CANCELLABLE')).toBe('r_HQ_MESSAGE_NOT_CANCELLABLE');
});

it('every wording exists in en, ko and es', () => {
  const src = readFileSync('src/components/hq-communications/copy.ts', 'utf8');
  for (const lang of ['ko', 'es']) expect(src).toContain(`const ${lang}: Record<Key, string>`);
  expect(commsText('ko', 'title')).toBe('문자 및 이메일');
  expect(commsText('es', 'compose')).toBe('Escribir a los dueños');
});

it('links Texts & Email from the HQ navigation, the school page and the support case', () => {
  expect(HQ_NAV.map(i => i.path)).toContain('/hq/communications');
  expect(hqPageLabel('/hq/communications')).toBe('Texts & Email');
  expect(hqPageLabel(`/hq/communications/${id(1)}`)).toBe('HQ message');
  expect(readFileSync('src/components/hq-school-detail/view.tsx', 'utf8')).toContain('/hq/communications?');
  expect(readFileSync('src/components/hq-support/case-view.tsx', 'utf8')).toContain('supportCaseId: c.caseId');
  // The page only points the form at a school from validated ids; the server confirms the school on save.
  expect(readFileSync('src/app/hq/communications/page.tsx', 'utf8')).toContain('saasUuid');
});
