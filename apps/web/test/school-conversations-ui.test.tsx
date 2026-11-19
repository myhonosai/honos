import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaffConversations, parseTags } from '../src/components/conversations/staff-conversations';
import { conversationsCopy } from '../src/components/conversations/copy';
import {
  CONVERSATION_REFUSALS, ConversationsAccessError, ConversationsRefusal, ConversationsUnknown, commandAttempt, loadConversation, loadConversations,
  markConversationRead, replyConversation, updateConversation,
} from '../src/components/conversations/http';
import { NO_SCHOOL_SHELL, SchoolShellProvider } from '../src/components/school-shell/context';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';

// 0364 Conversations screen: fixed same-origin calls with the shell scope, verified answers, definite refusals vs unknown outcomes.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const T = '2026-11-20T17:00:00.000Z';
const scope = { organizationId: A, schoolId: B };
const row = (patch = {}) => ({ conversationId: C, channel: 'SMS', contactAddress: '+15125550100', contactName: 'Ada Lee', personId: D, leadId: null, leadStatus: null, leadStage: null,
  status: 'OPEN', unread: 1, tags: [], assignedTo: null, lastMessage: { direction: 'INBOUND', preview: 'Hi', mediaCount: 0, at: T }, lastMessageAt: T, lastInboundAt: T, version: 3, ...patch });
const msg = (patch = {}) => ({ messageId: D, direction: 'OUTBOUND', author: 'STAFF', staffName: 'Sam', body: 'Hello', mediaCount: 0, at: T, delivery: 'QUEUED', ...patch });
afterEach(() => vi.restoreAllMocks());

