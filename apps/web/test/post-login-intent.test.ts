import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { HON_SESSION_COOKIE, issueSession, sessionConfig } from '@hon/auth';
vi.mock('server-only', () => ({}));
import { GET as login } from '../src/app/auth/login/route';
import { GET as continueRoute } from '../src/app/auth/continue/route';
import { POST_LOGIN_INTENTS, POST_LOGIN_INTENT_COOKIE, postLoginIntent, postLoginIntentFromQuery } from '../src/server/post-login-intent';

const testEnv = { NODE_ENV: 'production', HON_AUTH_MODE: 'OIDC', HON_SESSION_JWT_SECRET: 'TEST_ONLY_HON_KEY_123456789012345678901234', HON_SESSION_AUDIENCE: 'hon-web-test', HON_PUBLIC_ORIGIN: 'https://hon.example', HON_OIDC_ISSUER: 'https://provider.example/issuer', HON_OIDC_AUTHORIZATION_ENDPOINT: 'https://provider.example/authorize', HON_OIDC_TOKEN_ENDPOINT: 'https://provider.example/token', HON_OIDC_JWKS_URI: 'https://provider.example/jwks', HON_OIDC_CLIENT_ID: 'hon-web-client', HON_OIDC_SCOPES: 'openid profile email', HON_OIDC_REDIRECT_URI: 'https://hon.example/auth/callback', HON_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: 'none' };
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (/^(MANUS_|HON_AUTH_|HON_SESSION_|HON_OIDC_|HON_PUBLIC_ORIGIN$|HON_API_BASE_URL$)/.test(key)) delete process.env[key];
  Object.assign(process.env, testEnv, { HON_API_BASE_URL: 'http://127.0.0.1:3001' });
});
afterEach(() => { process.env = saved; vi.restoreAllMocks(); });
const session = () => issueSession({ externalSubject: 'parent-a', displayName: 'Parent', email: 'parent@example.invalid' }, sessionConfig());
const at = (path: string, cookie?: string) => new NextRequest(`https://hon.example${path}`, { headers: { host: 'hon.example', ...(cookie ? { cookie } : {}) } });

describe('post-login intent names', () => {
  it('accepts only the fixed names in the exact form ?for=<name>', () => {
    expect(postLoginIntent('parent')).toBe('parent');
    expect(postLoginIntent('family-invitation')).toBe('family-invitation');
    expect(postLoginIntent('mobile')).toBe('mobile');
    // Exact set: adding an intent must be a reviewed change to this list.
    expect(POST_LOGIN_INTENTS).toEqual({ parent: '/parent', 'family-invitation': '/account/family-invitation', mobile: '/auth/mobile/finish' });
    for (const bad of ['', 'Parent', '/parent', 'https://evil.example', 'toString', '__proto__', 'staff', 'hq']) expect(postLoginIntent(bad)).toBeNull();
    expect(postLoginIntentFromQuery(new URLSearchParams('for=parent'))).toBe('parent');
    for (const bad of ['for=parent&for=parent', 'for=parent&next=/hq', 'next=parent', 'for=/parent', '']) expect(postLoginIntentFromQuery(new URLSearchParams(bad))).toBeNull();
  });
});

describe('sign-in from the parent portal returns there', () => {
  it('login stores only the fixed name in an HttpOnly /auth cookie, and still goes to the provider', async () => {
    const response = await login(at('/auth/login?for=parent'));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).origin).toBe('https://provider.example');
    expect(response.cookies.get(POST_LOGIN_INTENT_COOKIE)?.value).toBe('parent');
    const header = response.headers.get('set-cookie')!;
    expect(header).toMatch(new RegExp(`${POST_LOGIN_INTENT_COOKIE}=parent;[^,]*Path=/auth`));
    expect(header).toMatch(/HttpOnly/);
  });

  it('login with no or an unknown name sets no intent, and clears a stale one', async () => {
    expect((await login(at('/auth/login'))).cookies.get(POST_LOGIN_INTENT_COOKIE)).toBeUndefined();
    expect((await login(at('/auth/login?for=https://evil.example'))).cookies.get(POST_LOGIN_INTENT_COOKIE)).toBeUndefined();
    const cleared = await login(at('/auth/login', `${POST_LOGIN_INTENT_COOKIE}=parent`));
    expect(cleared.cookies.get(POST_LOGIN_INTENT_COOKIE)?.value).toBe('');
  });

  it.each([['parent', '/parent'], ['family-invitation', '/account/family-invitation'], ['mobile', '/auth/mobile/finish']])('continue sends a signed-in %s intent to its fixed page, without probing roles, and clears it', async (intent, path) => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const response = await continueRoute(at('/auth/continue', `${HON_SESSION_COOKIE}=${session()}; ${POST_LOGIN_INTENT_COOKIE}=${intent}`));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(path);
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.cookies.get(POST_LOGIN_INTENT_COOKIE)?.value).toBe('');
  });

  it('an unknown intent value is ignored: normal routing runs and the cookie is still cleared', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}, { status: 403 }));
    const response = await continueRoute(at('/auth/continue', `${HON_SESSION_COOKIE}=${session()}; ${POST_LOGIN_INTENT_COOKIE}=/hq`));
    expect(response.headers.get('location')).toBe('/auth/access');
    expect(response.cookies.get(POST_LOGIN_INTENT_COOKIE)?.value).toBe('');
  });

  it('without a valid session the intent never applies and is cleared', async () => {
    const response = await continueRoute(at('/auth/continue', `${HON_SESSION_COOKIE}=not-a-session; ${POST_LOGIN_INTENT_COOKIE}=parent`));
    expect(response.headers.get('location')).toBe('/auth/login');
    expect(response.cookies.get(POST_LOGIN_INTENT_COOKIE)?.value).toBe('');
  });

  it('every parent page and the family invitation page sign in with their fixed intent', () => {
    const root = new URL('../src/app/parent', import.meta.url).pathname;
    const pages: string[] = [];
    const walk = (dir: string) => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (statSync(full).isDirectory()) walk(full); else if (name === 'page.tsx') pages.push(full); } };
    walk(root);
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      const source = readFileSync(page, 'utf8');
      if (source.includes('/auth/login')) expect(source, page).not.toMatch(/\/auth\/login(?!\?for=parent)/);
    }
    expect(readFileSync(new URL('../src/app/account/family-invitation/page.tsx', import.meta.url), 'utf8')).toContain("redirect('/auth/login?for=family-invitation')");
  });
});
