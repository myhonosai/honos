import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal hook harness (as in the staff directory test): no DOM, deterministic re-renders.
const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = initial; return [hooks.cells[i], (value: unknown) => { hooks.cells[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.cells[i]) : value; }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = { current: initial }; return hooks.cells[i]; },
    // An effect that has not run yet takes the latest render's closure (as React runs it after the last render).
    useEffect: (effect: () => (() => void) | void) => { const i = hooks.cursor++; const cell = hooks.cells[i] as { setup: typeof effect; ran?: boolean; cleanup?: (() => void) | undefined } | undefined;
      if (!cell) { hooks.cells[i] = { setup: effect }; hooks.effects.push(() => { const c = hooks.cells[i] as { setup: typeof effect; ran?: boolean; cleanup?: (() => void) | undefined }; c.ran = true; c.cleanup = c.setup() || undefined; }); }
      else if (!cell.ran) cell.setup = effect; },
  };
});
const shell = vi.hoisted(() => ({ scope: { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' } }));
vi.mock('../src/components/school-shell/page-school', () => ({
  useShellSchool: () => shell.scope,
  // Copies the shell school into the page fields on first render, like the real effect.
  useShellSchoolInto: (apply: (s: typeof shell.scope) => void) => { const ref = (hooks as unknown as { applied?: boolean }); if (!ref.applied) { ref.applied = true; apply(shell.scope); } return shell.scope; },
  ManualSchoolFields: ({ children }: { children: React.ReactNode }) => children,
}));
import { StaffRoleAdmin, roleCodeFrom } from '../src/components/staff-role-admin';
import { groupPermissions, labelOf, verifyAssignablePermissions, PERMISSION_LIST_LIMIT } from '../src/components/staff-permissions/catalog';

const base = `/api/v1/organizations/${shell.scope.organizationId}/schools/${shell.scope.schoolId}/staff-roles`;
const P = (code: string, description = `Stored ${code}`, sensitive = false) => ({ code, description, sensitive });
const OFFERED = [P('school.view'), P('attendance.record'), P('attendance.cards.manage', 'Choose how attendance cards look', true), P('crm.lead.read'), P('teaching.studio.read', 'Open the teaching studio')];
const ROLE = { id: '33333333-3333-4333-8333-333333333333', code: 'CUSTOM_FRONT_DESK', name: 'Front desk', version: 2, permissionCodes: ['billing.refund.create', 'crm.lead.read', 'school.view'] };

type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const e = node as Element; return [e, ...elements(e.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { hooks.cursor = 0; StaffRoleAdmin(); hooks.cursor = 0; const tree = StaffRoleAdmin() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
const all = () => elements(render());
const box = (code: string) => all().find(e => e.props.name === `permission-${code}`);
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const json = (data: unknown, status = 200) => Response.json(status < 400 ? { data, meta: {} } : { detail: 'no' }, { status });
let posts: { url: string; body: any }[] = [];
function serve(permissions: () => Response = () => json(OFFERED)) {
  posts = [];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body)) }); return json({ ok: true }); }
    if (url === `${base}/lists`) return json({ roles: [ROLE], grants: [] });
    if (url === `${base}/permissions`) return permissions();
    return json(null, 404);
  });
}
async function opened(): Promise<void> { render(); await settle(); }

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; hooks.effects = []; (hooks as unknown as { applied?: boolean }).applied = false; });
afterEach(() => { vi.restoreAllMocks(); });

