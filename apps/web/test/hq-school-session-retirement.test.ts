import { afterEach, expect, it, vi } from 'vitest';
import { SchoolCreationController, bindSchoolCreationPrivacy } from '../src/components/hq-onboarding-controller';
import { schoolCreationApi, SchoolCreationError } from '../src/components/hq-onboarding-http';
import { HqSchoolDirectoryController } from '../src/components/hq-school-directory-controller';
import { loadHqSchoolDirectory, readHqSchoolDirectoryPrincipal, HqSchoolDirectoryAccessError } from '../src/components/hq-school-directory-http';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../src/components/session-invalidation';

const principal = '10000000-0000-4000-8000-000000000001';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('creation session failure remains classified after privacy events and requires a fresh authorized read', async () => {
  const api = { authorize: vi.fn().mockRejectedValueOnce(new SchoolCreationError(401)).mockResolvedValue(principal), send: vi.fn() };
  const c = new SchoolCreationController(api); c.start(); await c.authorize();
  c.conceal();
  expect(c.snapshot()).toMatchObject({ access: 'signed-out', concealed: true });
  expect(api.authorize).toHaveBeenCalledTimes(1); expect(api.send).not.toHaveBeenCalled();
  await c.authorize(); expect(api.authorize).toHaveBeenCalledTimes(2); expect(c.snapshot().access).toBe('ready'); c.stop();
});
it('directory session failure remains classified after privacy events and requires a fresh authorized read', async () => {
  const api = { principal: vi.fn().mockRejectedValueOnce(new HqSchoolDirectoryAccessError('expired', 401)).mockResolvedValue(principal), load: vi.fn().mockResolvedValue({ schools: [] }) };
  const c = new HqSchoolDirectoryController(api); await c.start(); c.conceal();
  expect(c.snapshot()).toMatchObject({ kind: 'unauthorized', directory: null });
  expect(api.principal).toHaveBeenCalledTimes(1); expect(api.load).not.toHaveBeenCalled();
  await c.load(); expect(api.principal).toHaveBeenCalledTimes(3); expect(c.snapshot().kind).toBe('ready'); c.stop();
});
it.each([['creation authority', schoolCreationApi.authorize], ['directory facts', loadHqSchoolDirectory], ['directory authority', readHqSchoolDirectoryPrincipal]] as const)('retired %s 401 cannot invalidate a newer session', async (_label, read) => {
  const browser = new EventTarget(), signal = new AbortController(), invalidated = vi.fn();
  browser.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated); vi.stubGlobal('window', browser);
  let finish!: (reply: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = read(signal.signal); signal.abort(); finish(new Response('{}', { status: 401 }));
  await expect(task).rejects.toThrow(); expect(invalidated).not.toHaveBeenCalled();
});
it('conceals form/receipt DOM synchronously for every browser privacy event without releasing unsettled ownership', async () => {
  const api = { authorize: vi.fn().mockResolvedValue(principal), send: vi.fn() };
  const c = new SchoolCreationController(api); c.start(); await c.authorize();
  const browser = new EventTarget(), documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let hidden = false;
  const unbind = bindSchoolCreationPrivacy(c, () => { hidden = true; }, browser, documentTarget);
  for (const event of ['blur', 'pagehide', HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT]) {
    hidden = false; browser.dispatchEvent(new Event(event));
    expect(hidden).toBe(true); expect(c.snapshot().concealed).toBe(true);
  }
  expect(c.snapshot().access).toBe('signed-out'); hidden = false; unbind(); expect(hidden).toBe(true); c.stop();
});
