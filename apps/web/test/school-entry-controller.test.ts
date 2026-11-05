import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SchoolEntryController, schoolWorkflowLinks } from '../src/components/school-entry/controller';
import { SchoolEntryError, type SchoolEntryApi } from '../src/components/school-entry/http';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = { organizationId: id(1), schoolId: id(2) }, b = { organizationId: id(3), schoolId: id(4) };
const choices = [a, b].map((s, i) => ({ ...s, organizationName: `Private organization ${i}`, schoolName: `Private school ${i}` }));
let api: SchoolEntryApi, c: SchoolEntryController;
beforeEach(() => {
  api = { identity: vi.fn().mockResolvedValue(undefined), current: vi.fn().mockResolvedValue({ state: 'RESOLVED', ...a }),
    choices: vi.fn().mockResolvedValue({ state: 'SELECTION_REQUIRED', schools: choices }), verifySchool: vi.fn().mockResolvedValue(undefined) };
  c = new SchoolEntryController('school-a-owner', api);
});
afterEach(() => { c.dispose(); });
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

it('checks same-session continuity before and after an exact authorized report and retains no aggregates', async () => {
  await c.load(); expect(c.snapshot()).toMatchObject({ phase: 'READY', selection: a, choices: [] });
  expect(api.identity).toHaveBeenCalledTimes(2); expect(api.identity).toHaveBeenCalledWith('school-a-owner', expect.any(AbortSignal));
  expect(api.verifySchool).toHaveBeenCalledWith(a, expect.any(AbortSignal)); expect(api.choices).not.toHaveBeenCalled();
  expect(vi.mocked(api.identity).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.verifySchool).mock.invocationCallOrder[0]!);
  expect(vi.mocked(api.identity).mock.invocationCallOrder[1]).toBeGreaterThan(vi.mocked(api.verifySchool).mock.invocationCallOrder[0]!);
});
it('does not select the first of multiple authorized schools; a deliberate choice rechecks its exact organization', async () => {
  vi.mocked(api.current).mockResolvedValue({ state: 'MANUAL_ENTRY_REQUIRED' }); await c.load(); const version = c.snapshot().revision;
  expect(c.snapshot().phase).toBe('CHOICE'); expect(c.snapshot().selection).toBeNull(); expect(api.verifySchool).not.toHaveBeenCalled();
  await c.choose(b.schoolId, version); expect(c.snapshot().selection).toEqual(b); expect(api.verifySchool).toHaveBeenCalledWith(b, expect.any(AbortSignal));
});
it('rejects forged options and retained old selection callbacks before any read', async () => {
  vi.mocked(api.current).mockResolvedValue({ state: 'MANUAL_ENTRY_REQUIRED' }); await c.load(); const version = c.snapshot().revision;
  await c.choose(id(99), version); expect(api.verifySchool).not.toHaveBeenCalled();
  await c.choose(a.schoolId, version); const calls = vi.mocked(api.identity).mock.calls.length;
  await c.choose(b.schoolId, version); expect(api.identity).toHaveBeenCalledTimes(calls); expect(c.snapshot().selection).toEqual(a);
});
it.each(['SESSION', 'DENIED', 'UNAVAILABLE', 'IDENTITY'] as const)('fails closed on %s after a report and shows no previously authorized scope', async kind => {
  vi.mocked(api.identity).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new SchoolEntryError(kind)); await c.load();
  expect(c.snapshot()).toMatchObject({ phase: kind, selection: null, choices: [] });
});
it('requires explicit restoration; blur invalidates a pending report and late success cannot reveal it', async () => {
  let finish!: () => void; vi.mocked(api.verifySchool).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = c.load(); await tick(); c.conceal(); finish(); await task;
  expect(c.snapshot()).toMatchObject({ phase: 'CONCEALED', selection: null }); expect(api.identity).toHaveBeenCalledTimes(1);
  await c.load(); expect(c.snapshot().phase).toBe('READY'); expect(api.verifySchool).toHaveBeenCalledTimes(2);
});
it('clears loaded facts and retires links synchronously on session loss; no in-page session restart is allowed', async () => {
  await c.load(); const version = c.snapshot().revision; expect(c.canNavigate(version, a)).toBe(true);
  c.conceal('SESSION'); expect(c.canNavigate(version, a)).toBe(false); expect(c.snapshot().selection).toBeNull();
  await c.load(); expect(api.current).toHaveBeenCalledTimes(1); expect(c.snapshot().phase).toBe('SESSION');
});
it.each(['SESSION', 'IDENTITY'] as const)('keeps %s terminal through later privacy events and effect cleanup', async phase => {
  vi.mocked(api.identity).mockRejectedValueOnce(new SchoolEntryError(phase));
  await c.load(); const reads = vi.mocked(api.identity).mock.calls.length;
  c.conceal(); c.conceal(); c.dispose(); c.activate();
  await c.load();
  expect(c.snapshot()).toMatchObject({ phase, selection: null, choices: [] });
  expect(api.identity).toHaveBeenCalledTimes(reads);
});
it('does not confuse unavailable/suspended school resolution with a verified empty list or grant an exception', async () => {
  vi.mocked(api.current).mockResolvedValue({ state: 'MANUAL_ENTRY_REQUIRED' }); vi.mocked(api.choices).mockResolvedValue({ state: 'MANUAL_ENTRY_REQUIRED' });
  await c.load(); expect(c.snapshot().phase).toBe('UNAVAILABLE'); expect(api.verifySchool).not.toHaveBeenCalled();
});
it('does not reveal school B if authorization is revoked after its choice was listed', async () => {
  vi.mocked(api.current).mockResolvedValue({ state: 'MANUAL_ENTRY_REQUIRED' }); await c.load(); vi.mocked(api.verifySchool).mockRejectedValue(new SchoolEntryError('DENIED'));
  await c.choose(b.schoolId, c.snapshot().revision); expect(c.snapshot()).toMatchObject({ phase: 'DENIED', selection: null, choices: [] });
});
it('prevents duplicate reads and ignores responses from an unmounted or concealed instance', async () => {
  let finish!: () => void; vi.mocked(api.identity).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = c.load(); await c.load(); expect(api.identity).toHaveBeenCalledOnce(); c.dispose(); finish(); await task;
  expect(c.snapshot().selection).toBeNull(); expect(api.current).not.toHaveBeenCalled();
});
it('repeated concealment invalidates an in-flight access restoration', async () => {
  await c.load(); c.conceal(); let finish!: () => void;
  vi.mocked(api.verifySchool).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const task = c.load(); await tick(); c.conceal(); finish(); await task;
  expect(c.snapshot()).toMatchObject({ phase: 'CONCEALED', selection: null });
});
it('links only established workflows with inert school selectors; no student, membership, role or command is carried', () => {
  const links = schoolWorkflowLinks(a); expect(links.map(x => x.key)).toEqual(['crm', 'registration', 'membership', 'booking', 'attendance', 'dashboard', 'team', 'family']);
  for (const link of links) {
    const u = new URL(link.href, 'https://hon.example'); expect(u.origin).toBe('https://hon.example');
    expect([...u.searchParams.keys()]).toEqual(['organizationId', 'schoolId']); expect(u.searchParams.get('schoolId')).toBe(a.schoolId);
    expect(['/staff/crm/journey', '/staff/dashboard', '/staff/team/invitations', '/staff/family-access']).toContain(u.pathname);
  }
});
