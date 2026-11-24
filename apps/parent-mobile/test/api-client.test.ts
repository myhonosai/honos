import { createParentApi } from '../src/api/client';
import { journeyBody, jsonResponse } from './fixtures';

function api(fetchImpl: jest.Mock, token: string | null = 'tok') {
  return createParentApi({ baseUrl: 'https://api.example.test', getToken: async () => token, fetchImpl, timeoutMs: 1000 });
}

describe('parent API client', () => {
  it('starts an invoice payment naming only the invoice, as a human command with an idempotency key', async () => {
    const inv = '66666666-6666-4666-8666-666666666666';
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { state: 'OPEN', url: 'https://checkout.stripe.test/pay/cs_1', expiresAt: '2026-11-17T15:30:00.000Z', amountMinor: 14900, currency: 'USD' } }));
    const result = await api(fetchImpl).startInvoicePayment(inv, 'key-0000000000000001');
    expect(result.ok && result.data.state).toBe('OPEN');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.example.test/v1/parent/invoice-payments/${inv}/start`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-hon-human-command']).toBe('parent.invoice.pay.start');
    expect(init.headers['Idempotency-Key']).toBe('key-0000000000000001');
    expect(JSON.parse(init.body)).toEqual({});
    const bad = jest.fn().mockResolvedValue(jsonResponse(200, { data: { state: 'OPEN', url: 'http://evil.test', expiresAt: '2026-11-17T15:30:00.000Z', amountMinor: 1, currency: 'USD' } }));
    expect((await api(bad).startInvoicePayment(inv, 'key-0000000000000002')).ok).toBe(false);
  });

  it('reads school announcements with no selector and verifies them', async () => {
    const item = { announcementId: '77777777-7777-4777-8777-000000000001', title: 'Closed Monday', body: 'No classes.', publishedAt: '2026-11-17T15:30:00.000Z' };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { schoolName: 'Dojo', announcements: [item] } }));
    const result = await api(fetchImpl).announcements();
    expect(result.ok && result.data.announcements[0]!.title).toBe('Closed Monday');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/announcements');
    expect(init.method).toBe('GET');
    const leaky = jest.fn().mockResolvedValue(jsonResponse(200, { data: { schoolName: 'Dojo', announcements: [{ ...item, author: 'Coach' }] } }));
    expect(await api(leaky).announcements()).toEqual({ ok: false, state: 'unavailable' });
  });

  it('reads journey recommendations with no selector and refuses an unexpected field', async () => {
    const item = { recommendationId: '77777777-7777-4777-8777-000000000002', program: 'Kids', rank: null, triggerKind: 'CLASSES_ATTENDED', threshold: 10,
      title: 'Sparring gear', message: 'Ready for light sparring.', targetKind: 'PRO_SHOP', checkoutId: null, eventId: null, targetLabel: null };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { children: [{ name: 'Mia', recommendations: [item] }] } }));
    const result = await api(fetchImpl).journeyRecommendations();
    expect(result.ok && result.data.children[0]!.recommendations[0]!.title).toBe('Sparring gear');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/journey-recommendations');
    expect(init.method).toBe('GET');
    const leaky = jest.fn().mockResolvedValue(jsonResponse(200, { data: { children: [{ name: 'Mia', recommendations: [{ ...item, studentProfileId: item.recommendationId }] }] } }));
    expect(await api(leaky).journeyRecommendations()).toEqual({ ok: false, state: 'unavailable' });
  });

  it('answers a recommendation naming only it, the answer and who it is for, and refuses a receipt for something else (0608)', async () => {
    const rec = '77777777-7777-4777-8777-000000000002';
    const receipt = { recommendationId: rec, kind: 'HIDDEN', childName: null, recordedAt: '2026-11-17T15:30:00.000Z', replayed: false };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: receipt }));
    expect(await api(fetchImpl).respondJourneyRecommendation(rec, { kind: 'HIDDEN' }, 'key-0000000000000003')).toEqual({ ok: true, data: receipt, replayed: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.example.test/v1/parent/journey-recommendations/${rec}/response`);
    expect(init.method).toBe('POST');
    expect(init.headers['x-hon-human-command']).toBe('parent.journey_recommendations.respond');
    expect(init.headers['Idempotency-Key']).toBe('key-0000000000000003');
    expect(JSON.parse(init.body)).toEqual({ kind: 'HIDDEN' });
    const want = { kind: 'INTERESTED' as const, childName: 'Sam Park', sibling: true };
    const interested = jest.fn().mockResolvedValue(jsonResponse(200, { data: { ...receipt, kind: 'INTERESTED', childName: 'Sam Park' } }));
    expect((await api(interested).respondJourneyRecommendation(rec, want, 'key-0000000000000006')).ok).toBe(true);
    expect(JSON.parse(interested.mock.calls[0][1].body)).toEqual(want);
    const other = jest.fn().mockResolvedValue(jsonResponse(200, { data: { ...receipt, kind: 'INTERESTED', childName: 'Leo Park' } }));
    expect(await api(other).respondJourneyRecommendation(rec, want, 'key-0000000000000004')).toEqual({ ok: false, state: 'unknown' });
    const gone = jest.fn().mockResolvedValue(jsonResponse(404, { code: 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' }));
    expect(await api(gone).respondJourneyRecommendation(rec, { kind: 'HIDDEN' }, 'key-0000000000000005')).toEqual({ ok: false, state: 'refused', code: 'JOURNEY_RECOMMENDATIONS_NOT_FOUND' });
  });

  it('reads attendance streaks with no selector and refuses anything beyond a name and a number', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { children: [{ name: 'Mia', weeks: 3 }] } }));
    const result = await api(fetchImpl).attendanceStreaks();
    expect(result.ok && result.data.children[0]!.weeks).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/parent/attendance-streaks');
    expect(init.method).toBe('GET');
    const leaky = jest.fn().mockResolvedValue(jsonResponse(200, { data: { children: [{ name: 'Mia', weeks: 3, lastClassAt: '2026-11-17T15:30:00.000Z' }] } }));
    expect(await api(leaky).attendanceStreaks()).toEqual({ ok: false, state: 'unavailable' });
  });

  it('reads the pro shop with no selector and refuses a link to another site', async () => {
    const item = { productId: '11', title: 'Gloves', imageUrl: null, fromPrice: '19.50', url: 'https://dojo.myshopify.com/products/gloves' };
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { data: { schoolName: 'Dojo', available: true, currency: 'USD', products: [item] } }));
    const result = await api(fetchImpl).proShop();
    expect(result.ok && result.data.products[0]!.url).toBe(item.url);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example.test/v1/parent/pro-shop');
    const evil = jest.fn().mockResolvedValue(jsonResponse(200, { data: { schoolName: 'Dojo', available: true, currency: 'USD', products: [{ ...item, url: 'https://evil.test/products/x' }] } }));
    expect(await api(evil).proShop()).toEqual({ ok: false, state: 'unavailable' });
  });

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

