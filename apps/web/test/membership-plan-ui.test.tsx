import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, expect, it, vi, type MockInstance } from 'vitest';
import { MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, type MembershipPaymentOption, type MembershipPlanSetup, type MembershipPlanListing } from '@hon/contracts';
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
const setupOf = (p: { planId: string; version: number }, options: MembershipPaymentOption[] = [{ optionNo: 1, label: 'Standard payment', priceMinor: 14900, billingFrequency: 'MONTHLY', payments: null, termMonths: null, downPaymentMinor: null, checkoutEnabled: true }]) =>
  ({ planId: p.planId, version: p.version, derived: false, classesPerWeek: 2, features: ['Belt testing included'], paymentOptions: options }) as MembershipPlanSetup;
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
  f.mockResolvedValueOnce(response({ plans: [listing], programs: [] })).mockResolvedValueOnce(response({ setups: [setupOf(listing)] }));
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
    .mockResolvedValueOnce(response({ plans: [], programs: [] })).mockResolvedValueOnce(response({ setups: [] }));
  view = () => SchoolMembershipCatalog(); click('Load my school plans'); await settle(); expect(f).toHaveBeenCalledTimes(2);
  expect(button(render(),'Load selected school plans').props.disabled).toBe(true); fill('School location', id(22)); click('Load selected school plans'); await settle();
  expect(String(f.mock.calls[2]![0])).toContain(id(22)); expect(text(render())).toContain('Second'); expect(text(render())).toContain('no published membership plans');
});
it('suppresses duplicate publishing, preserves an exact uncertain retry and distinguishes publication from current catalog', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); await catalogReady(f); click('New plan');
  const editor = elements(render()).find(e => e.type === MembershipPlanEditor)!;
  let fail!: (e: Error) => void; f.mockImplementationOnce(() => new Promise((_yes,no) => { fail = no; }));
  editor.props.onPublish(request()); editor.props.onPublish(request()); expect(f).toHaveBeenCalledTimes(4);
  fail(new Error('lost reply')); await settle(); expect(button(render(),'Reload catalog').props.disabled).toBe(true);
  f.mockResolvedValueOnce(response(plan,200,true)); click('Retry exact plan request'); await settle();
  expect(f.mock.calls[3]![0]).toBe(f.mock.calls[4]![0]); expect(f.mock.calls[3]![1]!.body).toBe(f.mock.calls[4]![1]!.body); expect(f.mock.calls[3]![1]!.headers).toEqual(f.mock.calls[4]![1]!.headers);
  expect(text(render())).toContain('Historical publication receipt'); expect(text(render())).toContain('Previously recorded plan version 1');
  expect(elements(render()).some(e => e.type === MembershipPlanEditor)).toBe(false);
});
it('invalidates a stale catalog review and ignores late responses after leaving the page', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); await catalogReady(f); click('New plan');
  f.mockResolvedValueOnce(response({ code: 'MEMBERSHIP_PLAN_VERSION_STALE' },409)); elements(render()).find(e => e.type === MembershipPlanEditor)!.props.onPublish(request()); await settle();
  expect(text(render())).toContain('Reload and review'); expect(elements(render()).some(e => e.type === MembershipPlanEditor)).toBe(false);
  let done!: (r: Response) => void; f.mockImplementationOnce(() => new Promise(yes => { done = yes; })); click('Reload catalog'); window.dispatchEvent(new Event('blur'));
  done(response({ plans: [listing], programs: [] })); await settle(); expect(text(render())).not.toContain('Adult Monthly'); expect(text(render())).toContain('Choose your school');
});
const nth = (t: Element, name: string, n: number) => elements(t).filter(e => e.type === 'label' && text(e).startsWith(name))[n]!;
function fillNth(name: string, n: number, value: string): void { elements(nth(render(), name, n)).find(e => ['input','select','textarea'].includes(String(e.type)))!.props.onChange({ target: { value } }); }
function editor(selected: MembershipPlanListing | null = null, setup: ReturnType<typeof setupOf> | null = null) {
  const publish = vi.fn(); view = () => MembershipPlanEditor({ scope, selected, setup: setup as never, programs: [{ programId: id(8), name: 'Little Tigers' }], disabled: false, onPublish: publish, onCancel() {} }); render(); return publish;
}
it('lays out a plan like the Manus form: name, program, several payment options, classes per week, features; publishes only after review and confirmation', () => {
  const publish = editor();
  expect(text(render())).toContain('Payment options'); expect(text(render())).toContain('Option 1 (standard)');
  fill('Plan name','Little Tigers'); fill('Program',id(8)); fillNth('Amount',0,'159'); click('Add option');
  fillNth('Option name',1,'6 monthly payments'); fillNth('Amount',1,'149'); fillNth('Number of payments',1,'6'); fillNth('Length in months',1,'6');
  elements(nth(render(),'Down payment at sign-up',1)).find(e => e.type === 'input')!.props.onChange({ target: { checked: true } }); fillNth('Down payment amount',0,'99');
  click('Add option'); fillNth('Option name',2,'1 year paid in full'); fillNth('Amount',2,'1590'); fillNth('How often',2,'PAID_IN_FULL'); fillNth('Length in months',2,'12');
  elements(nth(render(),'Offer this option on checkout pages',2)).find(e => e.type === 'input')!.props.onChange({ target: { checked: false } });
  fill('Classes per week','2'); fill('Features (one per line)','2 classes a week\nBelt testing included\n');
  submit(); expect(publish).not.toHaveBeenCalled(); expect(text(render())).toContain('Check and publish'); expect(text(render())).toContain('USD 1590 paid in full');
  submit(); expect(publish).not.toHaveBeenCalled(); agree(); submit();
  const sent = publish.mock.calls[0]![0]; expect(sent.kind).toBe('createOptions'); expect(sent.path).toContain('/membership-plans/with-options');
  expect(JSON.parse(sent.body)).toEqual({ planCode: 'LITTLE-TIGERS', displayName: 'Little Tigers', description: null, programId: id(8), availability: 'AVAILABLE', currency: 'USD', classesPerWeek: 2,
    features: ['2 classes a week', 'Belt testing included'], confirmation: MEMBERSHIP_PLAN_CHANGE_CONFIRMATION, paymentOptions: [
      { label: 'Standard payment', priceMinor: 15900, billingFrequency: 'MONTHLY', payments: null, termMonths: null, checkoutEnabled: true },
      { label: '6 monthly payments', priceMinor: 14900, billingFrequency: 'MONTHLY', payments: 6, termMonths: 6, downPaymentMinor: 9900, checkoutEnabled: true },
      { label: '1 year paid in full', priceMinor: 159000, billingFrequency: 'PAID_IN_FULL', payments: null, termMonths: 12, checkoutEnabled: false }] });
});
it.each([['QUARTERLY','','Option 1 is the standard price'],['PAID_IN_FULL','','Paid in full needs a length'],['ANNUAL','18','whole years']])('explains a %s option the server would refuse instead of sending it', (frequency, months, message) => {
  const publish = editor(); fill('Plan name','Adults'); fillNth('Amount',0,'100'); fillNth('How often',0,frequency!); if (months) fillNth('Length in months',0,months);
  submit(); expect(publish).not.toHaveBeenCalled(); expect(text(render())).toContain(message!);
});
it('edits an existing plan from its published options and sends the reviewed version', () => {
  const publish = editor(listing, setupOf(listing, [
    { optionNo: 1, label: 'Monthly', priceMinor: 14900, billingFrequency: 'MONTHLY', payments: null, termMonths: null, downPaymentMinor: null, checkoutEnabled: true },
    { optionNo: 2, label: 'Paid in full', priceMinor: 150000, billingFrequency: 'PAID_IN_FULL', payments: null, termMonths: 12, downPaymentMinor: 5000, checkoutEnabled: false }]));
  expect(elements(nth(render(),'Plan code',0)).find(e => e.type === 'input')!.props.readOnly).toBe(true);
  fillNth('Amount',0,'159'); click('Remove option 2'); fill('Offered to new students','UNAVAILABLE'); submit(); agree(); submit();
  const sent = publish.mock.calls[0]![0]; expect(sent.kind).toBe('reviseOptions'); expect(sent.path).toContain(`/membership-plans/${listing.planId}/option-revisions`);
  expect(JSON.parse(sent.body)).toMatchObject({ expectedVersion: 1, availability: 'UNAVAILABLE', features: ['Belt testing included'], classesPerWeek: 2,
    paymentOptions: [{ label: 'Monthly', priceMinor: 15900, billingFrequency: 'MONTHLY' }] });
  expect(text(render())).toContain('keep the version they joined with');
});
it('shows each plan with its payment options on the plans page', async () => {
  const f = vi.spyOn(globalThis, 'fetch'); await catalogReady(f);
  expect(String(f.mock.calls[2]![0])).toContain('/membership-plans/setups'); expect((f.mock.calls[2]![1]!.headers as Record<string, string>)['X-HON-Human-Command']).toBe('membership-plan-setups-read');
  const t = text(render()); expect(t).toContain('Standard payment'); expect(t).toContain('USD 149 / month · ongoing'); expect(t).toContain('Belt testing included'); expect(t).toContain('2 classes a week');
  click('Edit Adult Monthly'); expect(elements(render()).find(e => e.type === MembershipPlanEditor)!.props.setup).toEqual(setupOf(listing));
});
it('requires explicit options, selection, version review and confirmation before creating a plan-bound DRAFT', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({ plans:[listing,{ ...listing,planId:id(33),planCode:'KRW-ADULT',currency:'KRW' }] })).mockResolvedValueOnce(response({ receipt,plan }));
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
  expect(callbacks.onBlocking).toHaveBeenLastCalledWith(true); expect(button(render(),'Reload available membership plans').props.disabled).toBe(true);
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
