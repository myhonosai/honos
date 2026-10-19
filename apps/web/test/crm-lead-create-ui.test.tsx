import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CrmLeadCreatePanel } from '../src/components/crm-lead-create-panel';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';

// Deterministic hook/effect lifecycle runner exercises actual event handlers,
// including delayed promises and cleanup, without a new DOM dependency.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.values[i]) : value; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
}; });
const org = '11111111-1111-4111-8111-111111111111', school = '22222222-2222-4222-8222-222222222222', stageId = '33333333-3333-4333-8333-333333333333', lead = '44444444-4444-4444-8444-444444444444';
const stages = [{ pipelineId: org, pipelineName: 'Admissions', stageId, stageName: 'New inquiry' }] as const;
const response = (status = 201, replayed = false) => new Response(JSON.stringify({ data: { id: lead, status: 'OPEN', pipelineStageId: stageId, primaryPersonId: school, version: 1, createdAt: '2026-10-17T01:02:03.000Z' }, meta: { requestId: org, correlationId: org, replayed } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const currentScopeResponse = (state: 'RESOLVED' | 'MANUAL_ENTRY_REQUIRED' = 'RESOLVED') => new Response(JSON.stringify({ data: state === 'RESOLVED' ? { state, organizationId: org, schoolId: school } : { state } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const stageResponse = (data: unknown = stages, status = 200) => new Response(JSON.stringify({ data, meta: { requestId: org, correlationId: org } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(view: () => ReactElement): Element { hooks.cursor = 0; const tree = view() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const value of hooks.values) if (value && typeof value === 'object' && 'cleanup' in value) (value as { cleanup?: () => void }).cleanup?.(); }
const button = (tree: Element, label: string) => elements(tree).find(e => e.type === 'button' && text(e) === label);
const control = (tree: Element, label: string) => elements(tree).find(e => e.type === 'label' && text(e).startsWith(label))!.props.children.find((e: Element) => React.isValidElement(e) && (e.type === 'input' || e.type === 'select')) as Element;
const submit = (tree: Element) => elements(tree).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} });
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fill(view: () => ReactElement): Element {
  let tree = render(view);
  for (const [label, value] of [['Intake stage', stageId], ['Primary contact given name', 'Ari'], ['Primary contact family name', 'Stone']] as Array<[string, string]>) { control(tree, label).props.onChange({ target: { value } }); tree = render(view); }
  return tree;
}
function confirm(tree: Element, view: () => ReactElement): Element { elements(tree).find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); return render(view); }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); });
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('first-value direct-human CRM intake', () => {
  it('allocates no key/request before an explicit valid stage-selected confirmation, then offers only inert untrusted trial handoff from the receipt', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()), key = vi.spyOn(crypto, 'randomUUID');
    const view = () => CrmLeadCreatePanel({ organizationId: org, schoolId: school, intakeStages: stages, intakeStagesMessage: 'Ready.', onStarted() {}, onBusy() {}, onAccessLost() {} });
    let tree = render(view); expect(f).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled(); submit(tree); await settle();
    tree = confirm(tree, view); submit(tree); await settle(); expect(f).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    tree = confirm(fill(view), view); submit(tree); submit(tree); await settle(); tree = render(view);
    expect(f).toHaveBeenCalledTimes(1); expect(key).toHaveBeenCalledTimes(1); expect(text(tree)).toContain('Returned CRM creation receipt');
    expect(text(tree)).toContain('New inquiry'); expect(text(tree)).not.toContain(stageId); expect(text(tree)).not.toContain(org);
    const handoff = elements(tree).find(e => e.type === 'a' && text(e) === 'Prepare trial appointment with this untrusted lead selection')!;
    expect(handoff.props.href).toBe(`/staff/crm/trials?organizationId=${org}&schoolId=${school}&leadId=${lead}`); expect(handoff.props.onClick).toBeUndefined();
    expect(f.mock.calls[0]![0]).toContain('/crm/leads'); expect((f.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });
  it('shows a truthful no-stage state with no create action, and preserves exact in-memory uncertain retry only after a human attempt', async () => {
    const absent = () => CrmLeadCreatePanel({ organizationId: org, schoolId: school, intakeStages: [], intakeStagesMessage: 'No stages.', onStarted() {}, onBusy() {}, onAccessLost() {} });
    let tree = render(absent); expect(text(tree)).toContain('No configured non-terminal CRM intake stage'); expect(button(tree, 'Confirm create CRM lead')).toBeUndefined(); expect(elements(tree).find(e => e.type === 'form')).toBeUndefined();
    hooks.values = []; hooks.cursor = 0; hooks.effects = [];
    const f = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(200, true)); const view = () => CrmLeadCreatePanel({ organizationId: org, schoolId: school, intakeStages: stages, intakeStagesMessage: 'Ready.', onStarted() {}, onBusy() {}, onAccessLost() {} });
    tree = confirm(fill(view), view); submit(tree); await settle(); tree = render(view); expect(button(tree, 'Retry exact retained lead-create request')).toBeDefined(); expect(f).toHaveBeenCalledTimes(1);
    button(tree, 'Retry exact retained lead-create request')!.props.onClick(); await settle(); tree = render(view); expect(f.mock.calls[0]).toEqual(f.mock.calls[1]); expect(text(tree)).toContain('Returned CRM creation receipt');
    control(tree, 'Intake stage').props.onChange({ target: { value: '' } }); tree = render(view); expect(button(tree, 'Retry exact retained lead-create request')).toBeUndefined(); expect(text(tree)).not.toContain('Returned CRM creation receipt');
  });
  it('resolves one safe current staff school into bounded stage choices without auto-loading leads or issuing a create/trial command', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => String(path).includes('current-reporting-school') ? currentScopeResponse() : stageResponse());
    const view = () => CrmLeadsWorkbench({ initialScope: { organizationId: lead, schoolId: lead } });
    let tree = render(view); expect(text(tree)).toContain('Resolving current staff CRM scope'); await settle(); tree = render(view);
    expect(text(tree)).toContain('Verified current CRM school'); const panel = elements(tree).find(e => e.type === CrmLeadCreatePanel)!; expect(panel.props.intakeStages).toEqual(stages); expect(panel.props.organizationId).toBe(org); expect(panel.props.schoolId).toBe(school);
    expect(f.mock.calls.map(([path]) => String(path))).toEqual(['/api/v1/staff/current-reporting-school', `/api/v1/organizations/${org}/schools/${school}/crm/intake-stages`]);
    expect(f.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(['GET', 'GET']); expect(elements(tree).filter(e => e.type === 'a' && String(e.props.href).includes('/staff/crm/trials?'))).toHaveLength(0);
  });
  it('shows only existing authorized school names for multi-school selection and clears scope on intake-stage access denial', async () => {
    const south = '55555555-5555-4555-8555-555555555555';
    const choices = new Response(JSON.stringify({ data: { state: 'SELECTION_REQUIRED', schools: [{ organizationId: org, schoolId: school, organizationName: 'Local Organization', schoolName: 'North School' }, { organizationId: org, schoolId: south, organizationName: 'Local Organization', schoolName: 'South School' }] } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => String(path).includes('current-reporting-school') ? currentScopeResponse('MANUAL_ENTRY_REQUIRED') : String(path).includes('reporting-schools') ? choices : stageResponse({}, 403));
    const view = () => CrmLeadsWorkbench(); let tree = render(view); await settle(); tree = render(view);
    expect(text(tree)).toContain('North School — Local Organization'); expect(text(tree)).toContain('South School — Local Organization'); expect(text(tree)).not.toContain('Organization UUID'); expect(text(tree)).not.toContain(org);
    control(tree, 'Authorized school').props.onChange({ target: { value: school } }); tree = render(view); submit(tree); await settle(); tree = render(view);
    expect(text(tree)).toContain('Human session or current school authority unavailable'); expect(f.mock.calls.map(([path]) => String(path))).toContain(`/api/v1/organizations/${org}/schools/${school}/crm/intake-stages`);
  });
  it('keeps scope choices, stage response, receipt handoff, list reload and trial page non-authoritative and free of technical ID controls', () => {
    const panel = readFileSync('src/components/crm-lead-create-panel.tsx', 'utf8'); const workbench = readFileSync('src/components/crm-leads-workbench.tsx', 'utf8'); const intake = readFileSync('src/components/crm-intake-stages-http.ts', 'utf8'); const trial = readFileSync('src/components/trial-appointment-workbench.tsx', 'utf8');
    expect(panel).not.toMatch(/Known pipeline UUID|Known non-terminal stage UUID|pipelineId.*<input|pipelineStageId.*<input/); expect(panel).toContain('Prepare trial appointment with this untrusted lead selection');
    expect(workbench).not.toMatch(/Organization UUID|School UUID|localStorage|sessionStorage|setInterval|setTimeout/); expect(workbench).toContain('loadCurrentStaffReportingSchool'); expect(workbench).toContain('loadStaffReportingSchools'); expect(workbench).toContain('loadCrmIntakeStages');
    expect(intake).toContain("'X-HON-Human-Read': 'crm-intake-stages'"); expect(intake).toContain("cache: 'no-store'"); expect(intake).not.toMatch(/method: 'POST'|localStorage|sessionStorage/);
    expect(trial).toContain('initialScope'); expect(trial).not.toMatch(/useEffect\([^]*submit|setInterval/);
  });
});
