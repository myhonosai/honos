import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { MembershipActivationWorkbench } from '../src/components/membership-activation-workbench';
import { activateKnownMembership, loadMembershipActivationContext, membershipActivationPath, MembershipActivationError } from '../src/components/membership-activation-http';
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2'), membershipId: id('3') };
const current = { ...scope, state: 'DRAFT', version: 4 };
const saved = { id: scope.membershipId, billingAccountId: id('4'), participantPersonId: id('5'), planCode: 'KNOWN_DRAFT', state: 'ACTIVE', version: 5, createdAt: '2026-10-16T00:00:00.000Z' };
const meta = { requestId: id('6'), correlationId: id('6'), replayed: false };
const response = (data: unknown, m?: unknown) => ({ ok: true, json: async () => ({ data, ...(m ? { meta: m } : {}) }) }) as Response;

describe('conventional staff membership activation only', () => {
  it('makes only an explicit one-known-ID same-origin no-store read and verifies exact scope/state/version', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(current));
    try {
      expect(await loadMembershipActivationContext(scope)).toEqual(current);
      expect(f).toHaveBeenLastCalledWith(`${membershipActivationPath(scope)}/activation-context`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
      for (const patch of [{ payerId: id('4') }, { billingAccountId: id('4') }, { paymentMethod: 'secret' }, { agreementStatus: 'SIGNED' }, { billingStatus: 'PAID' }, { version: 0 }, { state: 'SIGNED' }, { schoolId: id('9') }, { membershipId: id('9') }]) {
        f.mockResolvedValue(response({ ...current, ...patch })); await expect(loadMembershipActivationContext(scope)).rejects.toThrow();
      }
      for (const state of ['ACTIVE', 'FROZEN', 'CANCELLED', 'EXPIRED', 'CANCELLATION_PENDING']) { f.mockResolvedValue(response({ ...current, state })); expect((await loadMembershipActivationContext(scope)).state).toBe(state); }
    } finally { f.mockRestore(); }
    for (const value of ['https://other.test', '../all', '', scope.membershipId + '?list=all']) expect(() => membershipActivationPath({ ...scope, membershipId: value })).toThrow();
  });
  it('sends only observed version to the canonical activation command and drops related IDs from the displayed receipt', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(saved, meta));
    try {
      expect(await activateKnownMembership(scope, 4, 'retained-key')).toEqual({ membership: { ...scope, state: 'ACTIVE', version: 5 }, replayed: false });
      expect(f).toHaveBeenLastCalledWith(`${membershipActivationPath(scope)}/activate`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.membership.activate', 'Idempotency-Key': 'retained-key' }, body: '{"expectedVersion":4}',
      });
      f.mockResolvedValue(response(saved, { ...meta, replayed: true })); expect((await activateKnownMembership(scope, 4, 'retained-key')).replayed).toBe(true);
      for (const patch of [{ id: id('9') }, { state: 'DRAFT' }, { version: 4 }, { version: 6 }, { signature: 'SIGNED' }, { paymentOutcome: 'SUCCEEDED' }, { paymentScheduleId: id('9') }]) {
        f.mockResolvedValue(response({ ...saved, ...patch }, meta)); await expect(activateKnownMembership(scope, 4, 'retained-key')).rejects.toThrow();
      }
      f.mockResolvedValue(response(saved, { ...meta, replayed: 'yes' })); await expect(activateKnownMembership(scope, 4, 'retained-key')).rejects.toThrow();
    } finally { f.mockRestore(); }
  });
  it('retains uncertain outcomes and classifies definitive access/version conflicts without exposing server private errors', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    try {
      for (const status of [400, 401, 403, 404, 409, 500]) {
        f.mockResolvedValue({ ok: false, status, json: async () => ({ detail: 'PRIVATE_PAYER_DETAIL' }) } as Response);
        await expect(activateKnownMembership(scope, 4, 'retained-key')).rejects.toBeInstanceOf(MembershipActivationError);
        await expect(loadMembershipActivationContext(scope)).rejects.not.toThrow('PRIVATE_PAYER_DETAIL');
      }
      f.mockRejectedValue(new Error('network uncertain')); await expect(activateKnownMembership(scope, 4, 'retained-key')).rejects.toThrow('network uncertain');
    } finally { f.mockRestore(); }
  });
  it('renders no activation or fake state before an explicit read; explains independent unsigned agreement/billing/payment posture', () => {
    const f = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<MembershipActivationWorkbench />);
      expect(f).not.toHaveBeenCalled(); expect(html).toContain('Activate a known membership'); expect(html).toContain('Already-known membership ID');
      expect(html).toContain('without an agreement signature, invoice or payment initiation');
      expect(html).toContain('Card collection never authorizes recurring billing'); expect(html).toContain('Agreement status, billing status and payer authorization are not read here');
      expect(html).not.toContain('Activate membership only</button>'); expect(html).not.toContain('Current membership observation');
      expect(html).not.toContain('Signed agreement'); expect(html).not.toContain('Payment complete');
    } finally { f.mockRestore(); }
    const source = readFileSync('src/components/membership-activation-workbench.tsx', 'utf8');
    for (const text of ["current.state === 'DRAFT'", 'Already ACTIVE', 'Retry exact retained activation', 'setCurrent(null)', 'expectedVersion: current.version', 'crypto.randomUUID()', 'generation.current', 'No activation is assumed', 'No agreement or billing outcome is claimed', 'setRetained(null)']) expect(source).toContain(text);
    expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|sendAgreement|owner-launch-http|paymentClient|providerClient/);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/billing/memberships')).toHaveLength(1);
    expect(readFileSync('src/components/owner-launch.tsx', 'utf8')).not.toContain('/staff/billing/memberships');
    expect(readFileSync('src/components/staff-dashboard.tsx', 'utf8')).toContain('href="/staff/billing/memberships"');
  });
});