describe('build profiles', () => {
  const eas = require('../eas.json') as { build: Record<string, { env: Record<string, string> }> };
  it.each(['preview', 'production'])('%s points at the live HON site over https and is accepted by the client', profile => {
    const env = eas.build[profile]!.env;
    expect(env.EXPO_PUBLIC_HON_WEB_URL).toBe('https://app.myhonos.com');
    expect(env.EXPO_PUBLIC_HON_API_URL).toBe('https://app.myhonos.com/api');
    expect(() => createParentApi({ baseUrl: env.EXPO_PUBLIC_HON_API_URL!, getToken: async () => null, fetchImpl: jest.fn() })).not.toThrow();
  });
  it('ships the Firebase file for the same Android app id, with no private key in it', () => {
    const app = require('../app.json') as { expo: { android: { package: string; googleServicesFile: string } } };
    expect(app.expo.android.googleServicesFile).toBe('./google-services.json');
    const raw = JSON.stringify(require('../google-services.json'));
    const file = require('../google-services.json') as { client: Array<{ client_info: { android_client_info: { package_name: string } } }> };
    expect(file.client.map(c => c.client_info.android_client_info.package_name)).toEqual([app.expo.android.package]);
    expect(raw).not.toMatch(/private_key|client_email|service_account/);
  });
  it('uses the decided app id and name', () => {
    const app = require('../app.json') as { expo: { name: string; ios: { bundleIdentifier: string }; android: { package: string } } };
    expect([app.expo.name, app.expo.ios.bundleIdentifier, app.expo.android.package]).toEqual(['HON Family', 'com.myhonos.family', 'com.myhonos.family']);
  });
});