describe('Roles & permissions: a checklist instead of typed codes (0412)', () => {
  it('opens on the signed-in school and shows what this manager can give, grouped by area in plain words', async () => {
    const fetcher = serve(); await opened();
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual([`${base}/lists`, `${base}/permissions`]);
    const list = all().find(e => e.props['data-permission-checklist'] === '')!;
    expect(elements(list).filter(e => e.type === 'fieldset').map(e => e.props['data-area'])).toEqual(['general', 'attendance', 'leads', 'ranks']);
    const attendance = text(elements(list).find(e => e.props['data-area'] === 'attendance'));
    expect(attendance).toContain('Take attendance, including scan check-in');
    expect(attendance).toContain('Attendance cards: choose the look, print, cancel, record photo consent');
    expect(attendance).toContain('sensitive');
    expect(text(list)).toContain('Open the teaching studio'); // no plain label yet: the stored description shows
    expect(text(list)).not.toMatch(/attendance\.record|CUSTOM_/);
    expect(all().some(e => e.type === 'textarea')).toBe(false);
    expect(box('school.view')!.props.checked).toBe(true);
  });

  it('makes a role from a name and ticked boxes: the code comes from the name, only offered codes are sent', async () => {
    serve(); await opened();
    all().find(e => e.props.placeholder === 'Front desk')!.props.onChange({ target: { value: 'Card desk' } });
    box('attendance.record')!.props.onChange({ target: { checked: true } });
    box('attendance.cards.manage')!.props.onChange({ target: { checked: true } });
    box('school.view')!.props.onChange({ target: { checked: false } });
    all().find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(posts).toEqual([{ url: `${base}/custom`, body: { code: 'CUSTOM_CARD_DESK', name: 'Card desk', permissionCodes: ['attendance.record', 'attendance.cards.manage'] } }]);
  });

  it('editing a role keeps the permissions this manager cannot give, unchanged, and says so', async () => {
    serve(); await opened();
    all().find(e => e.type === 'button' && text(e).startsWith('Front desk'))!.props.onClick();
    expect(box('crm.lead.read')!.props.checked).toBe(true);
    expect(text(all().find(e => e.props['data-kept-permissions'] === ''))).toContain('Give refunds');
    box('crm.lead.read')!.props.onChange({ target: { checked: false } });
    box('attendance.record')!.props.onChange({ target: { checked: true } });
    all().find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(`${base}/custom/${ROLE.id}/update`);
    expect(posts[0]!.body).toEqual({ name: 'Front desk', permissionCodes: ['billing.refund.create', 'school.view', 'attendance.record'], expectedVersion: 2 });
  });

  it('nothing ticked is refused on the page, before any request', async () => {
    serve(); await opened();
    all().find(e => e.props.placeholder === 'Front desk')!.props.onChange({ target: { value: 'Empty' } });
    box('school.view')!.props.onChange({ target: { checked: false } });
    all().find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(posts).toEqual([]);
    expect(text(render())).toContain('Tick at least one permission.');
  });

  it('if the permission list cannot be read, the typed list stays as a fallback and the rest of the page works', async () => {
    serve(() => json(null, 500)); await opened();
    expect(all().some(e => e.type === 'textarea')).toBe(true);
    expect(text(render())).toContain('The permission list could not be loaded');
    expect(text(render())).not.toContain('could not be done');
    expect(all().some(e => e.type === 'button' && text(e).startsWith('Front desk'))).toBe(true);
  });
});

describe('permission list check and labels', () => {
  it('leaves out odd rows instead of failing the whole list, and refuses a bad envelope', () => {
    const rows = verifyAssignablePermissions([P('school.view'), { ...P('x.y'), extra: 1 }, P('hq.billing.manage'), P('NotCode'), P('school.view'), P('a.b', ''), 'junk', P('attendance.record')]);
    expect(rows.map(r => r.code)).toEqual(['school.view', 'attendance.record']);
    expect(() => verifyAssignablePermissions({ permissions: [] })).toThrow();
    expect(() => verifyAssignablePermissions(Array.from({ length: PERMISSION_LIST_LIMIT + 1 }, (_, i) => P(`area.p${i}`)))).toThrow();
  });

  it('groups in menu order with Other last, and labels fall back to the stored description', () => {
    const groups = groupPermissions([P('zeta.thing'), P('billing.refund.create'), P('school.view'), P('attendance.record')]);
    expect(groups.map(g => g.label)).toEqual(['General', 'Attendance', 'Finance', 'Other']);
    expect(labelOf(P('zeta.thing', 'Something new'))).toBe('Something new');
  });

  it('makes a valid role code from any name', () => {
    expect(roleCodeFrom('Front desk')).toBe('CUSTOM_FRONT_DESK');
    expect(roleCodeFrom('  café helper! ')).toBe('CUSTOM_CAFE_HELPER');
    expect(roleCodeFrom('2nd shift')).toBe('CUSTOM_ROLE_2ND_SHIFT');
    for (const name of ['사범', 'x', 'A'.repeat(120), '---']) expect(roleCodeFrom(name)).toMatch(/^CUSTOM_[A-Z][A-Z0-9_]{1,47}$/);
  });
});
