import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #500 review P2: a search still waiting to run must never land after a privacy hide (session end or school change).
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useCallback: (fn: unknown) => { hooks.cursor++; return fn; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
const privacy = vi.hoisted(() => ({ conceal: null as null | (() => void) }));
vi.mock('../src/components/school-shell/privacy', () => ({ onShellPrivacyEvent: (fn: () => void) => { privacy.conceal = fn; return () => { privacy.conceal = null; }; } }));
const scope = { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' };
vi.mock('../src/components/school-shell/context', () => ({ useSchoolShell: () => ({ phase: 'READY', selection: scope, schoolName: 'Sunrise' }) }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en', timeZone: 'UTC' }, date: (v: string) => v, formattingLocale: 'en-US' }) }));
const api = vi.hoisted(() => ({ list: vi.fn(), one: vi.fn() }));
vi.mock('../src/components/conversations/http', async () => {
  const actual = await vi.importActual<typeof import('../src/components/conversations/http')>('../src/components/conversations/http');
  return { ...actual, loadConversations: api.list, loadConversation: api.one };
});
import { StaffConversations } from '../src/components/conversations/staff-conversations';

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function render(): Element[] { hooks.cursor = 0; const tree = StaffConversations() as Element; hooks.effects.splice(0).forEach(run => run()); return elements(tree); }
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const searchBox = () => render().find(e => e.type === 'input' && e.props.type === 'search')!;

beforeEach(() => {
  hooks.cells = []; hooks.cursor = 0; hooks.effects = []; privacy.conceal = null; vi.useFakeTimers();
  api.list.mockReset().mockResolvedValue({ conversations: [], nextCursor: null, unreadConversations: 0, canManage: true }); api.one.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Texts > Conversations search timer', () => {
  it('a privacy hide inside the search wait stops the search: nothing loads and the inbox stays hidden', async () => {
    render(); await settle(); render();
    expect(api.list).toHaveBeenCalledTimes(1);
    searchBox().props.onChange({ target: { value: 'Ada' } });
    privacy.conceal!();
    vi.advanceTimersByTime(1000); await settle();
    expect(api.list).toHaveBeenCalledTimes(1);
    const html = render();
    expect(html.some(e => e.props['aria-label'] === 'Inbox' || e.type === 'section')).toBe(false);
    expect(html.some(e => typeof e.props.children === 'string' && /hidden/i.test(e.props.children))).toBe(true);
  });
  it('without a hide, the search runs once after the wait', async () => {
    render(); await settle(); render();
    searchBox().props.onChange({ target: { value: 'Ad' } });
    searchBox().props.onChange({ target: { value: 'Ada' } });
    vi.advanceTimersByTime(349); expect(api.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); await settle();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.list.mock.calls[1]![1]).toMatchObject({ search: 'Ada' });
  });
});
