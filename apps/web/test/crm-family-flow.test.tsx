import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { CrmGuardianChildEnrollment, CrmGuardianChildFamilyState, CrmGuardianChildChildState } from '@hon/contracts';
import { CrmFamilyFlow } from '../src/components/crm-family-flow';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';
import { AdultMembershipPlanPicker } from '../src/components/membership-plans/picker';
import { family, scope, id, row, date, response, registration, receipt, plan, listing, payer } from './crm-family-fixtures';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ date: (v: string) => `Localized ${v}` }) }));
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.values[i]) : value; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
}; });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
let view: () => ReactElement;
function render(): Element { hooks.cursor = 0; const t = view() as Element; hooks.effects.splice(0).forEach(run => run()); return t; }
function unmount(): void { for (const v of hooks.values) if (v && typeof v === 'object' && 'cleanup' in v) (v as { cleanup?: () => void }).cleanup?.(); }
const button = (name: string) => elements(render()).find(e => e.type === 'button' && text(e) === name)!;
const click = (name: string) => button(name).props.onClick();
function fill(label: string, value: string): void { const field = elements(render()).find(e => e.type === 'label' && text(e).startsWith(label))!; elements(field).find(e => ['input','select'].includes(String(e.type)))!.props.onChange({ target: { value } }); }
function agree(): void { elements(render()).find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); }
function submit(): void { elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const callbacks = { onBusy: vi.fn(), onStarted: vi.fn(), onAccessLost: vi.fn(), onCancel: vi.fn(), onAdult: vi.fn() };
const pickerCallbacks = { onBlocking: vi.fn(), onStarted: vi.fn(), onCreated: vi.fn(), onAccessLost: vi.fn(), onNeedsRefresh: vi.fn() };
function start(data = family()): void { view = () => CrmFamilyFlow({ scope, row, initialFamily: data, ...callbacks }); render(); }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget()); });
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['NOT_REGISTERED','NEEDS_STAFF_REVIEW','ADULT_REGISTRATION','BILLING_ACCOUNT_REQUIRED','PAYER_DESIGNATION_REQUIRED','PAYER_DESIGNATED'] as CrmGuardianChildFamilyState[])('renders %s from verified recovery without automatically commanding', state => {
  const f = vi.spyOn(globalThis, 'fetch'); start(family(state)); expect(f).not.toHaveBeenCalled();
  expect(text(render())).toContain('Family setup for Ari Stone');
  if (state === 'NEEDS_STAFF_REVIEW') { expect(text(render())).toContain('Existing records are preserved'); expect(elements(render()).some(e => e.type === 'form')).toBe(false); }
  if (state === 'ADULT_REGISTRATION') { click('Open adult Resume Setup'); expect(callbacks.onAdult).toHaveBeenCalledOnce(); }
});
it.each(['AWAITING_PAYER_DESIGNATION','READY_FOR_DRAFT','CURRENT_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF','NEEDS_STAFF_REVIEW'] as CrmGuardianChildChildState[])('renders child state %s without widening DRAFT permissions', state => {
  start(family(state === 'AWAITING_PAYER_DESIGNATION' ? 'PAYER_DESIGNATION_REQUIRED' : 'PAYER_DESIGNATED', state));
  elements(render()).find(e => e.type === 'button' && text(e).startsWith('Kai Stone'))!.props.onClick();
  const output = text(render());
  if (state === 'CURRENT_DRAFT') expect(output).toContain('Original bound plan version');
  if (state === 'CURRENT_DRAFT_BY_OTHER_STAFF') { expect(output).toContain('confirmation, editing, transfer and activation controls are unavailable'); expect(output).not.toContain(receipt.membershipId); expect(elements(render()).some(e => e.type === AdultMembershipPlanPicker)).toBe(false); }
  expect(elements(render()).some(e => e.type === AdultMembershipPlanPicker)).toBe(state === 'READY_FOR_DRAFT');
});
it('guides registration, canonical account and explicit payer designation with distinct command keys and fresh reads', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(registration)).mockResolvedValueOnce(response(family('BILLING_ACCOUNT_REQUIRED')))
    .mockResolvedValueOnce(response({ id: id(20), responsiblePersonId: id(4), currency: 'USD', classification: 'CANONICAL', reused: true, version: 1, createdAt: date }, 201)).mockResolvedValueOnce(response(family('PAYER_DESIGNATION_REQUIRED')))
    .mockResolvedValueOnce(response(payer)).mockResolvedValueOnce(response(family()));
  start(family('NOT_REGISTERED')); fill('Child given name','Kai'); fill('Child family name','Stone'); fill('Child date of birth','2016-02-03'); submit(); expect(f).not.toHaveBeenCalled(); agree(); submit(); await settle();
  expect(button('Create or reuse guardian account').props.disabled).toBe(true); agree(); submit(); await settle();
  expect(text(render())).toContain('Existing canonical guardian account reused'); expect(button('Designate guardian payer').props.disabled).toBe(true);
  expect(JSON.parse(String(f.mock.calls[2]![1]!.body))).toEqual({ responsiblePersonId: id(4), currency: 'USD' });
  agree(); submit(); await settle(); expect(text(render())).toContain('Guardian payer designation verified');
  const keys = [0,2,4].map(i => (f.mock.calls[i]![1]!.headers as Record<string,string>)['Idempotency-Key']); expect(new Set(keys).size).toBe(3);
  expect([1,3,5].every(i => f.mock.calls[i]![1]!.body === '{}')).toBe(true);
});
it('suppresses duplicate submissions and retains an exact uncertain payer request', async () => {
  let reject!: (e: Error) => void;
  const f = vi.spyOn(globalThis,'fetch').mockImplementationOnce(() => new Promise((_yes,no) => { reject = no; })).mockResolvedValueOnce(response(payer,200,true)).mockResolvedValueOnce(response(family()));
  start(family('PAYER_DESIGNATION_REQUIRED')); agree(); submit(); submit(); expect(f).toHaveBeenCalledOnce();
  reject(new Error('lost response')); await settle(); expect(button('Refresh family setup').props.disabled).toBe(true);
  click('Retry exact family request'); await settle(); expect(f.mock.calls[0]![0]).toBe(f.mock.calls[1]![0]); expect(f.mock.calls[0]![1]!.body).toBe(f.mock.calls[1]![1]!.body); expect(f.mock.calls[0]![1]!.headers).toEqual(f.mock.calls[1]![1]!.headers);
});
it('requires refresh after a rejected designation and clears authority on permission loss', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({ code:'CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE' },404));
  start(family('PAYER_DESIGNATION_REQUIRED')); agree(); submit(); await settle(); expect(text(render())).toContain('Current family progress is unavailable'); expect(elements(render()).some(e => e.type === 'form')).toBe(false);
  f.mockResolvedValueOnce(response({ code:'private-canary' },403)); click('Refresh family setup'); await settle(); expect(callbacks.onAccessLost).toHaveBeenCalledOnce(); expect(text(render())).not.toContain('private-canary');
});
it('adds a separate child, leaves ambiguous identities unchanged and enforces 10 TOTAL', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({ outcome:'NEEDS_STAFF_REVIEW' })).mockResolvedValueOnce(response(family()));
  start(); fill('Child given name','Kai'); fill('Child family name','Stone'); fill('Child date of birth','2016-02-03'); agree(); submit(); await settle(); expect(text(render())).toContain('no child was created or merged');
  unmount(); hooks.values=[]; const data = family(); if (!('children' in data)) throw Error();
  const full: CrmGuardianChildEnrollment = { ...data, children: Array.from({length:10},(_,i) => ({...data.children[0]!,studentProfileId:i ? id(100+i) : id(5),origin:i ? 'ADDITIONAL_CHILD' : 'CRM_REGISTRATION'})) };
  start(full); expect(text(render())).toContain('maximum of 10 children'); expect(button('Add child')).toBeUndefined();
});
it('binds each selected child picker independently and keeps creation evidence historical until recovery', async () => {
  const data = family(); if (!('children' in data)) throw Error();
  start({ ...data, children: [...data.children,{...data.children[0]!,studentProfileId:id(12),displayName:'Mina Stone',origin:'ADDITIONAL_CHILD'}] });
  elements(render()).find(e => e.type === 'button' && text(e).startsWith('Mina Stone'))!.props.onClick();
  const picker = elements(render()).find(e => e.type === AdultMembershipPlanPicker)!; expect(picker.props.studentProfileId).toBe(id(12)); expect(picker.props.childName).toBe('Mina Stone'); expect(picker.props.currency).toBe('USD');
  picker.props.onCreated({receipt,plan},false); expect(text(render())).toContain('Historical DRAFT creation receipt for Mina Stone'); expect(text(render())).not.toContain('Current DRAFT verified'); expect(elements(render()).some(e => e.type === AdultMembershipPlanPicker)).toBe(false);
  const currentFamily: CrmGuardianChildEnrollment = { ...data, children: [data.children[0]!, { ...data.children[0]!, studentProfileId:id(12), displayName:'Mina Stone', origin:'ADDITIONAL_CHILD', workflowState:'CURRENT_DRAFT', currentMembershipDraft:{state:'RECORDED_DRAFT',receipt,plan} }] };
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response(currentFamily)); click('Refresh family setup'); await settle();
  expect(text(render())).toContain('Current family setup verified'); expect(text(render())).not.toContain('Historical DRAFT creation receipt for Mina Stone'); expect(text(render())).not.toContain('Refresh family setup to verify its current status');
});
it('ignores late recovery responses after leaving the family context', async () => {
  let resolve!: (r:Response) => void; vi.spyOn(globalThis,'fetch').mockImplementationOnce(() => new Promise(yes => { resolve=yes; }));
  start(family('BILLING_ACCOUNT_REQUIRED')); click('Refresh family setup'); unmount(); resolve(response(family())); await settle(); expect(text(render())).not.toContain('Guardian payer designation verified');
});
it('uses the child API, exact version and explicit child confirmation through the shared published-plan picker', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({plans:[listing,{...listing,planId:id(33),planCode:'KRW-JUNIOR',currency:'KRW'}]})).mockResolvedValueOnce(response({receipt,plan}));
  view = () => AdultMembershipPlanPicker({scope,studentProfileId:id(12),currency:'USD',childName:'Mina Stone',disabled:false,...pickerCallbacks}); render(); click('Load available membership plans'); await settle();
  expect(elements(render()).find(e => e.type==='option' && e.props.value===id(33))!.props.disabled).toBe(true);
  fill('Available membership plan',plan.planId); click('Review membership DRAFT'); expect(text(render())).toContain('confirm the membership DRAFT for Mina Stone'); expect(button('Create DRAFT from selected plan').props.disabled).toBe(true);
  agree(); click('Create DRAFT from selected plan'); await settle();
  expect(String(f.mock.calls[1]![0])).toContain('/billing/crm-guardian-child-membership-drafts/from-plan');
  expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toMatchObject({studentProfileId:id(12),membershipPlanVersion:1,confirmation:'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN'});
  expect(pickerCallbacks.onCreated).toHaveBeenCalledWith({receipt,plan},false);
});
it('invalidates a stale child plan review rather than automatically resubmitting', async () => {
  const f = vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({plans:[listing]})).mockResolvedValueOnce(response({code:'MEMBERSHIP_PLAN_VERSION_STALE'},409));
  view=()=>AdultMembershipPlanPicker({scope,studentProfileId:id(5),currency:'USD',childName:'Kai Stone',disabled:false,...pickerCallbacks}); render(); click('Load available membership plans'); await settle(); fill('Available membership plan',plan.planId); click('Review membership DRAFT'); agree(); click('Create DRAFT from selected plan'); await settle();
  expect(text(render())).toContain('Reload available plans and review the new version'); expect(button('Create DRAFT from selected plan')).toBeUndefined(); expect(pickerCallbacks.onCreated).not.toHaveBeenCalled(); expect(f).toHaveBeenCalledTimes(2);
});
it('opens recovery explicitly, conceals all CRM data on blur, then clears memory on pagehide/school switch', async () => {
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce({ok:true,status:200,json:async()=>({data:[row],meta:{}})} as Response).mockResolvedValueOnce(response(family()));
  view=()=>CrmLeadsWorkbench({initialScope:scope,sessionSubject:"family-staff"}); render(); expect(f).not.toHaveBeenCalled();
  elements(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}}); await settle(); click('Set up / resume family'); await settle(); expect(elements(render()).some(e=>e.type===CrmFamilyFlow)).toBe(true);
  window.dispatchEvent(new Event('blur')); expect(elements(render()).some(e=>e.type===CrmFamilyFlow)).toBe(true); expect(elements(render()).some(e=>e.type==='div' && e.props.hidden===true && e.props.inert===true)).toBe(true); expect(text(render())).toContain('CRM information hidden');
  window.dispatchEvent(new Event('pagehide')); expect(elements(render()).some(e=>e.type===CrmFamilyFlow)).toBe(false);
  fill('School UUID',id(22)); expect(elements(render()).some(e=>e.type===CrmFamilyFlow)).toBe(false); expect(f).toHaveBeenCalledTimes(2);
});

