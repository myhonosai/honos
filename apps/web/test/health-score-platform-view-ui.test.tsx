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

import { SchoolHealthScore } from '../src/components/school-health-score';

const id = (value: string) => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const organizationId = id('1'); const schoolId = id('2'); const nextSchoolId = id('3'); const generatedAt = '2026-10-16T00:00:00.000Z'; const day = 86_400_000;
const range = (days: number) => ({ windowFrom: new Date(Date.parse(generatedAt) - days * day).toISOString(), windowTo: generatedAt });
const report = () => ({
  organizationId, schoolId, entitlementTier: 'ESSENTIAL', formulaVersion: 'SCHOOL_HEALTH_SCORE_V1', generatedAt,
  weights: { attendanceEngagement: 35, pipelineTrial: 25, retention: 25, operations: 15 },
  categories: {
    attendanceEngagement: { status: 'AVAILABLE', ...range(28), evidence: { completedSessions: 4, recordedAttendanceObservations: 20, engagedAttendanceObservations: 15 }, reasons: [], score: 75 },
    pipelineTrial: { status: 'AVAILABLE', ...range(56), evidence: { leadsCreated: 5, trialAppointments: 4, trialOutcomesRecorded: 3 }, reasons: [], score: 75 },
    retention: { status: 'AVAILABLE', ...range(90), evidence: { membershipTermsEnded: 5, renewalReviewsRecorded: 4 }, reasons: [], score: 80 },
    operations: { status: 'AVAILABLE', ...range(28), evidence: { pendingApprovals: 1, outstandingWorkItems: 2 }, reasons: [], score: 80 },
  },
  overall: { status: 'AVAILABLE', reasons: [], score: 77 },
  indicatorStatement: 'Operational indicator only. It is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.',
});
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: id('8'), correlationId: id('8') } }) }) as Response;
const reportPath = (currentSchoolId = schoolId) => `/api/v1/organizations/${organizationId}/schools/${currentSchoolId}/health-score`;
const themePath = (currentSchoolId = schoolId) => `/api/v1/organizations/${organizationId}/schools/${currentSchoolId}/interface-theme`;

type Props = Record<string, unknown>;
function elements(node: unknown): React.ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement<Props>(node)) return []; if (typeof node.type === 'function') return [node, ...elements((node.type as (props: Props) => unknown)(node.props))]; return [node, ...elements(node.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement<Props>(node)) return typeof node.type === 'function' ? text((node.type as (props: Props) => unknown)(node.props)) : text(node.props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): React.ReactElement<Props> { hooks.cursor = 0; return SchoolHealthScore() as React.ReactElement<Props>; }
function input(index: number): React.ReactElement<Props> { const field = elements(render()).filter(element => element.type === 'input')[index]; expect(field).toBeDefined(); return field!; }
function fillVerifiedScope(currentSchoolId = schoolId): void { (input(0).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: organizationId } }); (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: currentSchoolId } }); }
async function submit(): Promise<void> { const form = elements(render()).find(element => element.type === 'form'); expect(form).toBeDefined(); await (form!.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} }); }
function pickerButton(label: string): React.ReactElement<Props> { const button = elements(render()).find(element => element.type === 'button' && text(element).includes(label)); expect(button).toBeDefined(); return button!; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(success => { resolve = success; }); return { promise, resolve }; }
function unmount(): void { for (const cell of hooks.cells) { if (!cell || typeof cell !== 'object' || !('cleanup' in cell)) continue; const effect = cell as { cleanup?: () => void; dependencies?: readonly unknown[] }; effect.cleanup?.(); delete effect.cleanup; delete effect.dependencies; } }

beforeEach(() => { hooks.cells = []; hooks.cursor = 0; vi.stubGlobal('crypto', { randomUUID: () => id('9') }); vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('School Health Score verified Platform View selector', () => {
  it('is absent and performs no preference I/O before the strict Health Score projection independently verifies the school', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => { if (path === reportPath()) return response({ healthScore: report() }); if (path === themePath()) return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' }); return { ok: false, status: 403 } as Response; });
    expect(text(render())).not.toContain('Platform View'); expect(fetch).not.toHaveBeenCalled();
    fillVerifiedScope(); await submit();
    await vi.waitFor(() => { const tree = render(); expect(text(tree)).toContain('Platform View'); expect(text(tree)).toContain('Modern HON is the visual default for this verified current school'); });
    expect(fetch.mock.calls.find(([path]) => path === themePath())).toEqual([themePath(), { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
  });

  it('saves only the verified current-school preference with SETTINGS provenance and preserves Health Score formula evidence semantics', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path, options) => { if (path === reportPath()) return response({ healthScore: report() }); if (path === themePath() && (options as RequestInit | undefined)?.method === 'GET') return response({ interfaceTheme: 'modern', selectedVia: 'DEFAULT' }); if (path === themePath() && (options as RequestInit | undefined)?.method === 'PUT') return response({ interfaceTheme: 'classic', selectedVia: 'SETTINGS', updatedAt: generatedAt }); return { ok: false, status: 403 } as Response; });
    fillVerifiedScope(); await submit(); await vi.waitFor(() => expect(text(render())).toContain('Modern HON is the visual default'));
    (pickerButton('Classic CRM').props.onClick as () => void)();
    await vi.waitFor(() => { const tree = render(); expect(tree.props['data-interface-theme']).toBe('classic'); expect(text(tree)).toContain('Saved for your current user and this verified current school only'); });
    const save = fetch.mock.calls.find(([, options]) => (options as RequestInit | undefined)?.method === 'PUT');
    expect(save).toEqual([themePath(), { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': id('9') }, body: JSON.stringify({ interfaceTheme: 'classic', selectedVia: 'SETTINGS' }), credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' }]);
    const copy = text(render()); for (const unchangedText of ['Overall operational indicator:', 'Formula', 'SCHOOL_HEALTH_SCORE_V1', 'Defined aggregate inputs', 'Operational indicator only']) expect(copy).toContain(unchangedText); expect(copy).toContain('change touch targets and density only');
  });

  it('clears stale theme state on scope change and discards a late aggregate response after unmount', async () => {
    const delayed = deferred<Response>(); let delayedMode = false;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => { if (path === reportPath()) return delayedMode ? delayed.promise : response({ healthScore: report() }); if (path === themePath()) return response({ interfaceTheme: 'big-button', selectedVia: 'SETTINGS', updatedAt: generatedAt }); return { ok: false, status: 403 } as Response; });
    fillVerifiedScope(); await submit(); await vi.waitFor(() => expect(render().props['data-interface-theme']).toBe('big-button'));
    (input(1).props.onChange as (event: { target: { value: string } }) => void)({ target: { value: nextSchoolId } });
    expect(text(render())).not.toContain('Platform View'); expect(render().props['data-interface-theme']).toBe('modern');
    delayedMode = true; fillVerifiedScope(); const pending = submit(); await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(reportPath(), expect.anything())); unmount(); delayed.resolve(response({ healthScore: report() })); await pending;
    const tree = render(); expect(text(tree)).not.toContain('Platform View'); expect(tree.props['data-interface-theme']).toBe('modern'); expect(fetch.mock.calls.filter(([path]) => path === themePath())).toHaveLength(1);
  });
});
