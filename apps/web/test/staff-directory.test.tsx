import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The same minimal hook harness as the mass-promotion test: no DOM, deterministic re-renders.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; if (!(i in hooks.cells)) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { (hooks.cells[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
const api = vi.hoisted(() => ({ staff: vi.fn(), scope: null as null | { organizationId: string; schoolId: string } }));
vi.mock('../src/components/school-pickers/http', async () => {
  const actual = await vi.importActual<typeof import('../src/components/school-pickers/http')>('../src/components/school-pickers/http');
  return { ...actual, pickerApi: { ...actual.pickerApi, staff: api.staff } };
});
vi.mock('../src/components/school-shell/page-school', () => ({ useShellSchool: () => api.scope }));
import { STAFF_CARD_LINKS, StaffDirectory } from '../src/components/staff-directory/staff-directory';
import { PickerError } from '../src/components/school-pickers/http';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const PEOPLE = [{ principalId: id('a'), displayName: 'Ana Rivera' }, { principalId: id('b'), displayName: 'Ben Okafor' }, { principalId: id('c'), displayName: 'Cy Rivera' }];

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element | null { hooks.cursor = 0; const tree = StaffDirectory() as Element | null; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const cell of hooks.cells) if (cell && typeof cell === 'object' && 'cleanup' in cell) (cell as { cleanup?: () => void }).cleanup?.(); }
const all = () => elements(render());
const person = (n: string) => all().find(e => e.props['data-person'] === id(n));
const card = () => all().find(e => e.props['data-staff-card'] === '');
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
async function loaded(): Promise<void> { render(); await settle(); }

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; api.staff.mockReset(); api.scope = scope; });
afterEach(() => { unmount(); vi.restoreAllMocks(); });

describe('Staff list with a slide-out card per person (L5)', () => {
  it('renders nothing and reads nothing before the shell verified a school', () => {
    api.scope = null;
    expect(render()).toBeNull();
    expect(api.staff).not.toHaveBeenCalled();
  });

  it('opens on everyone with a role here, by name, from one read; no IDs shown', async () => {
    api.staff.mockResolvedValue(PEOPLE);
    await loaded();
    expect(api.staff).toHaveBeenCalledTimes(1);
    expect(api.staff.mock.calls[0]!.slice(0, 2)).toEqual([scope, 'roles']);
    const copy = text(render());
    expect(copy).toContain('Your staff (3)');
    for (const p of PEOPLE) { expect(copy).toContain(p.displayName); expect(copy).not.toContain(p.principalId); }
    expect(copy).not.toContain(scope.schoolId);
    expect(card()).toBeUndefined();
  });

  it('falls through to the next staff screen this person manages when one is denied', async () => {
    api.staff.mockRejectedValueOnce(new PickerError('DENIED')).mockResolvedValueOnce(PEOPLE);
    await loaded();
    expect(api.staff.mock.calls.map(call => call[1])).toEqual(['roles', 'availability']);
    expect(text(render())).toContain('Your staff (3)');
  });

  it('says the role does not include the list only when every staff screen is denied', async () => {
    api.staff.mockRejectedValue(new PickerError('DENIED'));
    await loaded();
    expect(api.staff.mock.calls.map(call => call[1])).toEqual(['roles', 'availability', 'qualifications']);
    const copy = text(render());
    expect(copy).toContain('Your role does not include the staff list');
    expect(copy).not.toContain('could not be loaded');
  });

  it('stops at the first failure that is not a denial and asks for a reload', async () => {
    api.staff.mockRejectedValueOnce(new PickerError('UNAVAILABLE'));
    await loaded();
    expect(api.staff).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain('Staff could not be loaded');
  });

  it('an empty school points to Invite below', async () => {
    api.staff.mockResolvedValue([]);
    await loaded();
    const copy = text(render());
    expect(copy).toContain('Your staff (0)');
    expect(copy).toContain('Invite your first staff member below');
    expect(all().find(e => e.props.name === 'staffSearch')).toBeUndefined();
  });

  it('Find a person filters by name, ignoring case and spaces', async () => {
    api.staff.mockResolvedValue(PEOPLE);
    await loaded();
    all().find(e => e.props.name === 'staffSearch')!.props.onChange({ target: { value: '  rivera ' } });
    expect([person('a'), person('b'), person('c')].map(Boolean)).toEqual([true, false, true]);
    all().find(e => e.props.name === 'staffSearch')!.props.onChange({ target: { value: 'zed' } });
    expect(text(render())).toContain('No one matches.');
    expect(person('a')).toBeUndefined();
  });

  it('a name opens the card with the four staff jobs; the same name or Close shuts it', async () => {
    api.staff.mockResolvedValue(PEOPLE);
    await loaded();
    person('b')!.props.onClick();
    expect(person('b')!.props['aria-expanded']).toBe(true);
    expect(person('a')!.props['aria-expanded']).toBe(false);
    const open = card()!;
    expect(open.props['aria-label']).toBe('Ben Okafor, staff card');
    expect(text(open)).toContain('pick Ben Okafor there');
    expect(text(open)).not.toContain(id('b'));
    const links = elements(open).filter(e => e.type === 'a').map(e => [e.props.href, text(e)]);
    expect(links).toEqual(STAFF_CARD_LINKS.map(l => [l.href, l.label]));
    expect(links.map(l => l[0])).toEqual(['/staff/roles', '/staff/team/availability', '/staff/instructor-qualifications', '/staff/documents']);
    for (const [href] of links) expect(href).not.toMatch(/[?#]/);
    person('a')!.props.onClick();
    expect(card()!.props['aria-label']).toBe('Ana Rivera, staff card');
    person('a')!.props.onClick();
    expect(card()).toBeUndefined();
    person('c')!.props.onClick();
    all().find(e => e.type === 'button' && text(e) === 'Close')!.props.onClick();
    expect(card()).toBeUndefined();
  });

  it('a list at the 200-row cap shows 200+, not an understated count (review P3)', async () => {
    api.staff.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ principalId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, displayName: `Person ${i}` })));
    await loaded();
    expect(text(render())).toContain('Your staff (200+)');
    api.staff.mockReset(); hooks.cells = []; hooks.effects = [];
    api.staff.mockResolvedValue(PEOPLE.slice(0, 2));
    await loaded();
    expect(text(render())).toContain('Your staff (2)');
  });

  it('aria-controls names the card only while that card is open (review P3)', async () => {
    api.staff.mockResolvedValue(PEOPLE);
    await loaded();
    expect(person('a')!.props['aria-controls']).toBeUndefined();
    person('a')!.props.onClick();
    expect(person('a')!.props['aria-controls']).toBe('staff-card');
    expect(person('b')!.props['aria-controls']).toBeUndefined();
    expect(card()!.props.id).toBe('staff-card');
    expect(all().find(e => e.type === 'button' && text(e) === 'Close')!.props.id).toBe('staff-card-close');
  });

  it('a late answer after unmount changes nothing', async () => {
    let resolve!: (value: unknown) => void;
    api.staff.mockReturnValue(new Promise(r => { resolve = r; }));
    render();
    unmount();
    resolve(PEOPLE); await settle();
    expect(text(render())).not.toContain('Your staff (3)');
  });
});
