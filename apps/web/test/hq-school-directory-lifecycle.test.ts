import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HqSchoolDirectory } from '@hon/contracts';
import { HqSchoolDirectoryController, bindHqSchoolDirectoryPrivacy } from '../src/components/hq-school-directory-controller';
import { HqSchoolDirectoryAccessError, loadHqSchoolDirectory, readHqSchoolDirectoryPrincipal } from '../src/components/hq-school-directory-http';
import { SchoolCreationController } from '../src/components/hq-onboarding-controller';
import { createSchoolRequest, schoolCreationApi } from '../src/components/hq-onboarding-http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../src/components/session-invalidation';
import { readFileSync } from 'node:fs';

const principal = '10000000-0000-4000-8000-000000000001';
const otherPrincipal = '10000000-0000-4000-8000-000000000002';
const directory: HqSchoolDirectory = { schools: [{ schoolId: '30000000-0000-4000-8000-000000000001', organizationDisplayName: 'Private Harbor Organization', schoolDisplayName: 'Private Harbor School', organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'COMPLETE', createdAt: '2026-11-01T00:00:00.000Z' }] };
const form = { legalName: 'Harbor LLC', displayName: 'Harbor', schoolName: 'Harbor Main', schoolSlug: 'harbor-main', timezone: 'America/Los_Angeles' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function setup() {
  const api = { principal: vi.fn(async (_signal: AbortSignal) => principal), load: vi.fn(async (_signal: AbortSignal) => directory) };
  const controller = new HqSchoolDirectoryController(api);
  return { controller, api };
}
function privacy(controller: HqSchoolDirectoryController) {
  const browser = new EventTarget(), documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const facts = { hidden: false, inert: false };
  const hide = vi.fn(() => { facts.hidden = true; facts.inert = true; });
  const unbind = bindHqSchoolDirectoryPrivacy(controller, hide, browser, documentTarget);
  return { browser, documentTarget, facts, hide, unbind };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HQ directory privacy and current-principal read lifetime', () => {
  it('verifies the current principal before and after the unchanged minimized read', async () => {
    const s = setup(); expect(s.api.load).not.toHaveBeenCalled(); await s.controller.start();
    expect(s.api.principal).toHaveBeenCalledTimes(2); expect(s.api.load).toHaveBeenCalledTimes(1);
    expect(s.controller.snapshot()).toEqual({ kind: 'ready', directory, busy: false });
    expect(s.api.load.mock.calls[0]![0]).toBe(s.api.principal.mock.calls[0]![0]);
  });
  it('immediately hides/inerts facts and clears them on every privacy signal, restoring only by an explicit fresh read', async () => {
    for (const event of ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT, 'visibilitychange']) {
      const s = setup(); await s.controller.start(); const p = privacy(s.controller);
      const oldSignal = s.api.load.mock.calls[0]![0];
      if (event === 'visibilitychange') { p.documentTarget.visibilityState = 'hidden'; p.documentTarget.dispatchEvent(new Event(event)); }
      else p.browser.dispatchEvent(new Event(event));
      expect(p.facts).toEqual({ hidden: true, inert: true }); expect(oldSignal.aborted).toBe(true);
      expect(s.controller.snapshot()).toEqual({ kind: event === HON_SESSION_INVALIDATED_EVENT ? 'unauthorized' : 'concealed', directory: null, busy: false });
      p.browser.dispatchEvent(new Event('focus')); p.documentTarget.visibilityState = 'visible'; p.documentTarget.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve(); expect(s.api.load).toHaveBeenCalledTimes(1);
      await s.controller.load(); expect(s.api.load).toHaveBeenCalledTimes(2); expect(s.controller.snapshot().directory).toEqual(directory); p.unbind();
    }
  });
  it('rejects late pending directory responses after concealment and permits an independent fresh read', async () => {
    const s = setup(), wait = deferred<HqSchoolDirectory>(); s.api.load.mockImplementationOnce(() => wait.promise);
    const p = privacy(s.controller), run = s.controller.start(); await Promise.resolve();
    p.browser.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));
    await s.controller.load(); expect(s.controller.snapshot()).toMatchObject({ kind: 'ready', directory });
    wait.resolve({ schools: [] }); await run; expect(s.controller.snapshot()).toMatchObject({ kind: 'ready', directory });
    p.unbind();
  });
  it('discards pending authorization and post-response principal reads after privacy or unmount', async () => {
    const s = setup(), first = deferred<string>(); s.api.principal.mockImplementationOnce(() => first.promise);
    const run = s.controller.start(); s.controller.conceal(); first.resolve(principal); await run; expect(s.api.load).not.toHaveBeenCalled();
    const last = deferred<string>(); s.api.principal.mockResolvedValueOnce(principal).mockImplementationOnce(() => last.promise);
    const restore = s.controller.load(); await Promise.resolve(); await Promise.resolve(); s.controller.stop(); last.resolve(principal); await restore;
    expect(s.controller.snapshot()).toMatchObject({ kind: 'concealed', directory: null });
  });
  it('refuses switched identities and authorization denials without retaining customer facts', async () => {
    const s = setup(); s.api.principal.mockResolvedValueOnce(principal).mockResolvedValueOnce(otherPrincipal); await s.controller.start();
    expect(s.controller.snapshot()).toEqual({ kind: 'forbidden', directory: null, busy: false });
    for (const status of [401, 403] as const) {
      const denied = setup(); denied.api.principal.mockRejectedValue(new HqSchoolDirectoryAccessError('denied', status)); await denied.controller.start();
      expect(denied.api.load).not.toHaveBeenCalled(); expect(denied.controller.snapshot()).toMatchObject({ kind: status === 401 ? 'unauthorized' : 'forbidden', directory: null });
    }
  });
  it('keeps the creation request mounted and exact while a creation-transport 401 conceals loaded directory facts synchronously', async () => {
    const s = setup(); await s.controller.start(); const p = privacy(s.controller); vi.stubGlobal('window', p.browser);
    const receipt = { organizationId: '20000000-0000-4000-8000-000000000001', schoolId: '30000000-0000-4000-8000-000000000001', ownerRoleId: '40000000-0000-4000-8000-000000000001', replayed: true };
    const api = { authorize: vi.fn(async () => principal), send: vi.fn(async (_request: unknown) => receipt) };
    const creation = new SchoolCreationController(api); creation.start(); await creation.authorize();
    for (const key of Object.keys(form) as (keyof typeof form)[]) creation.edit(key, form[key]);
    api.send.mockRejectedValueOnce(new Error('unknown')); creation.confirm(true); await creation.submit(); const original = api.send.mock.calls[0]![0];
    p.browser.addEventListener(HON_SESSION_INVALIDATED_EVENT, () => creation.conceal(true));
    const json = vi.fn(); vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401, json } as unknown as Response);
    await expect(schoolCreationApi.send(createSchoolRequest(form, principal))).rejects.toMatchObject({ status: 401 });
    expect(json).not.toHaveBeenCalled(); expect(p.facts).toEqual({ hidden: true, inert: true });
    expect(s.controller.snapshot()).toMatchObject({ kind: 'unauthorized', directory: null }); expect(creation.snapshot().concealed).toBe(true);
    await creation.authorize(); expect(creation.snapshot().uncertain).toBe(true); creation.confirm(true); await creation.submit();
    expect(api.send.mock.calls[1]![0]).toBe(original); p.unbind(); creation.stop();
  });
  it('unmount hides facts and detaches listeners without a focus-triggered refresh or presentation dependency', async () => {
    const s = setup(); await s.controller.start(); const p = privacy(s.controller); p.unbind(); s.controller.stop();
    expect(p.facts).toEqual({ hidden: true, inert: true }); const calls = p.hide.mock.calls.length;
    p.browser.dispatchEvent(new Event('blur')); expect(p.hide).toHaveBeenCalledTimes(calls);
    const source = readFileSync('src/components/hq-school-directory.tsx', 'utf8');
    expect(source).toContain('facts.current.hidden = true; facts.current.inert = true;'); expect(source).toContain('}, [controller]);');
    expect(source).toContain("t('directoryRead')"); expect(source).toContain('inert={state.kind');
    expect(readFileSync('src/app/hq/schools/page.tsx', 'utf8')).toContain('<HqSchoolDirectory /><HqOnboardingPanel />');
  });
});

