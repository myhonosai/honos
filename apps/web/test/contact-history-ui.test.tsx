import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTACT_HISTORY_CHANNELS, CONTACT_HISTORY_ORIGINS, CONTACT_RESEND_BLOCKS, CONTACT_DELIVERY_STATES } from '@hon/contracts';
import { ContactMessageHistory, historyQuery } from '../src/components/contact-history/contact-history';
import { contactHistoryCopy } from '../src/components/contact-history/copy';
import {
  CONTACT_HISTORY_REFUSALS, ContactHistoryAccessError, ContactHistoryRefusal, ContactHistoryUnknown, loadContactEmail, loadContactHistory, resendContactEmail,
} from '../src/components/contact-history/http';

// 0424 contact message history: fixed same-origin calls with the shell scope, verified answers, definite refusals vs unknown outcomes.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', P = '33333333-3333-4333-8333-333333333333';
const M = '44444444-4444-4444-8444-444444444444', N = '55555555-5555-4555-8555-555555555555';
const T = '2026-11-20T17:00:00.000Z', T2 = '2026-11-19T17:00:00.000Z';
const scope = { organizationId: A, schoolId: B };
const base = `/api/v1/organizations/${A}/schools/${B}/people/${P}/messages`;
const row = (patch = {}) => ({ messageId: M, source: 'QUEUE', channel: 'EMAIL', direction: 'SENT', origin: 'AUTOMATION', subject: 'Trial reminder',
  preview: 'Your trial class is tomorrow.', at: T, by: 'HON Automation', delivery: 'DELIVERED', failureCode: null, resentFrom: null, ...patch });
const history = (patch = {}) => ({ personId: P, total: 1, messages: [row()], includesFamily: true, nextCursor: null, ...patch });
const view = (patch = {}) => ({
  message: { messageId: M, personId: P, origin: 'AUTOMATION', subject: 'Trial reminder', subjectStandard: false, body: 'Your trial class is tomorrow.\n<b>not html</b>', at: T, by: null },
  delivery: { status: 'DELIVERED', failureCode: null, attempts: 1, acceptedAt: T, finalAt: T, events: [{ type: 'DELIVERED', at: T }] },
  savedAddress: 'ada@example.invalid', emailConsent: 'OPTED_IN', resentFrom: null, resends: [], canResend: true, resendBlocked: null, ...patch });
afterEach(() => vi.restoreAllMocks());

