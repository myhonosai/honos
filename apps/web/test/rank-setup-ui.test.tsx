import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RankSetupProgram, StaffRankSetup } from '@hon/contracts';
import { RankSetupPage, studentsIn, plural, type RankSetupActions } from '../src/components/rank-setup/rank-setup';
import { rankSetupApi, RankSetupRefusal, requirementCode } from '../src/components/rank-setup/http';
import { SCHOOL_SHELL_NAV, schoolShellActiveItem } from '../src/components/school-shell/catalog';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = u(1), org = u(2), prog = u(10), white = u(11), yellow = u(12);
const program = (patch: Partial<RankSetupProgram> = {}): RankSetupProgram => ({ id: prog, name: 'Kids Taekwondo', version: 2, ranks: [
  { id: white, name: 'White belt', color: '#FFFFFF', order: 1, version: 1, students: 1, requirements: [{ id: u(30), code: 'FRONT_KICK', kind: 'TECHNIQUE', label: 'Front kick', description: '', required: true, version: 1 }] },
  { id: yellow, name: 'Yellow belt', color: null, order: 2, version: 1, students: 0, requirements: [] }], ...patch });
const view = (patch: Partial<StaffRankSetup> = {}): StaffRankSetup => ({ programs: [program()], students: [{ enrollmentId: u(40), programId: prog, studentProfileId: u(41),
  givenName: 'Ana', familyName: 'Sample', currentRankId: white, version: 3 }], ...patch });
const actions = (): RankSetupActions => ({ createProgram: vi.fn(), renameProgram: vi.fn(), addRank: vi.fn(), updateRank: vi.fn(), moveRank: vi.fn(), addRequirement: vi.fn(),
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
    expect(html).not.toMatch(/UUID|curriculum id|enrollment/i);
  });
  it('shows belts in order with color, students and what each belt needs', () => {
    const html = render(view());
    expect(html).toContain('Belts, first to last');
    expect(html.indexOf('White belt')).toBeLessThan(html.indexOf('Yellow belt'));
    expect(html).toContain('What this belt needs (1)');
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
    const r = await rankSetupApi.addRank(school, prog, 'Green belt', '#16A34A', u(500));
    expect(r.id).toBe(prog);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/staff/schools/${school}/rank-setup/programs/${prog}/ranks`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Hon-Human-Command']).toBe('rank-setup');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(u(500));
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Green belt', color: '#16A34A' });
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
    await expect(rankSetupApi.addRank(school, prog, 'White belt', null, u(503))).rejects.toMatchObject({ code: 'RANK_NAME_TAKEN', message: 'This program already has a belt with that name.' });
    vi.stubGlobal('fetch', vi.fn(async () => fail(403)));
    await expect(rankSetupApi.read(school)).rejects.toBeInstanceOf(RankSetupRefusal);
    vi.stubGlobal('fetch', vi.fn(async () => fail(500)));
    await expect(rankSetupApi.createProgram(school, 'Adults', u(504))).rejects.toThrow(/may or may not have been saved/);
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...program(), extra: 1 })));
    await expect(rankSetupApi.createProgram(school, 'Adults', u(505))).rejects.toThrow(/could not be verified/);
    await expect(rankSetupApi.read('not-a-school')).rejects.toThrow(/could not be verified/);
  });
});
