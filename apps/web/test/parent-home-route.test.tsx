import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HON_SESSION_COOKIE, issueSession, sessionConfig, SESSION_SECONDS } from '@hon/auth';

const request = vi.hoisted(() => ({ cookie: '' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: request.cookie }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));

import ParentHomePage from '../src/app/parent/page';
import ParentDocumentsPage from '../src/app/parent/documents/page';
import { ParentHome } from '../src/components/parent-home';
import { DocumentAcknowledgementDesk } from '../src/components/document-workbench';

describe('server-protected Parent Home destinations', () => {
  beforeEach(() => {
    request.cookie = '';
    vi.stubEnv('HON_AUTH_MODE', 'OIDC');
    vi.stubEnv('HON_SESSION_JWT_SECRET', 'TEST_ONLY_PARENT_HOME_SESSION_KEY_123456789');
    vi.stubEnv('HON_SESSION_AUDIENCE', 'parent-home-test');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('redirects missing, forged, expired, duplicate, and malformed sessions without contacting a provider or data API', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const valid = issueSession({ externalSubject: 'verified-parent' }, sessionConfig());
    const expired = issueSession({ externalSubject: 'verified-parent' }, sessionConfig(), Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1);
    for (const cookie of ['', `${HON_SESSION_COOKIE}=forged`, `${HON_SESSION_COOKIE}=${expired}`, `${HON_SESSION_COOKIE}=${valid}; ${HON_SESSION_COOKIE}=${valid}`, `${HON_SESSION_COOKIE}=%INVALID`]) {
      request.cookie = cookie;
      await expect(ParentHomePage()).rejects.toThrow('REDIRECT:/auth/login');
      await expect(ParentDocumentsPage()).rejects.toThrow('REDIRECT:/auth/login');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders only the separately guarded client compositions for a verified session and derives no family, child, or billing authority from it', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    request.cookie = `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: 'verified-parent' }, sessionConfig())}`;
    const home = await ParentHomePage();
    const documents = await ParentDocumentsPage();
    expect(React.isValidElement(home)).toBe(true);
    expect(home.type).toBe(ParentHome);
    expect(home.props).toEqual({});
    expect(React.isValidElement(documents)).toBe(true);
    expect(documents.type).toBe(DocumentAcknowledgementDesk);
    expect(documents.props).toEqual({ parent: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when session validation is unconfigured', async () => {
    request.cookie = `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: 'verified-parent' }, sessionConfig())}`;
    vi.stubEnv('HON_SESSION_JWT_SECRET', '');
    await expect(ParentHomePage()).rejects.toThrow('REDIRECT:/auth/login');
  });
});
