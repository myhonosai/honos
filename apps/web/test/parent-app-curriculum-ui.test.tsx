import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CurriculumAppChild, CurriculumAppState, CurriculumResourceRecord, StaffParentAppCurriculum } from '@hon/contracts';
import { ParentAppCurriculumPage, PreviewPhone, type CurriculumActions } from '../src/components/parent-app-curriculum/staff-parent-app-curriculum';
import { parentAppCurriculumApi, ParentAppCurriculumRefusal } from '../src/components/parent-app-curriculum/http';
import { cycleBanner, dayLabel, moveCycle, visibleInAppToday } from '../src/components/parent-app-curriculum/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveItem } from '../src/components/school-shell/catalog';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const school = u(1), org = u(2), cur = u(10), rank1 = u(11), rank2 = u(12), c1 = u(21), c2 = u(22), c3 = u(23);
const settings = (patch: Partial<CurriculumAppState['settings']> = {}): CurriculumAppState['settings'] => ({ saved: true, version: 3, expectedVersion: 3, displayMode: 'CYCLE', showInApp: true,
  rankShowEarlier: false, rankShowNext: false, cycleRotation: 'AUTO', cycleAnchorDate: '2026-11-02', cycleLengthWeeks: 2, cycleShowNext: true, ...patch });
const cycles = [{ id: c1, name: 'Cycle 1: Stances', position: 1, version: 1 }, { id: c2, name: 'Cycle 2: Kicks', position: 2, version: 1 }, { id: c3, name: 'Cycle 3: Forms', position: 3, version: 2 }];
const app = (patch: Partial<CurriculumAppState> = {}): CurriculumAppState => ({ curriculumId: cur, settings: settings(), cycles,
  cycleState: { today: '2026-11-19', current: { id: c2, name: 'Cycle 2: Kicks', startsOn: '2026-11-16', endsOn: '2026-11-29' }, next: { id: c3, name: 'Cycle 3: Forms', startsOn: '2026-11-30' } }, ...patch });
const res = (n: number, patch: Partial<CurriculumResourceRecord>): CurriculumResourceRecord => ({ id: u(100 + n), curriculumId: cur, rankId: null, cycleId: null, kind: 'VIDEO',
  url: `https://www.youtube.com/watch?v=sample${n}`, title: `Sample ${n}`, description: '', audience: 'PARENT', status: 'ACTIVE', version: 1, ...patch });
const view = (a: CurriculumAppState = app(), resources: CurriculumResourceRecord[] = []): StaffParentAppCurriculum => ({ timeZone: 'America/Los_Angeles', curricula: [{ id: cur, name: 'Little Dragons',
  modelCode: 'ROTATIONAL', lifecycle: 'PUBLISHED', ranks: [{ id: rank1, name: 'White', color: '#FFFFFF', order: 1 }, { id: rank2, name: 'Yellow', color: '#FFD400', order: 2 }], app: a, resources }] });
const actions = (): CurriculumActions => ({ saveSettings: vi.fn(), createCycle: vi.fn(), renameCycle: vi.fn(), archiveCycle: vi.fn(), switchCycle: vi.fn(), orderCycles: vi.fn(),
  addMaterial: vi.fn(), editMaterial: vi.fn(), archiveMaterial: vi.fn(), preview: vi.fn() });
const render = (v: StaffParentAppCurriculum | null, extra: Partial<Parameters<typeof ParentAppCurriculumPage>[0]> = {}) => renderToStaticMarkup(<ParentAppCurriculumPage view={v} selected={cur}
  onSelect={() => {}} busy={false} loading={false} error="" notice="" hasSchool organizationId={org} schoolId={school} onRefresh={() => {}} actions={actions()} {...extra} />);
const meta = (replayed = false) => ({ requestId: u(900), correlationId: u(900), replayed });
const ok = (data: unknown, replayed = false) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ data, meta: meta(replayed) }) } as Response);
const fail = (status: number, code?: string) => ({ ok: false, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => (code ? { code } : {}) } as Response);

