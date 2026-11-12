import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_HON_AGENTS, SAAS_COMMANDS } from '@hon/contracts';
import { hqHonApi, hqHonAskError } from '../src/components/hq-hon/http';
import { HqHonPanelView, type HqHonPanelViewProps } from '../src/components/hq-hon/hq-hon-panel';
import { HQ_HON_COPY_TABLES, hqHonText } from '../src/components/hq-hon/copy';
import { MarketingError } from '../src/components/hq-marketing/http';

// HQ Ask HON web (0263/0264): same-origin transport, one Idempotency-Key per attempt, server-decided availability,
// concealed answers never shown, and no provider, model, school or cost in the view.
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const viewer = { principalId: id(50), displayName: 'Synthetic Operator', isOwner: false };
const budget = (patch: Record<string, unknown> = {}) => ({ periodStart: '2026-11-01', creditCap: 100, usedCredits: 20, heldCredits: 10, availableCredits: 70,
  inProgress: 0, version: 1, setBy: { principalId: id(51), displayName: 'Synthetic Owner' }, setAt: T, ...patch });
const turn = (patch: Record<string, unknown> = {}) => ({ turnId: id(1), agentKey: 'mia', replyMode: 'STANDARD', question: 'How many urgent cases are open?',
  status: 'ANSWERED', failureReason: null, reply: 'Two urgent cases are open.', truncated: false, concealed: false, reservedCredits: 10, chargedCredits: 3,
  askedBy: { principalId: viewer.principalId, displayName: viewer.displayName }, version: 1, createdAt: T, completedAt: T2, ...patch });
