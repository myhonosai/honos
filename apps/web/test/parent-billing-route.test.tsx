import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HON_SESSION_COOKIE, issueSession, sessionConfig, SESSION_SECONDS } from '@hon/auth';
const request = vi.hoisted(() => ({ cookie: '' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: request.cookie }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import ParentBillingPage from '../src/app/parent/billing/page';
import { ParentBilling } from '../src/components/parent-billing';

describe('server-protected Parent Billing route', () => {
  beforeEach(() => { request.cookie = ''; vi.stubEnv('HON_AUTH_MODE', 'OIDC'); vi.stubEnv('HON_SESSION_JWT_SECRET', 'TEST_ONLY_PARENT_BILLING_SESSION_KEY_123456789'); vi.stubEnv('HON_SESSION_AUDIENCE', 'parent-billing-test'); });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it('redirects absent, forged, expired, duplicate and malformed sessions without contacting a provider or data API', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const valid = issueSession({ externalSubject: 'verified-guardian' }, sessionConfig()); const expired = issueSession({ externalSubject: 'verified-guardian' }, sessionConfig(), Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1);
    for (const cookie of ['', `${HON_SESSION_COOKIE}=forged`, `${HON_SESSION_COOKIE}=${expired}`, `${HON_SESSION_COOKIE}=${valid}; ${HON_SESSION_COOKIE}=${valid}`, `${HON_SESSION_COOKIE}=%INVALID`]) { request.cookie = cookie; await expect(ParentBillingPage()).rejects.toThrow('REDIRECT:/auth/login'); }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('renders only the live guarded read component and never derives a family or child from the session', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); request.cookie = `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: 'verified-guardian' }, sessionConfig())}`;
    const element = await ParentBillingPage(); expect(React.isValidElement(element)).toBe(true); expect(element.type).toBe(ParentBilling); expect(element.props).toEqual({}); expect(fetcher).not.toHaveBeenCalled();
  });
});