describe('contact history http', () => {
  it('reads with plain query filters and the keyset cursor as a same-origin GET with no command marker or key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, { data: history(), meta: {} }));
    const out = await loadContactHistory(scope, P, { range: 'DAYS_7', search: 'trial', before: { at: T, id: N } });
    expect(out.messages[0]!.subject).toBe('Trial reminder');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${base}?range=DAYS_7&search=trial&beforeAt=${encodeURIComponent(T)}&beforeId=${N}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect((init as RequestInit).headers).not.toHaveProperty('Idempotency-Key');
    expect((init as RequestInit).headers).not.toHaveProperty('X-HON-Human-Command');
    await loadContactHistory(scope, P, { range: 'ALL' });
    expect(fetcher.mock.calls[1]![0]).toBe(base);
    await expect(loadContactHistory({ organizationId: '../x', schoolId: B }, P)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    await expect(loadContactHistory(scope, P, { range: 'WEEK' } as never)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses answers that do not check out: another person, wrong order, family rows it may not show, a text with a subject', async () => {
    const bad = [history({ personId: N }), history({ total: 2, messages: [row({ at: T2 }), row({ messageId: N, at: T })] }),
      history({ includesFamily: false, messages: [row({ source: 'FAMILY', channel: 'APP', origin: 'FAMILY', direction: 'RECEIVED', subject: null, delivery: null })] }),
      history({ messages: [row({ channel: 'SMS' })] }), history({ total: 0 }), history({ nextCursor: { at: T, id: M } })];
    for (const data of bad) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data }));
      await expect(loadContactHistory(scope, P)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    }
  });
  it('loads the exact email view and checks it is the email asked for', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: view() })).mockResolvedValueOnce(json(200, { data: view({ message: { ...view().message, messageId: N } }) }))
      .mockResolvedValueOnce(json(200, { data: view({ canResend: true, savedAddress: null }) }));
    const v = await loadContactEmail(scope, P, M);
    expect(v.message.body).toBe('Your trial class is tomorrow.\n<b>not html</b>');
    await expect(loadContactEmail(scope, P, M)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    await expect(loadContactEmail(scope, P, M)).rejects.toBeInstanceOf(ContactHistoryUnknown);
  });
  it('resends as a human command with a key and an empty body, and checks the receipt', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(201, { data: { messageId: N, resentFrom: M, personId: P, channel: 'EMAIL', delivery: 'QUEUED', at: T }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(201, { data: { messageId: M, resentFrom: M, personId: P, channel: 'EMAIL', delivery: 'QUEUED', at: T }, meta: { replayed: false } }));
    const key = '66666666-6666-4666-8666-666666666666';
    const out = await resendContactEmail(scope, P, M, key);
    expect(out).toEqual({ receipt: { messageId: N, resentFrom: M, personId: P, channel: 'EMAIL', delivery: 'QUEUED', at: T }, replayed: false });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${base}/${M}/resend`);
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
    expect((init as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'contact.email.resend', 'Idempotency-Key': key });
    await expect(resendContactEmail(scope, P, M, key)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    await expect(resendContactEmail(scope, P, M, 'not-a-uuid')).rejects.toBeInstanceOf(ContactHistoryUnknown);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('tells definite refusals from access errors and unknown outcomes', async () => {
    const key = '66666666-6666-4666-8666-666666666666';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(422, { code: 'CONTACT_RESEND_CONSENT_REQUIRED' })).mockResolvedValueOnce(json(503, { code: 'CONTACT_HISTORY_UNAVAILABLE' }))
      .mockResolvedValueOnce(json(403, { code: 'CONVERSATION_FORBIDDEN' })).mockResolvedValueOnce(json(401, {})).mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const refusal = await resendContactEmail(scope, P, M, key).catch(e => e);
    expect(refusal).toBeInstanceOf(ContactHistoryRefusal); expect(refusal.code).toBe('CONTACT_RESEND_CONSENT_REQUIRED');
    await expect(resendContactEmail(scope, P, M, key)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    expect((await loadContactHistory(scope, P).catch(e => e)).reason).toBe('FORBIDDEN');
    expect((await loadContactHistory(scope, P).catch(e => e))).toBeInstanceOf(ContactHistoryAccessError);
    await expect(loadContactHistory(scope, P)).rejects.toBeInstanceOf(ContactHistoryUnknown);
    await expect(loadContactHistory(scope, P)).rejects.toBeInstanceOf(ContactHistoryUnknown);
  });
});

describe('contact history screen', () => {
  it('builds the query from the filters: All sends no range, blank or overlong search is dropped or cut', () => {
    expect(historyQuery({ range: 'ALL', search: '  ' })).toEqual({});
    expect(historyQuery({ range: 'TODAY', search: ' karate ' })).toEqual({ range: 'TODAY', search: 'karate' });
    expect(historyQuery({ range: 'ALL', search: 'x'.repeat(80) }).search).toHaveLength(60);
  });
  it('loads nothing until opened, and renders closed with the show button', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(<ContactMessageHistory scope={scope} personId={P} />);
    expect(html).toContain('Message history'); expect(html).toContain('Show message history'); expect(html).toContain('aria-expanded="false"');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('has the same copy in English, Korean and Spanish for every label, refusal, block, channel, origin and state', () => {
    const en = contactHistoryCopy('en');
    for (const language of ['en', 'ko', 'es'] as const) {
      const copy = contactHistoryCopy(language);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      for (const code of CONTACT_HISTORY_REFUSALS) expect(copy.refusal[code], `${language} ${code}`).toBeTruthy();
      for (const b of CONTACT_RESEND_BLOCKS) expect(copy.blocked[b]).toBeTruthy();
      for (const c of CONTACT_HISTORY_CHANNELS) expect(copy.channel[c]).toBeTruthy();
      for (const o of CONTACT_HISTORY_ORIGINS) expect(copy.origin[o]).toBeTruthy();
      for (const d of CONTACT_DELIVERY_STATES) expect(copy.delivery[d]).toBeTruthy();
    }
    expect(contactHistoryCopy('ko').title).not.toBe(en.title); expect(contactHistoryCopy('es').title).not.toBe(en.title);
  });
  it('renders the email body as text, keeps a resend key only for retrying the same email, and is mounted on People and the conversation contact panel', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/contact-history/contact-history.tsx'), 'utf8');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).toContain("if (attempt.current?.messageId !== messageId) attempt.current = { messageId, key: crypto.randomUUID() };");
    expect(source).toContain('else setError(copy.unknownResend);');
    expect(readFileSync(resolve(__dirname, '../src/components/people/people.tsx'), 'utf8')).toContain('<ContactMessageHistory');
    expect(readFileSync(resolve(__dirname, '../src/components/conversations/staff-conversations.tsx'), 'utf8')).toContain('<ContactMessageHistory');
  });
});
