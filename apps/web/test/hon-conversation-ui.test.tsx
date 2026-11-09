import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HonConversationThread, HonConversationTurn, HonOrchestration } from '@hon/contracts';
import {
  HON_CONVERSATION_API, HON_CONVERSATION_COMMAND, HonConversationError, honConversationBase, prepareConversation, prepareTurn, verifyHonPage, verifyHonReadiness,
} from '../src/components/hon-command/hon-conversation-http';
import { HonConversationView, type HonConversationViewProps } from '../src/components/hon-command/hon-conversation-panel';
import { HonWorkspaceView } from '../src/components/hon-command/hon-workspace-view';
import { initialHonCommandSnapshot } from '../src/components/hon-command/hon-command-data';
import { honTargetPath } from '../src/components/hon-command/hon-conversation-http';
import {
  HonTargetDrift, orchestrationsBySource, suggestionDelegation, verifyCampaignTargets, verifyCurriculumTargets, verifyLeadTargets,
} from '../src/components/hon-command/hon-suggestions';
import type { SuggestionConfirm } from '../src/components/hon-command/hon-conversation-panel';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const AT = '2026-11-06T18:00:00.000Z';
const SCHOOL = { organizationId: id(1), schoolId: id(2) };
const BASE = `/api/v1/organizations/${id(1)}/schools/${id(2)}/hon`;
const readiness = (honReply = true) => ({ contract: true as const, providerRoute: honReply, entitlement: true, authorization: true, availableAgentKeys: ['marcus' as const], honReply, businessPerformance: false, asOf: AT });
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
  groups: new Map(), groupPhase: 'READY', confirm: null, onSuggest: noop, onConfirmChange: noop, onConfirmSend: noop, onConfirmCancel: noop,
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

const campaign = (n: number, status = 'ACTIVE', over: Record<string, unknown> = {}) => ({ id: id(n), code: `C${n}`, name: `Spring trial ${n}`, goal: 'More trials', offerLabel: '',
  channel: 'EMAIL', startsAt: AT, endsAt: AT, plannedBudgetMinor: 0, currency: 'USD', version: 2, status, createdAt: AT, updatedAt: AT, planningOnly: true, ...over });
const lead = (n: number, status = 'OPEN') => ({ id: id(n), status, pipelineStageId: id(1), primaryPersonId: id(2), version: 4, createdAt: AT, givenName: 'Sam', familyName: `Lee${n}` });
const group = (status: HonOrchestration['status'], members: HonOrchestration['members']): HonOrchestration => ({ sourceTurnId: id(6), status, members });