function privacyHidden(): boolean { return elements(render()).some(e => e.type === 'div' && e.props.hidden === true && e.props.inert === true); }
const identityResponse = (subject = 'family-staff') => new Response(JSON.stringify({data:{externalSubject:subject}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function openFamilyWorkbench(f: ReturnType<typeof vi.spyOn>): Promise<void> {
  f.mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response(family()));
  view=()=>CrmLeadsWorkbench({initialScope:scope,sessionSubject:'family-staff'});render();
  elements(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();click('Set up / resume family');await settle();
}
it('reveals nothing on focus alone and explicitly verifies session, school and family before restoring', async()=>{
  const f=vi.spyOn(globalThis,'fetch');await openFamilyWorkbench(f);window.dispatchEvent(new Event('blur'));expect(privacyHidden()).toBe(true);
  window.dispatchEvent(new Event('focus'));await settle();expect(f).toHaveBeenCalledTimes(2);expect(privacyHidden()).toBe(true);
  f.mockResolvedValueOnce(identityResponse()).mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response(family())).mockResolvedValueOnce(identityResponse());
  click('Verify access and resume');click('Verify access and resume');await settle();expect(privacyHidden()).toBe(false);expect(f).toHaveBeenCalledTimes(6);
  expect(f.mock.calls.slice(2).every(([,options])=>!(options?.headers as Record<string,string>)?.['Idempotency-Key'])).toBe(true);
});
it.each([401,403])('discards private enrollment and retries after denied restoration %s',async status=>{
  const f=vi.spyOn(globalThis,'fetch');await openFamilyWorkbench(f);window.dispatchEvent(new Event('blur'));
  f.mockResolvedValueOnce(identityResponse()).mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response({code:'private-canary'},status));
  click('Verify access and resume');await settle();expect(elements(render()).some(e=>e.type===CrmFamilyFlow)).toBe(false);expect(text(render())).not.toContain('private-canary');
  expect(elements(render()).filter(e=>e.type==='input').map(e=>e.props.value)).toEqual(['','']);
});
it('rejects another signed-in user and never reveals old family or command memory',async()=>{
  const f=vi.spyOn(globalThis,'fetch');await openFamilyWorkbench(f);window.dispatchEvent(new Event('blur'));f.mockResolvedValueOnce(identityResponse('another-staff'));
  click('Verify access and resume');await settle();expect(elements(render()).some(e=>e.type===CrmFamilyFlow)).toBe(false);expect(f).toHaveBeenCalledTimes(3);
});
it.each([404,409,503])('keeps private data hidden when fresh recovery fails with %s',async status=>{
  const f=vi.spyOn(globalThis,'fetch');await openFamilyWorkbench(f);window.dispatchEvent(new Event('blur'));
  f.mockResolvedValueOnce(identityResponse()).mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response({},status));click('Verify access and resume');await settle();
  expect(privacyHidden()).toBe(true);expect(text(render())).toContain('CRM information remains hidden');
});
it('ignores a late successful restore after focus is lost again',async()=>{
  const f=vi.spyOn(globalThis,'fetch');await openFamilyWorkbench(f);window.dispatchEvent(new Event('blur'));
  let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identityResponse()).mockResolvedValueOnce(response([row])).mockImplementationOnce(()=>new Promise(yes=>{finish=yes;})).mockResolvedValueOnce(identityResponse());
  click('Verify access and resume');await settle();window.dispatchEvent(new Event('blur'));finish(response(family()));await settle();expect(privacyHidden()).toBe(true);
});
it('retains the exact uncertain child DRAFT outside the picker through fresh family revalidation',async()=>{
  const data=family();start(data);elements(render()).find(e=>e.type==='button'&&text(e).startsWith('Kai Stone'))!.props.onClick();
  const picker=elements(render()).find(e=>e.type===AdultMembershipPlanPicker)!;
  const {familyRequest}=await import('../src/components/crm-family-http');
  const {CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION}=await import('@hon/contracts');
  const request=familyRequest(scope,'childDraft',id(5),{studentProfileId:id(5),membershipPlanId:plan.planId,membershipPlanVersion:1,confirmation:CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION},id(10));
  picker.props.onUncertain(request);let freshData=family();view=()=>CrmFamilyFlow({scope,row,initialFamily:freshData,...callbacks});render();render();
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({receipt,plan},200,true));click('Retry exact family request');await settle();expect(f.mock.calls[0]![1]!.body).toBe(request.body);expect((f.mock.calls[0]![1]!.headers as Record<string,string>)['Idempotency-Key']).toBe(request.key);expect(text(render())).toContain('Historical DRAFT creation receipt for Kai Stone');
});
