import { createStaffApi } from '../src/api/client';
import { CHOICES, MANUAL, ORG, RESOLVED, SCHOOL_A, SCHOOL_B, jsonResponse, routeFetch } from './fixtures';

const CURRENT = '/v1/staff/current-reporting-school';
const LIST = '/v1/staff/reporting-schools';
const api = (fetchImpl: typeof fetch, token: string | null = 'staff.session.token') =>
  createStaffApi({ baseUrl: 'https://api.example.test', getToken: async () => token, fetchImpl });

describe('staff API client: where do I work', () => {
  it('one school: uses only the current-school read, as a native bearer GET with no cookies', async () => {
    const f = routeFetch({ [CURRENT]: () => jsonResponse(200, RESOLVED) });
    expect(await api(f.impl).whereIWork()).toEqual({ ok: true, data: { kind: 'one', school: { organizationId: ORG, schoolId: SCHOOL_A, schoolName: null } } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init).toMatchObject({ method: 'GET', credentials: 'omit', headers: { Accept: 'application/json', Authorization: 'Bearer staff.session.token' } });
  });
  it('several schools: asks for the choices', async () => {
    const f = routeFetch({ [CURRENT]: () => jsonResponse(200, MANUAL), [LIST]: () => jsonResponse(200, CHOICES) });
    const result = await api(f.impl).whereIWork();
    expect(result).toEqual({ ok: true, data: { kind: 'choose', schools: [
      { organizationId: ORG, schoolId: SCHOOL_A, schoolName: 'North Test School' },
      { organizationId: ORG, schoolId: SCHOOL_B, schoolName: 'South Test School' },
    ] } });
  });
  it('no staff school at all is "no staff access", never a guessed school', async () => {
    const f = routeFetch({ [CURRENT]: () => jsonResponse(200, MANUAL), [LIST]: () => jsonResponse(200, MANUAL) });
    expect(await api(f.impl).whereIWork()).toEqual({ ok: false, state: 'no-staff-access' });
  });
  it.each([
    [401, 'signed-out'], [403, 'no-staff-access'], [500, 'unavailable'], [503, 'unavailable'],
  ])('HTTP %i maps to %s', async (status, state) => {
    const f = routeFetch({ [CURRENT]: () => jsonResponse(status, { code: 'X' }) });
    expect(await api(f.impl).whereIWork()).toEqual({ ok: false, state });
  });
  it('an answer that does not verify is unavailable, not shown', async () => {
    const f = routeFetch({ [CURRENT]: () => jsonResponse(200, { data: { state: 'RESOLVED', organizationId: 'nope', schoolId: SCHOOL_A } }) });
    expect(await api(f.impl).whereIWork()).toEqual({ ok: false, state: 'unavailable' });
    const g = routeFetch({ [CURRENT]: () => jsonResponse(200, MANUAL), [LIST]: () => jsonResponse(200, { data: { state: 'SELECTION_REQUIRED', schools: [], extra: 1 } }) });
    expect(await api(g.impl).whereIWork()).toEqual({ ok: false, state: 'unavailable' });
  });
  it('a network failure is offline; no token is signed out without calling HON', async () => {
    const down = jest.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await api(down).whereIWork()).toEqual({ ok: false, state: 'offline' });
    const f = routeFetch({});
    expect(await api(f.impl, null).whereIWork()).toEqual({ ok: false, state: 'signed-out' });
    expect(f.calls).toHaveLength(0);
  });
  it.each(['http://api.example.test', 'https://u:p@api.example.test', 'https://api.example.test/?x=1', 'not a url', 'https://REPLACE-WITH-API.example'])('refuses a bad API address %s', raw => {
    expect(() => createStaffApi({ baseUrl: raw, getToken: async () => null })).toThrow();
  });
});
