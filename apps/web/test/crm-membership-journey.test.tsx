import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CrmLeadRegistrationRecovery } from '@hon/contracts';
import { CrmMembershipJourney } from '../src/components/crm-membership-journey';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';
import { CrmAdultFlow } from '../src/components/crm-adult-flow';
import { CrmFamilyFlow } from '../src/components/crm-family-flow';
import { MembershipActivationWorkbench } from '../src/components/membership-activation-workbench';
import { MembershipDatesWorkbench } from '../src/components/membership-dates-workbench';
import { AdultMembershipPlanPicker } from '../src/components/membership-plans/picker';
import { membershipJourneyCopy } from '../src/components/crm-membership-journey-copy';
import { family, scope, row, id, receipt, plan, date, response } from './crm-family-fixtures';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], language: 'en' as 'en' | 'ko' | 'es' }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ date: (value: string) => value, preferences: { language: hooks.language } }) }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.values[i]) : value; }]; },
  useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
}; });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' ? node : ''; }
let view: () => ReactElement;
function render(): Element { hooks.cursor = 0; const tree = view() as Element; hooks.effects.splice(0).forEach(run => run()); return tree; }
function unmount(): void { for (const value of hooks.values) if (value && typeof value === 'object' && 'cleanup' in value) (value as { cleanup?: () => void }).cleanup?.(); }
function reset(): void { unmount(); hooks.values = []; hooks.effects = []; hooks.cursor = 0; }
const button = (label: string) => elements(render()).find(e => e.type === 'button' && text(e) === label);
const click = (label: string) => button(label)!.props.onClick();
const component = (type: unknown) => elements(render()).find(e => e.type === type)!;
const settle = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
const reviewLabel = () => membershipJourneyCopy[hooks.language].review;
const target = { ...scope, membershipId: receipt.membershipId };
const callbacks = { onCancel: vi.fn(), onBusy: vi.fn(), onStarted: vi.fn(), onAccessLost: vi.fn(), onAdult: vi.fn(), onMembershipReview: vi.fn() };
const adultRegistration = { outcome: 'REGISTERED' as const, leadId: row.id, sourceContactPersonId: row.primaryPersonId, registrationPath: 'ADULT' as const, studentProfileId: id(5), familyId: null, recordedAt: date };
const adultBase = { leadId: row.id, historicalRegistrationReceipt: adultRegistration, billingAccount: { classification: 'CANONICAL' as const, currency: 'USD' } };
function adultCurrent(): CrmLeadRegistrationRecovery { return { ...adultBase, workflowState: 'CURRENT_DRAFT', currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt } }; }
function startAdult(initialRecovery = adultCurrent(), connected = true): void { view = () => CrmAdultFlow({ ...scope, row, initialRecovery, ...callbacks, ...(!connected ? { onMembershipReview: undefined } : {}) } as Parameters<typeof CrmAdultFlow>[0]); render(); }
function startFamily(data = family('PAYER_DESIGNATED', 'CURRENT_DRAFT')): void { view = () => CrmFamilyFlow({ scope, row, initialFamily: data, ...callbacks }); render(); }
function selectChild(name = 'Kai Stone'): void { elements(render()).find(e => e.type === 'button' && text(e).startsWith(name))!.props.onClick(); }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.language = 'en'; vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); });
afterEach(() => { unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('preserves standalone CRM behavior unless the optional handoff is provided', () => {
  const fetch = vi.spyOn(globalThis, 'fetch'); startAdult(adultCurrent(), false);
  expect(button(reviewLabel())).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
});
it.each(['en','ko','es'] as const)('offers a localized explicit creator-DRAFT handoff in %s with only three selectors', language => {
  hooks.language = language; const fetch = vi.spyOn(globalThis, 'fetch'); startAdult();
  const handler = button(reviewLabel())!.props.onClick; handler(); handler();
  expect(callbacks.onMembershipReview).toHaveBeenCalledExactlyOnceWith(target); expect(fetch).not.toHaveBeenCalled();
  expect(Object.keys(callbacks.onMembershipReview.mock.calls[0]![0]).sort()).toEqual(['membershipId','organizationId','schoolId']);
});
it.each(['NOT_REGISTERED','NEEDS_STAFF_REVIEW','READY_FOR_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF'] as const)('does not offer review for adult %s', state => {
  const initial = state === 'CURRENT_DRAFT_BY_OTHER_STAFF' ? { ...adultBase, workflowState: state, currentMembershipDraft: { state: 'RECORDED_DRAFT' } }
    : state === 'READY_FOR_DRAFT' ? { ...adultBase, workflowState: state } : { leadId: row.id, workflowState: state };
  startAdult(initial as CrmLeadRegistrationRecovery); expect(button(reviewLabel())).toBeUndefined();
  expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
});
it('keeps adult creation receipts historical until a separate current-DRAFT confirmation succeeds', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ studentDisplayName: 'Ari Stone', currency: 'USD', readiness: 'READY_FOR_DRAFT' })).mockResolvedValueOnce(response({ state: 'RECORDED_DRAFT', receipt }));
  startAdult({ ...adultBase, workflowState: 'READY_FOR_DRAFT' }); click('Check DRAFT readiness'); await settle();
  component(AdultMembershipPlanPicker).props.onCreated({ receipt, plan }, false);
  expect(button(reviewLabel())).toBeUndefined(); expect(text(render())).toContain('Historical creation receipt');
  click('Check current DRAFT'); await settle(); expect(button(reviewLabel())).toBeDefined(); expect(fetch).toHaveBeenCalledTimes(2);
});
it('rejects a captured adult handoff during a fresh read and after unmount', async () => {
  let resolve!: (value: Response) => void; vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(yes => { resolve = yes; })); startAdult();
  const stale = button(reviewLabel())!.props.onClick; click('Check current DRAFT'); stale(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
  resolve(response({ state: 'RECORDED_DRAFT', receipt })); await settle(); const late = button(reviewLabel())!.props.onClick;
  unmount(); late(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
});
it('removes adult handoff when fresh recovery no longer reports the creator-visible current draft', () => {
  let recovery = adultCurrent(); view = () => CrmAdultFlow({ ...scope, row, initialRecovery: recovery, ...callbacks });
  const stale = button(reviewLabel())!.props.onClick;
  recovery = { ...adultBase, workflowState: 'CURRENT_DRAFT_BY_OTHER_STAFF', currentMembershipDraft: { state: 'RECORDED_DRAFT' } };
  render(); stale(); expect(button(reviewLabel())).toBeUndefined(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
});
it.each(['AWAITING_PAYER_DESIGNATION','READY_FOR_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF','NEEDS_STAFF_REVIEW'] as const)('does not offer family review for child %s', childState => {
  startFamily(family(childState === 'AWAITING_PAYER_DESIGNATION' ? 'PAYER_DESIGNATION_REQUIRED' : 'PAYER_DESIGNATED', childState)); selectChild();
  expect(button(reviewLabel())).toBeUndefined(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
});
it('binds family handoff to the selected creator-visible child and rejects a stale child click before rerender', () => {
  const data = family('PAYER_DESIGNATED', 'CURRENT_DRAFT'); if (!('children' in data)) throw Error();
  const second = { ...data.children[0]!, studentProfileId: id(12), displayName: 'Mina Stone', origin: 'ADDITIONAL_CHILD' as const, currentMembershipDraft: { state: 'RECORDED_DRAFT' as const, receipt: { ...receipt, membershipId: id(13) }, plan } };
  startFamily({ ...data, children: [...data.children, second] }); selectChild(); const stale = button(reviewLabel())!.props.onClick;
  selectChild('Mina Stone'); stale(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
  click(reviewLabel()); expect(callbacks.onMembershipReview).toHaveBeenCalledExactlyOnceWith({ ...scope, membershipId: id(13) });
});
it('keeps child creation historical and requires an explicit authorized family refresh before handoff', async () => {
  const current = family('PAYER_DESIGNATED', 'CURRENT_DRAFT'); vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(current));
  startFamily(family()); selectChild(); component(AdultMembershipPlanPicker).props.onCreated({ receipt, plan }, false);
  expect(button(reviewLabel())).toBeUndefined(); expect(text(render())).toContain('Historical DRAFT creation receipt');
  click('Check current membership status'); await settle(); selectChild(); click(reviewLabel());
  expect(callbacks.onMembershipReview).toHaveBeenCalledExactlyOnceWith(target);
});
it('rejects a captured child handoff while family refresh is unsettled', async () => {
  let resolve!: (value: Response) => void; vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  startFamily(); selectChild(); const stale = button(reviewLabel())!.props.onClick; click('Refresh family setup'); stale(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
  resolve(response(family('PAYER_DESIGNATED', 'CURRENT_DRAFT'))); await settle(); selectChild(); click(reviewLabel()); expect(callbacks.onMembershipReview).toHaveBeenCalledExactlyOnceWith(target);
});
it('clears selected-child review when a fresh family recovery no longer exposes its creator receipt', () => {
  let recovery = family('PAYER_DESIGNATED', 'CURRENT_DRAFT'); view = () => CrmFamilyFlow({ scope, row, initialFamily: recovery, ...callbacks });
  selectChild(); const stale = button(reviewLabel())!.props.onClick;
  recovery = family('PAYER_DESIGNATED', 'CURRENT_DRAFT_BY_OTHER_STAFF'); render(); stale(); selectChild();
  expect(button(reviewLabel())).toBeUndefined(); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
});
it('switches only on explicit callback, passes frozen selectors and returns to a fresh idle CRM instance', () => {
  const fetch = vi.spyOn(globalThis, 'fetch'); view = () => CrmMembershipJourney({ sessionSubject: 'synthetic-staff', initialScope: scope });
  const first = component(CrmLeadsWorkbench); expect(component(MembershipActivationWorkbench)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  const stale = first.props.onMembershipReview; stale(target);
  const activation = component(MembershipActivationWorkbench); expect(activation.props.initialMembership).toEqual(target); expect(Object.isFrozen(activation.props.initialMembership)).toBe(true);
  expect(Object.keys(activation.props.initialMembership).sort()).toEqual(['membershipId','organizationId','schoolId']);
  expect(activation.props.sessionSubject).toBe('synthetic-staff'); expect(component(CrmLeadsWorkbench)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  activation.props.onReturn(); const returned = component(CrmLeadsWorkbench); expect(returned.key).not.toBe(first.key); expect(returned.props.initialScope).toEqual(scope);
  stale(target); activation.props.onReturn(); expect(component(MembershipActivationWorkbench)).toBeUndefined();
  reset(); view = () => CrmLeadsWorkbench(returned.props); render(); expect(fetch).not.toHaveBeenCalled(); expect(text(render())).toContain('No verified school list is loaded.');
});
it('does not accept invalid selectors or synthesize a preview when navigation is requested', () => {
  const fetch = vi.spyOn(globalThis, 'fetch'); view = () => CrmMembershipJourney({ sessionSubject: 'synthetic-staff' });
  component(CrmLeadsWorkbench).props.onMembershipReview({ ...target, membershipId: '../unsafe' }); expect(component(MembershipActivationWorkbench)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
});
it('hands current membership selectors into a separate idle date view and rejects stale or cross-school navigation',()=>{
  const f=vi.spyOn(globalThis,'fetch');view=()=>CrmMembershipJourney({sessionSubject:'synthetic-staff',initialScope:scope});component(CrmLeadsWorkbench).props.onMembershipReview(target);
  const old=component(MembershipActivationWorkbench);old.props.onManageDates({...target,schoolId:id(999)});expect(component(MembershipDatesWorkbench)).toBeUndefined();
  old.props.onManageDates(target);const dates=component(MembershipDatesWorkbench);expect(dates.props.initialMembership).toEqual(target);expect(Object.isFrozen(dates.props.initialMembership)).toBe(true);expect(component(MembershipActivationWorkbench)).toBeUndefined();expect(f).not.toHaveBeenCalled();
  old.props.onReturn();expect(component(MembershipDatesWorkbench)).toBeDefined();dates.props.onReturn();const active=component(MembershipActivationWorkbench);expect(active.key).not.toBe(old.key);expect(active.props.initialMembership).toEqual(target);
  dates.props.onAbandon();expect(component(MembershipActivationWorkbench)).toBeDefined();active.props.onManageDates(target);component(MembershipDatesWorkbench).props.onAbandon();expect(component(CrmLeadsWorkbench)).toBeDefined();expect(f).not.toHaveBeenCalled();
});

async function openAdultWorkbench() {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response(adultCurrent()));
  view = () => CrmLeadsWorkbench({ initialScope: scope, sessionSubject: 'synthetic-staff', onMembershipReview: callbacks.onMembershipReview });
  elements(render()).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); await settle(); click('Resume setup'); await settle(); return fetch;
}
it.each(['blur', 'hon:session-invalidated'])('checks parent privacy on %s, physical activity and row scope even for a captured child callback', async event => {
  await openAdultWorkbench(); const adult = component(CrmAdultFlow), handoff = adult.props.onMembershipReview;
  adult.props.onBusy(true); handoff(target); expect(callbacks.onMembershipReview).not.toHaveBeenCalled(); adult.props.onBusy(false);
  handoff({ ...target, schoolId: id(99) }); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
  window.dispatchEvent(new Event(event)); handoff(target); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('focus')); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
});
it.each(['blur', 'hon:session-invalidated'])('requires fresh authorized CRM recovery after %s before a newly rendered handoff can run', async event => {
  const fetch = await openAdultWorkbench(); const stale = component(CrmAdultFlow).props.onMembershipReview;
  window.dispatchEvent(new Event(event)); render();
  const identity = () => new Response(JSON.stringify({ data: { externalSubject: 'synthetic-staff' } }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  fetch.mockResolvedValueOnce(identity()).mockResolvedValueOnce(response([row])).mockResolvedValueOnce(response(adultCurrent())).mockResolvedValueOnce(identity());
  click('Verify access and resume'); await settle(); stale(target); expect(callbacks.onMembershipReview).not.toHaveBeenCalled();
  component(CrmAdultFlow).props.onMembershipReview(target); expect(callbacks.onMembershipReview).toHaveBeenCalledExactlyOnceWith(target);
});
