import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], next: null as string | null }));
vi.mock('../src/components/school-shell/page-school', () => ({ useShellSchool: () => ({ organizationId: '00000000-0000-4000-8000-000000000001', schoolId: '00000000-0000-4000-8000-000000000002' }) }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' }, date: (v: unknown) => String(v), number: (v: unknown) => String(v) }) }));
vi.mock('../src/components/membership-list/http', async importOriginal => ({ ...(await importOriginal<object>()),
  membershipListApi: { page: async () => ({ items: [], nextCursor: h.next, schoolTimezone: 'UTC', localToday: '2026-11-17' }) } }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v; }]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => any, deps?: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || !deps || deps.some((v, j) => v !== old.deps[j])) { h.values[i] = { deps: deps ?? [] }; h.effects.push(() => { h.values[i].cleanup = fn(); }); } },
}; });
import { MembershipDatesWorkbench } from '../src/components/membership-dates-workbench';
type E = ReactElement<Record<string, any>>;
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join(' ') : React.isValidElement(n) ? (typeof n.type === 'function' ? text((n.type as (p: unknown) => unknown)((n as E).props)) : text((n as E).props.children)) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
function render() { h.cursor = 0; const tree = MembershipDatesWorkbench({ sessionSubject: 'synthetic-staff' }); h.effects.splice(0).forEach(run => run()); return tree; }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); };
const HINT = 'Showing the first 50 memberships. Enter the membership ID for others.';
beforeEach(() => { h.values = []; h.cursor = 0; h.effects = []; vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); });
afterEach(() => { vi.unstubAllGlobals(); });
it('says the member list is only the first page when more memberships exist', async () => {
  h.next = 'cursor-2'; render(); await settle(); expect(text(render())).toContain(HINT);
});
it('shows no hint when every membership is listed', async () => {
  h.next = null; render(); await settle(); expect(text(render())).not.toContain(HINT);
});
