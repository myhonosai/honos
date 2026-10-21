import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, type MembershipPlanListing } from '@hon/contracts';
import { SchoolMembershipCatalog } from '../src/components/membership-plans/catalog';
import { MembershipPlanEditor } from '../src/components/membership-plans/editor';
import { AdultMembershipPlanPicker } from '../src/components/membership-plans/picker';
import { createPlanRequest } from '../src/components/membership-plans/http';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ money: (v: number, c: string) => `${c} ${v / 100}`, date: (v: string) => v }) }));
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
 useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.values[i]) : value; }]; },
 useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
 useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
 }; });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) }, date = '2026-10-21T09:00:00.000Z';
const terms = { displayName: 'Adult Monthly', description: null, programId: null, availability: 'AVAILABLE' as const, currency: 'USD', priceMinor: 14900, billingFrequency: 'MONTHLY' as const, termKind: 'OPEN_ENDED' as const, termMonths: null };
const plan = { ...terms, planCode: 'ADULT', planId: id(3), version: 1, publishedAt: date };
const listing: MembershipPlanListing = { ...plan, programName: null };
const request = () => createPlanRequest(scope, { ...terms, planCode: 'ADULT', confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION }, id(10));
const receipt = { membershipId: id(7), state: 'DRAFT', planCode: 'ADULT', termStartedAt: null, termEndsAt: null, recordedAt: date };
const response = (data: unknown, status = 200, replayed = false) => new Response(JSON.stringify(status === 200 ? { data, meta: { requestId: id(9), correlationId: id(9), replayed } } : data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
let view: () => ReactElement;
function render(): Element { hooks.cursor = 0; const t = view() as Element; hooks.effects.splice(0).forEach(run => run()); return t; }
function unmount(): void { for (const v of hooks.values) if (v && typeof v === 'object' && 'cleanup' in v) (v as { cleanup?: () => void }).cleanup?.(); }
const button = (t: Element, name: string) => elements(t).find(e => e.type === 'button' && text(e) === name)!;
const field = (t: Element, name: string) => elements(t).find(e => e.type === 'label' && text(e).startsWith(name))!;
function fill(name: string, value: string): Element { const e = elements(field(render(), name)).find(e => ['input','select','textarea'].includes(String(e.type)))!; e.props.onChange({ target: { value } }); return render(); }
function agree(): void { elements(render()).find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); }
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function click(name: string): void { button(render(), name).props.onClick(); }
function submit(): void { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget()); });
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const callbacks = { onBlocking: vi.fn(), onStarted: vi.fn(), onCreated: vi.fn(), onAccessLost: vi.fn(), onNeedsRefresh: vi.fn() };
function picker(currency = 'USD'): void { view = () => AdultMembershipPlanPicker({ scope, studentProfileId: id(5), currency, disabled: false, ...callbacks }); render(); }
function pickerReady(): void { fill('Available membership plan', plan.planId); click('Review membership DRAFT'); agree(); }
async function catalogReady(f: MockInstance<typeof fetch>): Promise<void> {
  f.mockResolvedValueOnce(new Response(JSON.stringify({ data: { state: 'RESOLVED', ...scope } }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }));
  f.mockResolvedValueOnce(response({ plans: [listing], programs: [] }));
  view = () => SchoolMembershipCatalog(); render(); expect(f).not.toHaveBeenCalled(); click('Load my school plans'); await settle();
}
it('requires an explicit catalog load, uses authorized scope and clears private terms on permission loss', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); await catalogReady(f);
  expect(f.mock.calls[0]![0]).toBe('/api/v1/staff/current-reporting-school'); expect(String(f.mock.calls[1]![0])).toContain(scope.schoolId);
  expect(text(render())).toContain('Adult Monthly'); f.mockResolvedValueOnce(response({ code: 'private-canary' }, 403)); click('Reload catalog'); await settle();
  expect(text(render())).not.toContain('Adult Monthly'); expect(text(render())).toContain('session or plan-management access'); expect(text(render())).not.toContain('private-canary');
});
it('requires a verified multi-school choice instead of guessing identifiers', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: { state: 'MANUAL_ENTRY_REQUIRED' } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { state: 'SELECTION_REQUIRED', schools: [{ ...scope, organizationName: 'Organization', schoolName: 'First' }, { organizationId: id(1), schoolId: id(22), organizationName: 'Organization', schoolName: 'Second' }] } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }))
    .mockResolvedValueOnce(response({ plans: [], programs: [] }));
  view = () => SchoolMembershipCatalog(); click('Load my school plans'); await settle(); expect(f).toHaveBeenCalledTimes(2);
  expect(button(render(),'Load selected school plans').props.disabled).toBe(true); fill('School location', id(22)); click('Load selected school plans'); await settle();
  expect(String(f.mock.calls[2]![0])).toContain(id(22)); expect(text(render())).toContain('Second'); expect(text(render())).toContain('no published membership plans');
});
it('suppresses duplicate publishing, preserves an exact uncertain retry and distinguishes publication from current catalog', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); await catalogReady(f); click('Create plan');
  const editor = elements(render()).find(e => e.type === MembershipPlanEditor)!;
  let fail!: (e: Error) => void; f.mockImplementationOnce(() => new Promise((_yes,no) => { fail = no; }));
  editor.props.onPublish(request()); editor.props.onPublish(request()); expect(f).toHaveBeenCalledTimes(3);
  fail(new Error('lost reply')); await settle(); expect(button(render(),'Reload catalog').props.disabled).toBe(true);
  f.mockResolvedValueOnce(response(plan,200,true)); click('Retry exact plan request'); await settle();
  expect(f.mock.calls[2]![0]).toBe(f.mock.calls[3]![0]); expect(f.mock.calls[2]![1]!.body).toBe(f.mock.calls[3]![1]!.body); expect(f.mock.calls[2]![1]!.headers).toEqual(f.mock.calls[3]![1]!.headers);
  expect(text(render())).toContain('Historical publication receipt'); expect(text(render())).toContain('Previously recorded plan version 1');
  expect(elements(render()).some(e => e.type === MembershipPlanEditor)).toBe(false);
});
it('invalidates a stale catalog review and ignores late responses after leaving the page', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); await catalogReady(f); click('Create plan');
  f.mockResolvedValueOnce(response({ code: 'MEMBERSHIP_PLAN_VERSION_STALE' },409)); elements(render()).find(e => e.type === MembershipPlanEditor)!.props.onPublish(request()); await settle();
  expect(text(render())).toContain('Reload and review'); expect(elements(render()).some(e => e.type === MembershipPlanEditor)).toBe(false);
  let done!: (r: Response) => void; f.mockImplementationOnce(() => new Promise(yes => { done = yes; })); click('Reload catalog'); window.dispatchEvent(new Event('blur'));
  done(response({ plans: [listing], programs: [] })); await settle(); expect(text(render())).not.toContain('Adult Monthly'); expect(text(render())).toContain('Choose your school');
});
it.each([['MONTHLY','OPEN_ENDED',''],['WEEKLY','OPEN_ENDED',''],['ANNUAL','FIXED_MONTHS','12'],['PAID_IN_FULL','FIXED_MONTHS','6']])('reviews %s terms and never publishes before explicit confirmation', (frequency, term, months) => {
  const publish = vi.fn(); view = () => MembershipPlanEditor({ scope, selected: null, programs: [{ programId: id(8), name: 'Adult program' }], disabled: false, onPublish: publish, onCancel() {} });
  fill('Plan name','Adult Monthly'); fill('Plan code','ADULT'); fill('Published price','149.01'); fill('School program',id(8)); fill('Billing frequency',frequency!); fill('Membership term',term!); if (months) fill('Term in months',months);
  submit(); expect(publish).not.toHaveBeenCalled(); expect(text(render())).toContain('Review published terms'); submit(); expect(publish).not.toHaveBeenCalled(); agree(); submit();
  expect(JSON.parse(publish.mock.calls[0]![0].body)).toMatchObject({ priceMinor:14901,programId:id(8),billingFrequency:frequency,termKind:term });
});
it('publishes a revision against the reviewed version, including marking it unavailable without deleting history', () => {
  const publish = vi.fn(); view = () => MembershipPlanEditor({ scope, selected: listing, programs: [], disabled: false, onPublish: publish, onCancel() {} });
  expect(elements(field(render(),'Plan code')).find(e => e.type === 'input')!.props.readOnly).toBe(true);
  fill('Published price','159'); fill('Availability','UNAVAILABLE'); submit(); agree(); submit();
  expect(JSON.parse(publish.mock.calls[0]![0].body)).toMatchObject({ expectedVersion:1,priceMinor:15900,availability:'UNAVAILABLE' }); expect(text(render())).toContain('Existing memberships keep their original plan version');
});
it('requires explicit options, selection, version review and confirmation before creating a plan-bound DRAFT', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({ plans:[listing,{ ...listing,planId:id(33),currency:'KRW' }] })).mockResolvedValueOnce(response({ receipt,plan }));
  picker(); expect(f).not.toHaveBeenCalled(); click('Load available membership plans'); await settle();
  expect(elements(render()).find(e => e.type === 'option' && e.props.value === id(33))!.props.disabled).toBe(true);
  expect(button(render(),'Review membership DRAFT')).toBeUndefined(); pickerReady(); click('Create DRAFT from selected plan'); await settle();
  expect(callbacks.onCreated).toHaveBeenCalledWith({receipt,plan},false);
  expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ studentProfileId:id(5),membershipPlanId:id(3),membershipPlanVersion:1,confirmation:'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT_FROM_PLAN' });
  expect(text(render())).not.toContain('active membership');
});
it('blocks parallel commands and retries only the same DRAFT request after an uncertain reply', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({plans:[listing]})); picker(); click('Load available membership plans'); await settle(); pickerReady();
  let fail!: (e: Error) => void; f.mockImplementationOnce(() => new Promise((_yes,no) => { fail = no; }));
  const b = button(render(),'Create DRAFT from selected plan'); b.props.onClick(); b.props.onClick(); expect(f).toHaveBeenCalledTimes(2); fail(new Error('lost')); await settle();
  expect(callbacks.onBlocking).toHaveBeenLastCalledWith(true); expect(button(render(),'Load available membership plans').props.disabled).toBe(true);
  f.mockResolvedValueOnce(response({receipt,plan},200,true)); click('Retry exact DRAFT request'); await settle();
  expect(f.mock.calls[1]![1]!.body).toBe(f.mock.calls[2]![1]!.body); expect(f.mock.calls[1]![1]!.headers).toEqual(f.mock.calls[2]![1]!.headers); expect(callbacks.onCreated).toHaveBeenCalledWith({receipt,plan},true);
});
it.each([['MEMBERSHIP_PLAN_VERSION_STALE',409],['MEMBERSHIP_PLAN_UNAVAILABLE',404],['MEMBERSHIP_PLAN_CURRENCY_MISMATCH',409]])('does not silently resubmit %s with a new version or currency', async (code,status) => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({plans:[listing]})).mockResolvedValueOnce(response({code},status as number)); picker(); click('Load available membership plans'); await settle(); pickerReady(); click('Create DRAFT from selected plan'); await settle();
  expect(callbacks.onCreated).not.toHaveBeenCalled(); expect(f).toHaveBeenCalledTimes(2); expect(button(render(),'Create DRAFT from selected plan')).toBeUndefined(); expect(button(render(),'Load available membership plans')).toBeDefined();
  if (code === 'MEMBERSHIP_PLAN_CURRENCY_MISMATCH') expect(callbacks.onNeedsRefresh).toHaveBeenCalledTimes(1);
});
it('forgets picker state on unmount and propagates session loss without exposing a receipt', async () => {
  let done!: (r: Response) => void; const f = vi.spyOn(globalThis,'fetch').mockImplementationOnce(() => new Promise(yes => { done = yes; })); picker(); click('Load available membership plans'); unmount(); done(response({plans:[listing]})); await settle(); expect(text(render())).not.toContain('Adult Monthly');
  f.mockResolvedValueOnce(response({},401)); click('Load available membership plans'); await settle(); expect(callbacks.onAccessLost).toHaveBeenCalledTimes(1); expect(callbacks.onCreated).not.toHaveBeenCalled();
});
