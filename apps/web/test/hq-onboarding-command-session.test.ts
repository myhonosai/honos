import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindSchoolCreationPrivacy, SchoolCreationController } from '../src/components/hq-onboarding-controller';
import { schoolCreationApi } from '../src/components/hq-onboarding-http';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

const principalId = '10000000-0000-4000-8000-000000000001';
const form = { legalName: 'Harbor LLC', displayName: 'Harbor', schoolName: 'Harbor Main', schoolSlug: 'harbor-main', timezone: 'America/Los_Angeles' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const browser = new EventTarget(); vi.stubGlobal('window', browser);
  const invalidations = vi.fn(); browser.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidations);
  const post = deferred<Response>(), dispatched = deferred<void>();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (url === '/api/v1/hq/session' && init?.method === 'GET') return new Response(JSON.stringify({ data: { principalId, hqRole: 'HON_HQ_OWNER' } }));
    expect(url).toBe('/api/v1/hq/organizations'); expect(init?.method).toBe('POST'); dispatched.resolve(); return post.promise;
  });
  const mount = () => {
    const controller = new SchoolCreationController(); controller.start();
    const unbind = bindSchoolCreationPrivacy(controller, () => {}, browser, Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const stop = () => { unbind(); controller.stop(); }; cleanup.push(stop); return { controller, stop };
  };
  return { browser, invalidations, post, dispatched, fetch, mount };
}
async function prepare(controller: SchoolCreationController) {
  await controller.authorize(); for (const [key, value] of Object.entries(form)) controller.edit(key as keyof typeof form, value); controller.confirm(true);
}

describe('HQ command session lifetime with actual fetch transport', () => {
  it('retired POST401 cannot invalidate or conceal an independently authorized replacement', async () => {
    const s = setup(), old = s.mount(); await prepare(old.controller);
    const run = old.controller.submit(); await s.dispatched.promise;
    const dispatched = s.fetch.mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
    old.stop(); expect(dispatched.signal?.aborted).toBe(false);
    const replacement = s.mount(); await prepare(replacement.controller);
    s.post.resolve(new Response('{}', { status: 401 })); await run;
    expect(s.invalidations).not.toHaveBeenCalled();
    expect(replacement.controller.snapshot()).toMatchObject({ access: 'ready', concealed: false, form, confirmed: true });
    expect(s.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it.each(['blur', HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT])('retired POST401 after %s never emits another session event and retains the original command', async event => {
    const s = setup(), mounted = s.mount(); await prepare(mounted.controller);
    const run = mounted.controller.submit(); await s.dispatched.promise;
    const original = s.fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    s.browser.dispatchEvent(new Event(event)); const before = s.invalidations.mock.calls.length;
    s.post.resolve(new Response('{}', { status: 401 })); await run;
    expect(s.invalidations).toHaveBeenCalledTimes(before);
    expect(mounted.controller.snapshot()).toMatchObject({ concealed: true, receipt: null, form: { legalName: '' }, busy: false });
    await mounted.controller.authorize(); expect(mounted.controller.snapshot()).toMatchObject({ access: 'ready', uncertain: true, form });
    s.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ data: { principalId, hqRole: 'HON_HQ_OWNER' } })));
    s.fetch.mockImplementationOnce(async () => new Response('{}', { status: 403 }));
    mounted.controller.confirm(true); await mounted.controller.submit();
    const posts = s.fetch.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(2);
    expect(posts[1]![0]).toBe(original[0]); expect(posts[1]![1]?.body).toBe(original[1]?.body);
    expect(posts[1]![1]?.headers).toEqual(original[1]?.headers);
    expect(s.invalidations).toHaveBeenCalledTimes(before);
  });
  it('current POST401 emits the shared event once and conceals the authorized form', async () => {
    const s = setup(), mounted = s.mount(); await prepare(mounted.controller);
    const run = mounted.controller.submit(); await s.dispatched.promise; s.post.resolve(new Response('{}', { status: 401 })); await run;
    expect(s.invalidations).toHaveBeenCalledTimes(1); expect(mounted.controller.snapshot()).toMatchObject({ access: 'signed-out', concealed: true, receipt: null });
  });
  it('current POST403 is a local denial without shared session invalidation', async () => {
    const s = setup(), mounted = s.mount(); await prepare(mounted.controller);
    const run = mounted.controller.submit(); await s.dispatched.promise; s.post.resolve(new Response('{}', { status: 403 })); await run;
    expect(s.invalidations).not.toHaveBeenCalled(); expect(mounted.controller.snapshot()).toMatchObject({ access: 'forbidden', concealed: true, receipt: null });
  });
  it('stop/start of the same controller cannot revive the old command401 handler', async () => {
    const s = setup(), mounted = s.mount(); await prepare(mounted.controller);
    const run = mounted.controller.submit(); await s.dispatched.promise; mounted.stop(); mounted.controller.start();
    s.post.resolve(new Response('{}', { status: 401 })); await run;
    expect(s.invalidations).not.toHaveBeenCalled(); expect(mounted.controller.snapshot().access).toBe('idle');
    await mounted.controller.authorize(); expect(mounted.controller.snapshot()).toMatchObject({ access: 'ready', concealed: false, receipt: null });
  });
  it('the actual authenticated HQ GET401 still reports confirmed invalidation', async () => {
    const s = setup(); s.fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    await expect(schoolCreationApi.authorize(new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(s.invalidations).toHaveBeenCalledTimes(1);
  });
});
