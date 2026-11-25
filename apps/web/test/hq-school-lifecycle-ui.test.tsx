import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HqSchoolDirectory } from '@hon/contracts';
vi.mock('../src/components/hq-modern/shell', () => ({ useHqModern: () => ({ view: 'modern' }) }));
import { DirectoryTable, LifecycleDialog, lifecycleConfirmReady } from '../src/components/hq-school-directory';
import { HqSchoolLifecycleError, loadHqSchoolArchiveDates, sendHqSchoolLifecycle } from '../src/components/hq-school-lifecycle-http';
import { SchoolCreationController, bindSchoolCreationPrivacy } from '../src/components/hq-onboarding-controller';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const directory: HqSchoolDirectory = { schools: [
  { schoolId: ids[0]!, organizationDisplayName: 'Ideal Org', schoolDisplayName: 'Ideal Martial Arts', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'COMPLETE', createdAt: '2026-11-14T05:46:53.188Z' },
  { schoolId: ids[1]!, organizationDisplayName: 'Paused Org', schoolDisplayName: 'Paused Dojo', organizationOperationalStatus: 'SUSPENDED', schoolOperationalStatus: 'SUSPENDED', entitlementTier: null, createdAt: '2026-11-15T05:46:53.188Z' },
  { schoolId: ids[2]!, organizationDisplayName: 'HON Internal Development', schoolDisplayName: 'Marketing Assistant Live Test', organizationOperationalStatus: 'ARCHIVED', schoolOperationalStatus: 'ARCHIVED', entitlementTier: 'COMPLETE', createdAt: '2026-10-15T19:47:36.931Z' },
] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HQ Schools list like agency sub-accounts', () => {
  it('shows search, a filter and a ⋯ menu; removed schools are hidden by default', () => {
    const html = renderToStaticMarkup(<DirectoryTable directory={directory} />);
    expect(html).toContain('data-school-search'); expect(html).toContain('data-school-filter');
    expect(html).toContain('Ideal Martial Arts'); expect(html).toContain('Paused Dojo');
    expect(html).not.toContain('Marketing Assistant Live Test');
    expect(html).toContain('data-action="PAUSE"'); expect(html).toContain('data-action="RESUME"'); expect(html).toContain('data-action="ARCHIVE"');
    expect(html).not.toContain('data-action="RESTORE"');
    expect(html).toContain(`href="/hq/schools/${ids[0]}"`);
    expect(html).toContain(`data-menu="plan" href="/hq/schools/${ids[0]}#plan"`); expect(html).toContain('Plan…');
    expect(html).not.toMatch(/not a selector|impersonation session/);
  });
  it('the confirm step gates Pause on the acknowledgement and Remove on the exact typed name', () => {
    expect(lifecycleConfirmReady('PAUSE', 'Ideal', '', false, false)).toBe(false);
    expect(lifecycleConfirmReady('PAUSE', 'Ideal', '', true, false)).toBe(true);
    expect(lifecycleConfirmReady('RESUME', 'Ideal', '', false, false)).toBe(true);
    expect(lifecycleConfirmReady('RESTORE', 'Ideal', '', false, false)).toBe(true);
    expect(lifecycleConfirmReady('ARCHIVE', 'Ideal', 'Ideal', false, false)).toBe(false);
    expect(lifecycleConfirmReady('ARCHIVE', 'Ideal', 'ideal', true, false)).toBe(false);
    expect(lifecycleConfirmReady('ARCHIVE', 'Ideal', 'Ideal ', true, false)).toBe(false);
    expect(lifecycleConfirmReady('ARCHIVE', 'Ideal', 'Ideal', true, false)).toBe(true);
    expect(lifecycleConfirmReady('ARCHIVE', 'Ideal', 'Ideal', true, true)).toBe(false);
    const html = renderToStaticMarkup(<LifecycleDialog pending={{ school: directory.schools[0]!, action: 'ARCHIVE', key: ids[1]! }} busy={false} error="" onCancel={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('Remove this school?'); expect(html).toContain('data-confirm-name'); expect(html).toMatch(/30 days/);
    expect(html).toMatch(/<button type="button" class="[^"]*" disabled="">Remove<\/button>/);
  });
  it('sends one same-origin human command with the idempotency key and maps refusals', async () => {
    const key = ids[1]!;
    const receipt = { schoolId: ids[0], action: 'ARCHIVE', schoolStatus: 'ARCHIVED', organizationStatus: 'ARCHIVED', eraseAfter: '2026-12-24T05:00:00.000Z', replayed: false };
    const f = vi.fn(async () => json({ data: receipt })); vi.stubGlobal('fetch', f);
    expect(await sendHqSchoolLifecycle(ids[0]!, { action: 'ARCHIVE', expectedStatus: 'ACTIVE', confirmName: 'Ideal Martial Arts' }, key)).toEqual(receipt);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/hq/schools/${ids[0]}/lifecycle`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
    expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'hq-school-lifecycle', 'Idempotency-Key': key });
    expect(JSON.parse(init.body as string)).toEqual({ action: 'ARCHIVE', expectedStatus: 'ACTIVE', confirmName: 'Ideal Martial Arts' });
    for (const [status, code, reason] of [[403, 'X', 'forbidden'], [400, 'HQ_SCHOOL_LIFECYCLE_NAME_MISMATCH', 'nameMismatch'], [409, 'HQ_SCHOOL_LIFECYCLE_STATUS_CONFLICT', 'changed'],
      [409, 'HQ_SCHOOL_LIFECYCLE_BILLING_ACTIVE', 'billingActive'], [409, 'HQ_SCHOOL_LIFECYCLE_OUTCOME_UNKNOWN', 'unknown'], [503, 'X', 'unknown'], [400, 'X', 'unavailable']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json({ code }, status)));
      await expect(sendHqSchoolLifecycle(ids[0]!, { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key)).rejects.toMatchObject({ reason });
    }
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { ...receipt, action: 'PAUSE', eraseAfter: null } })));
    await expect(sendHqSchoolLifecycle(ids[0]!, { action: 'ARCHIVE', expectedStatus: 'ACTIVE', confirmName: 'x' }, key)).rejects.toBeInstanceOf(HqSchoolLifecycleError);
    await expect(sendHqSchoolLifecycle('not-an-id', { action: 'PAUSE', expectedStatus: 'ACTIVE' }, key)).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('reads archive erase dates and rejects anything else', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { archives: [{ schoolId: ids[2], archivedAt: '2026-11-24T05:19:00.000Z', eraseAfter: '2026-12-24T05:19:00.000Z' }] } })));
    expect((await loadHqSchoolArchiveDates(new AbortController().signal)).archives).toHaveLength(1);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: { archives: [{ schoolId: ids[2], email: 'x' }] } })));
    await expect(loadHqSchoolArchiveDates(new AbortController().signal)).rejects.toThrow();
  });
  it('Create a school re-checks the owner by itself when the person comes back, never after sign-out', async () => {
    const api = { authorize: vi.fn(async () => ids[0]!), send: vi.fn() };
    const controller = new SchoolCreationController(api as never); controller.start();
    const browser = new EventTarget(); const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const unbind = bindSchoolCreationPrivacy(controller, () => {}, browser, documentTarget);
    expect(api.authorize).not.toHaveBeenCalled();
    await controller.authorize(); expect(controller.snapshot().concealed).toBe(false);
    browser.dispatchEvent(new Event('blur')); expect(controller.snapshot().concealed).toBe(true);
    browser.dispatchEvent(new Event('focus')); await vi.waitFor(() => expect(controller.snapshot().concealed).toBe(false));
    expect(api.authorize).toHaveBeenCalledTimes(2);
    controller.conceal(true); browser.dispatchEvent(new Event('focus')); await Promise.resolve();
    expect(api.authorize).toHaveBeenCalledTimes(2); expect(controller.snapshot().access).toBe('signed-out');
    unbind();
  });
  it('coming back during an in-flight create waits for it to settle, then re-checks once', async () => {
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const api = { authorize: vi.fn(async () => ids[0]!), send: vi.fn(async () => { await gate; throw new Error('network'); }) };
    const controller = new SchoolCreationController(api as never); controller.start();
    const browser = new EventTarget(); const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const unbind = bindSchoolCreationPrivacy(controller, () => {}, browser, documentTarget);
    await controller.authorize();
    for (const [key, value] of [['legalName', 'Harbor LLC'], ['displayName', 'Harbor'], ['schoolName', 'Harbor Main'], ['schoolSlug', 'harbor-main']] as const) controller.edit(key, value);
    controller.confirm(true); const sent = controller.submit();
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const before = api.authorize.mock.calls.length;
    browser.dispatchEvent(new Event('blur')); browser.dispatchEvent(new Event('focus'));
    expect(api.authorize).toHaveBeenCalledTimes(before);
    release(); await sent;
    await vi.waitFor(() => expect(controller.snapshot().concealed).toBe(false));
    expect(api.authorize).toHaveBeenCalledTimes(before + 1); expect(controller.snapshot().uncertain).toBe(true);
    unbind();
  });
});
