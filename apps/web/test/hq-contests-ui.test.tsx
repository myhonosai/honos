import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CHAMPIONS_COMMANDS, validateChampionsContestDetail, validateChampionsContestList, type ChampionsContestConfig, type ChampionsContestStatus } from '@hon/contracts';
import { contestApi, contestCommandError } from '../src/components/hq-contests/http';
import { configFrom, dayToInstant, dollarsToMinor, draftFrom, emptyDraft, scheduleBlockers } from '../src/components/hq-contests/form';
import { contestText } from '../src/components/hq-contests/copy';
import { HqContestsListView, type ContestListState } from '../src/components/hq-contests/hq-contests-list';
import { HqContestView, type ContestState } from '../src/components/hq-contests/hq-contest';
import { HQ_PLANNED, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KEY = '11111111-1111-4111-8111-111111111111';
const T = '2026-11-01T00:00:00.000Z', START = '2026-12-01T00:00:00.000Z', END = '2026-12-31T23:59:59.999Z';
const NOW = Date.parse('2026-11-09T00:00:00.000Z');
function contest(patch: Record<string, unknown> = {}) {
  return { contestId: id(1), name: 'Winter referral race', description: 'Most qualified referrals in December wins.', termsReference: 'Contest terms v1', status: 'DRAFT', version: 1,
    startsAt: START, endsAt: END, countBasis: 'QUALIFIED_IN_WINDOW', minimumQualified: 2, tieRule: 'OWNER_RESOLVES',
    eligibility: { scope: 'ALL_ACTIVE_SCHOOLS', tiers: ['CORE', 'COMPLETE'], schoolIds: [] }, budgetMinor: 100000, currency: 'USD', giftCardCompliance: 'UNDECIDED',
    schoolVisibility: 'HIDDEN', publicListing: 'DISABLED', financialActivation: 'DISABLED', automaticTransitions: 'NOT_CONFIGURED',
    prizes: [{ prizeId: id(11), placeFrom: 1, placeTo: 1, kind: 'EXPERIENCE', description: 'Team trip', quantity: 1, estimatedUnitCostMinor: 50000 },
      { prizeId: id(12), placeFrom: 2, placeTo: 3, kind: 'ELECTRONICS', description: 'Tablet', quantity: 1, estimatedUnitCostMinor: 20000 }],
    estimatedPrizeCostMinor: 90000, due: 'NONE', duplicatedFrom: null, createdAt: T, scheduledAt: null, activatedAt: null, endedAt: null, completedAt: null, cancelledAt: null,
    cancelReason: null, ...patch };
}
const standing = (n: number, rank: number, eligible = true) => ({ schoolId: id(20 + n), schoolName: `Synthetic School ${n}`, organizationId: id(30 + n), qualifiedReferrals: 10 - n,
  reachedAt: T, eligible, ineligibleReason: eligible ? null : 'BELOW_MINIMUM', rank: eligible ? rank : null, position: eligible ? rank : null });
function detail(c = contest(), patch: Record<string, unknown> = {}) {
  return { contest: c, standings: [standing(1, 1), standing(2, 2), standing(3, 0, false)], standingsFrozen: false, pauses: [], winners: [],
    liabilities: { currency: 'USD', budgetMinor: c.budgetMinor, estimatedPrizeCostMinor: c.estimatedPrizeCostMinor, pendingWinnerCostMinor: 0, approvedWinnerCostMinor: 0, financialActivation: 'DISABLED' },
    history: [{ action: 'CREATE', fromStatus: 'NONE', toStatus: 'DRAFT', contestVersion: 1, detail: {}, occurredAt: T }], countsOnly: 'QUALIFIED', ...patch };
}
const config = () => { const { prizes, ...c } = contest(); return { name: c.name, description: c.description, termsReference: c.termsReference, startsAt: START, endsAt: END,
  countBasis: c.countBasis, minimumQualified: 2, tieRule: c.tieRule, eligibility: c.eligibility, budgetMinor: 100000, giftCardCompliance: 'UNDECIDED',
  prizes: prizes.map(({ prizeId: _p, ...x }) => x) } as unknown as ChampionsContestConfig; };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;

it('reads the list and one contest with plain same-origin GETs, and checks the answers match', async () => {
  const f = stub(json({ data: { contests: [contest()], limit: 100 } }), json({ data: detail() }), json({ data: { contests: [contest({ status: 'ACTIVE' })], limit: 100 } }));
  expect((await contestApi.list(null, signal(), yes)).contests).toHaveLength(1);
  expect((await contestApi.read(id(1).toUpperCase(), signal(), yes)).contest.name).toBe('Winter referral race');
  await expect(contestApi.list('DRAFT', signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const calls = f.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(c => c[0])).toEqual(['/api/v1/hq/champions/contests', `/api/v1/hq/champions/contests/${id(1)}`, '/api/v1/hq/champions/contests?status=DRAFT']);
  for (const [, init] of calls) { expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' }); expect(init.body).toBeUndefined(); }
  stub(json({ data: detail(contest({ contestId: id(2) })) }));
  await expect(contestApi.read(id(1), signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(contestApi.read('nope', signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('sends commands with the human-command marker and key, and accepts only the matching answer', async () => {
  const f = stub(json({ data: { contest: contest(), action: 'CREATE', replayed: false } }));
  await contestApi.command(null, { action: 'CREATE', ...config() }, KEY, signal(), yes);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/champions/contests');
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': CHAMPIONS_COMMANDS.contestCommand, 'Idempotency-Key': KEY });
  expect(JSON.parse(String(init.body))).toMatchObject({ action: 'CREATE', name: 'Winter referral race', budgetMinor: 100000 });
  const g = stub(json({ data: { contest: contest({ status: 'SCHEDULED', version: 2 }), action: 'SCHEDULE', replayed: false } }));
  await contestApi.command(id(1), { action: 'SCHEDULE', expectedVersion: 1, schoolVisibility: 'HIDDEN' }, KEY, signal(), yes);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/champions/contests/${id(1)}/commands`);
  for (const answer of [{ contest: contest({ version: 3 }), action: 'PAUSE', replayed: false }, { contest: contest({ version: 2 }), action: 'END', replayed: false },
    { contest: contest({ contestId: id(9), version: 2 }), action: 'PAUSE', replayed: false }]) {
    stub(json({ data: answer }));
    await expect(contestApi.command(id(1), { action: 'PAUSE', expectedVersion: 1 }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(json({ data: { contest: contest({ contestId: id(5), duplicatedFrom: id(9), name: 'Copy', startsAt: START, endsAt: END }), action: 'DUPLICATE', replayed: false } }));
  await expect(contestApi.command(id(1), { action: 'DUPLICATE', name: 'Copy', startsAt: START, endsAt: END }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  const h = stub();
  await expect(contestApi.command(id(1), { action: 'CREATE', ...config() }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(contestApi.command(null, { action: 'PAUSE', expectedVersion: 1 }, KEY, signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(contestApi.command(id(1), { action: 'PAUSE', expectedVersion: 1 }, 'not-a-key', signal(), yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(h).not.toHaveBeenCalled();
});

it('maps refusals exactly; anything not definitive is unknown and kept for retry', () => {
  expect(contestCommandError(403, 'CHAMPIONS_FORBIDDEN').kind).toBe('DENIED');
  expect(contestCommandError(409, 'CHAMPIONS_TRANSITION_NOT_ALLOWED').kind).toBe('CHANGED');
  expect(contestCommandError(409, 'CHAMPIONS_VERSION_CONFLICT').kind).toBe('CHANGED');
  expect(contestCommandError(422, 'CHAMPIONS_CONTEST_OVER_BUDGET')).toMatchObject({ kind: 'REFUSED', code: 'CHAMPIONS_CONTEST_OVER_BUDGET' });
  expect(contestCommandError(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('KEY_REUSED');
  expect(contestCommandError(404, 'CHAMPIONS_UNAVAILABLE').kind).toBe('GONE');
  for (const [s, c] of [[409, 'CHAMPIONS_OUTCOME_UNKNOWN'], [503, 'CHAMPIONS_UNAVAILABLE'], [422, 'SOMETHING_ELSE'], [404, null], [500, null]] as const)
    expect(contestCommandError(s, c).kind).toBe('UNKNOWN');
});

it('turns the form into exactly the configuration the contract accepts, and back', () => {
  expect(dollarsToMinor('500')).toBe(50000); expect(dollarsToMinor('12.5')).toBe(1250); expect(dollarsToMinor('0.07')).toBe(7);
  for (const bad of ['', '-1', '1.234', '1e3', '$5']) expect(dollarsToMinor(bad)).toBeNull();
  expect(dayToInstant('2026-12-01', false)).toBe(START); expect(dayToInstant('2026-12-31', true)).toBe(END); expect(dayToInstant('2026-02-30', false)).toBeNull();
  const d = draftFrom(validateChampionsContestDetail(detail()).contest);
  expect(configFrom(d)).toEqual(config());
  expect(configFrom(emptyDraft())).toBeNull();
  expect(configFrom({ ...d, prizes: [...d.prizes, { ...d.prizes[1]!, placeFrom: '3', placeTo: '4' }] })).toBeNull();
  expect(configFrom({ ...d, scope: 'SELECTED_SCHOOLS', schoolIds: [] })).toBeNull();
  expect(configFrom({ ...d, scope: 'SELECTED_SCHOOLS', schoolIds: [id(21)] })?.eligibility.schoolIds).toEqual([id(21)]);
  expect(configFrom({ ...d, budget: '' })?.budgetMinor).toBeNull();
  expect(configFrom({ ...d, tiers: [] })).toBeNull();
});

it('names what still blocks scheduling, as the server will check it', () => {
  const c = (p: Record<string, unknown>) => validateChampionsContestDetail(detail(contest(p))).contest;
  expect(scheduleBlockers(c({}), NOW)).toEqual([]);
  expect(scheduleBlockers(c({ termsReference: null, budgetMinor: null }), NOW)).toEqual(['TERMS', 'BUDGET']);
  expect(scheduleBlockers(c({ budgetMinor: 80000 }), NOW)).toEqual(['OVER_BUDGET']);
  expect(scheduleBlockers(c({ prizes: [{ prizeId: id(11), placeFrom: 1, placeTo: 1, kind: 'GIFT_CARD', description: 'Card', quantity: 1, estimatedUnitCostMinor: 100 }], estimatedPrizeCostMinor: 100 }), NOW)).toEqual(['GIFT_CARDS']);
  expect(scheduleBlockers(c({}), Date.parse('2027-01-02T00:00:00.000Z'))).toEqual(['PASSED']);
});

const listView = (state: ContestListState, extra: Partial<{ concealed: boolean; form: boolean; language: string }> = {}) => renderToStaticMarkup(
  <HqContestsListView language={extra.language ?? 'en'} formattingLocale="en-US" concealed={extra.concealed ?? false} state={state} filter={null} form={extra.form ?? false}
    schools={{ state: 'READY', schools: [{ schoolId: id(21), label: 'Synthetic School 1 · Synthetic Org' }] }} outcome={null} locked={false} canRetry={false}
    onFilter={() => {}} onRefresh={() => {}} onReveal={() => {}} onForm={() => {}} onCreate={() => {}} onInvalid={() => {}} onTryAgain={() => {}}/>);
const view = (state: ContestState, extra: Partial<{ concealed: boolean; editing: boolean; language: string }> = {}) => renderToStaticMarkup(
  <HqContestView language={extra.language ?? 'en'} formattingLocale="en-US" concealed={extra.concealed ?? false} state={state} editing={extra.editing ?? false}
    schools={{ state: 'UNAVAILABLE' }} outcome={null} locked={false} canRetry={false} now={NOW} onRefresh={() => {}} onReveal={() => {}} onEdit={() => {}} onUpdate={() => {}}
    onInvalid={() => {}} onStep={() => {}} onDuplicate={() => {}} onTryAgain={() => {}}/>);
const ready = (p: Record<string, unknown> = {}, d: Record<string, unknown> = {}): ContestState => ({ state: 'READY', view: validateChampionsContestDetail(detail(contest(p), d)) });
const steps = (html: string) => [...html.matchAll(/data-contest-step="([A-Z_]+)"/g)].map(m => m[1]);

it('lists contests with status, window and recorded prize cost, and opens the builder', () => {
  const html = listView({ state: 'READY', view: validateChampionsContestList({ contests: [contest({ due: 'START_DUE', status: 'SCHEDULED', version: 2 })], limit: 100 }) });
  for (const s of ['Winter referral race', 'Scheduled', 'Dec 1, 2026', 'Prize cost $900.00', 'of $1,000.00 budget', contestText('en', 'dueSTART_DUE')]) expect(html).toContain(s);
  expect(html).toContain(`href="/hq/growth/contests/${id(1)}"`);
  const form = listView({ state: 'LOADING' }, { form: true });
  for (const s of ['data-contest-form="new"', contestText('en', 'termsHelp'), contestText('en', 'budgetHelp'), 'data-contest-prize="1"', contestText('en', 'create')]) expect(form).toContain(s);
  expect(listView({ state: 'DENIED' })).toContain(contestText('en', 'denied'));
  const hidden = listView({ state: 'READY', view: validateChampionsContestList({ contests: [contest()], limit: 100 }) }, { concealed: true });
  expect(hidden).toContain(contestText('en', 'concealed')); expect(hidden).not.toContain('Winter referral race');
  expect(listView({ state: 'READY', view: validateChampionsContestList({ contests: [], limit: 100 }) }, { language: 'ko' })).toContain(contestText('ko', 'none'));
});

it('offers only the steps that apply to each status, marking owner-only ones', () => {
  const by = (status: ChampionsContestStatus, p: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => view(ready({ status, version: 3, ...p }, d));
  const draft = by('DRAFT');
  expect(draft).toContain('data-contest-form="schedule"'); expect(draft).toContain('data-contest-form="cancel"'); expect(draft).toContain(contestText('en', 'edit'));
  expect(steps(by('SCHEDULED'))).toEqual(['ACTIVATE']);
  expect(by('SCHEDULED')).toContain(contestText('en', 'notStarted', { at: 'Dec 1, 2026, 12:00 AM UTC' }));
  expect(steps(by('ACTIVE'))).toEqual(['PAUSE', 'END']); expect(by('ACTIVE')).toContain(contestText('en', 'endEarly'));
  expect(steps(by('PAUSED'))).toEqual(['RESUME', 'END']);
  expect(steps(by('ENDED', { endedAt: T }, { standingsFrozen: true }))).toEqual(['PROPOSE_WINNERS']);
  expect(steps(by('COMPLETED', { completedAt: T }))).toEqual([]); expect(by('COMPLETED', { completedAt: T })).not.toContain('data-contest-form="cancel"');
  expect(by('CANCELLED', { cancelledAt: T, cancelReason: 'OWNER_DECISION' })).not.toContain('data-contest-form="cancel"');
  for (const s of ['DRAFT', 'COMPLETED'] as const) expect(by(s)).toContain('data-contest-form="duplicate"');
  expect(view(ready({ termsReference: null, budgetMinor: null }))).toContain('data-contest-blockers="TERMS BUDGET"');
  expect(view(ready(), { editing: true })).toContain('data-contest-form="edit"');
  expect(view(ready({ status: 'ACTIVE', version: 2 }), { editing: true })).not.toContain('data-contest-form="edit"');
});

it('shows winners with only the decisions their state allows, and the recorded liabilities', () => {
  const w = (n: number, status: string) => ({ winnerId: id(40 + n), place: n, prizeId: id(11), schoolId: id(20 + n), schoolName: `Synthetic School ${n}`, status,
    reasonCode: status === 'TIE_REVIEW' ? 'TIE_AT_BOUNDARY' : null, estimatedCostMinor: 50000, version: 1, decidedAt: null });
  const html = view(ready({ status: 'PENDING_WINNER_APPROVAL', version: 5, endedAt: T }, { standingsFrozen: true, winners: [w(1, 'PROPOSED'), w(2, 'TIE_REVIEW'), w(3, 'APPROVED')],
    liabilities: { currency: 'USD', budgetMinor: 100000, estimatedPrizeCostMinor: 90000, pendingWinnerCostMinor: 100000, approvedWinnerCostMinor: 50000, financialActivation: 'DISABLED' } }));
  const winner = (n: number) => html.slice(html.indexOf(`data-contest-winner="${id(40 + n)}"`), html.indexOf('</li>', html.indexOf(`data-contest-winner="${id(40 + n)}"`)));
  expect(steps(winner(1))).toEqual(['APPROVE_WINNER', 'DISPUTE_WINNER']); expect(winner(1)).toContain('data-contest-form="reject"'); expect(winner(1)).not.toContain('data-contest-form="resolve"');
  expect(steps(winner(2))).toEqual([]); expect(winner(2)).toContain('data-contest-form="resolve"'); expect(winner(2)).toContain('Tie: owner decides');
  expect(steps(winner(3))).toEqual(['DISPUTE_WINNER']); expect(winner(3)).not.toContain('data-contest-form="reject"');
  for (const s of ['$1,000.00', '$900.00', '$500.00', contestText('en', 'liabilityNote'), contestText('en', 'standingsFrozen'), 'Below the minimum']) expect(html).toContain(s);
  expect(steps(html)).toContain('COMPLETE');
});

it('shows nothing while loading, refused, gone or concealed', () => {
  for (const [state, key] of [['LOADING', 'loading'], ['DENIED', 'denied'], ['GONE', 'gone'], ['INVALID', 'invalid'], ['UNAVAILABLE', 'unavailable']] as const) {
    const html = view({ state } as ContestState); expect(html).toContain(contestText('en', key)); expect(html).not.toContain('Winter referral race');
  }
  const hidden = view(ready(), { concealed: true });
  expect(hidden).toContain(contestText('en', 'concealed')); expect(hidden).not.toContain('Winter referral race'); expect(hidden).not.toContain('Synthetic School');
  expect(view(ready(), { language: 'es' })).toContain(contestText('es', 'actions'));
});

it('routes, label and manifest are wired; the planned placeholder is gone; no storage', () => {
  expect(Object.keys(HQ_PLANNED)).not.toContain('/hq/growth/contests');
  expect(hqPageLabel(`/hq/growth/contests/${id(1)}`)).toBe('Contest detail');
  expect(hqPageLabel('/hq/growth/contests')).toBe('Referral Contests');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/hq/growth/contests/:contestId')).toHaveLength(1);
  for (const route of ['src/app/hq/growth/contests/page.tsx', 'src/app/hq/growth/contests/[contestId]/page.tsx']) {
    const source = readFileSync(route, 'utf8'); expect(source).toContain("'force-dynamic'"); expect(source).toContain('index: false'); expect(source).not.toMatch(/fetch\(|process\.env/);
  }
  for (const file of ['http.ts', 'form.ts', 'model.ts', 'parts.tsx', 'hq-contests-list.tsx', 'hq-contest.tsx'])
    expect(readFileSync(`src/components/hq-contests/${file}`, 'utf8')).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML/);
});
