import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HonConversationThread, HonConversationTurn } from '@hon/contracts';
import {
  HON_CONVERSATION_API, HON_CONVERSATION_COMMAND, HonConversationError, honConversationBase, prepareConversation, prepareTurn, verifyHonPage, verifyHonReadiness,
} from '../src/components/hon-command/hon-conversation-http';
import { HonConversationView, type HonConversationViewProps } from '../src/components/hon-command/hon-conversation-panel';
import { HonWorkspaceView } from '../src/components/hon-command/hon-workspace-view';
import { initialHonCommandSnapshot } from '../src/components/hon-command/hon-command-data';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const AT = '2026-11-06T18:00:00.000Z';
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const BASE = `/api/v1/organizations/${id(1)}/schools/${id(2)}/hon`;
const readiness = (honReply = true) => ({ contract: true as const, providerRoute: honReply, entitlement: true, authorization: true, availableAgentKeys: ['marcus' as const], honReply, asOf: AT });
const summary = (n: number, turnCount = 1) => ({ id: id(n), title: `Question ${n}`, createdAt: AT, updatedAt: AT, turnCount, status: 'COMPLETED' as const });
const human = (turn: number, text: string): HonConversationTurn => ({ turnId: id(turn), role: 'HUMAN', text, createdAt: AT, status: 'COMPLETED', reason: null,
  references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null });
const reply = (turn: number, over: Partial<HonConversationTurn> = {}, detail: Partial<NonNullable<HonConversationTurn['replyDetail']>> = {}): HonConversationTurn => ({
  turnId: id(turn), role: 'hon', text: 'You have 3 trial leads waiting for follow-up.', createdAt: AT, status: 'COMPLETED', reason: null,
  references: { workItemId: id(8), actionRequestId: null, invocationId: id(9) },
  replyDetail: { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [], ...detail }, ...over });
const thread = (turns: HonConversationTurn[]): HonConversationThread => ({ ...summary(5, turns.length / 2), turns });
const noop = () => {};
const props = (over: Partial<HonConversationViewProps> = {}): HonConversationViewProps => ({
  presentation: 'full', phase: 'READY', readiness: readiness(), conversations: [summary(5)], thread: null, threadPhase: 'NONE', pending: null, draft: '', mode: 'STANDARD',
  onDraft: noop, onMode: noop, onSend: noop, onOpen: noop, onNew: noop, onContinue: noop, onRetry: noop, onDismiss: noop, onRefresh: noop, ...over });