describe('parent app curriculum view helpers', () => {
  it('words the database-computed cycle without computing it', () => {
    expect(dayLabel('2026-11-29')).toBe('Sun, Nov 29');
    expect(cycleBanner(app())).toEqual({ now: 'Now: Cycle 2: Kicks, through Sun, Nov 29.', next: 'Next: Cycle 3: Forms, starting Mon, Nov 30.' });
    expect(cycleBanner(app({ cycleState: { today: '2026-10-01', current: null, next: { id: c1, name: 'Cycle 1: Stances', startsOn: '2026-11-02' } } })).now).toBe('Nothing yet. Cycle 1: Stances starts Mon, Nov 2.');
    expect(cycleBanner(app({ cycles: [], cycleState: { today: '2026-11-19', current: null, next: null } })).now).toMatch(/No cycles yet/);
    expect(cycleBanner(app({ settings: settings({ saved: false, version: 0, cycleRotation: 'STAFF_PICK' }), cycleState: { today: '2026-11-19', current: null, next: null } })).now).toMatch(/Save the setup/);
  });
  it('moves one cycle and keeps the whole order', () => {
    expect(moveCycle(cycles, c3, -1)).toEqual([c1, c3, c2]);
    expect(moveCycle(cycles, c1, -1)).toBeNull();
    expect(moveCycle(cycles, c3, 1)).toBeNull();
  });
  it('marks what the current app cannot show yet (documents and cycle material)', () => {
    expect(visibleInAppToday(res(1, {}))).toBe(true);
    expect(visibleInAppToday(res(2, { kind: 'LINK', rankId: rank1 }))).toBe(true);
    expect(visibleInAppToday(res(3, { kind: 'DOCUMENT' }))).toBe(false);
    expect(visibleInAppToday(res(4, { cycleId: c1 }))).toBe(false);
  });
});

