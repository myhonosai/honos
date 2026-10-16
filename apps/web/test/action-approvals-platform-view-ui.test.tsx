import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => { const index = hooks.cursor++; if (index >= hooks.cells.length) hooks.cells[index] = initial; return [hooks.cells[index], (value: unknown) => { hooks.cells[index] = typeof value === 'function' ? (value as (prior: unknown) => unknown)(hooks.cells[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = hooks.cursor++; if (index >= hooks.cells.length) hooks.cells[index] = { current: initial }; return hooks.cells[index]; },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => { const index = hooks.cursor++; const prior = hooks.cells[index] as { dependencies?: readonly unknown[]; cleanup?: () => void } | undefined; const changed = !prior || !dependencies || !prior.dependencies || dependencies.length !== prior.dependencies.length || dependencies.some((value, i) => value !== prior.dependencies![i]); if (!changed) return; prior?.cleanup?.(); const cleanup = effect(); hooks.cells[index] = { dependencies, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; },
  };
});

import { ActionApprovalsWorkbench } from '../src/components/action-approvals-workbench';

const id = (value: string) => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const schoolId = id('1'); const nextSchoolId = id('2'); const organizationId = id('3'); const reviewerId = id('4'); const requestId = id('5'); const createdAt = '2026-10-16T00:00:00.000Z';
const queue = (school = schoolId) => ({ organizationId, schoolId: school, reviewerPrincipalId: reviewerId, reviewerPermission: 'action.approve', status: 'AWAITING_APPROVAL', items: [{ id: requestId, actionCode: 'crm.lead.create', status: 'AWAITING_APPROVAL', requestedByPrincipalId: id('6'), effectiveAuthorityMode: 'CONFIRM', policyVersion: 1, approvalExpiresAt: '2026-10-16T00:30:00.000Z', createdAt }], nextAfter: null, executionTriggered: false });
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: id('8'), correlationId: id('8') } }) }) as Response;
const queuePath = (school = schoolId) => `/api/v1/staff/action-center/approvals/${school}?status=AWAITING_APPROVAL`;
const themePath = (school = schoolId) => `/api/v1/organizations/${organizationId}/schools/${school}/interface-theme`;