const render = (over: Partial<HonConversationViewProps> = {}) => renderToStaticMarkup(<HonConversationView {...props(over)} />);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('HON conversation transport', () => {
  it('builds fixed same-origin paths for one UUID school and refuses anything else', () => {
    expect(honConversationBase(SCHOOL)).toBe(BASE);
    expect(() => honConversationBase({ organizationId: 'x', schoolId: id(2) })).toThrow(HonConversationError);
    expect(() => honConversationBase({ organizationId: `${id(1)}/../hq`, schoolId: id(2) })).toThrow(HonConversationError);
  });
  it('accepts only the exact readiness and page envelopes', () => {
    expect(verifyHonReadiness({ data: readiness(), meta: {} }).honReply).toBe(true);
    for (const bad of [{ data: readiness() }, { data: { ...readiness(), extra: 1 }, meta: {} }, { data: { ...readiness(), contract: false }, meta: {} },
      { data: { ...readiness(), availableAgentKeys: ['lena'] }, meta: {} }, { data: { ...readiness(), availableAgentKeys: ['marcus', 'marcus'] }, meta: {} }])
      expect(() => verifyHonReadiness(bad)).toThrow(HonConversationError);
    expect(verifyHonPage({ data: { items: [summary(5)], nextCursor: null } }).items).toHaveLength(1);
    expect(() => verifyHonPage({ data: { items: [{ ...summary(5), extra: true }], nextCursor: null } })).toThrow(HonConversationError);
    expect(() => verifyHonPage({ data: { items: [], nextCursor: 'bad cursor' } })).toThrow(HonConversationError);
  });
  it('freezes each write with a fresh key and validates it before anything is sent', () => {
    const a = prepareTurn(SCHOOL, id(5), { text: 'How many trials this week?', delegation: null, replyMode: 'DETAILED' });
    const b = prepareTurn(SCHOOL, id(5), { text: 'How many trials this week?', delegation: null, replyMode: 'DETAILED' });
    expect(Object.isFrozen(a)).toBe(true); expect(a.key).not.toBe(b.key);
    expect(a.path).toBe(`${BASE}/conversations/${id(5)}/turns`);
    expect(JSON.parse(a.body)).toEqual({ text: 'How many trials this week?', delegation: null, replyMode: 'DETAILED' });
    expect(() => prepareTurn(SCHOOL, id(5), { text: '   ', delegation: null })).toThrow(HonConversationError);
    expect(() => prepareTurn(SCHOOL, id(5), { text: 'x'.repeat(2001), delegation: null })).toThrow(HonConversationError);
    expect(() => prepareTurn(SCHOOL, 'not-a-uuid', { text: 'Hi', delegation: null })).toThrow(HonConversationError);
    expect(() => prepareConversation(SCHOOL, '')).toThrow(HonConversationError);
    expect(JSON.parse(prepareConversation(SCHOOL, '  Weekly trials  ').body)).toEqual({ title: 'Weekly trials' });
  });
  it('sends the human-command header, idempotency key and exact body, and verifies the receipt', async () => {
    const receipt = { turnId: id(6), conversationId: id(5), status: 'COMPLETED', reason: null, delegatedAgentKeys: [], actionRequestIds: [], workItemIds: [id(8)], invocationId: id(9),
      reply: 'Three trials.', replyDetail: { mode: 'STANDARD', step: 1, maxSteps: 3, truncated: false, canContinue: false, continuesTurnId: null, suggestions: [] } };
    const fetchMock = vi.fn(async () => json(200, { data: receipt }));
    vi.stubGlobal('fetch', fetchMock);
    const prepared = prepareTurn(SCHOOL, id(5), { text: 'How many trials?', delegation: null });
    await expect(HON_CONVERSATION_API.sendTurn(prepared)).resolves.toMatchObject({ reply: 'Three trials.' });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(prepared.path);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', body: prepared.body });
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': HON_CONVERSATION_COMMAND, 'Idempotency-Key': prepared.key, 'Content-Type': 'application/json' });
  });
  it('classifies outcomes: only definitive conflicts are final, everything uncertain keeps the exact retry', async () => {
    const prepared = prepareTurn(SCHOOL, id(5), { text: 'Hi', delegation: null });
    const cases: Array<[() => Response | Promise<Response>, string, string | null]> = [
      [() => json(409, { code: 'HON_IDEMPOTENCY_CONFLICT' }), 'CONFLICT', 'HON_IDEMPOTENCY_CONFLICT'],
      [() => json(409, { code: 'HON_CONVERSATION_FULL' }), 'CONFLICT', 'HON_CONVERSATION_FULL'],
      [() => json(409, { code: 'SOMETHING_ELSE' }), 'UNKNOWN', 'SOMETHING_ELSE'],
      [() => json(403, { code: 'HON_AI_SPEND_REFUSED', reason: 'AI_SPEND_PAUSED' }), 'FORBIDDEN', 'HON_AI_SPEND_REFUSED'],
      [() => json(400, { code: 'HON_REPLY_NOT_CONTINUABLE' }), 'INVALID', 'HON_REPLY_NOT_CONTINUABLE'],
      [() => json(404, { code: 'HON_CONVERSATION_NOT_FOUND' }), 'INVALID', 'HON_CONVERSATION_NOT_FOUND'],
      [() => json(503, { code: 'HON_CONVERSATION_TIMEOUT' }), 'UNKNOWN', 'HON_CONVERSATION_TIMEOUT'],
      [() => json(200, { data: { surprise: true } }), 'UNKNOWN', null],
      [() => json(200, { data: {}, extra: 1 }), 'UNKNOWN', null],
      [() => Promise.reject(new TypeError('network')), 'UNKNOWN', null],
    ];
    for (const [respond, kind, code] of cases) {
      vi.stubGlobal('fetch', vi.fn(respond));
      const error = await HON_CONVERSATION_API.sendTurn(prepared).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HonConversationError);
      expect([(error as HonConversationError).kind, (error as HonConversationError).code]).toEqual([kind, code]);
    }
  });
  it('reads with no-store and maps a lost or drifted read to unavailable, never to an empty list', async () => {
    const fetchMock = vi.fn(async () => json(200, { data: { items: [], nextCursor: null, extra: 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await HON_CONVERSATION_API.list(SCHOOL, new AbortController().signal).catch((e: unknown) => e);
    expect((error as HonConversationError).kind).toBe('UNAVAILABLE');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`${BASE}/conversations`); expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'same-origin' });
    vi.stubGlobal('fetch', vi.fn(async () => json(500, {})));
    expect(((await HON_CONVERSATION_API.readiness(SCHOOL, new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('UNAVAILABLE');
  });
});

describe('Ask HON view', () => {
  it('opens the composer only when the server says HON can answer, and says nothing is charged', () => {
    const open = render();
    expect(open).toContain('How can I help you today?'); expect(open).toContain('nothing here is charged');
    expect(open).toMatch(/<textarea[^>]*id="hon-ask-full-text"(?![^>]*disabled)/);
    expect(open).not.toMatch(/customer credits|purchased credit|credits? (left|remaining)/i);
    const closed = render({ readiness: { ...readiness(false), providerRoute: false } });
    expect(closed).toContain('the AI provider is not activated yet'); expect(closed).toMatch(/<textarea[^>]*disabled=""/);
    expect(render({ readiness: { ...readiness(false), authorization: false } })).toContain('your role does not include HON');
  });
  it('shows no conversation content unless READY, and none while concealed or signed out', () => {
    for (const phase of ['LOADING', 'CONCEALED', 'SESSION', 'FORBIDDEN', 'UNAVAILABLE'] as const) {
      const html = render({ phase, thread: thread([human(6, 'Private question about Sam'), reply(6)]), threadPhase: 'READY' });
      expect(html).not.toContain('Question 5'); expect(html).not.toContain('Private question about Sam'); expect(html).not.toContain('data-hon-private');
    }
  });
  it('renders a thread with HON’s reply, an incomplete answer and its continue control', () => {
    const html = render({ thread: thread([human(6, 'Who needs follow-up?'), reply(6, {}, { truncated: true, canContinue: true })]), threadPhase: 'READY' });
    expect(html).toContain('Who needs follow-up?'); expect(html).toContain('You have 3 trial leads waiting');
    expect(html).toContain('This answer is incomplete'); expect(html).toContain('Continue this answer');
    expect(html).toContain('aria-current="true"');
  });
  it('explains a concealed, failed or held reply without inventing text', () => {
    const html = render({ thread: thread([
      human(6, 'Q1'), reply(6, { text: null, reason: 'RESULT_CONCEALED' }),
      human(7, 'Q2'), reply(7, { text: null, status: 'FAILED', reason: 'CONFIGURATION_REQUIRED', references: { workItemId: id(8), actionRequestId: null, invocationId: null } }, {}),
      human(3, 'Q3'), reply(3, { text: null, status: 'PROCESSING', reason: 'RESULT_HELD' }),
    ].map((turn) => turn.status !== 'COMPLETED' && turn.replyDetail ? { ...turn, replyDetail: { ...turn.replyDetail, truncated: false, canContinue: false } } : turn)), threadPhase: 'READY' });
    expect(html).toContain('could not be shown safely'); expect(html).toContain('AI provider is not activated yet'); expect(html).toContain('held until access is confirmed');
    expect(html).not.toContain('Continue this answer');
  });
  it('links a specialist proposal to Action Center and never shows its draft', () => {
    const marcus: HonConversationTurn = { turnId: id(6), role: 'marcus', text: null, createdAt: AT, status: 'AWAITING_APPROVAL', reason: null,
      references: { workItemId: id(8), actionRequestId: id(7), invocationId: id(9) }, replyDetail: null };
    const html = render({ thread: thread([human(6, 'Draft a campaign'), marcus]), threadPhase: 'READY' });
    expect(html).toContain('Marcus'); expect(html).toContain('Awaiting approval'); expect(html).toContain('href="/staff/action-center/approvals"');
  });
  it('locks sending while a message is in flight and offers the exact retry only for an unknown outcome', () => {
    const prepared = { path: `${BASE}/conversations/${id(5)}/turns`, key: id(7), body: '{}' };
    const sending = render({ pending: { prepared, kind: 'turn', label: 'Your message to HON', state: 'SENDING', conversationId: id(5) }, draft: 'Next' });
    expect(sending).toContain('HON is working on it'); expect(sending).toMatch(/<button type="submit" disabled=""/);
    const unknown = render({ pending: { prepared, kind: 'turn', label: 'Your message to HON', state: 'UNKNOWN', conversationId: id(5) } });
    expect(unknown).toContain('Retry the same request'); expect(unknown).toContain('cannot create a second reply');
    const refused = render({ pending: { prepared, kind: 'turn', label: 'Your message to HON', state: 'FORBIDDEN', conversationId: id(5), code: 'HON_AI_SPEND_REFUSED' } });
    expect(refused).toContain('paused by HON HQ'); expect(refused).not.toContain('Retry the same request');
    const full = render({ pending: { prepared, kind: 'turn', label: 'Your message to HON', state: 'CONFLICT', conversationId: id(5), code: 'HON_CONVERSATION_FULL' } });
    expect(full).toContain('This conversation is full');
  });
  it('never renders the pending label or retry while concealed or signed out; only a generic line', () => {
    const prepared = { path: `${BASE}/conversations`, key: id(7), body: '{}' };
    for (const phase of ['CONCEALED', 'SESSION'] as const) for (const state of ['SENDING', 'UNKNOWN'] as const) {
      const html = render({ phase, pending: { prepared, kind: 'create', label: 'Starting a conversation with HON', state, conversationId: null, text: 'secret question' } });
      expect(html).not.toContain('Starting a conversation'); expect(html).not.toContain('secret question'); expect(html).not.toContain('Retry the same request');
      expect(html).toContain('data-pending-hidden');
    }
  });
});

describe('HON workspace wiring', () => {
  it('uses the live conversation when one is passed and keeps the honest boundary otherwise', () => {
    const snapshot = { ...initialHonCommandSnapshot(), scope: { state: 'VERIFIED' as const, ...SCHOOL, source: 'CURRENT_SCHOOL' as const, message: 'Verified.' } };
    const base = { snapshot, variant: 'modern' as const, presentation: 'full' as const, tab: 'team' as const, selectedAgentId: null, headingId: 'h' };
    expect(renderToStaticMarkup(<HonWorkspaceView {...base} />)).toContain('Not connected');
    const live = renderToStaticMarkup(<HonWorkspaceView {...base} conversation={<HonConversationView {...props()} />} />);
    expect(live).toContain('data-hon-conversation="READY"'); expect(live).not.toContain('Conversation is not connected yet');
  });
});
