import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HqOverviewAccessError } from '../src/components/hq-overview-http';

// Review [17]: the shared HQ shell gated every page on the overview, so a current HQ support grant (which the support
// API and SQL permit) could not open Support. A small hook runner drives the real shell and reads the tree it returns.
type Frame = { values: unknown[]; cursor: number; effects: (() => void)[] };
const hooks = vi.hoisted(() => ({ frame: null as Frame | null, path: '/hq/support', load: null as null | ((signal?: AbortSignal) => Promise<unknown>) }));
vi.mock('react', async () => { const r = await vi.importActual<typeof import('react')>('react'); return { ...r,
  useState: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [f.values[i], (v: unknown) => { f.values[i] = typeof v === 'function' ? (v as (old: unknown) => unknown)(f.values[i]) : v; }]; },
  useRef: (initial: unknown) => { const f = hooks.frame!, i = f.cursor++; if (!(i in f.values)) f.values[i] = { current: initial }; return f.values[i]; },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => { const f = hooks.frame!, i = f.cursor++, old = f.values[i] as { deps?: unknown[] } | undefined;
    if (!old || !deps || deps.some((v, j) => v !== old.deps?.[j])) { f.values[i] = { deps }; f.effects.push(() => { effect(); }); } },
}; });
vi.mock('next/navigation', () => ({ usePathname: () => hooks.path }));
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => React.createElement('a', props) }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ t: (s: string) => s, text: (s: string) => s, number: String, money: String, date: String, formattingLocale: 'en' }) }));
vi.mock('../src/components/hq-overview-http', async () => { const actual = await vi.importActual<typeof import('../src/components/hq-overview-http')>('../src/components/hq-overview-http');
  return { ...actual, loadHqOverview: (signal?: AbortSignal) => hooks.load!(signal) }; });
import { HqModernShell, hqPageAuthorizesItself } from '../src/components/hq-modern/shell';

type Element = ReactElement<Record<string, any>>;
function elements(n: unknown): Element[] { if (Array.isArray(n)) return n.flatMap(elements); return React.isValidElement(n) ? [n as Element, ...elements((n as Element).props.children)] : []; }
function text(n: unknown): string { if (Array.isArray(n)) return n.map(text).join(''); return React.isValidElement(n) ? text((n as Element).props.children) : typeof n === 'string' ? n : ''; }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const CHILD = <section data-testid="page">Support page</section>;

async function shellAt(path: string, load: () => Promise<unknown>): Promise<Element> {
  hooks.path = path; hooks.load = load;
  const frame: Frame = { values: [], cursor: 0, effects: [] };
  const render = () => { hooks.frame = frame; frame.cursor = 0; const tree = HqModernShell({ children: CHILD }) as Element; frame.effects.splice(0).forEach((e) => e()); return tree; };
  render(); await settle(); return render();
}
const hasPage = (tree: Element) => elements(tree).some((e) => e.props['data-testid'] === 'page');
const denied = new HqOverviewAccessError('no overview', 403);

beforeEach(() => { vi.stubGlobal('window', Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) }));
  vi.stubGlobal('document', { title: '' }); });
afterEach(() => { vi.unstubAllGlobals(); });

it('an account the overview refuses can open Support and Texts & Email, whose own APIs decide its authority', async () => {
  for (const path of ['/hq/support', '/hq/support/00000000-0000-4000-8000-000000000001', '/hq/communications', '/hq/communications/00000000-0000-4000-8000-000000000002']) {
    const tree = await shellAt(path, () => Promise.reject(denied));
    expect(hasPage(tree), path).toBe(true);
    // No overview, and no HON assistant, is handed to a page opened without the overview.
    expect(elements(tree).some((e) => e.props.value && 'overview' in (e.props.value as object))).toBe(false);
    expect(text(tree)).not.toContain('Ask HON anywhere');
  }
});

it('every other HQ page still needs the overview: the refused account sees the denial with links to Support', async () => {
  for (const path of ['/hq', '/hq/revenue', '/hq/schools', '/hq/ai-providers', '/hq/communications/numbers', '/hq/support/not-a-case']) {
    const tree = await shellAt(path, () => Promise.reject(denied));
    expect(hasPage(tree), path).toBe(false);
    expect(text(tree)).toContain('This account has no current HQ authority for this page.');
    expect(elements(tree).some((e) => e.props.href === '/hq/support')).toBe(true);
  }
});

it('signed-out and unavailable overviews open no page at all, Support included', async () => {
  const signedOut = await shellAt('/hq/support', () => Promise.reject(new HqOverviewAccessError('sign in', 401)));
  expect(hasPage(signedOut)).toBe(false);
  expect(text(signedOut)).toContain('Sign in to verify HQ access.');
  const down = await shellAt('/hq/support', () => Promise.reject(new Error('down')));
  expect(hasPage(down)).toBe(false);
  expect(text(down)).toContain('The HQ overview could not be verified.');
  const loading = await shellAt('/hq/support', () => new Promise(() => {}));
  expect(hasPage(loading)).toBe(false);
});

it('the self-authorizing list is exact', () => {
  expect(['/hq/support', '/hq/communications'].every(hqPageAuthorizesItself)).toBe(true);
  for (const path of ['/hq', '/hq/supportx', '/hq/support/', '/hq/support/x/y', '/hq/communications/numbers', '/hq/schools', '/hq/communications?x=1']) expect(hqPageAuthorizesItself(path), path).toBe(false);
});
