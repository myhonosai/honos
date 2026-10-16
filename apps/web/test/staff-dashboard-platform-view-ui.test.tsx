import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (index >= hooks.cells.length) hooks.cells[index] = initial;
      return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks.cells[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (index >= hooks.cells.length) hooks.cells[index] = { current: initial };
      return hooks.cells[index];
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.cells[index] as { dependencies?: readonly unknown[]; cleanup?: () => void } | undefined;
      const changed = !previous || !dependencies || !previous.dependencies || dependencies.length !== previous.dependencies.length || dependencies.some((value, dependencyIndex) => value !== previous.dependencies![dependencyIndex]);
      if (!changed) return;
      previous?.cleanup?.();
      const cleanup = effect();
      hooks.cells[index] = { dependencies, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    },
  };
});

import { StaffDashboard } from '../src/components/staff-dashboard';

const id = (value: string) => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const organizationId = id('1');
const schoolId = id('2');
const nextSchoolId = id('3');
const from = '2026-10-01T00:00:00.000Z';
const to = '2026-10-02T00:00:00.000Z';
const report = (currentSchoolId = schoolId) => ({
  organizationId, schoolId: currentSchoolId, generatedAt: to, from, to,
  studentProfiles: { total: 3 },
  leads: { byStatus: { OPEN: 4, WON: 1, LOST: 2, ARCHIVED: 0 } },
  classSessions: { inRange: { scheduled: 5, completed: 6, cancelled: 7 } },
  attendance: { inRangeByStatus: { PRESENT: 8, LATE: 9, EXCUSED_ABSENCE: 10, UNEXCUSED_ABSENCE: 11, MAKEUP: 12 } },
  memberships: { byState: { DRAFT: 0, ACTIVE: 13, FROZEN: 1, CANCELLATION_PENDING: 2, CANCELLED: 3, EXPIRED: 4 } },
  invoices: { inRangeByStatus: { DRAFT: 0, ISSUED: 5, PAID: 6, VOID: 7, UNCOLLECTIBLE: 8 } },
  paymentAttempts: { inRangeByState: { PENDING: 0, PROCESSING: 1, SUCCEEDED: 2, FAILED: 3, REQUIRES_ACTION: 4, UNKNOWN: 5, REFUNDED: 6 } },
});
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: 'id', correlationId: 'id' } }) }) as Response;
const reportPath = (currentSchoolId = schoolId) => `/api/v1/organizations/${organizationId}/schools/${currentSchoolId}/reports/operations`;
const themePath = (currentSchoolId = schoolId) => `/api/v1/organizations/${organizationId}/schools/${currentSchoolId}/interface-theme`;

type Props = Record<string, unknown>;
function elements(node: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Props>(node)) return [];
  if (typeof node.type === 'function') return [node, ...elements((node.type as (props: Props) => unknown)(node.props))];
  return [node, ...elements(node.props.children)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (React.isValidElement<Props>(node)) return typeof node.type === 'function' ? text((node.type as (props: Props) => unknown)(node.props)) : text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
function render(): React.ReactElement<Props> { hooks.cursor = 0; return StaffDashboard() as React.ReactElement<Props>; }
function input(index: number): React.ReactElement<Props> {
  const field = elements(render()).filter((element) => element.type === 'input')[index];
  expect(field).toBeDefined();
  return field!;
}
function fillVerifiedScope(currentSchoolId = schoolId): void {
  (input(0).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: organizationId } });
  (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: currentSchoolId } });
}
async function submit(): Promise<void> {
  const form = elements(render()).find((element) => element.type === 'form');
  expect(form).toBeDefined();
  await (form!.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
}
function pickerButton(label: string): React.ReactElement<Props> {
  const button = elements(render()).find((element) => element.type === 'button' && text(element).includes(label));
  expect(button).toBeDefined();
  return button!;
}

beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  vi.stubGlobal('crypto', { randomUUID: () => id('9') });
});
afterEach(() => vi.restoreAllMocks());

describe('Staff Dashboard verified Platform View selector', () => {
  it('is absent and performs no preference read/save before a report independently verifies the dashboard scope, then reads that current-school preference', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === reportPath()) return response({ operationalSnapshot: report() });
      if (path === themePath()) return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
      return { ok: false, status: 403 } as Response;
    });

    expect(text(render())).not.toContain('Platform View');
    expect(fetch).not.toHaveBeenCalled();
    fillVerifiedScope();
    await submit();
    await vi.waitFor(() => {
      const tree = render();
      expect(text(tree)).toContain('Platform View');
      expect(text(tree)).toContain('Modern HON is the visual default for this verified current school');
    });
    const preferenceRead = fetch.mock.calls.find(([path]) => path === themePath());
    expect(preferenceRead).toEqual([themePath(), { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
    expect(fetch.mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
  });

  it('saves only the current verified school with a generated idempotency UUID and SETTINGS provenance while every mode keeps the same dashboard semantics', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      if (path === reportPath()) return response({ operationalSnapshot: report() });
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'PUT') return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: to });
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedScope();
    await submit();
    await vi.waitFor(() => expect(text(render())).toContain('Modern HON is the visual default'));

    (pickerButton('Classic CRM').props.onClick as () => void)();
    await vi.waitFor(() => {
      const tree = render();
      expect(tree.props['data-interface-theme']).toBe('classic');
      expect(text(tree)).toContain('Saved for your current user and this verified current school only');
    });
    const save = fetch.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === 'PUT');
    expect(save).toEqual([themePath(), {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9') },
      body: JSON.stringify({ interfaceTheme: 'classic', selectedVia: 'SETTINGS' }),
      credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
    }]);
    const copy = text(render());
    for (const unchangedFactOrLink of ['Attendance & classes', 'Leads & trials', 'Membership & plan', 'Student profiles', 'Find an exact class or student in staff search', 'Open human revenue planning', 'Open membership renewal reviews']) expect(copy).toContain(unchangedFactOrLink);
    expect(copy).toContain('change touch targets and density only');
    expect(fetch.mock.calls.filter(([path]) => path === reportPath())).toHaveLength(1);
  });

  it('clears picker/theme state before a scope reload and keeps it cleared after report access failure without reading or saving a stale preference', async () => {
    let reportAvailable = true;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      if (path === reportPath() && reportAvailable) return response({ operationalSnapshot: report() });
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'big-button', selectedVia: 'SETTINGS', updatedAt: to });
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedScope();
    await submit();
    await vi.waitFor(() => expect(render().props['data-interface-theme']).toBe('big-button'));
    expect(text(render())).toContain('Platform View');

    reportAvailable = false;
    await submit();
    const reloading = render();
    expect(text(reloading)).not.toContain('Platform View');
    expect(reloading.props['data-interface-theme']).toBe('modern');
    await vi.waitFor(() => {
      const tree = render();
      expect(text(tree)).toContain('not authorized');
      expect(text(tree)).not.toContain('Platform View');
    });
    expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
  });

  it('also clears the verified preference surface immediately when the entered school changes before another report can verify it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === reportPath()) return response({ operationalSnapshot: report() });
      if (path === themePath()) return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: to });
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedScope();
    await submit();
    await vi.waitFor(() => expect(render().props['data-interface-theme']).toBe('classic'));
    (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: nextSchoolId } });
    const tree = render();
    expect(text(tree)).toContain('No verified school is selected');
    expect(text(tree)).not.toContain('Platform View');
    expect(tree.props['data-interface-theme']).toBe('modern');
    expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1);
  });
});
