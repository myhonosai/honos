import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CrmLeadCreatePanel } from '../src/components/crm-lead-create-panel';
import { CrmLeadClosePanel } from '../src/components/crm-lead-close-panel';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';
import LeadPage from '../src/app/staff/crm/leads/page';
import { issueSession } from '@hon/auth';
const signedConfig = {mode:'OIDC' as const,audience:'crm-privacy-test',secret:'synthetic-only-crm-session-secret-123456789'};

vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ date: (v: string) => `Localized ${v}` }) }));
// Deterministic hook/effect lifecycle runner exercises actual event handlers,
// including delayed promises and cleanup, without a new DOM dependency.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const session = vi.hoisted(() => ({ token: 'first-test-session' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: session.token }) }) }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
 useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.values[i]) : value; }]; },
 useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
 useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
 }; });
const org = '11111111-1111-4111-8111-111111111111', school = '22222222-2222-4222-8222-222222222222', stage = '33333333-3333-4333-8333-333333333333', lead = '44444444-4444-4444-8444-444444444444';
const row = { id: lead, status: 'OPEN', pipelineStageId: stage, primaryPersonId: school, version: 1, createdAt: '2026-10-17T01:02:03.000Z', givenName: 'Ari', familyName: 'Stone' };
const response = (status = 201, replayed = false) => new Response(JSON.stringify({ data: { id: lead, status: 'OPEN', pipelineStageId: stage, primaryPersonId: school, version: 1, createdAt: row.createdAt }, meta: { requestId: org, correlationId: org, replayed } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(view: () => ReactElement): Element { hooks.cursor = 0; const tree = view() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const value of hooks.values) if (value && typeof value === 'object' && 'cleanup' in value) (value as { cleanup?: () => void }).cleanup?.(); }
const button = (tree: Element, label: string) => elements(tree).find(e => e.type === 'button' && text(e) === label);
const input = (tree: Element, label: string) => elements(tree).find(e => e.type === 'label' && text(e) === label)!.props.children.find((e: Element) => React.isValidElement(e) && e.type === 'input') as Element;
const submit = (tree: Element) => elements(tree).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fill(view: () => ReactElement): Element {
 let tree = render(view);
 for (const [label, value] of [['Known pipeline UUID', org], ['Known non-terminal stage UUID', stage], ['Primary contact given name', 'Ari'], ['Primary contact family name', 'Stone']]) { input(tree, label!).props.onChange({ target: { value } }); tree = render(view); }
 return tree;
}
function confirm(tree: Element, view: () => ReactElement): Element { elements(tree).find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); return render(view); }
beforeEach(() => {
 hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.stubEnv('HON_AUTH_MODE',signedConfig.mode);vi.stubEnv('HON_SESSION_AUDIENCE',signedConfig.audience);vi.stubEnv('HON_SESSION_JWT_SECRET',signedConfig.secret);session.token=issueSession({externalSubject:'first-fixture-staff'},signedConfig);
 vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
});
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('idle direct-human CRM intake', () => {
 it('allocates no key/request on mount, prefill, invalid submit, editing or confirmation; requires explicit valid submit', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response()), key = vi.spyOn(crypto, 'randomUUID');
  const view = () => CrmLeadCreatePanel({ organizationId: org, schoolId: school, onStarted() {}, onBusy() {}, onAccessLost() {} });
  let tree = render(view); expect(f).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled(); submit(tree); await settle();
  tree = confirm(tree, view); submit(tree); await settle(); expect(f).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
  tree = fill(view); submit(tree); await settle(); expect(f).not.toHaveBeenCalled(); tree = confirm(tree, view);
  expect(key).not.toHaveBeenCalled(); submit(tree); submit(tree); await settle(); tree = render(view);
  expect(f).toHaveBeenCalledTimes(1); expect(key).toHaveBeenCalledTimes(1); expect(text(tree)).toContain('Returned CRM creation receipt');
  expect(text(tree)).not.toContain('ari@example.test'); expect(button(tree, 'Prepare CRM-only close')).toBeUndefined(); expect(elements(tree).filter(e => e.type === 'a')).toHaveLength(0);
  submit(tree); await settle(); expect(f).toHaveBeenCalledTimes(1); expect(button(tree, 'Retry exact retained lead-create request')).toBeUndefined();
 });
 it('retains only an uncertain exact body/key, performs no automatic retry, and clears it/confirmation/receipt on editing', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(200, true)), key = vi.spyOn(crypto, 'randomUUID'), started = vi.fn();
  const view = () => CrmLeadCreatePanel({ organizationId: org, schoolId: school, onStarted: started, onBusy() {}, onAccessLost() {} });
  let tree = confirm(fill(view), view); submit(tree); await settle(); tree = render(view);
  expect(button(tree, 'Retry exact retained lead-create request')).toBeDefined(); expect(f).toHaveBeenCalledTimes(1);
  submit(tree); await settle(); expect(f).toHaveBeenCalledTimes(1);
  button(tree, 'Retry exact retained lead-create request')!.props.onClick(); await settle(); tree = render(view);
  expect(f.mock.calls[0]).toEqual(f.mock.calls[1]); expect(key).toHaveBeenCalledTimes(1); expect(started).toHaveBeenCalledTimes(2); expect(text(tree)).toContain('replayed creation receipt');
  input(tree, 'Primary contact given name').props.onChange({ target: { value: 'Edited' } }); tree = render(view);
  expect(text(tree)).not.toContain('Returned CRM creation receipt'); expect(button(tree, 'Confirm create CRM lead')!.props.disabled).toBe(true); expect(button(tree, 'Retry exact retained lead-create request')).toBeUndefined();
  f.mockRejectedValueOnce(new Error('again')); tree = confirm(tree, view); submit(tree); await settle(); tree = render(view); expect(button(tree, 'Retry exact retained lead-create request')).toBeDefined();
  input(tree, 'Known non-terminal stage UUID').props.onChange({ target: { value: org } }); tree = render(view); expect(button(tree, 'Retry exact retained lead-create request')).toBeUndefined(); expect(key).toHaveBeenCalledTimes(2);
  button(tree, 'Discard draft / start new lead')!.props.onClick(); tree = render(view); expect(input(tree, 'Primary contact given name').props.value).toBe(''); expect(input(tree, 'Known pipeline UUID').props.value).toBe('');
 });
 it('discards definite-rejection retry, clears all contact drafts on access loss, and ignores delayed completion after unmount', async () => {
  const lost = vi.fn(), f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(409)).mockResolvedValueOnce(response(403));
  const view = () => CrmLeadCreatePanel({ organizationId: org, schoolId: school, onStarted() {}, onBusy() {}, onAccessLost: lost });
  let tree = confirm(fill(view), view); submit(tree); await settle(); tree = render(view);
  expect(button(tree, 'Retry exact retained lead-create request')).toBeUndefined(); expect(text(tree)).toContain('command rejected');
  input(tree, 'Primary contact given name').props.onChange({ target: { value: 'New draft' } }); tree = confirm(render(view), view); submit(tree); await settle(); tree = render(view);
  expect(lost).toHaveBeenCalledTimes(1); expect(input(tree, 'Primary contact given name').props.value).toBe(''); expect(button(tree, 'Retry exact retained lead-create request')).toBeUndefined();
  let release!: (r: Response) => void; f.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  tree = confirm(fill(view), view); submit(tree); unmount(); const snapshot = hooks.values.slice(); release(response()); await settle(); expect(hooks.values).toEqual(snapshot);
 });
 it('never inserts a creation receipt into the authorized list or close panel; explicit reload and scope edits discard draft keys', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [row], meta: {} }), { status: 200 }));
  const view = () => CrmLeadsWorkbench({ initialScope: { organizationId: org, schoolId: school } });
  let tree = render(view); const panel = () => elements(tree).find(e => e.type === CrmLeadCreatePanel)!;
  expect(f).not.toHaveBeenCalled(); const initialKey = panel().key; submit(tree); await settle(); tree = render(view);
  const loaded = hooks.values[3]; panel().props.onStarted(); tree = render(view);
  expect(hooks.values[3]).toBe(loaded); expect(text(tree)).toContain('1 verified CRM lead'); expect(button(tree, 'Prepare CRM-only close')!.props.disabled).toBe(true); expect(elements(tree).some(e => e.type === CrmLeadClosePanel)).toBe(false); expect(f).toHaveBeenCalledTimes(1);
  const beforeReload = panel().key; submit(tree); await settle(); tree = render(view); expect(panel().key).not.toBe(beforeReload); expect(panel().key).not.toBe(initialKey); expect(button(tree, 'Prepare CRM-only close')!.props.disabled).toBe(false);
  button(tree, 'Prepare CRM-only close')!.props.onClick(); tree = render(view); const oldClose = elements(tree).find(e => e.type === CrmLeadClosePanel)!;
  elements(tree).find(e => e.type === 'input')!.props.onChange({ target: { value: school } }); tree = render(view); expect(text(tree)).toContain('No verified school list is loaded.'); expect(button(tree, 'Prepare CRM-only close')).toBeUndefined();
  oldClose.props.onBusy(true); tree = render(view); expect(elements(tree).find(e => e.type === 'fieldset')!.props.disabled).toBe(false);
 });
 it('invalidates all local state on pagehide/hidden session view, suppresses stale list results, and keys server renders by session only', async () => {
  const windowEvents = new EventTarget(), documentEvents = Object.assign(new EventTarget(), { visibilityState: 'visible' }); vi.stubGlobal('window', windowEvents); vi.stubGlobal('document', documentEvents);
  let release!: (r: Response) => void; const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = () => CrmLeadsWorkbench({ initialScope: { organizationId: org, schoolId: school } });
  let tree = render(view); submit(tree); tree = render(view); const key = elements(tree).find(e => e.type === CrmLeadCreatePanel)!.key;
  documentEvents.visibilityState = 'hidden'; documentEvents.dispatchEvent(new Event('visibilitychange')); tree = render(view);
  expect(elements(tree).find(e => e.type === CrmLeadCreatePanel)!.key).not.toBe(key);
  release(new Response(JSON.stringify({ data: [row], meta: {} }), { status: 200 })); await settle(); tree = render(view); expect(text(tree)).toContain('No verified school list is loaded.'); expect(text(tree)).not.toContain('Ari Stone'); expect(f).toHaveBeenCalledTimes(1);
  const afterHidden = elements(tree).find(e => e.type === CrmLeadCreatePanel)!.key; windowEvents.dispatchEvent(new Event('pagehide')); tree = render(view); expect(elements(tree).find(e => e.type === CrmLeadCreatePanel)!.key).not.toBe(afterHidden);
  const beforeBlur = elements(tree).find(e => e.type === CrmLeadCreatePanel)!.key; windowEvents.dispatchEvent(new Event('blur')); tree = render(view); expect(elements(tree).find(e => e.type === CrmLeadCreatePanel)!.key).not.toBe(beforeBlur);
  const first = await LeadPage({ searchParams: Promise.resolve({ organizationId: org, schoolId: school, pipelineId: stage } as any) }); session.token=issueSession({externalSubject:'second-fixture-staff'},signedConfig); const second = await LeadPage({ searchParams: Promise.resolve({ organizationId: org, schoolId: school }) });
  expect(first.key).not.toBe(second.key); expect(first.props.initialScope).toEqual({ organizationId: org, schoolId: school }); expect(JSON.stringify(first)).not.toContain('first-test-session');
 });
 it('statically has no persistence, request effects, polling, directory, campaign or other-domain command', () => {
  const panel = readFileSync('src/components/crm-lead-create-panel.tsx', 'utf8'), http = readFileSync('src/components/crm-lead-create-http.ts', 'utf8');
  expect(panel + http).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|loadCrmLeads|setLeads|executeAction|invokeLLM|sendMessage|\/crm\/pipelines|\/people|\/appointments|\/trials|\/follow-ups|\/enroll|\/billing/);
  expect(panel).toContain('useEffect(() => () => { epoch.current++; }, [])'); expect(panel).not.toContain('CrmLeadClosePanel');
  expect(http).toContain("'X-HON-Human-Command': 'crm-lead-create'");
 });
});
