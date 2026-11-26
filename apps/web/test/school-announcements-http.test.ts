import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementsAccessError, AnnouncementsRefusal, attemptFor, loadSchoolAnnouncements, publishSchoolAnnouncement, withdrawSchoolAnnouncement } from '../src/components/school-announcements/http';

// 0576 school announcements web client: fixed same-origin calls, verified answers, definite refusals vs unknown outcomes.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const scope = { organizationId: A, schoolId: B };
const T1 = '2026-11-20T17:00:00.000Z';
const live = { announcementId: C, title: 'Closed Monday', body: 'No classes.', status: 'PUBLISHED', publishedAt: T1, withdrawnAt: null, version: 1 };
afterEach(() => vi.restoreAllMocks());

describe('school announcements http', () => {
  it('posts as a browser command under the school scope', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, { data: { announcement: live }, meta: { replayed: false } }));
    expect((await publishSchoolAnnouncement(scope, 'Closed Monday', 'No classes.', 'key-1')).announcement.announcementId).toBe(C);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`/api/v1/organizations/${A}/schools/${B}/announcements`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', body: JSON.stringify({ title: 'Closed Monday', body: 'No classes.' }) });
    expect((init as RequestInit).headers).toMatchObject({ 'X-HON-Human-Command': 'school_announcements.publish', 'Idempotency-Key': 'key-1' });
  });
  it('sends phoneAlert only when staff ticked it (0658)', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(201, { data: { announcement: live }, meta: { replayed: false } }));
    await publishSchoolAnnouncement(scope, 'Closed Monday', 'No classes.', 'key-1', true);
    await publishSchoolAnnouncement(scope, 'Closed Monday', 'No classes.', 'key-2', false);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ title: 'Closed Monday', body: 'No classes.', phoneAlert: true }) });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ title: 'Closed Monday', body: 'No classes.' }) });
  });
  it('refuses bad text before any call and refuses an answer for another post', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(201, { data: { announcement: { ...live, title: 'Other' } }, meta: { replayed: false } }));
    await expect(publishSchoolAnnouncement(scope, 'a\nb', 'x', 'k')).rejects.toThrow();
    await expect(publishSchoolAnnouncement(scope, 'T', ' ', 'k')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(publishSchoolAnnouncement(scope, 'Closed Monday', 'No classes.', 'k')).rejects.toThrow();
  });
  it('takes one down at its version and checks the answer', async () => {
    const down = { ...live, status: 'WITHDRAWN', withdrawnAt: '2026-11-20T18:00:00.000Z', version: 2 };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(200, { data: { announcement: down }, meta: { replayed: false } }))
      .mockResolvedValueOnce(json(200, { data: { announcement: live }, meta: { replayed: false } }));
    expect((await withdrawSchoolAnnouncement(scope, C, 1, 'k')).announcement.status).toBe('WITHDRAWN');
    expect(fetcher.mock.calls[0]![0]).toBe(`/api/v1/organizations/${A}/schools/${B}/announcements/${C}/withdraw`);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: JSON.stringify({ expectedVersion: 1 }) });
    await expect(withdrawSchoolAnnouncement(scope, C, 1, 'k')).rejects.toThrow();
  });
  it('tells definite refusals from unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(429, { code: 'SCHOOL_ANNOUNCEMENTS_RATE_LIMITED' })).mockResolvedValueOnce(json(503, { code: 'SCHOOL_ANNOUNCEMENTS_UNAVAILABLE' }))
      .mockResolvedValueOnce(json(403, { code: 'SCHOOL_ANNOUNCEMENTS_FORBIDDEN' })).mockResolvedValueOnce(json(200, { data: { announcements: [live] }, meta: {} }));
    await expect(publishSchoolAnnouncement(scope, 'T', 'x', 'k')).rejects.toBeInstanceOf(AnnouncementsRefusal);
    const unknown = await publishSchoolAnnouncement(scope, 'T', 'x', 'k').catch(e => e);
    expect(unknown).not.toBeInstanceOf(AnnouncementsRefusal); expect(unknown).toBeInstanceOf(Error);
    await expect(loadSchoolAnnouncements(scope)).rejects.toBeInstanceOf(AnnouncementsAccessError);
    expect((await loadSchoolAnnouncements(scope)).announcements).toHaveLength(1);
  });
  it('keeps the key only for the same command', () => {
    let n = 0; const key = () => `k${++n}`;
    const first = attemptFor('publish:a', null, key);
    expect(attemptFor('publish:a', first, key)).toBe(first);
    expect(attemptFor('publish:b', first, key).key).toBe('k2');
  });
});