describe('HQ directory transport access and cancellation', () => {
  it('accepts only closed OWNER/OPERATOR sessions, refusing support and augmented or malformed identity', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const hqRole of ['HON_HQ_OWNER', 'HON_HQ_OPERATOR']) {
      spy.mockResolvedValue(new Response(JSON.stringify({ data: { principalId: principal, hqRole } })));
      await expect(readHqSchoolDirectoryPrincipal(new AbortController().signal)).resolves.toBe(principal);
    }
    for (const data of [{ principalId: principal, hqRole: 'HON_HQ_SUPPORT' }, { principalId: principal, hqRole: 'HON_HQ_OWNER', organizationId: 'private' }, { principalId: 'bad', hqRole: 'HON_HQ_OWNER' }]) {
      spy.mockResolvedValue(new Response(JSON.stringify({ data }))); await expect(readHqSchoolDirectoryPrincipal(new AbortController().signal)).rejects.toThrow();
    }
  });
  it('propagates cancellation through fixed no-store GET and broadcasts only 401 before consuming a body', async () => {
    const browser = new EventTarget(), invalidated = vi.fn(); browser.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); vi.stubGlobal('window', browser);
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockResolvedValue(new Response(JSON.stringify({ data: { directory } })));
    const controller = new AbortController(); await loadHqSchoolDirectory(controller.signal);
    const options = spy.mock.calls[0]![1]!; expect(options).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    controller.abort(); expect(options.signal!.aborted).toBe(true);
    for (const loader of [loadHqSchoolDirectory, readHqSchoolDirectoryPrincipal]) for (const status of [401, 403] as const) {
      const json = vi.fn(); spy.mockResolvedValue({ ok: false, status, json } as unknown as Response);
      await expect(loader(new AbortController().signal)).rejects.toMatchObject({ status }); expect(json).not.toHaveBeenCalled();
    }
    expect(invalidated).toHaveBeenCalledTimes(2);
  });
});
