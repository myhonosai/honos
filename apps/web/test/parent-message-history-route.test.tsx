import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HON_SESSION_COOKIE, issueSession, sessionConfig, SESSION_SECONDS } from '@hon/auth';
const request = vi.hoisted(() => ({ cookie: '' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: request.cookie }) }));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
import ParentMessageHistoryPage from '../src/app/parent/messages/page';
import { ParentMessageHistory } from '../src/components/parent-message-history';
import { ParentSchoolMessages } from '../src/components/family-messages/parent-school-messages';

describe('server-protected Parent Message History route', () => {
  beforeEach(() => {
    request.cookie = '';
    vi.stubEnv('HON_AUTH_MODE', 'OIDC');
    vi.stubEnv('HON_SESSION_JWT_SECRET', 'TEST_ONLY_PARENT_MESSAGE_HISTORY_SESSION_KEY_123456789');
    vi.stubEnv('HON_SESSION_AUDIENCE', 'parent-message-history-test');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('redirects missing, forged, expired, duplicate and malformed HON cookies without contacting providers or data APIs', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const valid = issueSession({ externalSubject: 'verified-parent' }, sessionConfig());
    const expired = issueSession({ externalSubject: 'verified-parent' }, sessionConfig(), Math.floor(Date.now() / 1000) - SESSION_SECONDS - 1);
    for (const cookie of ['', `${HON_SESSION_COOKIE}=forged`, `${HON_SESSION_COOKIE}=${expired}`, `${HON_SESSION_COOKIE}=${valid}; ${HON_SESSION_COOKIE}=${valid}`, `${HON_SESSION_COOKIE}=%INVALID`]) {
      request.cookie = cookie;
      await expect(ParentMessageHistoryPage()).rejects.toThrow('REDIRECT:/auth/login');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders only the live fixed readers (school conversation, then history) for a verified session, without deriving family, child, recipient, or message authority from the session', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    request.cookie = `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: 'verified-parent' }, sessionConfig())}`;
    const element = await ParentMessageHistoryPage();
    expect(React.isValidElement(element)).toBe(true); expect(element.type).toBe(React.Fragment);
    const children = React.Children.toArray((element.props as { children: React.ReactNode }).children) as React.ReactElement[];
    expect(children.map(c => c.type)).toEqual([ParentSchoolMessages, ParentMessageHistory]); expect(children.map(c => Object.keys(c.props as object))).toEqual([[], []]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when HON session validation is unconfigured', async () => {
    request.cookie = `${HON_SESSION_COOKIE}=${issueSession({ externalSubject: 'verified-parent' }, sessionConfig())}`;
    vi.stubEnv('HON_SESSION_JWT_SECRET', '');
    await expect(ParentMessageHistoryPage()).rejects.toThrow('REDIRECT:/auth/login');
  });
});
