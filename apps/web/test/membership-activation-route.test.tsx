import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MembershipActivationPage, { dynamic, metadata } from '../src/app/staff/billing/memberships/page';
import { MembershipActivationWorkbench } from '../src/components/membership-activation-workbench';

const membershipId = '33333333-3333-4333-8333-333333333333';

describe('membership activation receipt handoff route', () => {
  it('admits only one inert membership selector through the protected dynamic route', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const key = vi.spyOn(crypto, 'randomUUID');
    try {
      const page = await MembershipActivationPage({ searchParams: Promise.resolve({ membershipId }) });
      expect(page.type).toBe(MembershipActivationWorkbench);
      expect(page.props).toEqual({ initialMembershipId: membershipId });
      expect(dynamic).toBe('force-dynamic');
      expect(metadata.robots).toEqual({ index: false, follow: false });
      expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
      for (const value of [undefined, '', 'not-a-uuid', '33333333-3333-0333-8333-333333333333', [membershipId], [membershipId, '44444444-4444-4444-8444-444444444444']]) {
        const params = value === undefined ? {} : { membershipId: value as string | string[] };
        expect((await MembershipActivationPage({ searchParams: Promise.resolve(params) })).props).toEqual({});
      }
    } finally { fetcher.mockRestore(); key.mockRestore(); }
  });

  it('keeps a valid DRAFT receipt selector as initial text only, with no scope or command effect', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const key = vi.spyOn(crypto, 'randomUUID');
    try {
      const html = renderToStaticMarkup(<MembershipActivationWorkbench initialMembershipId={membershipId} />);
      expect(fetcher).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
      expect(html).toContain(`value="${membershipId}"`); expect(html).toContain('Enter the known organization and school IDs.');
      expect(html).not.toContain('Current membership observation'); expect(html).not.toContain('Activate membership only</button>');
      expect(html).not.toContain('Payment complete'); expect(html).not.toContain('Signed agreement');
    } finally { fetcher.mockRestore(); key.mockRestore(); }
  });

  it('keeps the route free of lookup, command, scope, and receipt-data handoff code', () => {
    const route = require('node:fs').readFileSync('src/app/staff/billing/memberships/page.tsx', 'utf8');
    expect(route).toContain('normalizeInitialMembershipId'); expect(route).toContain("key={initialMembershipId ?? 'empty'}");
    expect(route).not.toMatch(/fetch\(|loadMembership|activateKnown|organizationId|schoolId|studentProfileId|accountId|personId|conversionId|planCode|termStartedAt|termEndsAt|recordedAt/);
  });
});