type Props = Record<string, unknown>;
function elements(node: unknown): React.ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement<Props>(node)) return []; if (typeof node.type === 'function') return [node, ...elements((node.type as (props: Props) => unknown)(node.props))]; return [node, ...elements(node.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement<Props>(node)) return typeof node.type === 'function' ? text((node.type as (props: Props) => unknown)(node.props)) : text(node.props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): React.ReactElement<Props> { hooks.cursor = 0; return ActionApprovalsWorkbench() as React.ReactElement<Props>; }
function input(): React.ReactElement<Props> { const field = elements(render()).find(element => element.type === 'input'); expect(field).toBeDefined(); return field!; }
function enterSchool(value = schoolId): void { (input().props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function button(label: string): React.ReactElement<Props> { const item = elements(render()).find(element => element.type === 'button' && text(element).includes(label)); expect(item).toBeDefined(); return item!; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(success => { resolve = success; }); return { promise, resolve }; }
function unmount(): void { for (const cell of hooks.cells) { if (!cell || typeof cell !== 'object' || !('cleanup' in cell)) continue; const effect = cell as { cleanup?: () => void; dependencies?: readonly unknown[] }; effect.cleanup?.(); delete effect.cleanup; delete effect.dependencies; } }

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; vi.stubGlobal('crypto', { randomUUID: () => id('9') }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Action Engine approval workbench verified Platform View selector', () => {
  it('is absent and performs no preference I/O before the qualified human queue response independently verifies organization, school and reviewer', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => { if (path === queuePath()) return response(queue()); if (path === themePath()) return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' }); return { ok: false, status: 403 } as Response; });
    expect(text(render())).not.toContain('Platform View'); expect(fetch).not.toHaveBeenCalled();
    enterSchool(); await (button('Load / refresh queue').props.onClick as () => Promise<void>)();
    await vi.waitFor(() => { const tree = render(); expect(text(tree)).toContain('Platform View'); expect(text(tree)).toContain('Modern HON is the visual default for this verified current-school reviewer'); });
    expect(fetch.mock.calls.find(([path]) => path === themePath())).toEqual([themePath(), { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
    expect(fetch.mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
  });

  it('saves only the independently verified current-school preference with SETTINGS provenance and leaves Action Engine decision posture untouched', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => { if (path === queuePath()) return response(queue()); if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' }); if (path === themePath() && (options as RequestInit | undefined)?.method === 'PUT') return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: createdAt }); return { ok: false, status: 403 } as Response; });
    enterSchool(); await (button('Load / refresh queue').props.onClick as () => Promise<void>)(); await vi.waitFor(() => expect(text(render())).toContain('Modern HON is the visual default'));
    (button('Classic CRM').props.onClick as () => void)();
    await vi.waitFor(() => { const tree = render(); expect(tree.props['data-interface-theme']).toBe('classic'); expect(text(tree)).toContain('Saved for your current user and this verified current school only'); });
    const save = fetch.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === 'PUT');
    expect(save).toEqual([themePath(), { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9') }, body: JSON.stringify({ interfaceTheme: 'classic', selectedVia: 'SETTINGS' }), credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
    const copy = text(render()); for (const unchanged of ['No execution. No provider or AI call.', 'action.approve', 'crm.lead.create', 'AWAITING_APPROVAL', 'Request']) expect(copy).toContain(unchanged);
    expect(copy).toContain('preserve the exact proposal queue, immutable payload, reviewer permission, approval binding, idempotency, decision controls, and no-execution posture');
  });

  it('clears presentation state on school change and discards a late preference result after unmount', async () => {
    const delayedPreference = deferred<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => { if (path === queuePath()) return response(queue()); if (path === themePath()) return delayedPreference.promise; return { ok: false, status: 403 } as Response; });
    enterSchool(); await (button('Load / refresh queue').props.onClick as () => Promise<void>)();
    await vi.waitFor(() => { render(); expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1); });
    enterSchool(nextSchoolId);
    expect(text(render())).not.toContain('Platform View'); expect(render().props['data-interface-theme']).toBe('modern');
    unmount(); delayedPreference.resolve(response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: createdAt })); await Promise.resolve(); await Promise.resolve();
    const tree = render(); expect(text(tree)).not.toContain('Platform View'); expect(tree.props['data-interface-theme']).toBe('modern'); expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1);
  });

  it('invalidates a pending preference before a verified queue reload and never lets the old scope result overwrite the reloaded presentation', async () => {
    const delayedPreference = deferred<Response>(); const delayedQueueReload = deferred<Response>(); let queueLoads = 0; let preferenceLoads = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => {
      if (path === queuePath()) { queueLoads += 1; return queueLoads === 1 ? response(queue()) : delayedQueueReload.promise; }
      if (path === themePath()) { preferenceLoads += 1; return preferenceLoads === 1 ? delayedPreference.promise : response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' }); }
      return { ok: false, status: 403 } as Response;
    });
    enterSchool(); await (button('Load / refresh queue').props.onClick as () => Promise<void>)();
    await vi.waitFor(() => { render(); expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1); });
    (button('Load / refresh queue').props.onClick as () => void)();
    await vi.waitFor(() => { const tree = render(); expect(text(tree)).not.toContain('Platform View'); expect(tree.props['data-interface-theme']).toBe('modern'); expect(queueLoads).toBe(2); });
    delayedQueueReload.resolve(response(queue()));
    await vi.waitFor(() => { render(); expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(2); });
    delayedPreference.resolve(response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: createdAt }));
    await vi.waitFor(() => { const tree = render(); expect(tree.props['data-interface-theme']).toBe('modern'); expect(text(tree)).toContain('Modern HON is the visual default'); });
  });

  it('removes the selector after a verified queue access denial and reports an unavailable preference honestly without issuing a save', async () => {
    let queueAvailable = true; let preferenceAvailable = true;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => {
      if (path === queuePath()) return queueAvailable ? response(queue()) : { ok: false, status: 403 } as Response;
      if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return preferenceAvailable ? response({ interfaceTheme: 'big-button', selectedVia: 'SETTINGS', updatedAt: createdAt }) : { ok: false, status: 403 } as Response;
      return { ok: false, status: 403 } as Response;
    });
    enterSchool(); await (button('Load / refresh queue').props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(render().props['data-interface-theme']).toBe('big-button'));
    queueAvailable = false; await (button('Load / refresh queue').props.onClick as () => Promise<void>)();
    await vi.waitFor(() => { const tree = render(); expect(text(tree)).toContain('Current exact school review permission is unavailable'); expect(text(tree)).not.toContain('Platform View'); expect(tree.props['data-interface-theme']).toBe('modern'); });
    expect(fetch.mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);

    queueAvailable = true; preferenceAvailable = false; await (button('Load / refresh queue').props.onClick as () => Promise<void>)();
    await vi.waitFor(() => { const tree = render(); expect(text(tree)).toContain('personal interface preference is unavailable'); expect(tree.props['data-interface-theme']).toBe('modern'); });
    expect(fetch.mock.calls.filter(([, options]) => (options as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0);
  });
});
