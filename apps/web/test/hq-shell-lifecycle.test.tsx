import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';

// Review [18] (HQ shell part): one overview read is current at a time, a newer check aborts the older one, and a
// session end aborts the read and retires the overview, the HON assistant and any draft. A small hook runner drives
// the real shell and reads the tree it returns.
type Frame = { values: unknown[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ frame: null as Frame | null, path: '/hq/revenue', load: null as null | ((signal?: AbortSignal) => Promise<unknown>) }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [f.values[i], (v: unknown) => { f.values[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(f.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i]; },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { deps?: unknown[]; cleanup?: () => void } | undefined;
    if (!old || !deps || deps.some((v, j) => v !== old.deps?.[j])) { const slot: { deps: unknown[] | undefined; cleanup?: () => void } = { deps }; old?.cleanup?.(); f.values[i] = slot;
      f.effects.push(() => { const c = effect(); if (typeof c === 'function') slot.cleanup = c; }); } },
}; });
vi.mock('next/navigation', () => ({ usePathname: () => hooks.path }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => React.createElement('a', props) }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ t: (s: string) => s, text: (s: string) => s, number: String, money: String, date: String, formattingLocale: 'en', preferences: { language: 'en' } }) }));
vi.mock('../src/components/hq-modern/assistant', () => ({ HonAssistant: () => React.createElement('aside', { 'data-testid': 'assistant' }) }));
vi.mock('../src/components/calls/phone-panel', () => ({ HqPhone: () => React.createElement('span', { 'data-testid': 'hq-phone' }) }));
vi.mock('../src/components/hq-overview-http', async () => { const actual = await vi.importActual<typeof import('../src/components/hq-overview-http')>('../src/components/hq-overview-http');
  return { ...actual, loadHqOverview: (signal?: AbortSignal) => hooks.load!(signal) }; });
import { HqModernShell } from '../src/components/hq-modern/shell';

type Element = ReactElement<Record<string, any>>;
function elements(n: unknown): Element[] { if (Array.isArray(n)) return n.flatMap(elements); return React.isValidElement(n) ? [n as Element, ...elements((n as Element).props.children)] : []; }
function text(n: unknown): string { if (Array.isArray(n)) return n.map(text).join(''); return React.isValidElement(n) ? text((n as Element).props.children) : typeof n === 'string' ? n : ''; }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const CHILD = <section data-testid="page">Revenue page</section>;
const overview = (organizationCount: number) => ({ asOf: '2026-11-22T00:00:00.000Z', callerHqRole: 'OWNER', organizationCount });

function mount(path = '/hq/revenue') {
  hooks.path = path;
  const frame: Frame = { values: [], cursor: 0, effects: [] };
  const render = () => { hooks.frame = frame; frame.cursor = 0; const tree = HqModernShell({ children: CHILD }) as Element; frame.effects.splice(0).forEach((e) => e()); return tree; };
  return render;
}
const hasPage = (tree: Element) => elements(tree).some((e) => e.props['data-testid'] === 'page');
const provided = (tree: Element) => elements(tree).find((e) => e.props.value && 'overview' in (e.props.value as object))?.props.value as { overview: { organizationCount: number }; openAssistant: () => void; setDraft: (s: string) => void } | undefined;
const hasAssistant = (tree: Element) => elements(tree).some((e) => typeof e.type === 'function' && (e.type as { name?: string }).name === 'HonAssistant');
const button = (tree: Element, label: string) => elements(tree).find((e) => e.type === 'button' && text(e).includes(label))!;
const endSession = () => (window as unknown as EventTarget).dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));

beforeEach(() => { vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) }));
  vi.stubGlobal('document', { title: '', activeElement: null }); vi.stubGlobal('requestAnimationFrame', () => 0); vi.stubGlobal('HTMLElement', class {}); });
afterEach(() => { vi.unstubAllGlobals(); });

it('a session end retires the overview, the assistant and the draft, and opens no page', async () => {
  hooks.load = () => Promise.resolve(overview(3));
  const render = mount(); render(); await settle(); let tree = render();
  expect(hasPage(tree)).toBe(true);
  provided(tree)!.openAssistant(); provided(tree)!.setDraft('private question'); tree = render();
  expect(hasAssistant(tree)).toBe(true);
  endSession(); tree = render();
  expect(hasPage(tree)).toBe(false);
  expect(provided(tree)).toBeUndefined();
  expect(hasAssistant(tree)).toBe(false);
  expect(text(tree)).toContain('Sign in to verify HQ access.');
  // Checking again verifies a fresh overview; the assistant stays closed.
  hooks.load = () => Promise.resolve(overview(4));
  button(tree, 'Refresh HQ access').props.onClick(); tree = render(); await settle(); tree = render();
  expect(provided(tree)!.overview.organizationCount).toBe(4);
  expect(hasAssistant(tree)).toBe(false);
});

it('a read still out when the session ends is aborted and its late answer never lands', async () => {
  let late!: (v: unknown) => void; let seen: AbortSignal | undefined;
  hooks.load = (signal) => { seen = signal; return new Promise((ok) => { late = ok; }); };
  const render = mount(); render(); await settle();
  endSession(); let tree = render();
  expect(seen?.aborted).toBe(true);
  late(overview(9)); await settle(); tree = render();
  expect(hasPage(tree)).toBe(false);
  expect(provided(tree)).toBeUndefined();
  expect(text(tree)).toContain('Sign in to verify HQ access.');
});

it('a newer access check aborts the older read; only the newest answer can land', async () => {
  const pending: { signal: AbortSignal | undefined; ok: (v: unknown) => void }[] = [];
  hooks.load = (signal) => new Promise((ok) => { pending.push({ signal, ok }); });
  const render = mount(); let tree = render(); await settle(); tree = render();
  button(tree, 'Refresh HQ access').props.onClick(); tree = render(); await settle();
  expect(pending).toHaveLength(2);
  expect(pending[0]!.signal?.aborted).toBe(true);
  expect(pending[1]!.signal?.aborted).toBe(false);
  pending[1]!.ok(overview(2)); await settle(); tree = render();
  expect(provided(tree)!.overview.organizationCount).toBe(2);
  pending[0]!.ok(overview(1)); await settle(); tree = render();
  expect(provided(tree)!.overview.organizationCount).toBe(2);
});

it('the overview read carries the abort signal to fetch', async () => {
  const { loadHqOverview } = await vi.importActual<typeof import('../src/components/hq-overview-http')>('../src/components/hq-overview-http');
  const controller = new AbortController();
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 503 }));
  vi.stubGlobal('fetch', f);
  await expect(loadHqOverview(controller.signal)).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(1);
  expect(f.mock.calls[0]![1]?.signal).toBe(controller.signal);
});
