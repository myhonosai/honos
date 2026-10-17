import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRICULUM_PROGRESS_STATUSES, type StaffCurriculumEnrollmentDetails } from '@hon/contracts';
import { CurriculumProgressAccessError, CurriculumProgressReadError, CurriculumProgressRejectedError, CurriculumProgressUncertainError, HUMAN_PROGRESS_STATUSES, PROGRESS_REQUIREMENTS_MAX,
  curriculumEnrollmentPath, loadCurriculumEnrollment, parseCurriculumEnrollment, parseCurriculumObservation, prepareCurriculumObservation, submitCurriculumObservation, validateCurriculumObservationDraft, validateCurriculumProgressIds, type PreparedCurriculumObservation } from '../src/components/curriculum-progress-workbench-http';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const ids = { organizationId: id('1'), schoolId: id('2'), curriculumId: id('3'), enrollmentId: id('4') };
const timestamp = '2026-10-16T12:00:00.123456+00:00';
const requirement = { id: id('6'), rankId: id('5'), code: 'BASICS', kind: 'TECHNIQUE', definition: { label: 'Foundation', description: 'PRIVATE_DESCRIPTION' }, required: true, version: 2, progressVersion: 7, status: null, recordedAt: null };
const data = { enrollment: { id: ids.enrollmentId, curriculumId: ids.curriculumId, studentProfileId: id('7'), currentRankId: id('5'), version: 3, status: 'ACTIVE', enrolledAt: timestamp }, requirements: [requirement] };
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } });
const snapshot = parseCurriculumEnrollment(envelope(data), ids);
const command = prepareCurriculumObservation(ids, snapshot, requirement.id, 'MET', 'Private note', id('9'));
const observation = { id: id('a'), enrollmentId: ids.enrollmentId, requirementId: requirement.id, requirementVersion: 2, enrollmentVersion: 3, status: 'MET', version: 8, recordedAt: timestamp };
const response = (data: unknown, replayed = false) => Response.json(envelope(data, replayed));
const posture = { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
afterEach(() => vi.restoreAllMocks());

describe('closed curriculum progress browser transport', () => {
  it('uses only the canonical exact enrollment GET and observation POST with no browser authority or key allocation', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response(observation));
    const key = vi.spyOn(crypto, 'randomUUID');
    expect(await loadCurriculumEnrollment(ids)).toEqual(data);
    expect(await submitCurriculumObservation(command)).toEqual({ observation, replayed: false });
    expect(fetcher.mock.calls).toEqual([
      [curriculumEnrollmentPath(ids), { ...posture, method: 'GET', headers: { Accept: 'application/json' } }],
      [curriculumEnrollmentPath(ids) + '/observations', { ...posture, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9'), 'X-HON-Human-Command': 'curriculum-progress' }, body: JSON.stringify({ requirementId: requirement.id, expectedRequirementVersion: 2, expectedEnrollmentVersion: 3, expectedProgressVersion: 7, status: 'MET', instructorNote: 'Private note' }) }],
    ]);
    expect(key).not.toHaveBeenCalled(); expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.ids)).toBe(true);
    expect(HUMAN_PROGRESS_STATUSES).toEqual(CURRICULUM_PROGRESS_STATUSES); expect(Object.isFrozen(HUMAN_PROGRESS_STATUSES)).toBe(true);
  });
  it('rejects non-exact IDs and authority selectors, forged paths, body fields, reordered/oversized commands and non-v4 keys before I/O', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const field of Object.keys(ids)) for (const bad of ['', 'Name', ' ' + id('1'), id('1') + '?x=1', 'https://evil.test/' + id('1'), null, ['UUID']]) {
      expect(() => validateCurriculumProgressIds({ ...ids, [field]: bad } as typeof ids)).toThrow();
      await expect(loadCurriculumEnrollment({ ...ids, [field]: bad } as typeof ids)).rejects.toThrow();
    }
    expect(() => validateCurriculumProgressIds({ ...ids, source: 'HUMAN_UI' } as typeof ids)).toThrow();
    for (const path of ['https://evil.test' + command.path, '//evil.test' + command.path, command.path + '?x=1', command.path + '/', command.path.replace('/observations', '/current-rank'), command.path.replace('/curricula/', '/curricula/../curricula/')]) await expect(submitCurriculumObservation({ ...command, path })).rejects.toThrow();
    for (const patch of [{ key: 'manual' }, { key: id('9').replace('-4999-', '-1999-') }, { ids: { ...ids, schoolId: id('b') } }, { body: ' ' + command.body }, { body: '{invalid' }, { body: JSON.stringify({ ...JSON.parse(command.body), actorPrincipalId: id('b') }) }, { body: JSON.stringify({ ...JSON.parse(command.body), status: 'PROMOTED' }) }, { body: JSON.stringify({ ...JSON.parse(command.body), expectedProgressVersion: 999999999 }) }, { body: 'x'.repeat(13001) }, { method: 'GET' }]) await expect(submitCurriculumObservation({ ...command, ...patch } as PreparedCurriculumObservation)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks exact enrollment/curriculum/current rank, every returned field and uniqueness, null semantics and bounds', () => {
    for (const patch of [{ id: id('b') }, { curriculumId: id('b') }, { studentProfileId: 'Name' }, { currentRankId: 'Rank' }, { version: 0 }, { version: '3' }, { version: 1.2 }, { version: 1000000000 }, { status: 'PROMOTED' }, { enrolledAt: '2026-02-30T00:00:00Z' }, { enrolledAt: '2026-10-16T24:00:00Z' }, { enrolledAt: '2026-10-16T12:00:00+14:30' }, { authority: 'SECRET' }]) expect(() => parseCurriculumEnrollment(envelope({ ...data, enrollment: { ...data.enrollment, ...patch } }), ids)).toThrow();
    for (const patch of [{ rankId: id('b') }, { id: 'label' }, { code: 'bad code' }, { kind: 'PROMOTION' }, { required: 'true' }, { version: 0 }, { progressVersion: -1 }, { progressVersion: 1000000000 }, { status: 'READY' }, { status: 'MET', recordedAt: null }, { recordedAt: timestamp }, { definition: { label: '' } }, { definition: { label: 'x'.repeat(161) } }, { definition: { label: 'a\nb' } }, { definition: { label: 'Safe', description: 'x'.repeat(2001) } }, { definition: { label: 'Safe', actor: 'SECRET' } }, { instructorNote: 'SECRET' }]) expect(() => parseCurriculumEnrollment(envelope({ ...data, requirements: [{ ...requirement, ...patch }] }), ids)).toThrow();
    for (const field of Object.keys(data.enrollment)) { const copy = { ...data.enrollment } as Record<string, unknown>; delete copy[field]; expect(() => parseCurriculumEnrollment(envelope({ ...data, enrollment: copy }), ids)).toThrow(); }
    for (const field of Object.keys(requirement)) { const copy = { ...requirement } as Record<string, unknown>; delete copy[field]; expect(() => parseCurriculumEnrollment(envelope({ ...data, requirements: [copy] }), ids)).toThrow(); }
    for (const requirements of [[requirement, requirement], [requirement, { ...requirement, id: id('b') }], Array.from({ length: PROGRESS_REQUIREMENTS_MAX + 1 }, () => requirement), null, {}]) expect(() => parseCurriculumEnrollment(envelope({ ...data, requirements }), ids)).toThrow();
    expect(() => parseCurriculumEnrollment(envelope({ ...data, enrollment: { ...data.enrollment, currentRankId: null } }), ids)).toThrow();
    expect(parseCurriculumEnrollment(envelope({ ...data, enrollment: { ...data.enrollment, currentRankId: null }, requirements: [] }), ids).requirements).toEqual([]);
    expect(parseCurriculumEnrollment(envelope(data), ids).requirements[0]?.progressVersion).toBe(7);
    for (const status of CURRICULUM_PROGRESS_STATUSES) expect(parseCurriculumEnrollment(envelope({ ...data, requirements: [{ ...requirement, status, recordedAt: timestamp }] }), ids).requirements[0]?.status).toBe(status);
    for (const value of [null, [envelope(data)], { ...envelope(data), authority: 'SECRET' }, { ...envelope(data), data: { ...data, history: [] } }, envelope(data, true), { ...envelope(data), meta: { ...envelope(data).meta, correlationId: id('b') } }, { ...envelope(data), meta: { ...envelope(data).meta, replayed: 'false' } }, { ...envelope(data), meta: { ...envelope(data).meta, source: 'AI' } }]) expect(() => parseCurriculumEnrollment(value, ids)).toThrow();
  });
  it('derives immutable expected versions from the returned requirement, preserves historical sequences and bounds closed statuses/notes', () => {
    for (const status of CURRICULUM_PROGRESS_STATUSES) expect(validateCurriculumObservationDraft(ids, snapshot, requirement.id, status, '').expectedProgressVersion).toBe(7);
    expect(validateCurriculumObservationDraft(ids, snapshot, requirement.id, 'MET', '')).not.toHaveProperty('instructorNote');
    expect(validateCurriculumObservationDraft(ids, snapshot, requirement.id, 'MET', 'x'.repeat(2000)).instructorNote).toHaveLength(2000);
    for (const status of ['', 'READY', 'PROMOTION', 'PASSED', 'met', null, ['MET']]) expect(() => validateCurriculumObservationDraft(ids, snapshot, requirement.id, status, '')).toThrow();
    for (const note of ['x'.repeat(2001), '\u0000', { source: 'AI' }, null]) expect(() => validateCurriculumObservationDraft(ids, snapshot, requirement.id, 'MET', note)).toThrow();
    expect(() => validateCurriculumObservationDraft(ids, snapshot, id('b'), 'MET', '')).toThrow();
    for (const status of ['SUSPENDED', 'ARCHIVED']) expect(() => validateCurriculumObservationDraft(ids, { ...data, enrollment: { ...data.enrollment, status } } as StaffCurriculumEnrollmentDetails, requirement.id, 'MET', '')).toThrow();
    const upper = prepareCurriculumObservation(Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v.toUpperCase()])) as typeof ids, snapshot, requirement.id.toUpperCase(), 'MET', 'Private note', id('9'));
    expect(upper).toEqual(command);
  });
  it('verifies every receipt field, exact requirement/enrollment/status and all expected versions without private details', async () => {
    for (const replayed of [true, false]) expect(parseCurriculumObservation(envelope(observation, replayed), command)).toEqual({ observation, replayed });
    for (const patch of [{ enrollmentId: id('b') }, { requirementId: id('b') }, { requirementVersion: 1 }, { enrollmentVersion: 2 }, { version: 7 }, { version: '8' }, { status: 'PRACTICING' }, { status: 'PROMOTED' }, { recordedAt: 'yesterday' }, { actorPrincipalId: id('b') }, { instructorNote: 'PRIVATE' }, { outbox: {} }]) expect(() => parseCurriculumObservation(envelope({ ...observation, ...patch }), command)).toThrow();
    for (const field of Object.keys(observation)) { const copy = { ...observation } as Record<string, unknown>; delete copy[field]; expect(() => parseCurriculumObservation(envelope(copy), command)).toThrow(); }
    for (const status of CURRICULUM_PROGRESS_STATUSES) {
      const exact = prepareCurriculumObservation(ids, snapshot, requirement.id, status, '', id('9'));
      expect(parseCurriculumObservation(envelope({ ...observation, status }), exact).observation.status).toBe(status);
    }
  });
  it('classifies access loss and definite conflicts safely, never echoes raw problems and never retries automatically', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403]) {
      fetcher.mockResolvedValue(Response.json({ detail: 'SQL_SECRET' }, { status }));
      await expect(loadCurriculumEnrollment(ids)).rejects.toBeInstanceOf(CurriculumProgressAccessError);
      await expect(submitCurriculumObservation(command)).rejects.toMatchObject({ status });
    }
    for (const status of [400, 404, 409, 413, 415, 422]) {
      fetcher.mockResolvedValue(Response.json({ detail: 'SQL_SECRET' }, { status }));
      await expect(submitCurriculumObservation(command)).rejects.toBeInstanceOf(CurriculumProgressRejectedError);
      await expect(loadCurriculumEnrollment(ids)).rejects.not.toThrow('SQL_SECRET');
    }
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET'));
    await expect(submitCurriculumObservation(command)).rejects.toBeInstanceOf(CurriculumProgressUncertainError);
    fetcher.mockRejectedValueOnce(new Error('NETWORK_SECRET'));
    await expect(loadCurriculumEnrollment(ids)).rejects.toBeInstanceOf(CurriculumProgressReadError);
  });
  it('treats malformed, excessive, redirected, wrong-type or non-200 success as uncertain for POST and failed for GET', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const candidates = () => [new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }), new Response('x'.repeat(400001), { headers: { 'Content-Type': 'application/json' } }), new Response(JSON.stringify(envelope(observation)), { headers: { 'Content-Type': 'text/html' } }), new Response(null, { status: 201 }), new Response(null, { status: 202 }), new Response(null, { status: 302 }), new Response(null, { status: 503 }), response({ ...observation, instructorNote: 'PRIVATE' })];
    for (const candidate of candidates()) { fetcher.mockResolvedValueOnce(candidate); await expect(submitCurriculumObservation(command)).rejects.toBeInstanceOf(CurriculumProgressUncertainError); }
    for (const candidate of candidates()) { fetcher.mockResolvedValueOnce(candidate); await expect(loadCurriculumEnrollment(ids)).rejects.toBeInstanceOf(CurriculumProgressReadError); }
    const redirected = response(observation); Object.defineProperty(redirected, 'redirected', { value: true }); fetcher.mockResolvedValueOnce(redirected);
    await expect(submitCurriculumObservation(command)).rejects.toBeInstanceOf(CurriculumProgressUncertainError);
    expect(fetcher).toHaveBeenCalledTimes(17);
  });
});
