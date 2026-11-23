import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RankSetupProgram, StaffRankSetup } from '@hon/contracts';
import { RankSetupPage, ruleText, studentsIn, plural, type RankSetupActions } from '../src/components/rank-setup/rank-setup';
import { rankSetupApi, RankSetupRefusal, requirementCode } from '../src/components/rank-setup/http';
import { RANK_TEMPLATES, beltListProblem, buildBelts, choicesFor } from '../src/components/rank-setup/templates';
import { AI_EXAMPLES, AI_FOLLOW_UPS, QuickSetup, type QuickSetupAi } from '../src/components/rank-setup/quick-setup';
import { rankChartApi, rankChartOutcome } from '../src/components/rank-setup/ai-draft-http';
import { RANK_CHART_LIMITS, validateRankChartBrief, type RankChartView } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellActiveItem } from '../src/components/school-shell/catalog';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = u(1), org = u(2), prog = u(10), white = u(11), yellow = u(12);
const program = (patch: Partial<RankSetupProgram> = {}): RankSetupProgram => ({ id: prog, name: 'Kids Taekwondo', version: 2, ranks: [
  { id: white, name: 'White belt', color: '#FFFFFF', order: 1, version: 1, classes: 48, days: 90, students: 1, requirements: [{ id: u(30), code: 'FRONT_KICK', kind: 'TECHNIQUE', label: 'Front kick', description: '', required: true, version: 1 }] },
  { id: yellow, name: 'Yellow belt', color: null, order: 2, version: 1, classes: 0, days: 0, students: 0, requirements: [] }], ...patch });
const view = (patch: Partial<StaffRankSetup> = {}): StaffRankSetup => ({ programs: [program()], students: [{ enrollmentId: u(40), programId: prog, studentProfileId: u(41),
  givenName: 'Ana', familyName: 'Sample', currentRankId: white, version: 3 }], ...patch });
const actions = (): RankSetupActions => ({ createProgram: vi.fn(), renameProgram: vi.fn(), quickSetup: vi.fn(), addRank: vi.fn(), updateRank: vi.fn(), removeRank: vi.fn(), moveRank: vi.fn(), addRequirement: vi.fn(),
  updateRequirement: vi.fn(), placeStudent: vi.fn(), setStudentRank: vi.fn() });
const render = (v: StaffRankSetup | null, extra: Partial<Parameters<typeof RankSetupPage>[0]> = {}) => renderToStaticMarkup(<RankSetupPage view={v} selected={prog} onSelect={() => {}}
  busy={false} loading={false} error="" notice="" scope={{ organizationId: org, schoolId: school }} onRefresh={() => {}} actions={actions()} {...extra} />);
const meta = { requestId: u(900), correlationId: u(900), replayed: false };
const ok = (data: unknown) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ data, meta }) } as Response);
const fail = (status: number, code?: string) => ({ ok: false, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => (code ? { code } : {}) } as Response);
afterEach(() => vi.unstubAllGlobals());

describe('rank setup page', () => {
  it('is the first page in the Rank setup menu group', () => {
    const group = SCHOOL_SHELL_NAV.find((i) => i.key === 'ranks')!;
    expect(group.routes[0]!.href).toBe('/staff/curriculum/ranks');
    expect(schoolShellActiveItem('/staff/curriculum/ranks')?.key).toBe('ranks');
  });
  it('shows plain first steps when the school has no program yet', () => {
    const html = render(view({ programs: [], students: [] }));
    expect(html).toContain('Start with your first program');
    expect(html).toContain('Add program');
    expect(html).toContain('Quick setup');
    expect(html).toContain('What do you teach?');
    for (const t of RANK_TEMPLATES) expect(html).toContain(t.art.replace(/&/g, '&amp;'));
    expect(html).not.toMatch(/UUID|curriculum id|enrollment/i);
  });
  it('shows belts in order with color, students and what each belt needs', () => {
    const html = render(view());
    expect(html).toContain('Belts, first to last');
    expect(html.indexOf('White belt')).toBeLessThan(html.indexOf('Yellow belt'));
    expect(html).toContain('What this belt needs (1)');
    expect(html).toContain('48 classes and 90 days to move up');
    expect(html).toContain('Quick setup for a new program');
    expect(html).toContain('Move White belt up');
    expect(html).toMatch(/aria-label="Move White belt up" disabled/);
    expect(html).toMatch(/aria-label="Move Yellow belt down" disabled/);
    expect(html).toContain('Ana Sample');
    expect(html).toContain('Belt for Ana Sample');
    expect(html).toContain('Tests &gt; Promotions');
    expect(html).toContain('href="/staff/parent-app/curriculum"');
  });
  it('explains a missing progress permission instead of showing students', () => {
    const html = render(view({ students: null }));
    expect(html).toContain('needs permission to record student progress');
    expect(html).not.toContain('Ana Sample');
  });
  it('holds no school of its own without the shell school', () => {
    const html = render(null, { scope: null });
    expect(html).toContain('Open this page from your school');
    expect(html).toMatch(/<button type="button"[^>]*disabled[^>]*>Refresh/);
  });
  it('helpers count students per program', () => {
    expect(studentsIn(view(), prog)).toHaveLength(1);
    expect(studentsIn(view(), u(99))).toHaveLength(0);
    expect(plural(1, 'belt')).toBe('1 belt');
    expect(plural(3, 'belt')).toBe('3 belts');
  });
});

