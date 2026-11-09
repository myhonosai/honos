import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  validateChampionsSchoolContests, validateChampionsSchoolLeaderboard, validateChampionsSchoolRewards, validateChampionsSchoolStatistics, validateChampionsSchoolView,
} from '@hon/contracts';
import { ChampionsError, championsErrorFor, championsSchoolApi, keepForRetry, utcMonth } from '../src/components/champions-school/http';
import { ChampionsSchoolView, type ChampionsSchoolViewProps } from '../src/components/champions-school/view';
import { CHAMPIONS_LANGUAGES } from '../src/components/champions-school/copy';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';
import { board, codeReceipt, contest, contests, preferenceReceipt, rewards, school, statistics, summary } from './champions-school-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const key = id(77), base = `/api/v1/schools/${school}/champions`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const yes = () => true;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ChampionsError; } throw new Error('expected a failure'); };

it('reads each card as a plain same-origin GET for the verified school and refuses drifted or foreign answers', async () => {
  const f = stub(json({ data: summary() }));
  expect((await championsSchoolApi.summary(school.toUpperCase(), signal(), yes)).referralCode?.code).toBe('K7M2Q9X4PA');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`${base}/summary`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(init.body).toBeUndefined();
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const [read, body, tail] of [['statistics', statistics(), 'statistics'], ['rewards', rewards(), 'rewards'], ['contests', contests(), 'contests']] as const) {
    const g = stub(json({ data: body }));
    await (championsSchoolApi[read] as (s: string, a: AbortSignal, o: () => boolean) => Promise<unknown>)(school, signal(), yes);
    expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`${base}/${tail}`);
  }
  for (const bad of [{ data: summary({ schoolId: id(3) }) }, { data: summary({ extra: 1 }) }, { data: summary(), meta: {} }, { data: summary({ referralCode: { code: 'short', status: 'ACTIVE', issuedAt: '2026-11-05T12:00:00.000Z' } }) }]) {
    stub(json(bad));
    expect((await fails(championsSchoolApi.summary(school, signal(), yes))).kind).toBe('UNKNOWN');
  }
  stub(json({ statusCode: 403, code: 'CHAMPIONS_FORBIDDEN' }, 403));
  expect((await fails(championsSchoolApi.summary(school, signal(), yes))).kind).toBe('DENIED');
  stub(json({ code: 'CHAMPIONS_UNAVAILABLE' }, 404));
  expect((await fails(championsSchoolApi.rewards(school, signal(), yes))).kind).toBe('MISSING');
  const g = stub(json({}));
  expect((await fails(championsSchoolApi.summary('not-a-school', signal(), yes))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('asks the leaderboard for one period and refuses an answer for a different period or month', async () => {
  const f = stub(json({ data: board('MONTH', '2026-11') }));
  expect((await championsSchoolApi.leaderboard(school, { period: 'MONTH', month: '2026-11' }, signal(), yes)).you.rank).toBe(2);
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${base}/leaderboard?period=MONTH&month=2026-11`);
  const g = stub(json({ data: board() }));
  await championsSchoolApi.leaderboard(school, { period: 'ALL_TIME' }, signal(), yes);
  expect((g.mock.calls[0] as unknown as [string])[0]).toBe(`${base}/leaderboard?period=ALL_TIME`);
  for (const wrong of [board('ALL_TIME'), board('MONTH', '2026-10')]) {
    stub(json({ data: wrong }));
    expect((await fails(championsSchoolApi.leaderboard(school, { period: 'MONTH', month: '2026-11' }, signal(), yes))).kind).toBe('UNKNOWN');
  }
  const h = stub(json({}));
  expect((await fails(championsSchoolApi.leaderboard(school, { period: 'MONTH', month: '2026-13' }, signal(), yes))).kind).toBe('INVALID');
  expect(h).not.toHaveBeenCalled();
  expect(utcMonth(Date.parse('2026-11-30T23:30:00.000-05:00'))).toBe('2026-12');
});

it('sends each command as a marked POST with its key, and checks the receipt is for this school and choice', async () => {
  const f = stub(json({ data: codeReceipt() }));
  expect((await championsSchoolApi.issueCode(school, key, signal(), yes)).created).toBe(true);
  let [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`${base}/referral-code`);
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'X-HON-Human-Command': 'champions-referral-code-issue', 'Idempotency-Key': key, 'Content-Type': 'application/json' } });
  expect(init.body).toBe('{}');
  const g = stub(json({ data: preferenceReceipt('SCHOOL_NAME') }));
  expect((await championsSchoolApi.setDisplay(school, 'SCHOOL_NAME', key, signal(), yes)).displayMode).toBe('SCHOOL_NAME');
  [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`${base}/leaderboard-preference`);
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('champions-leaderboard-preference');
  expect(JSON.parse(init.body as string)).toEqual({ displayMode: 'SCHOOL_NAME' });
  stub(json({ data: preferenceReceipt('ANONYMOUS') }));
  expect((await fails(championsSchoolApi.setDisplay(school, 'SCHOOL_NAME', key, signal(), yes))).kind).toBe('UNKNOWN');
  stub(json({ data: { ...codeReceipt(), schoolId: id(3) } }));
  expect((await fails(championsSchoolApi.issueCode(school, key, signal(), yes))).kind).toBe('UNKNOWN');
  const h = stub(json({}));
  expect((await fails(championsSchoolApi.issueCode(school, 'not-a-key', signal(), yes))).kind).toBe('INVALID');
  expect((await fails(championsSchoolApi.setDisplay(school, 'EVERYONE' as never, key, signal(), yes))).kind).toBe('INVALID');
  expect(h).not.toHaveBeenCalled();
});

it('maps refusals, keeps only an unknown outcome, and ends the session only when the request is owned', async () => {
  expect(championsErrorFor(403, 'CHAMPIONS_FORBIDDEN').kind).toBe('DENIED');
  expect(championsErrorFor(404, 'CHAMPIONS_UNAVAILABLE').kind).toBe('MISSING');
  expect(championsErrorFor(400, 'INVALID_CHAMPIONS_INPUT').kind).toBe('INVALID');
  expect(championsErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(championsErrorFor(409, 'CHAMPIONS_OUTCOME_UNKNOWN').kind).toBe('UNKNOWN');
  expect(championsErrorFor(422, 'SOMETHING').kind).toBe('UNKNOWN');
  expect(championsErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new ChampionsError('UNKNOWN'))).toBe(true);
  for (const k of ['DENIED', 'MISSING', 'INVALID', 'SESSION'] as const) expect(keepForRetry(new ChampionsError(k))).toBe(false);
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(new Response(null, { status: 401 }));
  expect((await fails(championsSchoolApi.summary(school, signal(), () => false))).kind).toBe('SESSION'); expect(seen).not.toHaveBeenCalled();
  stub(new Response(null, { status: 401 }));
  expect((await fails(championsSchoolApi.issueCode(school, key, signal(), yes))).kind).toBe('SESSION'); expect(seen).toHaveBeenCalledTimes(1);
});

const ready = <V,>(value: V) => ({ state: 'READY', value }) as const;
const view = (over: Partial<ChampionsSchoolViewProps> = {}) => renderToStaticMarkup(<ChampionsSchoolView language="en" waiting={false} concealed={false} hasSchool
  summary={ready(validateChampionsSchoolView(summary()))} statistics={ready(validateChampionsSchoolStatistics(statistics()))} rewards={ready(validateChampionsSchoolRewards(rewards()))}
  contests={ready(validateChampionsSchoolContests(contests()))} board={ready(validateChampionsSchoolLeaderboard(board()))} period="ALL_TIME"
  outcome={null} locked={false} canRetry={false} copy="IDLE" {...over}/>);

it('shows the code, counts, milestones, rewards, leaderboard, contests and history from the reads', () => {
  const html = view();
  expect(html).toContain('K7M2Q9X4PA'); expect(html).toContain('Copy code'); expect(html).not.toContain('Create our referral code');
  expect(html).toMatch(/data-testid="champions-count-QUALIFIED"><dt>Qualified<\/dt><dd>4<\/dd>/);
  expect(html).toContain('Program terms version 3 are in effect.'); expect(html).toContain('Rewards are recorded only.');
  expect(html).toContain('6 more qualified referrals to reach Lifetime membership (at 10).'); expect(html).toContain('Reached: Free months at 3');
  expect(html).toContain('Referral credit: $100.00 credit'); expect(html).toContain('Free months: 2 free months at 3 referrals'); expect(html).toContain('Approved by HQ');
  expect(html).toContain('Your school is #2 with 4 qualified referrals.'); expect(html).toContain('Tiger Rock Dojang'); expect(html).toContain('A school (anonymous)');
  expect(html).toMatch(/<tr data-you="true"[^>]*><td>2<\/td><td>Our Test School<span[^>]*>You<\/span>/);
  expect(html).toMatch(/<input type="radio" name="displayMode" checked="" value="ANONYMOUS"\/>/);
  expect(html).toContain('Winter referral sprint'); expect(html).toContain('Place 1: Tablet for the front desk'); expect(html).toContain('Rank #1');
  expect(html).toContain('Pending → Qualified: qualification verified'); expect(html).toContain('New → Pending: referral recorded');
  expect(html).not.toMatch(/\$[0-9]+[^.]*prize|gift card/i);
});

it('offers to create a code when there is none, and says when terms are not published', () => {
  const html = view({ summary: ready(validateChampionsSchoolView(summary({ referralCode: null, program: { status: 'POLICY_UNDECIDED', policyVersion: null, financialRewards: 'DISABLED' } }))) });
  expect(html).toContain('Create our referral code'); expect(html).not.toContain('Copy code');
  expect(html).toContain('HQ has not published the program terms yet.');
  expect(view({ summary: ready(validateChampionsSchoolView(summary({ referralCode: null }))), locked: true })).toMatch(/<button type="button"[^>]*disabled=""[^>]*data-testid="champions-code-create"/);
  expect(view({ contests: ready(validateChampionsSchoolContests(contests([]))) })).toContain('No contests are open to your school.');
});

it('shows each refused read in its own card, and nothing while the school is not verified', () => {
  const html = view({ summary: { state: 'DENIED' }, board: { state: 'UNAVAILABLE' }, rewards: { state: 'MISSING' } });
  expect(html).toContain('Your access does not include the Champions Club at this school.'); expect(html).toContain('This could not be read or checked.');
  expect(html).toContain('The Champions Club is not available for this school.'); expect(html).not.toContain('K7M2Q9X4PA');
  expect(html).toContain('Winter referral sprint');
  for (const [over, text] of [[{ concealed: true }, 'Hidden. Return to this tab'], [{ waiting: true }, 'Checking your school'], [{ hasSchool: false }, 'Choose a school']] as const) {
    const hidden = view(over);
    expect(hidden).toContain(text); expect(hidden).not.toContain('K7M2Q9X4PA'); expect(hidden).not.toContain('Tiger Rock Dojang');
  }
  // A leaderboard answer for the other period is never shown under this tab.
  expect(view({ period: 'MONTH' })).not.toContain('Tiger Rock Dojang');
});

it('says what an answer means, and offers Try again and Stop only for a kept request', () => {
  expect(view({ outcome: { kind: 'DONE', action: 'code', created: false, replayed: true } })).toContain('Your school already had this code. This was already done');
  expect(view({ outcome: { kind: 'DONE', action: 'display', mode: 'SCHOOL_NAME' } })).toContain('the leaderboard now shows your school as: Show our school name.'.replace('the', 'The'));
  const kept = view({ outcome: { kind: 'UNKNOWN', action: 'display' }, locked: true, canRetry: true, onTryAgain: () => {}, onStop: () => {} });
  expect(kept).toContain('Try again'); expect(kept).toContain('Stop and read again'); expect(kept).toMatch(/<fieldset[^>]*disabled=""/);
  const denied = view({ outcome: { kind: 'DENIED', action: 'code' }, onTryAgain: () => {}, onStop: () => {} });
  expect(denied).toContain('Nothing changed.'); expect(denied).not.toContain('Try again');
  expect(view({ copy: 'COPIED' })).toContain('Copied.'); expect(view({ copy: 'FAILED' })).toContain('Could not copy.');
});

it('lists the page under Referrals & Rewards, with every wording in each language', () => {
  const group = SCHOOL_SHELL_NAV.find((g) => g.key === 'referrals');
  expect(group?.routes.map((r) => r.href)).toEqual(['/staff/champions-club']);
  const en = Object.keys(CHAMPIONS_LANGUAGES.en).sort();
  for (const lang of ['ko', 'es'] as const) expect(Object.keys(CHAMPIONS_LANGUAGES[lang]).sort()).toEqual(en);
  expect(contest().status).toBe('ACTIVE');
});
