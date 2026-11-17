import { createParentApi } from '../src/api/client';
import { journeyBody, jsonResponse } from './fixtures';

function api(fetchImpl: jest.Mock, token: string | null = 'tok') {
  return createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => token, fetchImpl, timeoutMs: 1000 });
}

describe('parent API client', () => {
  it('reads the journey with a bearer session, no cookies and no selectors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, journeyBody()));
    const result = await api(fetchImpl).journey();
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/journey');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer tok' });
    expect(init.body).toBeUndefined();
  });

  it('does not call the API at all without a session', async () => {
    const fetchImpl = jest.fn();
    expect(await api(fetchImpl, null).journey()).toEqual({ ok: false, state: 'signed-out' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, undefined, 'signed-out'],
    [403, 'PARENT_SCOPE_DENIED', 'access-denied'],
    [403, 'PARENT_SCOPE_CHANGED', 'access-denied'],
    [403, 'CHILD_SCOPE_CHANGED', 'access-denied'],
    [409, 'PARENT_SCOPE_AMBIGUOUS', 'choose-family'],
    [503, 'PARENT_JOURNEY_UNAVAILABLE', 'unavailable'],
    [500, undefined, 'unavailable'],
    [403, 'HUMAN_UI_REQUIRED', 'unavailable'],
  ])('maps HTTP %s %s to %s', async (status, code, state) => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(status, code ? { code } : {}));
    expect(await api(fetchImpl).journey()).toEqual({ ok: false, state });
  });

  it('treats a response that fails the shared contract verifier as unavailable, never as data', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { ...journeyBody(), extra: 'field' }));
    expect(await api(fetchImpl).journey()).toEqual({ ok: false, state: 'unavailable' });
  });

  it('reports a network failure as offline', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    expect(await api(fetchImpl).journey()).toEqual({ ok: false, state: 'offline' });
  });

  it('reads the school time zone from the class booking choices', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { canBook: true, timezone: 'America/Los_Angeles', horizonDays: 14, children: [] } }));
    expect(await api(fetchImpl).schoolTimeZone()).toBe('America/Los_Angeles');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.test/v1/parent/class-bookings');
  });

  it('returns no school time zone when the booking read fails or is malformed', async () => {
    expect(await api(jest.fn().mockResolvedValue(jsonResponse(403, {}))).schoolTimeZone()).toBeNull();
    expect(await api(jest.fn().mockResolvedValue(jsonResponse(200, { data: { timezone: 'Not/AZone' } }))).schoolTimeZone()).toBeNull();
  });

  it('refuses a non-https API address outside local development', () => {
    expect(() => createParentApi({ baseUrl: 'http://api.example.test', getToken: async () => 't', fetchImpl: jest.fn() })).toThrow();
    expect(() => createParentApi({ baseUrl: 'http://localhost:4000', getToken: async () => 't', fetchImpl: jest.fn() })).not.toThrow();
  });

  it('refuses the unfilled placeholder address from eas.json', () => {
    expect(() => createParentApi({ baseUrl: 'https://REPLACE-WITH-PRODUCTION-API', getToken: async () => 't', fetchImpl: jest.fn() })).toThrow();
  });
});
