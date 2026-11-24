import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HQ_HON_AGENTS, SAAS_COMMANDS } from '@hon/contracts';
import { hqHonApi, hqHonAskError, hqHonBudgetError } from '../src/components/hq-hon/http';
import { HqHonPanelView, type HqHonPanelViewProps } from '../src/components/hq-hon/hq-hon-panel';
import { HQ_HON_COPY_TABLES, hqHonText } from '../src/components/hq-hon/copy';
import { MarketingError } from '../src/components/hq-marketing/http';
import { HqExecutiveRecords, PerformanceView, TaskHistoryView } from '../src/components/hq-hon/hq-executive-records';

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
  state: { kind: 'READY', view: conv() as never }, question: '', mode: 'STANDARD', outcome: null, onQuestion: () => {}, onMode: () => {}, onAsk: () => {}, onRefresh: () => {}, budgetOutcome: null, onBudget: () => {}, ...patch });

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

it('sets the HQ AI text budget with the owner command marker; the receipt must match the period and cap', async () => {
  const receipt = { budget: budget({ creditCap: 500, availableCredits: 470, version: 2 }), replayed: false };
  const f = stub(json({ data: receipt }));
  const input = { periodStart: '2026-11-01', creditCap: 500, expectedVersion: 1, reason: 'Room for executive questions' };
  expect((await hqHonApi.setBudget(input, id(8), new AbortController().signal, yes)).budget.creditCap).toBe(500);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/hon/budget');
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': SAAS_COMMANDS.setHqHonBudget, 'Idempotency-Key': id(8) });
  expect(JSON.parse(String(init.body))).toEqual(input);
  stub(json({ data: { ...receipt, budget: budget({ creditCap: 400, availableCredits: 370, version: 2 }) } }));
  await expect(hqHonApi.setBudget(input, id(8), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(hqHonApi.setBudget({ ...input, reason: 'x' }, id(8), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  for (const code of ['HQ_HON_PERIOD_NOT_ALLOWED', 'HQ_HON_BUDGET_NO_CHANGE', 'HQ_HON_CAP_BELOW_USE']) expect(hqHonBudgetError(422, code).kind).toBe('REFUSED');
  expect(hqHonBudgetError(409, 'SAAS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(hqHonBudgetError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  expect(hqHonBudgetError(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(hqHonBudgetError(500, null).kind).toBe('UNKNOWN');
  expect(hqHonBudgetError(422, 'HQ_HON_BUDGET_EXHAUSTED').kind).toBe('UNKNOWN');
});

it('offers the budget form to the HQ owner only, and says setting it spends nothing', () => {
  const owner = { kind: 'READY' as const, view: conv({ viewer: { ...viewer, isOwner: true } }) as never };
  const html = renderToStaticMarkup(<HqHonPanelView {...props({ state: owner })}/>);
  expect(html).toContain('data-hq-hon-budget-form'); expect(html).toContain('Set this month');
  expect(html).toContain('does not connect a provider or spend anything');
  expect(renderToStaticMarkup(<HqHonPanelView {...props()}/>)).not.toContain('data-hq-hon-budget-form');
  const saved = renderToStaticMarkup(<HqHonPanelView {...props({ state: owner, budgetOutcome: { kind: 'DONE' } })}/>);
  expect(saved).toContain('Budget saved.');
  const refused = renderToStaticMarkup(<HqHonPanelView {...props({ state: owner, budgetOutcome: { kind: 'ERROR', error: new MarketingError('REFUSED', 'HQ_HON_CAP_BELOW_USE') } })}/>);
  expect(refused).toContain('Not saved: the cap is below what this month has already used or holds.');
  const sending = renderToStaticMarkup(<HqHonPanelView {...props({ state: owner, budgetOutcome: { kind: 'SENDING' } })}/>);
  expect(sending).toMatch(/data-hq-hon-budget-form=""[^]*?<fieldset disabled="">/);
});

// ---------- 0338 (HX-1): executive workspace sections ----------
const tx = (key: Parameters<typeof hqHonText>[1], params: Readonly<Record<string, string | number>> = {}) => hqHonText('en', key, { name: 'Chase', ...params });
const perf = { agentKey: 'chase' as const, periodStart: '2026-11-01', asked: 4, answered: 2, failed: 1, underReview: 1, inProgress: 0, resolved: 0, askers: 2,
  chargedCredits: 9, lastAskedAt: '2026-11-13T07:00:00.000Z', asOf: '2026-11-13T07:30:00.000Z' };

it('0338: performance shows this month\'s aggregate counts only; refusals and errors show nothing invented', () => {
  const html = renderToStaticMarkup(<PerformanceView state={{ kind: 'READY', value: perf }} t={tx}/>);
  for (const text of ['Chase this month', 'Every HQ question to Chase since 2026-11', 'Questions asked', 'Answered', 'HQ people who asked', 'HQ AI text credits charged', 'Last question']) expect(html).toContain(text);
  expect(html).not.toMatch(/reply|provider|model|\$/i);
  expect(renderToStaticMarkup(<PerformanceView state={{ kind: 'READY', value: { ...perf, asked: 0, answered: 0, failed: 0, underReview: 0, askers: 0, chargedCredits: 0, lastAskedAt: null } }} t={tx}/>)).toContain('No HQ questions to Chase this month.');
  expect(renderToStaticMarkup(<PerformanceView state={{ kind: 'DENIED' }} t={tx}/>)).toContain('does not include Chase&#x27;s area');
  expect(renderToStaticMarkup(<PerformanceView state={{ kind: 'UNAVAILABLE' }} t={tx}/>)).toContain('Performance could not be read. Nothing is shown.');
});

it('0338: task history lists only this agent\'s recorded turns; recommendations and approvals say the executive never acts', () => {
  const turn = (agentKey: string, question: string) => ({ turnId: crypto.randomUUID(), agentKey, replyMode: 'STANDARD', question, status: 'ANSWERED', failureReason: null,
    reply: 'x', truncated: false, concealed: false, reservedCredits: 10, chargedCredits: 2, askedBy: { principalId: crypto.randomUUID(), displayName: 'A' }, version: 2,
    createdAt: '2026-11-13T07:00:00.000Z', completedAt: '2026-11-13T07:00:05.000Z' });
  const view = { turns: [turn('chase', 'How are HQ campaigns doing?'), turn('mia', 'Support backlog?')] } as never;
  const html = renderToStaticMarkup(<TaskHistoryView agentKey="chase" state={{ kind: 'READY', value: view }} t={tx}/>);
  expect(html).toContain('How are HQ campaigns doing?'); expect(html).not.toContain('Support backlog?'); expect(html).toContain('Answered');
  expect(renderToStaticMarkup(<TaskHistoryView agentKey="chase" state={{ kind: 'READY', value: { turns: [] } as never }} t={tx}/>)).toContain('You have not asked Chase anything yet.');
  expect(renderToStaticMarkup(<HqExecutiveRecords agentKey="chase" name="Chase" tab="recommendations"/>)).toContain('Chase answers questions only');
  expect(renderToStaticMarkup(<HqExecutiveRecords agentKey="chase" name="Chase" tab="approvals"/>)).toContain('Chase never takes an action');
});

it('0338: the performance read asks for one catalog agent and refuses an answer about another', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ...perf, agentKey: 'mia' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await expect(hqHonApi.performance('chase', AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/v1/hq/hon/performance/chase');
    await expect(hqHonApi.performance('claire' as never, AbortSignal.timeout(1000), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