const conv = (patch: Record<string, unknown> = {}) => ({ provider: 'CONNECTED', budget: budget(), turns: [turn()], budgetHistory: [], underReview: [],
  availableAgents: ['hon', 'mia'], limit: 50, viewer, asOf: T2, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

it('reads the conversation with a same-origin no-store GET and refuses drift', async () => {
  const f = stub(json({ data: conv() }));
  expect((await hqHonApi.conversation(new AbortController().signal, yes)).availableAgents).toEqual(['hon', 'mia']);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/hon');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  for (const bad of [conv({ providerId: 'OPENROUTER' }), conv({ availableAgents: ['mia'] }), conv({ turns: [{ ...turn(), schoolId: id(3) }] })]) {
    stub(json({ data: bad }));
    await expect(hqHonApi.conversation(new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  await expect(hqHonApi.conversation(new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('asks with the human-command marker and the caller\'s key; the answer must match the question', async () => {
  const receipt = { turn: turn({ status: 'ANSWERED' }), budget: budget(), replayed: false };
  const f = stub(json({ data: receipt }));
  const input = { question: 'How many urgent cases are open?', replyMode: 'STANDARD', agentKey: 'mia' } as const;
  expect((await hqHonApi.ask(input, id(9), new AbortController().signal, yes)).turn.reply).toBe('Two urgent cases are open.');
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/hon/turns');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': SAAS_COMMANDS.askHqHon, 'Idempotency-Key': id(9), 'Content-Type': 'application/json' });
  expect(JSON.parse(String(init.body))).toEqual(input);
  stub(json({ data: { ...receipt, turn: turn({ agentKey: 'ryan' }) } }));
  await expect(hqHonApi.ask(input, id(9), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(hqHonApi.ask({ ...input, agentKey: 'claire' } as never, id(9), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('maps only definitive refusals; anything else is UNKNOWN so a retry keeps the key', () => {
  expect(hqHonAskError(503, 'HQ_HON_PROVIDER_NOT_CONNECTED').kind).toBe('REFUSED');
  for (const code of ['HQ_HON_PAUSED_BY_HQ', 'HQ_HON_NO_ELIGIBLE_ROUTE', 'HQ_HON_BUDGET_NOT_SET', 'HQ_HON_TOO_MANY_IN_PROGRESS', 'HQ_HON_BUDGET_EXHAUSTED'])
    expect(hqHonAskError(422, code).kind).toBe('REFUSED');
  expect(hqHonAskError(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(hqHonAskError(409, 'HQ_HON_TURN_IN_PROGRESS').kind).toBe('CHANGED');
  expect(hqHonAskError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  for (const [s, c] of [[503, 'HQ_HON_PERSISTENCE_UNKNOWN'], [500, null], [422, 'SOMETHING_ELSE']] as const) expect(hqHonAskError(s, c).kind).toBe('UNKNOWN');
});

const props = (patch: Partial<HqHonPanelViewProps> = {}): HqHonPanelViewProps => ({ agentKey: 'mia', name: 'Mia', language: 'en', number: n => String(n),
  state: { kind: 'READY', view: conv() as never }, question: '', mode: 'STANDARD', outcome: null, onQuestion: () => {}, onMode: () => {}, onAsk: () => {}, onRefresh: () => {}, ...patch });

it('offers the question only when the server lists the agent and a provider is connected', () => {
  const html = renderToStaticMarkup(<HqHonPanelView {...props()}/>);
  expect(html).toContain('Ask Mia'); expect(html).toContain('<textarea'); expect(html).toContain('Two urgent cases are open.');
  expect(html).toContain('70 of 100 credits available');
  const notMine = renderToStaticMarkup(<HqHonPanelView {...props({ agentKey: 'ryan', name: 'Ryan' })}/>);
  expect(notMine).not.toContain('<textarea'); expect(notMine).toContain('cannot ask Ryan'); expect(notMine).toContain('No questions to Ryan yet.');
  const off = renderToStaticMarkup(<HqHonPanelView {...props({ state: { kind: 'READY', view: conv({ provider: 'NOT_CONNECTED' }) as never } })}/>);
  expect(off).not.toContain('<textarea'); expect(off).toContain('approval first'); expect(off).not.toContain('David');
  const noCap = renderToStaticMarkup(<HqHonPanelView {...props({ state: { kind: 'READY', view: conv({ budget: budget({ creditCap: null, availableCredits: 0, version: null, setBy: null, setAt: null }) }) as never } })}/>);
  expect(noCap).toContain('No HQ AI text budget is set');
});

it('never shows a concealed answer, shows each status, and never names a provider, model or school', () => {
  const view = conv({ turns: [turn({ reply: null, concealed: true }), turn({ turnId: id(2), status: 'UNDER_REVIEW', failureReason: 'PROVIDER_UNKNOWN', reply: null,
    truncated: null, chargedCredits: null }), turn({ turnId: id(3), agentKey: 'hon', question: 'Other agent question' })] });
  const html = renderToStaticMarkup(<HqHonPanelView {...props({ state: { kind: 'READY', view: view as never } })}/>);
  expect(html).toContain('Hidden: you no longer hold the access'); expect(html).toContain('Held for HQ owner review');
  expect(html).not.toContain('Other agent question');
  expect(html).not.toMatch(/OPENROUTER|fixture\/model|schoolId|organizationId/);
  const refused = renderToStaticMarkup(<HqHonPanelView {...props({ outcome: { kind: 'ERROR', error: new MarketingError('REFUSED', 'HQ_HON_BUDGET_EXHAUSTED') } })}/>);
  expect(refused).toContain('Not asked: the monthly budget is used up.');
  // A replayed receipt shows the turn's own status, never "Answered." for a turn that is not ANSWERED.
  const held = renderToStaticMarkup(<HqHonPanelView {...props({ outcome: { kind: 'DONE', status: 'UNDER_REVIEW' } })}/>);
  expect(held).toContain('Held for HQ owner review'); expect(held).not.toContain('<p>Answered.</p>');
  expect(renderToStaticMarkup(<HqHonPanelView {...props({ outcome: { kind: 'DONE', status: 'ANSWERED' } })}/>)).toContain('<p>Answered.</p>');
  // After an unconfirmed result, Ask stays off until a refresh, so an edited question cannot ask twice.
  const unknown = renderToStaticMarkup(<HqHonPanelView {...props({ question: 'Edited question', outcome: { kind: 'ERROR', error: new MarketingError('UNKNOWN') } })}/>);
  expect(unknown).toMatch(/<button type="submit" disabled="">/); expect(unknown).toContain('Refresh before asking again');
  for (const s of ['LOADING', 'DENIED', 'UNAVAILABLE'] as const) expect(renderToStaticMarkup(<HqHonPanelView {...props({ state: { kind: s } })}/>)).not.toContain('<textarea');
});

it('has every phrase in en, ko and es, and the workspace mounts the panel for each executive', () => {
  const keys = Object.keys(HQ_HON_COPY_TABLES.en).sort();
  for (const lang of ['ko', 'es'] as const) expect(Object.keys(HQ_HON_COPY_TABLES[lang]).sort()).toEqual(keys);
  expect(hqHonText('ko', 'askTitle', { name: 'Mia' })).toBe('Mia에게 질문');
  const pages = readFileSync('src/components/hq-modern/pages.tsx', 'utf8');
  expect(pages).toContain('<HqHonPanel agentKey={executive.executiveKey}');
  expect([...HQ_HON_AGENTS]).toEqual(['hon', 'chase', 'mia', 'ethan', 'olivia', 'ryan', 'sophia']);
  const panel = readFileSync('src/components/hq-hon/hq-hon-panel.tsx', 'utf8');
  expect(panel).not.toMatch(/localStorage|sessionStorage|providerId|modelId/);
});
