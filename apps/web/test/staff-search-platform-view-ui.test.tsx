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

import { StaffSearch } from '../src/components/staff-search';

const id = (value: string) => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const organizationId = id('1');
const schoolId = id('2');
const nextSchoolId = id('3');
const searchPath = `/api/v1/organizations/${organizationId}/schools/${schoolId}/search`;
const themePath = `/api/v1/organizations/${organizationId}/schools/${schoolId}/interface-theme`;
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: id('8'), correlationId: id('8') } }) }) as Response;

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
function render(): React.ReactElement<Props> { hooks.cursor = 0; return StaffSearch() as React.ReactElement<Props>; }
function input(index: number): React.ReactElement<Props> {
  const field = elements(render()).filter((element) => element.type === 'input')[index];
  expect(field).toBeDefined();
  return field!;
}
function fillVerifiedSearch(currentSchoolId = schoolId): void {
  (input(0).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: organizationId } });
  (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: currentSchoolId } });
  (input(2).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Ada' } });
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
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Staff Search verified Platform View selector', () => {
  it('is absent and performs no preference I/O until a search response independently verifies the current organization and school scope', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (String(path).startsWith(searchPath)) return response({ search: { organizationId, schoolId, results: [] } });
      if (path === themePath) return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
      return { ok: false, status: 403 } as Response;
    });
    expect(text(render())).not.toContain('Platform View');
    expect(fetch).not.toHaveBeenCalled();
    fillVerifiedSearch();
    await submit();
    await vi.waitFor(() => {
      const tree = render();
      expect(text(tree)).toContain('Platform View');
      expect(text(tree)).toContain('Modern HON is the visual default for this verified current school');
    });
    expect(fetch.mock.calls.find(([path]) => path === themePath)).toEqual([themePath, { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
  });

  it('persists only the verified current-school preference with SETTINGS provenance while retaining the same search semantics and cards', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      if (String(path).startsWith(searchPath)) return response({ search: { organizationId, schoolId, results: [] } });
      if (path === themePath && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
      if (path === themePath && (options as RequestInit | undefined)?.method === 'PUT') return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: '2026-10-16T00:00:00.000Z' });
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedSearch();
    await submit();
    await vi.waitFor(() => expect(text(render())).toContain('Modern HON is the visual default'));
    (pickerButton('Classic CRM').props.onClick as () => void)();
    await vi.waitFor(() => {
      const tree = render();
      expect(tree.props['data-interface-theme']).toBe('classic');
      expect(text(tree)).toContain('Saved for your current user and this verified current school only');
    });
    const save = fetch.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === 'PUT');
    expect(save).toEqual([themePath, {
      method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9') },
      body: JSON.stringify({ interfaceTheme: 'classic', selectedVia: 'SETTINGS' }), credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
    }]);
    const copy = text(render());
    for (const unchangedText of ['SINGLE-SCHOOL SEARCH', 'No matching records', 'Literal, case-insensitive matching', 'Search stays within this school', 'search.global']) expect(copy).toContain(unchangedText);
    expect(copy).toContain('change touch targets and density only');
  });

  it('clears the presentation state immediately when verified search input changes and never saves a stale preference', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (String(path).startsWith(searchPath)) return response({ search: { organizationId, schoolId, results: [] } });
      if (path === themePath) return response({ interfaceTheme: 'big-button', selectedVia: 'SETTINGS', updatedAt: '2026-10-16T00:00:00.000Z' });
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedSearch();
    await submit();
    await vi.waitFor(() => expect(render().props['data-interface-theme']).toBe('big-button'));
    (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: nextSchoolId } });
    const tree = render();
    expect(text(tree)).not.toContain('Platform View');
    expect(text(tree)).toContain('Nothing is listed until you search');
    expect(tree.props['data-interface-theme']).toBe('modern');
    expect(fetch.mock.calls.filter(([path]) => path === themePath)).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
  });
});
