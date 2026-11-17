import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], events: {} as Record<string, () => void>, visibility: 'visible',
  shell: null as null | { organizationId: string; schoolId: string } }));
vi.mock('../src/components/school-shell/page-school', () => ({ useShellSchool: () => h.shell }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (fn: () => any, deps?: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || !deps || deps.some((v, j) => v !== old.deps[j])) { h.values[i] = { deps: deps ?? [] }; h.effects.push(() => { h.values[i].cleanup = fn(); }); } },
}; });
import { OwnerLaunch } from '../src/components/owner-launch';
type E = ReactElement<Record<string, any>>;
const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const context = { organizationId: id('1'), schoolId: id('2'), schoolName: 'Sunrise Dojo', tier: 'ESSENTIAL', program: null, classSession: null, registration: null, guardianChildRegistration: null };
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) }) as Response;
const nodes = (n: unknown): E[] => Array.isArray(n) ? n.flatMap(nodes) : React.isValidElement(n) ? [n as E, ...nodes((n as E).props.children)] : [];
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join(' ') : React.isValidElement(n) ? text((n as E).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
function render() { h.cursor = 0; const tree = OwnerLaunch(); h.effects.splice(0).forEach(run => run()); return tree; }
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); render(); };
const launchReads = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.filter(([path]) => path === '/api/v1/owner-launch').length;
let fetch: { mock: { calls: unknown[][] } };
beforeEach(() => {
  h.values = []; h.cursor = 0; h.effects = []; h.events = {}; h.visibility = 'visible'; h.shell = null;
  const add = (name: string, fn: () => void) => { h.events[name] = fn; };
  vi.stubGlobal('window', { addEventListener: add, removeEventListener: () => {} });
  vi.stubGlobal('document', { addEventListener: add, removeEventListener: () => {}, get visibilityState() { return h.visibility; } });
  fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async path => response(path === '/api/v1/owner-launch' ? context
    : path === '/api/v1/owner-launch/first-class-booking-context' ? { state: 'NO_RECORDED_BOOKING', context: null } : { state: 'NO_RECORDED_DRAFT', receipt: null }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('outside the shell waits for the owner to load', async () => {
  render(); await settle(); expect(launchReads(fetch)).toBe(0);
  expect(nodes(render()).some(n => n.type === 'button' && text(n) === 'Load / refresh saved receipts')).toBe(true);
});
it('inside the shell loads the signed-in school by itself, hides its ID and reloads on return', async () => {
  h.shell = { organizationId: id('1'), schoolId: id('2') }; render(); await settle();
  expect(launchReads(fetch)).toBe(1);
  const page = text(render()); expect(page).toContain('Sunrise Dojo'); expect(page).toContain('1. Your school'); expect(page).not.toContain(id('2'));
  expect(page).not.toContain('Load your verified school context'); expect(nodes(render()).some(n => n.type === 'button' && text(n) === 'Refresh')).toBe(true);
  h.visibility = 'hidden'; h.events.visibilitychange!(); await settle(); expect(launchReads(fetch)).toBe(1);
  h.visibility = 'visible'; h.events.focus!(); await settle(); expect(launchReads(fetch)).toBe(2); expect(text(render())).toContain('Sunrise Dojo');
});