describe('rank setup calls', () => {
  it('builds unique requirement codes from labels', () => {
    expect(requirementCode('Front kick', [])).toBe('FRONT_KICK');
    expect(requirementCode('Front kick', ['FRONT_KICK'])).toBe('FRONT_KICK_1');
    expect(requirementCode('Poomsae: Taegeuk 1', [])).toBe('POOMSAE_TAEGEUK_1');
    expect(requirementCode('3 push-ups', [])).toBe('R_3_PUSH_UPS');
    expect(requirementCode('앞차기', [])).toBe('REQ_1');
    expect(requirementCode('Café', [])).toBe('CAFE');
  });
  it('posts to the verified school with the rank-setup command and an idempotency key', async () => {
    const fetchMock = vi.fn(async () => ok(program()));
    vi.stubGlobal('fetch', fetchMock);
    const r = await rankSetupApi.addRank(school, prog, { name: 'Green belt', color: '#16A34A', classes: 24, days: 60 }, u(500));
    expect(r.id).toBe(prog);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/staff/schools/${school}/rank-setup/programs/${prog}/ranks`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Hon-Human-Command']).toBe('rank-setup');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(u(500));
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Green belt', color: '#16A34A', classes: 24, days: 60 });
  });
  it('sends quick setup as one command and belt removal with its version', async () => {
    const fetchMock = vi.fn(async () => ok(program()));
    vi.stubGlobal('fetch', fetchMock);
    const ranks = buildBelts(RANK_TEMPLATES[0]!, choicesFor(RANK_TEMPLATES[0]!));
    await rankSetupApi.quickSetup(school, 'Taekwondo', ranks, u(510));
    await rankSetupApi.removeRank(school, prog, yellow, 1, u(511));
    await rankSetupApi.updateRank(school, prog, white, 1, { name: 'White belt', color: null, classes: 10, days: 30 }, u(512));
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(`/api/v1/staff/schools/${school}/rank-setup/quick-setup`);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ name: 'Taekwondo', ranks });
    expect(calls[1]![0]).toBe(`/api/v1/staff/schools/${school}/rank-setup/programs/${prog}/ranks/${yellow}/remove`);
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ expectedVersion: 1 });
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ expectedVersion: 1, name: 'White belt', color: null, classes: 10, days: 30 });
    vi.stubGlobal('fetch', vi.fn(async () => fail(409, 'RANK_IN_USE')));
    await expect(rankSetupApi.removeRank(school, prog, white, 1, u(513))).rejects.toMatchObject({ code: 'RANK_IN_USE', message: expect.stringMatching(/cannot be removed/) });
  });
  it('sends requirements and belt changes to the existing progress commands', async () => {
    const fetchMock = vi.fn(async () => ok({ id: u(31) }));
    vi.stubGlobal('fetch', fetchMock);
    await rankSetupApi.addRequirement(org, school, prog, white, { code: 'FRONT_KICK', kind: 'TECHNIQUE', label: 'Front kick', description: '', required: true }, u(501));
    await rankSetupApi.setStudentRank(org, school, prog, u(40), yellow, 3, u(502));
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe(`/api/v1/organizations/${org}/schools/${school}/curricula/${prog}/ranks/${white}/requirements`);
    expect((calls[0]![1].headers as Record<string, string>)['X-Hon-Human-Command']).toBe('curriculum-progress');
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ code: 'FRONT_KICK', kind: 'TECHNIQUE', required: true, definition: { label: 'Front kick' } });
    expect(calls[1]![0]).toBe(`/api/v1/organizations/${org}/schools/${school}/curricula/${prog}/enrollments/${u(40)}/current-rank`);
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ currentRankId: yellow, expectedEnrollmentVersion: 3 });
  });
  it('turns refusals into plain sentences and refuses unverifiable answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(409, 'RANK_NAME_TAKEN')));
    await expect(rankSetupApi.addRank(school, prog, { name: 'White belt', color: null, classes: 0, days: 0 }, u(503))).rejects.toMatchObject({ code: 'RANK_NAME_TAKEN', message: 'This program already has a belt with that name.' });
    vi.stubGlobal('fetch', vi.fn(async () => fail(403)));
    await expect(rankSetupApi.read(school)).rejects.toBeInstanceOf(RankSetupRefusal);
    vi.stubGlobal('fetch', vi.fn(async () => fail(500)));
    await expect(rankSetupApi.createProgram(school, 'Adults', u(504))).rejects.toThrow(/may or may not have been saved/);
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...program(), extra: 1 })));
    await expect(rankSetupApi.createProgram(school, 'Adults', u(505))).rejects.toThrow(/could not be verified/);
    await expect(rankSetupApi.read('not-a-school')).rejects.toThrow(/could not be verified/);
  });
});

describe('quick setup starting points', () => {
  const t = (id: string) => RANK_TEMPLATES.find((x) => x.id === id)!;
  it('every starting point builds a list the server accepts', () => {
    for (const x of RANK_TEMPLATES) {
      const list = buildBelts(x, choicesFor(x));
      expect(beltListProblem(list), x.id).toBe('');
      expect(list.length).toBeGreaterThan(0);
      expect(list.at(-1)).toMatchObject({ classes: 0, days: 0 });
      for (const b of list) { expect(b.color === null || /^#[0-9A-F]{6}$/.test(b.color)).toBe(true); expect(Object.keys(b).sort()).toEqual(['classes', 'color', 'days', 'name']); }
    }
  });
  it('belt-based Taekwondo comes first, with degrees after the color belts', () => {
    expect(RANK_TEMPLATES[0]!.id).toBe('taekwondo');
    const names = buildBelts(t('taekwondo'), { stripes: 0, degrees: 3, classes: 24, days: 60 }).map((b) => b.name);
    expect(names).toEqual(['White belt', 'Yellow belt', 'Orange belt', 'Green belt', 'Blue belt', 'Purple belt', 'Brown belt', 'Red belt', '1st degree black belt', '2nd degree black belt', '3rd degree black belt']);
  });
  it('adds stripes between belts but not after the black belt', () => {
    const list = buildBelts(t('bjj-adult'), { stripes: 4, degrees: 0, classes: 40, days: 120 });
    expect(list).toHaveLength(21);
    expect(list[1]).toEqual({ name: 'White belt, 1 stripe', color: '#FFFFFF', classes: 40, days: 120 });
    expect(list[4]!.name).toBe('White belt, 4 stripes');
    expect(list.at(-1)!.name).toBe('Black belt');
    expect(buildBelts(t('bjj-kids'), { stripes: 4, degrees: 5, classes: 0, days: 0 }).at(-1)!.name).toBe('Green belt, 4 stripes');
  });
  it('supports arts without belts and clamps odd answers', () => {
    expect(buildBelts(t('levels'), choicesFor(t('levels'))).map((b) => b.name)).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6']);
    expect(buildBelts(t('kung-fu'), choicesFor(t('kung-fu')))[0]!.name).toBe('White sash');
    const odd = buildBelts(t('karate'), { stripes: 99, degrees: -3, classes: 99999, days: Number.NaN });
    expect(odd[0]).toMatchObject({ classes: 2000, days: 0 });
    expect(odd.filter((b) => b.name.startsWith('White belt'))).toHaveLength(5);
  });
  it('says plainly why a list cannot be saved', () => {
    expect(beltListProblem([])).toMatch(/at least one/);
    expect(beltListProblem([{ name: 'White', color: null, classes: 0, days: 0 }, { name: ' white ', color: null, classes: 0, days: 0 }])).toMatch(/Two belts are named/);
    expect(beltListProblem([{ name: ' ', color: null, classes: 0, days: 0 }])).toMatch(/needs a name/);
    expect(beltListProblem(buildBelts(t('taekwondo'), { stripes: 4, degrees: 9, classes: 0, days: 0 }))).toBe('');
    expect(beltListProblem(Array.from({ length: 61 }, (_, i) => ({ name: `B${i}`, color: null, classes: 0, days: 0 })))).toMatch(/up to 60 belts/);
  });
  it('the wizard starts with the question and saves nothing by itself', () => {
    const html = renderToStaticMarkup(<QuickSetup busy={false} onCreate={vi.fn()} />);
    expect(html).toContain('1. What do you teach?');
    expect(html).not.toContain('3. Check the list');
    expect(html).toContain('you can change anything later');
  });
  it('describes belt minimums in plain words', () => {
    expect(ruleText({ classes: 48, days: 90 })).toBe('48 classes and 90 days');
    expect(ruleText({ classes: 1, days: 0 })).toBe('1 class');
    expect(ruleText({ classes: 0, days: 0 })).toBe('');
  });
});

describe('describe your martial art (AI draft)', () => {
  const chart: RankChartView = { id: u(700), status: 'RESULT_RECORDED', reason: null, brief: { description: 'Kids Taekwondo. White, yellow, black.', current: null }, mine: true,
    draft: { name: 'Kids Taekwondo', summary: 'Three belts from white to black.', ranks: [{ name: 'White belt', color: '#FFFFFF', classes: 24, days: 60 }, { name: 'Black belt', color: '#111111', classes: 0, days: 0 }] },
    problems: [], createdAt: '2026-11-22T00:00:00.000Z', updatedAt: '2026-11-22T00:00:00.000Z' };
  const ai = (available: boolean | null): QuickSetupAi => ({ available, draft: vi.fn(), used: vi.fn() });
  const box = (available: boolean | null) => renderToStaticMarkup(<QuickSetup busy={false} onCreate={vi.fn()} ai={ai(available)} />);

  it('offers the box above the choices and keeps the button off until words are typed', () => {
    const html = box(true);
    expect(html).toContain('Set it up by talking to Kai');
    expect(html).toContain('keep talking to change it');
    expect(html).not.toContain('Tell Kai what to change');
    expect(html.indexOf('Set it up by talking to Kai')).toBeLessThan(html.indexOf('1. Or pick what you teach'));
    expect(html).toMatch(/<button type="button" class="[^"]*" disabled="">Draft my ranks with AI<\/button>/);
    expect(html).toContain(`maxLength="${RANK_CHART_LIMITS.description}"`);
    expect(html).toContain('You check it before anything is saved');
    expect(html).toContain('uses your school&#x27;s AI allowance');
    expect(html).not.toContain('3. Check the list');
    // Voice appears only in a browser that has speech recognition (checked after mount), never in the server render.
    expect(html).not.toContain('Talk to Kai');
  });
  it('says plainly when AI drafting is off and still shows every built-in choice', () => {
    const html = box(false);
    expect(html).toContain('Kai is not available on your account yet');
    expect(html).not.toContain('AI allowance');
    for (const t of RANK_TEMPLATES) expect(html).toContain(t.art.replace(/&/g, '&amp;'));
    expect(box(null)).not.toContain('not available on your account');
  });
  it('the page hands the box to quick setup only when it is given one', () => {
    expect(render(view({ programs: [], students: [] }), { ai: ai(false) })).toContain('Set it up by talking to Kai');
    expect(render(view({ programs: [], students: [] }))).not.toContain('Set it up by talking to Kai');
  });
  it('every example is a brief the server accepts', () => {
    expect(AI_EXAMPLES.length).toBe(3);
    for (const x of [...AI_EXAMPLES, ...AI_FOLLOW_UPS]) expect(validateRankChartBrief({ description: x })).toEqual({ description: x, current: null });
  });
  it('asks with the rank-chart-draft command and an idempotency key, and reads availability without one', async () => {
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => ok(init?.method === 'POST' ? chart : { aiAvailable: true, requests: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await rankChartApi.available(school)).toBe(true);
    const got = await rankChartApi.draft(school, chart.brief.description, null, u(501));
    expect(got.draft?.ranks).toHaveLength(2);
    const [readUrl, readInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(readUrl).toBe(`/api/v1/staff/schools/${school}/rank-setup/ai-drafts`);
    expect(readInit.method).toBe('GET');
    expect((readInit.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(readUrl);
    expect((init.headers as Record<string, string>)['X-Hon-Human-Command']).toBe('rank-chart-draft');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(u(501));
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ description: chart.brief.description, current: null });
    // A later turn sends the list on screen for Kai to change.
    const current = { name: 'Kids Taekwondo', ranks: chart.draft!.ranks };
    await rankChartApi.draft(school, 'Add a yellow belt in the middle.', current, u(509));
    expect(JSON.parse(String((fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body))).toEqual({ description: 'Add a yellow belt in the middle.', current });
    await rankChartApi.close(school, chart.id, 'APPLIED', u(502));
    const [closeUrl, closeInit] = fetchMock.mock.calls[3] as unknown as [string, RequestInit];
    expect(closeUrl).toBe(`/api/v1/staff/schools/${school}/rank-setup/ai-drafts/${chart.id}/close`);
    expect(JSON.parse(String(closeInit.body))).toEqual({ status: 'APPLIED' });
  });
  it('treats any failed availability read as off, refuses a bad description before sending, and never trusts an odd answer', async () => {
    const fetchMock = vi.fn(async () => fail(403, 'RANK_CHART_FORBIDDEN'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await rankChartApi.available(school)).toBe(false);
    expect(await rankChartApi.available('not-a-school')).toBe(false);
    await expect(rankChartApi.draft(school, chart.brief.description, null, u(503))).rejects.toThrow(/Complete plan/);
    const before = fetchMock.mock.calls.length;
    await expect(rankChartApi.draft(school, 'x'.repeat(601), null, u(504))).rejects.toThrow();
    await expect(rankChartApi.draft(school, 'Shorter.', { name: 'Long', ranks: Array.from({ length: 60 }, (_, i) => ({ name: `${'Rank '.repeat(20)}${i}`, color: '#FFFFFF', classes: 10, days: 10 })) }, u(510))).rejects.toThrow(/change it by hand/);
    await expect(rankChartApi.draft(school, 'Fix it.', { name: 'Two', ranks: [{ name: 'White', color: null, classes: 0, days: 0 }, { name: 'white', color: null, classes: 0, days: 0 }] }, u(511))).rejects.toThrow(/change it by hand/);
    expect(fetchMock.mock.calls.length).toBe(before);
    vi.stubGlobal('fetch', vi.fn(async () => fail(403, 'RANK_CHART_SPEND_STOPPED')));
    await expect(rankChartApi.draft(school, chart.brief.description, null, u(505))).rejects.toThrow(/Nothing was sent/);
    vi.stubGlobal('fetch', vi.fn(async () => fail(401)));
    await expect(rankChartApi.draft(school, chart.brief.description, null, u(506))).rejects.toThrow(/Sign in again/);
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...chart, extra: 1 })));
    await expect(rankChartApi.draft(school, chart.brief.description, null, u(507))).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...chart, draft: { ...chart.draft!, ranks: [{ name: 'White', color: 'white', classes: 0, days: 0 }] } })));
    await expect(rankChartApi.draft(school, chart.brief.description, null, u(508))).rejects.toThrow();
  });
  it('explains in plain words why a draft cannot be shown', () => {
    expect(rankChartOutcome(chart)).toBe('');
    const none = (status: RankChartView['status']) => rankChartOutcome({ ...chart, status, draft: null });
    expect(none('CONFIGURATION_REQUIRED')).toMatch(/not switched on yet. Nothing was sent/);
    expect(none('BLOCKED')).toMatch(/Nothing was sent/);
    expect(none('RESULT_REJECTED')).toMatch(/not a usable rank chart/);
    expect(none('FAILED')).toMatch(/Try again/);
    expect(none('PENDING')).toMatch(/held for HON to check and is not sent again/);
  });
});
