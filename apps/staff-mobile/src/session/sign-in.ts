/**
 * S0b HON Staff app sign-in (docs/architecture/STAFF_MOBILE_SIGN_IN.md). The app proves itself with PKCE: it keeps the
 * verifier, sends only the challenge to the web hand-off (/auth/staff-mobile/start), receives a one-minute code at its
 * fixed address and trades code + verifier for a staff session at the API. Nothing about the school, role or
 * permissions is chosen or stored here.
 */
export const APP_RETURN = 'honstaff://auth';
export type AuthSessionResult = { type: 'success'; url: string } | { type: string };

export interface SignInDeps {
  webOrigin: string;
  apiBaseUrl: string;
  randomVerifier: () => Promise<string>;
  challengeFor: (verifier: string) => Promise<string>;
  openAuthSession: (url: string, returnUrl: string) => Promise<AuthSessionResult>;
  fetchImpl: typeof fetch;
  saveToken: (token: string) => Promise<void>;
}

function codeFrom(url: string): string | null {
  if (!url.startsWith(`${APP_RETURN}?`)) return null;
  const params = new URLSearchParams(url.slice(APP_RETURN.length + 1));
  const codes = params.getAll('code');
  if (codes.length !== 1 || [...params.keys()].length !== 1 || !/^[A-Za-z0-9_.-]{20,8192}$/.test(codes[0]!)) return null;
  return codes[0]!;
}

export async function signIn(d: SignInDeps): Promise<'signed-in' | 'cancelled' | 'failed'> {
  try {
    const verifier = await d.randomVerifier();
    const challenge = await d.challengeFor(verifier);
    const result = await d.openAuthSession(`${d.webOrigin}/auth/staff-mobile/start?challenge=${challenge}`, APP_RETURN);
    if (result.type !== 'success' || !('url' in result) || typeof result.url !== 'string') return 'cancelled';
    const code = codeFrom(result.url);
    if (!code) return 'failed';
    const response = await d.fetchImpl(`${d.apiBaseUrl}/v1/auth/mobile/staff-session`, {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, verifier }),
    });
    if (!response.ok) return 'failed';
    const token = ((await response.json()) as { data?: { token?: unknown } } | null)?.data?.token;
    if (typeof token !== 'string' || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return 'failed';
    await d.saveToken(token);
    return 'signed-in';
  } catch {
    return 'failed';
  }
}
