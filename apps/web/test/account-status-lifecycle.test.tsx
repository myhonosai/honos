import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], language: 'en' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language } }) }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (fn: () => any, deps: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) { old?.cleanup?.(); h.values[i] = { deps }; h.effects.push(() => { h.values[i].cleanup = fn(); }); } },
}; });
import { SchoolAccountStatus } from '../src/components/account-status/workbench';
import { accountText as t } from '../src/components/account-status/copy';
import type { AccountInitialSelectors } from '../src/components/account-status/selectors';
import { id, scope, rawAccount, rawStanding, rawWallet, reply } from './account-status-fixtures';
type E = ReactElement<Record<string, any>>;
const nodes = (n: unknown): E[] => Array.isArray(n) ? n.flatMap(nodes) : React.isValidElement(n) ? [n as E, ...nodes((n as E).props.children)] : [];
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join(' ') : React.isValidElement(n) ? text((n as E).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
function render(initial: AccountInitialSelectors = {}) { h.cursor = 0; const tree = SchoolAccountStatus({ sessionSubject: 'owner-a', ...initial }); h.effects.splice(0).forEach(run => run()); return tree; }
const byId = (key: string) => nodes(render()).find(node => node.props['data-testid'] === key)!;
const change = (key: string, value: string) => byId(key).props.onChange({ target: { value } });
const click = (key: string) => byId(key).props.onClick();
const settle = async () => { for (let i = 0; i < 95; i++) await Promise.resolve(); render(); };
const dom = () => { const area = { hidden: false, inert: false, querySelectorAll: () => [] }; byId('account-private').props.ref.current = area; return area; };
let subject: string, identityStatus: number, accountReply: () => Promise<Response>, standingReply: () => Promise<Response>, walletReply: () => Promise<Response>;
beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = []; h.language = 'en'; subject = 'owner-a'; identityStatus = 200;
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  accountReply = async () => reply(rawAccount(true)); standingReply = async () => reply(rawStanding()); walletReply = async () => reply(rawWallet());
  vi.stubGlobal('fetch', vi.fn(async (path: string, options: RequestInit) => {
    if (path === '/api/identity/me') return identityStatus === 200 ? reply({ externalSubject: subject }) : reply({}, identityStatus);
    expect(options.method).toBe('GET');
    if (path.endsWith('/access-standing')) return standingReply(); if (path.endsWith('/creative-credits')) return walletReply(); if (path.endsWith('/hon-billing')) return accountReply(); throw Error('Unexpected route');
  }));
});
afterEach(() => { for (const value of h.values) value?.cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function billing() { render({ initialSchoolId: scope.schoolId }); click('account-read-billing'); await settle(); }
it('keeps school-only navigation inert, preserves normal input lifetime, and requires deliberate reads', async () => {
  render({ initialSchoolId: scope.schoolId }); expect(byId('account-school').props.value).toBe(scope.schoolId); expect(byId('account-org').props.value).toBe(''); expect(fetch).not.toHaveBeenCalled();
  const key = byId('account-private').key; change('account-org', scope.organizationId); expect(byId('account-private').key).toBe(key); expect(fetch).not.toHaveBeenCalled();
  click('account-read-billing'); await settle(); expect(text(render())).toContain('PRIVATE organization'); expect(text(render())).toContain(t('en', 'proposed'));
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/creative-credits'))).toBe(false);
});
it('keeps suspended billing visible after an independently denied wallet read without a reporting request', async () => {
  await billing(); walletReply = async () => reply({}, 403); click('account-read-wallet'); await settle();
  expect(text(byId('account-card'))).toContain('PRIVATE organization'); expect(text(byId('standing-card'))).toContain(t('en', 'recovery')); expect(text(byId('wallet-card'))).toContain(t('en', 'deniedCard'));
  expect(vi.mocked(fetch).mock.calls.every(([path]) => path === '/api/identity/me' || String(path).startsWith(`/api/v1/schools/${scope.schoolId}/`))).toBe(true);
});
it('shows returned creative grants, held credits and consumption without inferring the static monthly allowance', async () => {
  const raw = rawWallet(); walletReply = async () => reply({ ...raw, walletVersion: 1, program: { ...raw.program, status: 'ACTIVE' },
    eligibility: { eligible: true, reason: null, window: { index: 0, startsAt: '2026-11-05T00:00:00.000Z', endsAt: '2026-12-05T00:00:00.000Z' } },
    balance: { availableCredits: 317, heldCredits: 19, byKind: raw.balance.byKind.map((kind, i) => i === 1 ? { ...kind, grantedCredits: 419, availableCredits: 317, heldCredits: 19, consumedCredits: 83 } : kind) } });
  render({ initialSchoolId: scope.schoolId }); click('account-read-wallet'); await settle(); const wallet = text(byId('wallet-card'));
  for (const number of ['317', '419', '19', '83']) expect(wallet).toContain(number); expect(wallet).not.toContain('12,000'); expect(wallet).not.toContain('12000');
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/hon-billing'))).toBe(false);
});
it.each(['blur', 'pagehide', 'hidden', 'hon:school-context-changed'])('%s immediately conceals/inerts facts and remounts blank selectors only after explicit identity restoration', async event => {
  await billing(); const area = dom(), key = byId('account-private').key, count = vi.mocked(fetch).mock.calls.length;
  if (event === 'hidden') { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
  else window.dispatchEvent(new Event(event));
  expect(area.hidden).toBe(true); expect(area.inert).toBe(true); expect(text(render())).not.toContain('PRIVATE organization'); expect(byId('account-private').key).not.toBe(key); expect(fetch).toHaveBeenCalledTimes(count);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); click('account-restore'); await settle();
  expect(byId('account-school').props.value).toBe(''); expect(byId('account-org').props.value).toBe(''); expect(text(render())).not.toContain('PRIVATE organization');
  expect(vi.mocked(fetch).mock.calls.slice(count).map(([path]) => path)).toEqual(['/api/identity/me']);
  change('account-school', scope.schoolId); click('account-read-billing'); await settle(); expect(text(render())).toContain('PRIVATE organization');
});
it.each([401, 403])('a pending account read returning late HTTP %i cannot repaint facts or invalidate the replacement session', async status => {
  let finish!: (response: Response) => void; accountReply = () => new Promise(resolve => { finish = resolve; });
  render({ initialSchoolId: scope.schoolId }); click('account-read-billing'); await settle(); const area = dom(), invalidation = vi.fn(); window.addEventListener('hon:session-invalidated', invalidation);
  const read = vi.mocked(fetch).mock.calls.find(([path]) => String(path).endsWith('/hon-billing'))!; window.dispatchEvent(new Event('blur')); expect(read[1]!.signal!.aborted).toBe(true);
  finish(reply({}, status)); await settle(); expect(area.hidden).toBe(true); expect(text(render())).not.toContain('PRIVATE organization'); expect(invalidation).not.toHaveBeenCalled();
});
it('domain403 after a silent identity switch conceals all prior billing facts and requires a new authenticated page', async () => {
  await billing(); const area = dom(); walletReply = async () => { subject = 'other-owner'; return reply({}, 403); }; click('account-read-wallet'); await settle();
  expect(area.hidden).toBe(true); expect(text(render())).toContain(t('en', 'IDENTITY')); expect(byId('account-restore')).toBeUndefined(); expect(text(render())).not.toContain('PRIVATE organization');
  window.dispatchEvent(new Event('blur')); expect(text(render())).toContain(t('en', 'IDENTITY'));
});
it('live billing403 clears revoked billing facts while preserving a separately authorized wallet', async () => {
  await billing(); click('account-read-wallet'); await settle(); accountReply = standingReply = async () => reply({}, 403); click('account-read-billing'); await settle();
  expect(text(byId('account-card'))).toContain(t('en', 'deniedCard')); expect(text(byId('standing-card'))).toContain(t('en', 'deniedCard')); expect(text(render())).not.toContain('PRIVATE organization'); expect(text(byId('wallet-card'))).toContain(t('en', 'readyCard'));
});
it('confirmed401 and shared session invalidation are terminal and immediately conceal the whole private form', async () => {
  await billing(); const area = dom(); identityStatus = 401; click('account-read-wallet'); await settle();
  expect(area.hidden).toBe(true); expect(area.inert).toBe(true); expect(text(render())).toContain(t('en', 'SESSION')); expect(byId('account-restore')).toBeUndefined();
  window.dispatchEvent(new Event('hon:session-invalidated')); expect(text(render())).not.toContain('PRIVATE organization');
});
it('effect cleanup/reactivation publishes the retired controller revision and permits explicit blank-selector recovery', async () => {
  render({ initialSchoolId: scope.schoolId }); const effect = h.values.find(value => typeof value?.cleanup === 'function');
  effect.cleanup(); effect.deps = []; render(); await settle();
  expect(byId('account-restore')).toBeDefined(); expect(fetch).not.toHaveBeenCalled(); click('account-restore'); await settle();
  expect(byId('account-school').props.value).toBe(''); expect(byId('account-org').props.value).toBe('');
  expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(['/api/identity/me']);
});
it('scope edits retire stale read callbacks and later query props cannot silently replace the selected school', async () => {
  await billing(); const retained = byId('account-read-wallet').props.onClick, count = vi.mocked(fetch).mock.calls.length;
  change('account-school', id(99)); retained(); await settle(); expect(fetch).toHaveBeenCalledTimes(count); expect(text(render())).not.toContain('PRIVATE organization');
  render({ initialSchoolId: scope.schoolId, initialOrganizationId: scope.organizationId }); expect(byId('account-school').props.value).toBe(id(99)); expect(fetch).toHaveBeenCalledTimes(count);
});
it.each(['en', 'ko', 'es'])('%s supports all three presentation modes without extra reads or commercial controls', async language => {
  h.language = language; await billing(); const count = vi.mocked(fetch).mock.calls.length;
  for (const mode of ['modern', 'classic', 'big'] as const) {
    const button = nodes(render()).find(node => node.type === 'button' && text(node) === t(language, mode))!; button.props.onClick(); expect((render() as E).props['data-interface-theme']).toBe(mode);
  }
  expect(fetch).toHaveBeenCalledTimes(count); expect(text(render())).toContain(t(language, 'agentTitle'));
  expect(nodes(render()).filter(node => node.type === 'a').some(node => node.props.href === '/staff/subscription')).toBe(false);
  expect(text(render())).not.toContain('12,000'); expect(text(render())).not.toContain('12000');
});