describe('Ask HON suggestion targets (C3a)', () => {
  it('reads each specialist’s own list API, and only the targets that specialist accepts', () => {
    expect(honTargetPath('marcus', SCHOOL)).toBe('/api/v1/marketing/campaigns');
    expect(honTargetPath('kai', SCHOOL)).toBe('/api/v1/staff/teaching-assistant/curricula');
    expect(honTargetPath('chad', SCHOOL)).toBe(`/api/v1/organizations/${id(1)}/schools/${id(2)}/crm/leads?limit=50&status=OPEN`);
    expect(() => honTargetPath('chad', { organizationId: 'x', schoolId: id(2) })).toThrow(HonConversationError);
    expect(verifyCampaignTargets({ data: [campaign(3), campaign(4, 'ARCHIVED'), campaign(5, 'DRAFT')], meta: {} }).map((t) => [t.id, t.detail])).toEqual([[id(3), 'active'], [id(5), 'draft']]);
    expect(verifyCurriculumTargets({ data: { items: [{ id: id(3), name: 'Little Dragons', version: 2 }] } })).toEqual([{ id: id(3), label: 'Little Dragons', detail: 'version 2', version: null }]);
    expect(verifyLeadTargets({ data: [lead(3), lead(4, 'WON')], meta: {} })).toEqual([{ id: id(3), label: 'Sam Lee3', detail: null, version: 4 }]);
  });
  it('treats a drifted list as unverified, never as an empty one', () => {
    for (const bad of [{ data: [campaign(3)] }, { data: [campaign(3, 'GONE')], meta: {} }, { data: [campaign(3, 'ACTIVE', { planningOnly: false })], meta: {} },
      { data: [campaign(3), campaign(3)], meta: {} }, { data: {}, meta: {} }]) expect(() => verifyCampaignTargets(bad)).toThrow(HonTargetDrift);
    for (const bad of [{ data: { items: [{ id: id(3), name: 'X', version: 0 }] } }, { data: { items: [] }, meta: {} }, { data: { items: [{ id: id(3), name: 'X', version: 1, extra: 1 }] } }])
      expect(() => verifyCurriculumTargets(bad)).toThrow(HonTargetDrift);
    for (const bad of [{ data: [{ ...lead(3), version: 0 }], meta: {} }, { data: [lead(3)] }]) expect(() => verifyLeadTargets(bad)).toThrow(HonTargetDrift);
  });
  it('builds the confirmed delegation naming the answer it came from; a lead needs its version and a purpose', () => {
    const target = { id: id(3), label: 'Sam Lee', detail: null, version: 4 };
    expect(() => suggestionDelegation('chad', target, null)).toThrow(HonTargetDrift);
    expect(() => suggestionDelegation('chad', { ...target, version: null }, 'CHECK_IN')).toThrow(HonTargetDrift);
    const prepared = prepareTurn(SCHOOL, id(5), { text: 'Friendly check-in', delegation: suggestionDelegation('chad', target, 'CHECK_IN'), fromSuggestionTurnId: id(6) });
    expect(JSON.parse(prepared.body)).toEqual({ text: 'Friendly check-in', delegation: { agentKey: 'chad', leadId: id(3), expectedLeadVersion: 4, purpose: 'CHECK_IN' }, fromSuggestionTurnId: id(6) });
    expect(JSON.parse(prepareTurn(SCHOOL, id(5), { text: 'Spring post', delegation: suggestionDelegation('marcus', target, null), fromSuggestionTurnId: id(6) }).body).delegation).toEqual({ agentKey: 'marcus', campaignId: id(3) });
    expect(JSON.parse(prepareTurn(SCHOOL, id(5), { text: 'Week 1 plan', delegation: suggestionDelegation('kai', target, null), fromSuggestionTurnId: id(6) }).body).delegation).toEqual({ agentKey: 'kai', curriculumId: id(3) });
    expect(() => prepareTurn(SCHOOL, id(5), { text: 'x'.repeat(1201), delegation: suggestionDelegation('kai', target, null), fromSuggestionTurnId: id(6) })).toThrow(HonConversationError);
  });
  it('reads grouped status from the fixed orchestrations path and refuses a status that does not match its members', async () => {
    const ok = { items: [group('NEEDS_REVIEW', [{ agentKey: 'marcus', turnId: id(7), status: 'AWAITING_APPROVAL' }])] };
    const fetchMock = vi.fn(async () => json(200, { data: ok }));
    vi.stubGlobal('fetch', fetchMock);
    const list = await HON_CONVERSATION_API.orchestrations(SCHOOL, id(5), new AbortController().signal);
    expect(orchestrationsBySource(list).get(id(6))?.status).toBe('NEEDS_REVIEW');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/conversations/${id(5)}/orchestrations`);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: { items: [{ ...ok.items[0], status: 'COMPLETED' }] } })));
    expect(((await HON_CONVERSATION_API.orchestrations(SCHOOL, id(5), new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('UNAVAILABLE');
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { data: [campaign(3)], meta: {}, extra: 1 })));
    expect(((await HON_CONVERSATION_API.targets('marcus', SCHOOL, new AbortController().signal).catch((e: unknown) => e)) as HonConversationError).kind).toBe('UNAVAILABLE');
  });
  it('a 401 for a retired read or command never ends the session; an owned one does', async () => {
    vi.stubGlobal('window', new EventTarget());
    const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { code: 'SIGN_IN_REQUIRED' })));
    const retired = () => false, owned = () => true;
    const prepared = prepareTurn(SCHOOL, id(5), { text: 'Hi', delegation: suggestionDelegation('marcus', { id: id(3), label: 'C', detail: null, version: null }, null), fromSuggestionTurnId: id(6) });
    for (const call of [() => HON_CONVERSATION_API.sendTurn(prepared, retired), () => HON_CONVERSATION_API.targets('chad', SCHOOL, new AbortController().signal, retired),
      () => HON_CONVERSATION_API.orchestrations(SCHOOL, id(5), new AbortController().signal, retired), () => HON_CONVERSATION_API.thread(SCHOOL, id(5), new AbortController().signal, retired)])
      await expect(call()).rejects.toMatchObject({ kind: 'SESSION' });
    expect(seen).not.toHaveBeenCalled();
    await expect(HON_CONVERSATION_API.sendTurn(prepared, owned)).rejects.toMatchObject({ kind: 'SESSION' });
    await expect(HON_CONVERSATION_API.targets('kai', SCHOOL, new AbortController().signal, owned)).rejects.toMatchObject({ kind: 'SESSION' });
    expect(seen).toHaveBeenCalledTimes(2);
  });
  it('a refused confirmation is definitive and named; an unknown one keeps the exact retry', async () => {
    const prepared = prepareTurn(SCHOOL, id(5), { text: 'Hi', delegation: suggestionDelegation('kai', { id: id(3), label: 'C', detail: null, version: null }, null), fromSuggestionTurnId: id(6) });
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { code: 'HON_SUGGESTION_NOT_CONFIRMABLE' })));
    expect(await HON_CONVERSATION_API.sendTurn(prepared).catch((e: unknown) => e)).toMatchObject({ kind: 'INVALID', code: 'HON_SUGGESTION_NOT_CONFIRMABLE' });
    const html = render({ pending: { prepared, kind: 'turn', label: 'Your request to Kai', state: 'INVALID', conversationId: id(5), code: 'HON_SUGGESTION_NOT_CONFIRMABLE' } });
    expect(html).toContain('can no longer be confirmed'); expect(html).not.toContain('Retry the same request');
  });
});

describe('Ask HON suggestion cards (C3a)', () => {
  const answer = (suggestions: Array<'marcus' | 'kai' | 'chad'>, over: Partial<HonConversationTurn> = {}) => thread([human(6, 'How do I fill Saturday trials?'), reply(6, over, { suggestions })]);
  const all = { ...readiness(), availableAgentKeys: ['marcus' as const, 'kai' as const, 'chad' as const] };
  it('offers one card per suggested specialist that only opens a confirmation; nothing runs from the card', () => {
    const html = render({ readiness: all, thread: answer(['marcus', 'chad']), threadPhase: 'READY' });
    expect(html).toContain('HON suggests asking these specialists'); expect(html).toContain('Nothing runs until you choose what they work on and confirm');
    expect(html).toContain('>Ask Marcus</button>'); expect(html).toContain('>Ask Chad</button>'); expect(html).not.toContain('Ask Kai');
    expect(html).toContain('Nothing is sent to the family'); expect(html).not.toMatch(/credits? (left|remaining)|purchased credit/i);
    expect(html).toMatch(/data-hon-private=""[\s\S]*data-hon-suggestions/);
  });
  it('shows no card for a concealed, failed or cut-off answer even if suggestions were present', () => {
    for (const over of [{ reason: 'RESULT_CONCEALED', text: null }, { status: 'FAILED' as const }]) expect(render({ readiness: all, thread: answer(['marcus'], over), threadPhase: 'READY' })).not.toContain('Ask Marcus');
  });
  it('says a specialist is unavailable instead of offering it, and locks every card while a request is in flight or unknown', () => {
    expect(render({ readiness: readiness(), thread: answer(['kai']), threadPhase: 'READY' })).toContain('Kai isn’t available for your role');
    const prepared = { path: `${BASE}/conversations/${id(5)}/turns`, key: id(7), body: '{}' };
    for (const state of ['SENDING', 'UNKNOWN'] as const)
      expect(render({ readiness: all, thread: answer(['marcus']), threadPhase: 'READY', pending: { prepared, kind: 'turn', label: 'Your request to Chad', state, conversationId: id(5) } })).toMatch(/disabled=""[^>]*>Ask Marcus/);
    expect(render({ readiness: all, thread: answer(['marcus']), threadPhase: 'READY', groupPhase: 'UNAVAILABLE' })).toMatch(/could not be verified, so they can’t be asked[\s\S]*disabled=""[^>]*>Ask Marcus/);
  });
  it('shows grouped status with each member and points a draft to Action Center; an asked specialist is not offered again', () => {
    const g = group('PARTIAL', [{ agentKey: 'marcus', turnId: id(7), status: 'COMPLETED' }, { agentKey: 'chad', turnId: id(8), status: 'FAILED' }]);
    const html = render({ readiness: all, thread: answer(['marcus', 'chad', 'kai']), threadPhase: 'READY', groups: orchestrationsBySource({ items: [g] }) });
    expect(html).toContain('Specialists you asked'); expect(html).toContain('Partly done'); expect(html).toContain('data-orchestration="PARTIAL"');
    expect(html).toContain('href="/staff/action-center/approvals"'); expect(html).not.toContain('>Ask Marcus</button>'); expect(html).not.toContain('>Ask Chad</button>');
    expect(html).toContain('>Ask Kai</button>'); expect(html.match(/Asked from this answer/g)).toHaveLength(2);
  });
  it('the confirmation names the specialist’s own target, the follow-up type for Chad, and the specialist’s text limit', () => {
    const base: SuggestionConfirm = { seq: 1, sourceTurnId: id(6), agent: 'chad', targetId: '', purpose: null, text: '', targets: [{ id: id(3), label: 'Sam Lee', detail: null, version: 4 }] };
    const html = render({ readiness: all, thread: answer(['chad']), threadPhase: 'READY', confirm: base });
    expect(html).toContain('aria-label="Ask Chad"'); expect(html).toContain('Choose a lead'); expect(html).toContain('Sam Lee'); expect(html).toContain('Follow-up type');
    expect(html).toContain('Trial reminder'); expect(html).toContain('2,000 characters left'); expect(html).toMatch(/<button type="submit" disabled="">Send to Chad/);
    const ready = render({ readiness: all, thread: answer(['chad']), threadPhase: 'READY', confirm: { ...base, targetId: id(3), purpose: 'CHECK_IN', text: 'Ask about Saturday' } });
    expect(ready).toMatch(/<button type="submit">Send to Chad/);
    const kai = render({ readiness: all, thread: answer(['kai']), threadPhase: 'READY', confirm: { ...base, agent: 'kai', targets: [] } });
    expect(kai).toContain('No published curricula'); expect(kai).not.toContain('Send to Kai');
    expect(render({ readiness: all, thread: answer(['kai']), threadPhase: 'READY', confirm: { ...base, agent: 'kai', targets: [{ id: id(3), label: 'Little Dragons', detail: 'version 2', version: null }] } })).toContain('1,200 characters left');
    expect(render({ readiness: all, thread: answer(['marcus']), threadPhase: 'READY', confirm: { ...base, agent: 'marcus', targets: 'LOADING' } })).toContain('Loading campaign choices for Marcus');
    const failed = render({ readiness: all, thread: answer(['marcus']), threadPhase: 'READY', confirm: { ...base, agent: 'marcus', targets: 'UNAVAILABLE' } });
    expect(failed).toContain('could not be verified right now'); expect(failed).not.toContain('Send to Marcus');
  });
  it('explains a specialist’s recorded refusal without inventing a draft', () => {
    const chad: HonConversationTurn = { turnId: id(7), role: 'chad', text: null, createdAt: AT, status: 'FAILED', reason: 'AGENT_TARGET_NOT_FOUND',
      references: { workItemId: null, actionRequestId: null, invocationId: null }, replyDetail: null };
    expect(render({ thread: thread([human(7, 'Follow up'), chad]), threadPhase: 'READY' })).toContain('no longer available to this specialist');
  });
  it('offers Summarize with HON only on a finished, verified group, and sends it as a question naming that group', () => {
    const members: HonOrchestration['members'] = [{ agentKey: 'marcus', turnId: id(7), status: 'COMPLETED' }];
    const asked: string[] = [];
    for (const status of ['COMPLETED', 'FAILED', 'PARTIAL'] as const) {
      const html = render({ readiness: all, thread: answer(['marcus']), threadPhase: 'READY', groups: orchestrationsBySource({ items: [group(status, members)] }), onSummarize: (t) => asked.push(t) });
      expect(html).toMatch(/<button type="button" class="[^"]*">Summarize with HON<\/button>/); expect(html).toContain('It changes nothing.');
    }
    for (const status of ['PENDING', 'NEEDS_REVIEW', 'UNKNOWN'] as const)
      expect(render({ readiness: all, thread: answer(['marcus']), threadPhase: 'READY', groups: orchestrationsBySource({ items: [group(status, members)] }), onSummarize: noop })).not.toContain('Summarize with HON');
    const done = { readiness: all, thread: answer(['marcus']), threadPhase: 'READY' as const, groups: orchestrationsBySource({ items: [group('COMPLETED', members)] }), onSummarize: noop };
    expect(render({ ...done, groupPhase: 'UNAVAILABLE' })).not.toContain('Summarize with HON');
    expect(render({ ...done, readiness: { ...all, honReply: false } })).toMatch(/disabled=""[^>]*>Summarize with HON/);
    const prepared = { path: `${BASE}/conversations/${id(5)}/turns`, key: id(7), body: '{}' };
    expect(render({ ...done, pending: { prepared, kind: 'turn', label: 'Summarize with HON', state: 'UNKNOWN', conversationId: id(5) } })).toMatch(/disabled=""[^>]*>Summarize with HON/);
    const body = JSON.parse(prepareTurn(SCHOOL, id(5), { text: 'Summarize', delegation: null, summarizeTurnId: id(6) }).body);
    expect(body).toEqual({ text: 'Summarize', delegation: null, summarizeTurnId: id(6) });
    expect(() => prepareTurn(SCHOOL, id(5), { text: 'Summarize', delegation: null, summarizeTurnId: id(6), continueTurnId: id(6) })).toThrow(HonConversationError);
    expect(render({ thread: answer(['marcus']), threadPhase: 'READY', pending: { prepared, kind: 'turn', label: 'Summarize with HON', state: 'INVALID', conversationId: id(5), code: 'HON_GROUP_NOT_SUMMARIZABLE' } }))
      .toContain('HON can’t summarize those specialists yet');
    expect(render({ thread: thread([human(4, 'Summarize'), reply(6, { text: null, status: 'FAILED', reason: 'GROUP_NOT_SUMMARIZABLE' })]), threadPhase: 'READY' })).toContain('HON did not summarize');
  });
});