describe('Parent app > Curriculum page', () => {
  it('lives in the Parent app menu next to messages and is in the route manifest', () => {
    const item = SCHOOL_SHELL_NAV.find((i) => i.key === 'parentApp')!;
    expect(item.routes.map((r) => r.href)).toEqual(['/staff/family-messages', '/staff/family-messages/announcements', '/staff/parent-app/curriculum']);
    expect(schoolShellActiveItem('/staff/parent-app/curriculum')?.key).toBe('parentApp');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
    expect(manifest.routes.some((r) => r.path === '/staff/parent-app/curriculum')).toBe(true);
  });
  it('cycle-based: shows now/next, rotation, cycles in order with their material and the app notice', () => {
    const html = render(view(app(), [res(1, { cycleId: c2, title: 'Front kick drill' }), res(2, { kind: 'DOCUMENT', title: 'Belt chart' }), res(3, { audience: 'STAFF', title: 'Staff only' }),
      res(4, { cycleId: c1, status: 'ARCHIVED', title: 'Old stance video' })]));
    expect(html).toContain('Now: Cycle 2: Kicks, through Sun, Nov 29.');
    expect(html).toContain('Rotates every 2 weeks');
    expect(html.indexOf('1</span>Cycle 1: Stances')).toBeLessThan(html.indexOf('3</span>Cycle 3: Forms'));
    expect(html).toContain('Front kick drill');
    expect(html).toContain('Belt chart');
    expect(html).toContain('Not in the app yet');
    expect(html).toContain('Coming to the HON Parent app.');
    expect(html).not.toContain('Staff only');
    expect(html).not.toContain('Old stance video');
    expect(html).toContain('2 items');
    expect(html).toContain('Rotate automatically');
    expect(html).toContain('Weeks per cycle');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  it('rank-based: one card per rank in order, review/next switches, link to Progress for rank changes, no cycle controls', () => {
    const html = render(view(app({ settings: settings({ displayMode: 'RANK', cycleRotation: 'STAFF_PICK', cycleAnchorDate: null, cycleLengthWeeks: null }) }), [res(1, { rankId: rank2, title: 'Yellow form' })]));
    expect(html).toContain('Material by rank');
    expect(html.indexOf('>White<')).toBeLessThan(html.indexOf('>Yellow<'));
    expect(html).toContain('Yellow form');
    expect(html).toContain('Also show earlier ranks for review');
    expect(html).toContain('Also show a preview of the next rank');
    expect(html).toContain('href="/staff/curriculum/progress"');
    expect(html).not.toContain('Add cycle');
    expect(html).not.toContain('Switch…');
  });
  it('unsaved setup says families see rank material until saved, and switching waits for a save', () => {
    const html = render(view(app({ settings: settings({ saved: false, version: 0, cycleRotation: 'STAFF_PICK', cycleAnchorDate: null, cycleLengthWeeks: null }), cycleState: { today: '2026-11-19', current: null, next: null } })));
    expect(html).toContain('Not set up yet. Families see rank material until you save.');
    expect(html).toContain('Save setup');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Switch…<\/button>/);
  });
  it('empty, outside-the-shell and error states', () => {
    expect(render({ timeZone: 'UTC', curricula: [] })).toContain('No curriculum yet');
    expect(render(null, { hasSchool: false, organizationId: '', schoolId: '' })).toContain("Open this page from your school&#x27;s menu");
    expect(render(null, { error: 'Your access does not include managing curriculum at this school.' })).toContain('role="alert"');
  });
  it('mounts the shared recommendations editor for the selected curriculum, only inside a school', () => {
    const html = render(view(app()));
    expect(html).toContain('ecommendation');
    expect(render(view(app()), { organizationId: '', schoolId: '' })).not.toContain('ecommendation');
  });
  it('preview renders what a family sees, with section names and dates', () => {
    const child: CurriculumAppChild = { childDisplayName: 'Sample Child', curricula: [{ curriculumName: 'Little Dragons', mode: 'CYCLE', rank: null,
      cycle: { name: 'Cycle 2: Kicks', startsOn: '2026-11-16', endsOn: '2026-11-29', rotation: 'AUTO' }, next: { name: 'Cycle 3: Forms', startsOn: '2026-11-30' },
      sections: [{ label: 'CURRENT', items: [{ title: 'Front kick drill', description: '', kind: 'VIDEO', url: 'https://www.youtube.com/watch?v=s1' }] },
        { label: 'ALL', items: [{ title: 'Belt chart', description: '', kind: 'DOCUMENT', url: 'https://drive.google.com/file/d/s2' }] }] }] };
    const html = renderToStaticMarkup(<PreviewPhone child={child} />);
    for (const text of ['Sample Child', 'Cycle 2: Kicks, through Sun, Nov 29', '>Now<', 'Front kick drill', 'Whole curriculum', 'Belt chart', 'Next: Cycle 3: Forms, Mon, Nov 30']) expect(html).toContain(text);
    expect(html).not.toMatch(/<a |<iframe|<video/);
  });
});

describe('parent app curriculum http', () => {
  const { expectedVersion: _drop, ...wireSettings } = settings();
  const state = { ...app(), settings: wireSettings };
  it('reads and commands only the shell school on same-origin paths with the human command and retained key', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      fetch.mockResolvedValue(ok(state, true));
      await parentAppCurriculumApi.switchCycle(school, cur, c3, 3, 'key-1');
      expect(fetch).toHaveBeenLastCalledWith(`/api/v1/staff/schools/${school}/parent-app/curriculum/${cur}/cycles/${c3}/switch`, expect.objectContaining({ method: 'POST', mode: 'same-origin',
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: expect.objectContaining({ 'X-Hon-Human-Command': 'parent-app-curriculum', 'Idempotency-Key': 'key-1' }), body: '{"expectedVersion":3}' }));
      await parentAppCurriculumApi.orderCycles(school, cur, [c3, c1, c2], 'key-2');
      expect(fetch).toHaveBeenLastCalledWith(`/api/v1/staff/schools/${school}/parent-app/curriculum/${cur}/cycle-order`, expect.objectContaining({ body: JSON.stringify({ cycleIds: [c3, c1, c2] }) }));
      fetch.mockResolvedValue(ok(res(1, { kind: 'DOCUMENT', cycleId: c1 })));
      await parentAppCurriculumApi.addMaterial(school, { expectedVersion: 0, curriculumId: cur, rankId: null, cycleId: c1, kind: 'DOCUMENT', url: 'https://www.youtube.com/watch?v=sample1', title: 'Sample 1', description: '', audience: 'PARENT' }, 'key-3');
      expect(fetch).toHaveBeenLastCalledWith(`/api/v1/staff/schools/${school}/curriculum-library`, expect.objectContaining({ headers: expect.objectContaining({ 'X-Hon-Human-Command': 'curriculum-library', 'Idempotency-Key': 'key-3' }) }));
      const calls = fetch.mock.calls.length;
      await expect(parentAppCurriculumApi.read('https://attacker.invalid')).rejects.toThrow();
      await expect(parentAppCurriculumApi.archiveCycle(school, cur, '../x', 1, 'k')).rejects.toThrow();
      expect(fetch.mock.calls.length).toBe(calls);
    } finally { fetch.mockRestore(); }
  });
  it('maps refusals to plain words and never treats an unknown failure as success', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      fetch.mockResolvedValue(fail(409, 'CYCLE_IS_CURRENT'));
      await expect(parentAppCurriculumApi.archiveCycle(school, cur, c2, 1, 'k')).rejects.toThrow(/Switch to another cycle first/);
      fetch.mockResolvedValue(fail(409, 'SETTINGS_REQUIRED'));
      await expect(parentAppCurriculumApi.switchCycle(school, cur, c2, 0, 'k')).rejects.toBeInstanceOf(ParentAppCurriculumRefusal);
      fetch.mockResolvedValue(fail(403));
      await expect(parentAppCurriculumApi.read(school)).rejects.toThrow(/does not include managing curriculum/);
      fetch.mockResolvedValue(fail(502));
      await expect(parentAppCurriculumApi.createCycle(school, cur, 'Cycle 4', 'k')).rejects.toThrow(/may or may not have been saved/);
      fetch.mockResolvedValue(ok({ ...state, extra: true }));
      await expect(parentAppCurriculumApi.createCycle(school, cur, 'Cycle 4', 'k')).rejects.toThrow(/could not be verified/);
      fetch.mockResolvedValue(ok({ childDisplayName: 'Sample Child', curricula: [], studentId: u(5) }));
      await expect(parentAppCurriculumApi.preview(school, u(5))).rejects.toThrow();
    } finally { fetch.mockRestore(); }
  });
});
