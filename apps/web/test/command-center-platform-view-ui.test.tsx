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

import { SchoolCommandCenter } from '../src/components/school-command-center';

const id = (value: string) => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const organizationId = id('1');
const schoolId = id('2');
const nextSchoolId = id('3');
const generatedAt = '2026-10-16T00:00:00.000Z';
const day = 86_400_000;
const at = (offset: number) => new Date(Date.parse(generatedAt) + offset).toISOString();
const windowMetric = (from: number, to: number) => ({ availability: 'AVAILABLE', windowFrom: at(from), windowTo: at(to), count: 0 });
const report = (currentSchoolId = schoolId) => ({
  organizationId,
  schoolId: currentSchoolId,
  entitlementTier: 'ESSENTIAL',
  generatedAt,
  metrics: {
    newLeads24h: windowMetric(-day, 0),
    upcomingTrials24h: windowMetric(0, day),
    upcomingTestingEvents30d: windowMetric(0, 30 * day),
    pendingActionApprovals: { availability: 'AVAILABLE', count: 0 },
    outstandingWorkItems: { availability: 'AVAILABLE', count: 0 },
    membershipTermsEnding30d: windowMetric(0, 30 * day),
    paidInvoicesCreated30d: { availability: 'AVAILABLE', windowFrom: at(-30 * day), windowTo: at(0), count: 0, amountsByCurrency: [] },
    unansweredInquiries: { availability: 'UNAVAILABLE', reason: 'No approved inquiry response-state projection exists.' },
    attendanceDecline: { availability: 'INSUFFICIENT_DATA', reason: 'No approved attendance-decline policy or longitudinal projection exists.' },
    trialConversion: { availability: 'UNAVAILABLE', reason: 'No authoritative trial-to-enrollment linkage is available.' },
    revenue: { availability: 'UNAVAILABLE', reason: 'Current paid invoice state is not authoritative cash revenue or collection data.' },
  },
  dailyBriefing: 'Daily briefing: no counted priorities are currently recorded in the available Command Center metrics.',
  recommendations: [],
});
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: id('8'), correlationId: id('8') } }) }) as Response;
const reportPath = (currentSchoolId = schoolId) => `/api/v1/organizations/${organizationId}/schools/${currentSchoolId}/command-center`;
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
function render(): React.ReactElement<Props> { hooks.cursor = 0; return SchoolCommandCenter() as React.ReactElement<Props>; }
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
function unmount(): void {
  for (const cell of hooks.cells) {
    if (!cell || typeof cell !== 'object' || !('cleanup' in cell)) continue;
    const effect = cell as { cleanup?: () => void; dependencies?: readonly unknown[] };
    effect.cleanup?.(); delete effect.cleanup; delete effect.dependencies;
  }
}

beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  vi.stubGlobal('crypto', { randomUUID: () => id('9') });
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('School Command Center verified Platform View selector', () => {
  it('is absent and performs no preference read/save before the aggregate projection independently verifies the school, then reads only that current-school preference', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === reportPath()) return response({ commandCenter: report() });
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

  it('saves only the verified current school with a generated idempotency UUID and SETTINGS provenance while every view preserves facts, formulas, and navigation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      if (path === reportPath()) return response({ commandCenter: report() });
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' });
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'PUT') return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: generatedAt });
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
    for (const unchangedFactOrLink of ['Daily briefing:', 'Available operational facts', 'Not calculated without an approved source', 'No recommendation threshold is currently met', 'Operations dashboard', 'Human navigation only']) expect(copy).toContain(unchangedFactOrLink);
    expect(copy).toContain('change touch targets and density only');
    expect(fetch.mock.calls.filter(([path]) => path === reportPath())).toHaveLength(1);
  });

  it('clears picker/theme state before a scope reload and keeps it cleared after aggregate access denial without reading or saving a stale preference', async () => {
    let reportAvailable = true;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      if (path === reportPath() && reportAvailable) return response({ commandCenter: report() });
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'big-button', selectedVia: 'SETTINGS', updatedAt: generatedAt });
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

  it('also clears the verified preference surface immediately when the entered school changes before another aggregate can verify it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === reportPath()) return response({ commandCenter: report() });
      if (path === themePath()) return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: generatedAt });
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

  it('discards an aggregate response that settles after unmount without mounting a preference surface from stale state', async () => {
    const delayedReport = deferred<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === reportPath()) return delayedReport.promise;
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedScope();
    const pending = submit();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(reportPath(), expect.anything()));
    unmount();
    delayedReport.resolve(response({ commandCenter: report() }));
    await pending;
    const tree = render();
    expect(text(tree)).not.toContain('Platform View');
    expect(tree.props['data-interface-theme']).toBe('modern');
    expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(0);
  });

  it('discards a delayed preference response after verified scope input clears the surface', async () => {
    const delayedPreference = deferred<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === reportPath()) return response({ commandCenter: report() });
      if (path === themePath()) return delayedPreference.promise;
      return { ok: false, status: 403 } as Response;
    });
    fillVerifiedScope();
    await submit();
    await vi.waitFor(() => { render(); expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1); });
    (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: nextSchoolId } });
    delayedPreference.resolve(response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: generatedAt }));
    await Promise.resolve(); await Promise.resolve();
    const tree = render();
    expect(text(tree)).toContain('No verified school is selected');
    expect(text(tree)).not.toContain('Platform View');
    expect(tree.props['data-interface-theme']).toBe('modern');
    expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1);
  });
});