describe('school conversations http', () => {
  it('lists with plain query filters and the keyset cursor, as a same-origin GET', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { data: { conversations: [], nextCursor: null, unreadConversations: 0, canManage: true }, meta: {} }));
    await loadConversations(scope, { status: 'OPEN', unreadOnly: true, search: 'Ada', before: { at: T, id: C } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/organizations/${A}/schools/${B}/conversations?status=OPEN&unreadOnly=true&search=Ada&beforeAt=${encodeURIComponent(T)}&beforeId=${C}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect((init as RequestInit).headers).not.toHaveProperty('Idempotency-Key');
    await expect(loadConversations({ organizationId: '../x', schoolId: B })).rejects.toBeInstanceOf(ConversationsUnknown);
    await expect(loadConversations(scope, { status: 'GONE' } as never)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('replies as a human command with an idempotency key and only the version and text in the body', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, { data: { conversation: row({ version: 4, unread: 0 }), message: msg() }, meta: { replayed: false } }));
    const out = await replyConversation(scope, C, 3, 'Hello', 'key-1');
    expect(out.replayed).toBe(false);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/organizations/${A}/schools/${B}/conversations/${C}/replies`);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ expectedVersion: 3, body: 'Hello' }) });
    expect((init as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'conversation.reply', 'Idempotency-Key': 'key-1' });
    await expect(replyConversation(scope, C, 3, ' ', 'k')).rejects.toThrow();
    await expect(replyConversation(scope, C, 3, 'x'.repeat(1601), 'k')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses a receipt for another conversation or other text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, { data: { conversation: row({ version: 4 }), message: msg({ body: 'Other' }) }, meta: { replayed: false } }));
    await expect(replyConversation(scope, C, 3, 'Hello', 'k')).rejects.toThrow();
  });
  it('tells definite refusals from access errors and unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(422, { code: 'CONVERSATION_CONSENT_REQUIRED' })).mockResolvedValueOnce(json(503, { code: 'CONVERSATION_UNAVAILABLE' }))
      .mockResolvedValueOnce(json(403, { code: 'CONVERSATION_FORBIDDEN' })).mockResolvedValueOnce(json(401, {})).mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const refusal = await replyConversation(scope, C, 3, 'Hi', 'k').catch(e => e);
    expect(refusal).toBeInstanceOf(ConversationsRefusal); expect(refusal.code).toBe('CONVERSATION_CONSENT_REQUIRED');
    await expect(replyConversation(scope, C, 3, 'Hi', 'k')).rejects.toBeInstanceOf(ConversationsUnknown);
    expect((await loadConversations(scope).catch(e => e)).reason).toBe('FORBIDDEN');
    expect((await loadConversations(scope).catch(e => e)).reason).toBe('SESSION');
    await expect(replyConversation(scope, C, 3, 'Hi', 'k')).rejects.toBeInstanceOf(ConversationsUnknown);
    await expect(loadConversations(scope)).rejects.toBeInstanceOf(ConversationsUnknown);
  });
  it('marks read only through a loaded message, updates by version, and pages older messages by id', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { conversationId: C, unread: 0, version: 4 }, meta: {} }))
      .mockResolvedValueOnce(json(200, { data: { conversation: row({ status: 'CLOSED', version: 5 }) }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(200, { data: { conversation: row(), contact: { person: null, lead: null, nextAppointment: null, peopleWithNumber: 0, schoolCanText: true }, messages: [], hasOlder: false, canManage: true }, meta: {} }));
    expect((await markConversationRead(scope, C, D)).unread).toBe(0);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ throughMessageId: D }) });
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('Idempotency-Key');
    expect((await updateConversation(scope, C, 4, { status: 'CLOSED' }, 'k')).receipt.conversation.status).toBe('CLOSED');
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ expectedVersion: 4, status: 'CLOSED' }) });
    await loadConversation(scope, C, D);
    expect(fetcher.mock.calls[2]![0]).toBe(`/api/v1/organizations/${A}/schools/${B}/conversations/${C}?before=${D}`);
    await expect(markConversationRead(scope, C, 'nope')).rejects.toThrow();
    await expect(updateConversation(scope, C, 4, { tags: ['a', 'A'] }, 'k')).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('keeps the key only for the same command', () => {
    let n = 0; const key = () => `k${++n}`;
    const first = commandAttempt('reply:1:Hi', null, key);
    expect(commandAttempt('reply:1:Hi', first, key)).toBe(first);
    expect(commandAttempt('reply:1:Hi!', first, key).key).toBe('k2');
  });
});

describe('school conversations screen', () => {
  it('asks for a school, then renders the inbox shell without data or IDs', () => {
    expect(renderToStaticMarkup(<StaffConversations />)).toContain('Choose a school to see its conversations.');
    const html = renderToStaticMarkup(<SchoolShellProvider value={{ ...NO_SCHOOL_SHELL, phase: 'READY', selection: scope, schoolName: 'Sunrise' }}><StaffConversations /></SchoolShellProvider>);
    expect(html).toContain('<h1>Conversations</h1>'); expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain(A); expect(html).not.toContain(B);
  });
  it('has every string and refusal in English, Korean and Spanish', () => {
    const en = conversationsCopy('en');
    for (const language of ['en', 'ko', 'es'] as const) {
      const copy = conversationsCopy(language);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      for (const code of CONVERSATION_REFUSALS) expect(copy.refusal[code], `${language} ${code}`).toBeTruthy();
      expect(Object.keys(copy.delivery).sort()).toEqual(Object.keys(en.delivery).sort());
    }
    expect(conversationsCopy('ko').title).toBe('대화'); expect(conversationsCopy('es').title).toBe('Conversaciones');
  });
  it('accepts only valid tags', () => {
    expect(parseTags('trial, kids')).toEqual(['trial', 'kids']);
    expect(parseTags('')).toEqual([]);
    expect(parseTags('a, A')).toBeNull(); expect(parseTags('<b>')).toBeNull();
  });
  it('is the first tab of Texts under Communication, and the old address redirects there', () => {
    const texts = SCHOOL_SHELL_NAV.find(item => item.key === 'messages')!;
    expect(texts.section).toBe('communication');
    expect(texts.routes.map(r => r.href)).toEqual(['/staff/texts', '/staff/texts/send']);
    expect(readFileSync(resolve('src/app/staff/conversations/page.tsx'), 'utf8')).toContain("redirect('/staff/texts')");
    expect(readFileSync(resolve('src/app/staff/texts/page.tsx'), 'utf8')).toContain('<StaffConversations />');
  });
  it('searches as you type and filters with chips, with no Apply button', () => {
    const source = readFileSync(resolve('src/components/conversations/staff-conversations.tsx'), 'utf8');
    expect(source).toContain('filter({ ...draft, search: e.target.value }, 350)');
    expect(source).not.toContain('copy.apply');
  });
  it('keeps a separate retry key per command kind, so an update cannot replace an unconfirmed reply key', () => {
    const source = readFileSync(resolve('src/components/conversations/staff-conversations.tsx'), 'utf8');
    expect(source).toMatch(/updateAttempt\.current = commandAttempt\(fingerprint, updateAttempt\.current,/);
    expect(source).toMatch(/attempt\.current = commandAttempt\(`reply:/);
    expect(source).not.toMatch(/attempt\.current\?\.fingerprint\.startsWith\('update:'\)/);
    expect(source).toContain('setError(copy.unknownUpdate)');
  });
  it('never stores, injects HTML or calls a provider from the browser', () => {
    for (const file of ['conversations/staff-conversations.tsx', 'conversations/http.ts']) {
      const source = readFileSync(resolve('src/components', file), 'utf8');
      expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|twilio|openrouter|apiKey/i);
    }
  });
});
