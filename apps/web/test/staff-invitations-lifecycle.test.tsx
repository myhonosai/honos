import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (fn: () => any, deps: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); h.values[i] = { deps }; h.effects.push(() => { h.values[i].cleanup = fn(); }); } },
}; });
import { StaffInvitations } from '../src/components/staff-invitations/workbench';
import { staffInvitationText as t } from '../src/components/staff-invitations/copy';
type E = ReactElement<Record<string, any>>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = { invitationId: id(4), schoolId: id(2), roleId: id(3), roleName: 'Front desk', email: 'PRIVATE@example.test', expiresAt: '2026-11-06T12:00:00Z', status: 'PENDING' };
const role = { id: id(3), schoolId: id(2), code: 'CUSTOM_DESK', name: 'Front desk', permissionCodes: ['school.view'], version: 1 };
let acceptance: boolean, subject: string, posts: RequestInit[], list: () => Promise<Response>, send: () => Promise<Response>, identityStatus: number;
const data = (value: unknown) => Response.json({ data: value });
const nodes = (n: unknown): E[] => Array.isArray(n) ? n.flatMap(nodes) : React.isValidElement(n) ? [n as E, ...nodes((n as E).props.children)] : [];
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join(' ') : React.isValidElement(n) ? text((n as E).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
function render() { h.cursor = 0; const tree = StaffInvitations({ sessionSubject: 'manager-a', acceptance }); h.effects.splice(0).forEach(run => run()); return tree; }
const byId = (value: string) => nodes(render()).find(n => n.props['data-testid'] === value)!;
const button = (key: Parameters<typeof t>[1]) => nodes(render()).find(n => n.type === 'button' && text(n) === t(h.language, key))!;
const change = (key: string, value: string | boolean) => byId(key).props.onChange({ target: { value, checked: value } });
const click = (key: Parameters<typeof t>[1]) => button(key).props.onClick();
const settle = async () => { for (let i = 0; i < 55; i++) await Promise.resolve(); render(); };
const submit = () => nodes(render()).find(n => n.type === 'form')!.props.onSubmit({ preventDefault() {} });
async function ready() { render(); change('staff-org', id(1)); change('staff-school', id(2)); click('verify'); await settle(); change('staff-role-id', id(3)); click('loadRole'); await settle(); }
async function prepare() { await ready(); change('staff-email', 'staff@example.test'); click('newToken'); change('staff-confirm', true); }
function dom() { const node = { hidden: false, inert: false, querySelectorAll: () => [] }; byId('staff-account-private').props.ref.current = node; return node; }
beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = []; h.language = 'en'; acceptance = false; subject = 'manager-a'; identityStatus = 200; posts = [];
  const w = Object.assign(new EventTarget(), { confirm: () => true }); vi.stubGlobal('window', w); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  list = async () => data([item]); send = async () => data({ ...item, email: 'staff@example.test' });
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    if (path === '/api/identity/me') return identityStatus === 200 ? data({ externalSubject: subject }) : Response.json({ code: 'SIGN_IN_REQUIRED' }, { status: identityStatus });
    if (options.method === 'POST') { posts.push(options); return send(); }
    if (path.includes('/staff-roles/custom/')) return Response.json({ data: role, meta: {} });
    return list();
  }));
});
afterEach(() => { for (const v of h.values) v?.cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['blur', 'pagehide', 'hon:session-invalidated', 'hon:school-context-changed'])('%s synchronously hides private information and native controls before React can render', async event => {
  await ready(); const area = dom(); expect(text(render())).toContain(item.email); window.dispatchEvent(new Event(event));
  expect(area.hidden).toBe(true); expect(area.inert).toBe(true); expect(text(render())).not.toContain(item.email); expect(posts).toHaveLength(0);
});
it.each(['blur', 'pagehide', 'hidden'])('%s before selectors are complete requires explicit same-identity restoration to selector entry', async event => {
  render(); change('staff-org', id(1)); const area = dom(); vi.mocked(fetch).mockClear();
  if (event === 'hidden') { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
  else window.dispatchEvent(new Event(event));
  expect(area.hidden).toBe(true); expect(area.inert).toBe(true); expect(byId('staff-school')).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); render(); expect(area.hidden).toBe(true); expect(fetch).not.toHaveBeenCalled();
  click('restore'); await settle(); expect(text(render())).toContain(t('en', 'IDLE')); expect(area.hidden).toBe(false); expect(area.inert).toBe(false);
  expect(byId('staff-org').props.value).toBe(id(1)); expect(byId('staff-school').props.value).toBe(''); expect(byId('staff-role-id')).toBeUndefined(); expect(text(render())).not.toContain(item.email);
  expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual(['/api/identity/me']); expect(posts).toHaveLength(0);
  change('staff-school', id(2)); click('verify'); await settle(); expect(text(render())).toContain(t('en', 'READY')); expect(text(render())).toContain(item.email); expect(posts).toHaveLength(0);
});
it('privacy before any selector input restores only blank selectors after an explicit identity check', async () => {
  render(); const area = dom(); window.dispatchEvent(new Event('blur')); expect(byId('staff-org')).toBeUndefined(); click('restore'); await settle();
  expect(area.hidden).toBe(false); expect(byId('staff-org').props.value).toBe(''); expect(byId('staff-school').props.value).toBe(''); expect(byId('staff-role-id')).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual(['/api/identity/me']); expect(posts).toHaveLength(0);
});
it.each([401, 403])('identity %s during incomplete-selector recovery keeps selectors concealed', async status => {
  render(); change('staff-org', id(1)); const area = dom(), event = vi.fn(); window.addEventListener('hon:session-invalidated', event); window.dispatchEvent(new Event('blur')); identityStatus = status;
  click('restore'); await settle(); expect(area.hidden).toBe(true); expect(area.inert).toBe(true); expect(byId('staff-school')).toBeUndefined(); expect(posts).toHaveLength(0);
  expect(text(render())).toContain(t('en', status === 401 ? 'SESSION' : 'DENIED')); expect(event).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it('a changed subject cannot restore incomplete selectors; only a later explicit matching identity can', async () => {
  render(); change('staff-org', id(1)); const area = dom(); window.dispatchEvent(new Event('pagehide')); subject = 'manager-b'; click('restore'); await settle();
  expect(area.hidden).toBe(true); expect(text(render())).toContain(t('en', 'IDENTITY')); expect(byId('staff-org')).toBeUndefined();
  subject = 'manager-a'; expect(area.hidden).toBe(true); click('restore'); await settle(); expect(area.hidden).toBe(false); expect(text(render())).toContain(t('en', 'IDLE')); expect(byId('staff-school')).toBeDefined(); expect(posts).toHaveLength(0);
});
it('a late ignored-cancellation list response cannot repopulate concealed information', async () => {
  render(); change('staff-org', id(1)); change('staff-school', id(2)); let finish!: (r: Response) => void; list = () => new Promise(resolve => { finish = resolve; });
  click('verify'); await settle(); const area = dom(); window.dispatchEvent(new Event('blur')); finish(data([item])); await settle();
  expect(area.hidden).toBe(true); expect(text(render())).not.toContain(item.email); expect(text(render())).toContain(t('en', 'CONCEALED'));
});
it('settlement while concealed clears the command lock, keeps receipt private and restores without automatic replay', async () => {
  await prepare(); let finish!: (r: Response) => void; send = () => new Promise(resolve => { finish = resolve; }); submit(); await settle(); const area = dom();
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  window.dispatchEvent(new Event('blur')); finish(data({ ...item, email: 'staff@example.test' })); await settle();
  expect(area.hidden).toBe(true); expect(button('restore').props.disabled).toBe(false); expect(posts).toHaveLength(1); click('restore'); await settle();
  expect(text(render())).toContain(t('en', 'success')); expect(posts).toHaveLength(1);
});
it('actual authenticated identity transport 401 triggers shared concealment and same-identity restoration is explicit', async () => {
  await ready(); const area = dom(), event = vi.fn(); window.addEventListener('hon:session-invalidated', event); identityStatus = 401; click('verify'); await settle();
  expect(event).toHaveBeenCalledOnce(); expect(area.hidden).toBe(true); expect(text(render())).not.toContain(item.email); expect(text(render())).toContain(t('en', 'SESSION'));
  identityStatus = 200; expect(posts).toHaveLength(0); click('restore'); await settle(); expect(text(render())).toContain(item.email);
});
it('403 remains a local denial and never broadcasts session invalidation', async () => {
  await ready(); const event = vi.fn(); window.addEventListener('hon:session-invalidated', event); list = async () => Response.json({ code: 'ACCOUNT_FORBIDDEN' }, { status: 403 }); click('verify'); await settle();
  expect(event).not.toHaveBeenCalled(); expect(text(render())).not.toContain(item.email); expect(text(render())).toContain(t('en', 'DENIED'));
});
it('a silent identity switch during the POST never reveals its receipt or private handoff', async () => {
  await prepare(); let finish!: (r: Response) => void; send = () => new Promise(resolve => { finish = resolve; }); submit(); await settle(); subject = 'manager-b'; finish(data({ ...item, email: 'staff@example.test' })); await settle();
  expect(text(render())).toContain(t('en', 'IDENTITY')); expect(text(render())).not.toContain(t('en', 'success')); expect(nodes(render()).some(n => n.type === 'button' && text(n) === t('en', 'show'))).toBe(false);
  subject = 'manager-a'; click('restore'); await settle(); expect(text(render())).toContain(t('en', 'unknown')); expect(posts).toHaveLength(1);
});
it('an unmounted preparatory read cannot broadcast a late real-transport 401 into a replacement session', async () => {
  await prepare(); let finish!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { finish = r; })); const event = vi.fn(); window.addEventListener('hon:session-invalidated', event);
  submit(); await settle(); const signal = vi.mocked(fetch).mock.calls.at(-1)![1]!.signal as AbortSignal;
  for (const v of h.values) v?.cleanup?.(); expect(signal.aborted).toBe(true); finish(Response.json({ code: 'SIGN_IN_REQUIRED' }, { status: 401 })); await settle();
  expect(event).not.toHaveBeenCalled(); expect(posts).toHaveLength(0); expect(text(render())).not.toContain(t('en', 'success'));
});
it('presentation and language changes do not read invitation data or dispatch commands', async () => {
  await ready(); const count = vi.mocked(fetch).mock.calls.length; click('classic'); render(); h.language = 'ko'; render(); click('big'); render(); h.language = 'es'; render();
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(count); expect(posts).toHaveLength(0); expect(text(render())).toContain(t('es', 'title'));
});
