import { signIn, type SignInDeps } from '../src/session/sign-in';
import { jsonResponse } from './fixtures';

const verifier = 'v'.repeat(43);
function deps(overrides: Partial<SignInDeps> = {}): SignInDeps & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    webOrigin: 'https://app.example.test',
    apiBaseUrl: 'https://api.example.test',
    randomVerifier: async () => verifier,
    challengeFor: async () => 'c'.repeat(43),
    openAuthSession: jest.fn(async () => ({ type: 'success' as const, url: 'honstaff://auth?code=aaaa.bbbbbbbbbbbbbbbb.cccc' })),
    fetchImpl: jest.fn(async () => jsonResponse(200, { data: { token: 'mobile.session.token', expiresAt: '2026-11-18T03:00:00.000Z' } })) as unknown as typeof fetch,
    saveToken: async (t: string) => { saved.push(t); },
    ...overrides,
  };
}

describe('native sign-in', () => {
  it('opens the web hand-off with only the challenge and the fixed return address', async () => {
    const d = deps();
    await signIn(d);
    expect(d.openAuthSession).toHaveBeenCalledWith(`https://app.example.test/auth/staff-mobile/start?challenge=${'c'.repeat(43)}`, 'honstaff://auth');
  });

  it('exchanges the code with the verifier, as a native JSON POST, and stores the session', async () => {
    const d = deps();
    expect(await signIn(d)).toBe('signed-in');
    const [url, init] = (d.fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.example.test/v1/auth/mobile/staff-session');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ code: 'aaaa.bbbbbbbbbbbbbbbb.cccc', verifier });
    expect(d.saved).toEqual(['mobile.session.token']);
  });

  it('cancelling the browser stores nothing', async () => {
    const d = deps({ openAuthSession: jest.fn(async () => ({ type: 'cancel' as const })) });
    expect(await signIn(d)).toBe('cancelled');
    expect(d.fetchImpl).not.toHaveBeenCalled();
    expect(d.saved).toEqual([]);
  });

  it.each([
    'honstaff://auth?code=a&code=b',
    'honstaff://auth',
    'https://evil.example/auth?code=x',
    'honstaff://other?code=x',
  ])('refuses a return URL that is not exactly one code at the app address: %s', async url => {
    const d = deps({ openAuthSession: jest.fn(async () => ({ type: 'success' as const, url })) });
    expect(await signIn(d)).toBe('failed');
    expect(d.saved).toEqual([]);
  });

  it('a refused or malformed exchange stores nothing', async () => {
    for (const response of [jsonResponse(401, { code: 'MOBILE_SIGN_IN_INVALID' }), jsonResponse(200, { data: {} })]) {
      const d = deps({ fetchImpl: jest.fn(async () => response) as unknown as typeof fetch });
      expect(await signIn(d)).toBe('failed');
      expect(d.saved).toEqual([]);
    }
  });
});
