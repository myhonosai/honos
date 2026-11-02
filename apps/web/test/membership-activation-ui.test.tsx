import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { formatLocaleCalendarDate, DEFAULT_LOCALE } from '@hon/design-system';
import { MembershipActivationWorkbench } from '../src/components/membership-activation-workbench';
import { activateKnownMembership, loadMembershipActivationContext, previewMembershipActivation, prepareMembershipActivation, membershipActivationPath, MembershipActivationError } from '../src/components/membership-activation-http';
import { scope, id, current, preview, input, receipt, envelope, rejected } from './membership-activation-fixtures';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('E1a closed frontend transport', () => {
  it('uses the exact preview marker, no-store human POST and no idempotency key', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => envelope(preview()));
    expect(await previewMembershipActivation(scope, {})).toEqual(preview());
    const [path, options] = f.mock.calls[0]!;
    expect(path).toBe(membershipActivationPath(scope) + '/activation-preview');
    expect(options).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: '{}' });
    expect(options!.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.membership.activation.preview' });
    await previewMembershipActivation(scope, { startDate: '2027-11-07', endDate: null });
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ startDate: '2027-11-07', endDate: null });
  });
  it('rejects forged selectors, closed-body additions, cross-membership previews and replayed reads', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(preview({ membershipId: id('9') })));
    await expect(previewMembershipActivation(scope, {})).rejects.toThrow();
    f.mockResolvedValue(envelope(preview(), true)); await expect(previewMembershipActivation(scope, {})).rejects.toThrow();
    for (const value of ['', '../all', scope.membershipId + '?x=1', 'https://other.test']) expect(() => membershipActivationPath({ ...scope, membershipId: value })).toThrow();
    await expect(previewMembershipActivation(scope, { payment: true } as never)).rejects.toThrow();
    await expect(previewMembershipActivation(scope, { startDate: '2027-02-29', endDate: null })).rejects.toThrow();
    expect(() => prepareMembershipActivation(scope, { expectedVersion: 1 } as never, id('9'))).toThrow();
  });
  it('retains immutable, canonical confirmation bytes and validates the matching receipt', async () => {
    const body = input(), request = prepareMembershipActivation(scope, body, id('9'));
    body.startDate = '2027-01-01'; expect(JSON.parse(request.body).startDate).toBe('2026-10-22'); expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.scope)).toBe(true);
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(receipt()));
    expect(await activateKnownMembership(request)).toEqual({ receipt: receipt(), replayed: false });
    expect(f.mock.calls[0]![1]).toMatchObject({ body: request.body, headers: { 'Idempotency-Key': id('9'), 'X-HON-Human-Command': 'billing.membership.activate' } });
    f.mockResolvedValue(envelope(receipt(), true)); expect((await activateKnownMembership(request)).replayed).toBe(true);
    for (const patch of [{ membershipId: id('7') }, { version: 3, previousVersion: 2 }, { acknowledgedWarnings: ['BIRTH_DATE_MISSING'] }, { paid: true }, { effectivePeriod: { ...receipt().effectivePeriod, endDateInclusive: false } }]) {
      f.mockResolvedValue(envelope({ ...receipt(), ...patch })); await expect(activateKnownMembership(request)).rejects.toMatchObject({ uncertain: true });
    }
  });
  it('requires exact-school live context and closed verified metadata for restoration', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(current, false, true));
    expect(await loadMembershipActivationContext(scope)).toEqual(current);
    for (const patch of [{ schoolId: id('9') }, { state: 'PAID' }, { version: 0 }, { creator: 'private' }]) { f.mockResolvedValue(envelope({ ...current, ...patch }, false, true)); await expect(loadMembershipActivationContext(scope)).rejects.toThrow(); }
  });
  it.each(['ACTIVATION_PREVIEW_STALE', 'ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED', 'ACTIVATION_ACKNOWLEDGEMENT_REQUIRED', 'ACTIVATION_OVERRIDE_REQUIRED', 'ACTIVATION_OVERRIDE_FORBIDDEN', 'ACTIVATION_BLOCKED', 'VERSION_CONFLICT', 'MEMBERSHIP_NOT_DRAFT', 'IDEMPOTENCY_KEY_REUSED', 'DATE_SOURCE_MISMATCH', 'ACTIVATION_REASON_TEXT_REQUIRED', 'ADULT_VERIFICATION_NOT_APPLICABLE', 'SCHOOL_TIMEZONE_INVALID', 'VALIDATION_FAILED'])('maps %s without exposing backend text', async code => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rejected(409, code));
    await expect(activateKnownMembership(prepareMembershipActivation(scope, input(), id('9')))).rejects.toMatchObject({ code, uncertain: false });
    await expect(previewMembershipActivation(scope, {})).rejects.not.toThrow('PRIVATE_CANARY');
  });
  it.each([0, 500, 502, 503, 504, 200])('retains an unknown outcome for transport/status %s', async status => {
    const f = vi.spyOn(globalThis, 'fetch'); if (!status) f.mockRejectedValue(new DOMException('Timeout', 'TimeoutError')); else f.mockResolvedValue(new Response('malformed', { status }));
    await expect(activateKnownMembership(prepareMembershipActivation(scope, input(), id('9')))).rejects.toMatchObject({ uncertain: true });
  });
  it('keeps in-progress requests retryable; classifies authorization refusal', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rejected(409, 'IDEMPOTENCY_IN_PROGRESS'));
    await expect(activateKnownMembership(prepareMembershipActivation(scope, input(), id('9')))).rejects.toMatchObject({ uncertain: true });
    f.mockResolvedValue(rejected(403, 'ACTIVATION_OVERRIDE_FORBIDDEN'));
    await expect(activateKnownMembership(prepareMembershipActivation(scope, input(), id('9')))).rejects.toBeInstanceOf(MembershipActivationError);
  });
  it.each([401, 403])('handles %s with sanitized errors, broadcasting only confirmed session loss', async status => {
    const target = new EventTarget(), invalidated = vi.fn(); target.addEventListener('hon:session-invalidated', invalidated); vi.stubGlobal('window', target);
    const response = rejected(status, 'ACTIVATION_OVERRIDE_FORBIDDEN'), consume = vi.spyOn(response, 'text');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(previewMembershipActivation(scope, {})).rejects.toMatchObject({ status });
    if (status === 401) expect(consume).not.toHaveBeenCalled();
    expect(invalidated).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });
  it('renders inert, preserves billing boundaries and uses calendar dates without converting to user timezone', () => {
    const f = vi.spyOn(globalThis, 'fetch'); const html = renderToStaticMarkup(<MembershipActivationWorkbench sessionSubject="synthetic" />);
    expect(f).not.toHaveBeenCalled(); expect(html).toContain('Review and confirm membership activation'); expect(html).not.toContain('Confirm membership activation</button>'); expect(html).toContain('does not collect tuition');
    expect(formatLocaleCalendarDate({ ...DEFAULT_LOCALE, timeZone: 'America/Los_Angeles' }, '2027-11-07')).toContain('7');
    const source = readFileSync('src/components/membership-activation-workbench.tsx', 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|window.location.reload/);
    expect(source).toContain('instance.current === life'); expect(source).toContain('verifyEnrollmentSession');
    expect(readFileSync('src/app/staff/billing/memberships/page.tsx', 'utf8')).toContain("redirect('/auth/login')");
  });
});
