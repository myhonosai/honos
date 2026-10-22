import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CrmEnrollmentDiscard } from '../src/components/crm-enrollment-discard';
import { CrmAdultFlow } from '../src/components/crm-adult-flow';
import type { CrmLeadRegistrationRecovery } from '@hon/contracts';
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ date: (v: string) => `Localized ${v}` }) }));
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
 useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (value: unknown) => { hooks.values[i] = typeof value === 'function' ? (value as (v: unknown) => unknown)(hooks.values[i]) : value; }]; },
 useRef: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
 useEffect: (effect: () => (() => void) | void, deps: unknown[]) => { const i = hooks.cursor++, prior = hooks.values[i] as { deps: unknown[]; cleanup?: (() => void) | undefined } | undefined; if (!prior || deps.some((v, j) => v !== prior.deps[j])) { prior?.cleanup?.(); hooks.values[i] = { deps }; hooks.effects.push(() => { (hooks.values[i] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
 }; });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = { id: id(3), primaryPersonId: id(4), status: 'WON' as const, pipelineStageId: id(8), version: 1, createdAt: '2026-10-20T00:00:00.000Z', givenName: 'Ari', familyName: 'Stone' };
const date = '2026-10-20T09:00:00.000Z', meta = { requestId: id(8), correlationId: id(8), replayed: false };
const registration = { outcome: 'REGISTERED', leadId: id(3), sourceContactPersonId: id(4), registrationPath: 'ADULT', studentProfileId: id(5), familyId: null, recordedAt: date } as const;
const account = { id: id(6), responsiblePersonId: id(4), currency: 'USD', classification: 'CANONICAL', reused: true, version: 1, createdAt: date };
const receipt = { membershipId: id(7), state: 'DRAFT', planCode: 'ADULT-MONTHLY', termStartedAt: null, termEndsAt: null, recordedAt: date } as const;
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, meta }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (React.isValidElement(node)) { const e = node as Element; return [e, ...elements(e.props.children)]; } return []; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' ? node : ''; }
const props = { organizationId: id(1), schoolId: id(2), row, onCancel: vi.fn(), onBusy: vi.fn(), onStarted: vi.fn(), onAccessLost: vi.fn() };
let initialRecovery: CrmLeadRegistrationRecovery | undefined;
const refreshRecovery = vi.fn();
const view = () => CrmAdultFlow({ ...props, ...(initialRecovery ? { initialRecovery, onRecover: refreshRecovery } : {}) });
function render(): Element { hooks.cursor = 0; const t = view() as Element; hooks.effects.splice(0).forEach(run => run()); return t; }
function unmount(): void { for (const v of hooks.values) if (v && typeof v === 'object' && 'cleanup' in v) (v as { cleanup?: () => void }).cleanup?.(); }
const button = (t: Element, label: string) => elements(t).find(e => e.type === 'button' && text(e) === label)!;
const field = (t: Element, label: string) => elements(t).find(e => e.type === 'label' && text(e).startsWith(label))!;
const input = (t: Element, label: string) => elements(field(t, label)).find(e => e.type === 'input')!;
const settle = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
function fill(label: string, value: string): Element { let t = render(); input(t, label).props.onChange({ target: { value } }); return render(); }
function agree(): Element { const t = render(); elements(t).find(e => e.type === 'input' && e.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); return render(); }
function submit(t = render()): void { elements(t).find(e => e.type === 'form')!.props.onSubmit({ preventDefault() {} }); }
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; initialRecovery = undefined; vi.clearAllMocks(); });
afterEach(() => { unmount(); vi.restoreAllMocks(); });
async function register(): Promise<void> { fill('Date of birth', '1990-01-02'); submit(agree()); await settle(); }
it('connects all five real API steps without manual record identifiers, automatic commands or activation links', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(registration)).mockResolvedValueOnce(response(account))
    .mockResolvedValueOnce(response({ studentDisplayName: 'Ari Stone', currency: 'USD', readiness: 'READY_FOR_DRAFT' })).mockResolvedValueOnce(response(receipt)).mockResolvedValueOnce(response({ state: 'RECORDED_DRAFT', receipt }));
  render(); expect(f).not.toHaveBeenCalled(); await register(); expect(text(render())).toContain('Registration recorded');
  submit(agree()); await settle(); expect(text(render())).toContain('Existing account reused');
  expect(f).toHaveBeenCalledTimes(2); button(render(), 'Check DRAFT readiness').props.onClick(); await settle();
  fill('Membership plan code', 'ADULT-MONTHLY'); submit(agree()); await settle();
  expect(text(render())).toContain('Historical creation receipt'); expect(text(render())).not.toContain('Current DRAFT verified.');
  button(render(), 'Check current DRAFT').props.onClick(); await settle(); expect(text(render())).toContain('Current DRAFT verified.');
  expect(f).toHaveBeenCalledTimes(5); expect(new Set(f.mock.calls.map(c => (c[1]?.headers as any)['Idempotency-Key']).filter(Boolean)).size).toBe(3);
  expect(elements(render()).filter(e => e.type === 'a')).toHaveLength(0);
});
it('suppresses synchronous double submissions and retries only the frozen body/key after uncertain completion', async () => {
  let reject!: (e: Error) => void;
  const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((_r, no) => { reject = no; })).mockResolvedValueOnce(response(registration));
  fill('Date of birth', '1990-01-02'); const t = agree(); submit(t); submit(t); expect(f).toHaveBeenCalledTimes(1);
  reject(new Error('connection lost')); await settle(); expect(text(render())).toContain('Outcome unverified');
  submit(render()); expect(f).toHaveBeenCalledTimes(1); button(render(), 'Retry exact request').props.onClick(); await settle();
  expect(f.mock.calls[0]).toEqual(f.mock.calls[1]); expect(text(render())).toContain('Registration recorded');
});
it('does not advance on staff review or on a returned adult identity that differs from the authorized lead', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ outcome: 'NEEDS_STAFF_REVIEW' }));
  await register(); expect(text(render())).toContain('Staff review required'); expect(text(render())).not.toContain('Create or reuse account'); expect(f).toHaveBeenCalledTimes(1);
});
it('clears no authority itself and delegates access loss to the parent to discard the scoped workflow', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 403)); await register(); expect(props.onAccessLost).toHaveBeenCalledTimes(1); expect(text(render())).not.toContain('Registration recorded');
});
it('ignores a delayed response after the selected row/school is discarded', async () => {
  let resolve!: (r: Response) => void; vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
  fill('Date of birth', '1990-01-02'); submit(agree()); unmount(); resolve(response(registration)); await settle(); expect(text(render())).not.toContain('Registration recorded');
});
it('refuses a returned adult identity mismatch before exposing billing actions', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ ...registration, sourceContactPersonId: id(99) })); await register();
  expect(text(render())).toContain('does not match this lead'); expect(text(render())).not.toContain('Create or reuse account');
});

const recovered = { leadId: id(3), historicalRegistrationReceipt: registration, billingAccount: { classification: 'CANONICAL' as const, currency: 'USD' } };
it.each(['NOT_REGISTERED', 'NEEDS_STAFF_REVIEW'] as const)('renders recovered %s without fetching or claiming a later state', state => {
  initialRecovery = { leadId: id(3), workflowState: state }; const f = vi.spyOn(globalThis, 'fetch');
  const t = render(); expect(f).not.toHaveBeenCalled(); expect(text(t)).not.toContain(registration.studentProfileId);
  expect(Boolean(button(t, 'Register adult'))).toBe(state === 'NOT_REGISTERED'); expect(Boolean(button(t, 'Create or reuse account'))).toBe(false);
});
it('continues recovered registration only after explicit account confirmation with a fresh key', async () => {
  initialRecovery = { leadId: id(3), workflowState: 'BILLING_ACCOUNT_REQUIRED', historicalRegistrationReceipt: registration };
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(account)); render(); expect(f).not.toHaveBeenCalled();
  expect(text(render())).toContain('Historical registration receipt'); submit(agree()); await settle();
  expect(f).toHaveBeenCalledTimes(1); expect(f.mock.calls[0]![0]).toContain('/billing/accounts');
  expect((f.mock.calls[0]![1]!.headers as any)['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/);
});
it('uses a recovered canonical account without an id, requires preparation and preserves an uncertain DRAFT retry', async () => {
  initialRecovery = { ...recovered, workflowState: 'READY_FOR_DRAFT' };
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ studentDisplayName: 'Ari Stone', currency: 'USD', readiness: 'READY_FOR_DRAFT' }))
    .mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(receipt));
  render(); expect(f).not.toHaveBeenCalled(); expect(text(render())).toContain('No account identifier was returned');
  expect(button(render(), 'Create membership DRAFT')).toBeUndefined(); button(render(), 'Check DRAFT readiness').props.onClick(); await settle();
  fill('Membership plan code', 'ADULT-MONTHLY'); submit(agree()); await settle();
  expect(button(render(), 'Refresh saved setup').props.disabled).toBe(true);
  button(render(), 'Retry exact request').props.onClick(); await settle(); expect(f.mock.calls[1]).toEqual(f.mock.calls[2]);
  expect(text(render())).not.toContain('Current DRAFT verified.');
});
it('shows the creator current DRAFT from recovery without repeating registration, account creation or confirmation', () => {
  initialRecovery = { ...recovered, workflowState: 'CURRENT_DRAFT', currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt } };
  const f = vi.spyOn(globalThis, 'fetch'); expect(text(render())).toContain('Current DRAFT verified.'); expect(f).not.toHaveBeenCalled();
  expect(button(render(), 'Create membership DRAFT')).toBeUndefined();
  button(render(), 'Refresh saved setup').props.onClick(); expect(refreshRecovery).toHaveBeenCalledTimes(1); expect(f).not.toHaveBeenCalled();
});
it('shows noncreator current-DRAFT visibility with no membership details or confirmation/mutation controls', () => {
  initialRecovery = { ...recovered, workflowState: 'CURRENT_DRAFT_BY_OTHER_STAFF', currentMembershipDraft: { state: 'RECORDED_DRAFT' } };
  const f = vi.spyOn(globalThis, 'fetch'), t = render(); expect(text(t)).toContain('A current DRAFT exists, created by another staff member');
  for (const hidden of [receipt.membershipId, receipt.planCode, registration.studentProfileId]) expect(text(t)).not.toContain(hidden);
  for (const label of ['Register adult', 'Create or reuse account', 'Check DRAFT readiness', 'Create membership DRAFT', 'Check current DRAFT']) expect(button(t, label)).toBeUndefined();
  expect(elements(t).filter(e => e.type === 'form' || e.type === 'a')).toHaveLength(0); expect(f).not.toHaveBeenCalled();
});

it('retains an uncertain adult published-plan request across fresh recovery without automatic resubmission',async()=>{
  initialRecovery={...recovered,workflowState:'READY_FOR_DRAFT'};
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({studentDisplayName:'Ari Stone',currency:'USD',readiness:'READY_FOR_DRAFT'}));
  render();button(render(),'Check DRAFT readiness').props.onClick();await settle();
  const {AdultMembershipPlanPicker}=await import('../src/components/membership-plans/picker');
  const picker=elements(render()).find(e=>e.type===AdultMembershipPlanPicker)!;
  const {draftFromPlanRequest}=await import('../src/components/membership-plans/http');
  const {CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION}=await import('@hon/contracts');
  const plan={planId:id(40),planCode:'ADULT-MONTHLY',version:1,displayName:'Adult Monthly',description:null,programId:null,availability:'AVAILABLE' as const,currency:'USD',priceMinor:14900,billingFrequency:'MONTHLY' as const,termKind:'OPEN_ENDED' as const,termMonths:null,publishedAt:date};
  const request=draftFromPlanRequest({organizationId:props.organizationId,schoolId:props.schoolId},{studentProfileId:id(5),membershipPlanId:plan.planId,membershipPlanVersion:1,confirmation:CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION},id(60));
  picker.props.onUncertain(request);initialRecovery={...recovered,workflowState:'CURRENT_DRAFT',currentMembershipDraft:{state:'RECORDED_DRAFT',receipt}};render();render();expect(f).toHaveBeenCalledTimes(1);
  f.mockResolvedValueOnce(response({receipt,plan}));const retry=button(render(),'Retry exact plan request').props.onClick;retry();retry();await settle();
  expect(f).toHaveBeenCalledTimes(2);expect(f.mock.calls[1]![1]!.body).toBe(request.body);expect((f.mock.calls[1]![1]!.headers as Record<string,string>)['Idempotency-Key']).toBe(request.key);
});

it('offers deliberate adult DRAFT retry discard but guards a stale handler during exact replay', async () => {
  initialRecovery={...recovered,workflowState:'READY_FOR_DRAFT'};
  let finish!: (r:Response)=>void;
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({studentDisplayName:'Ari Stone',currency:'USD',readiness:'READY_FOR_DRAFT'})).mockRejectedValueOnce(new Error('unknown')).mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));
  render();button(render(),'Check DRAFT readiness').props.onClick();await settle();fill('Membership plan code','ADULT-MONTHLY');submit(agree());await settle();
  const discard=elements(render()).find(e=>e.type===CrmEnrollmentDiscard)!;const retry=button(render(),'Retry exact request').props.onClick;retry();retry();
  expect(elements(render()).find(e=>e.type===CrmEnrollmentDiscard)!.props.disabled).toBe(true);discard.props.onDiscard();expect(button(render(),'Retry exact request')).toBeDefined();expect(f).toHaveBeenCalledTimes(3);expect(f.mock.calls[1]).toEqual(f.mock.calls[2]);
  finish(response(receipt));await settle();expect(text(render())).toContain('Historical creation receipt');
});
it('offers dedicated adult plan retry discard and requires a fresh recovery before a new command', async () => {
  initialRecovery={...recovered,workflowState:'READY_FOR_DRAFT'};
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({studentDisplayName:'Ari Stone',currency:'USD',readiness:'READY_FOR_DRAFT'}));render();button(render(),'Check DRAFT readiness').props.onClick();await settle();
  const {AdultMembershipPlanPicker}=await import('../src/components/membership-plans/picker');const picker=elements(render()).find(e=>e.type===AdultMembershipPlanPicker)!;
  const {draftFromPlanRequest}=await import('../src/components/membership-plans/http');const {CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION}=await import('@hon/contracts');
  picker.props.onUncertain(draftFromPlanRequest(props,{studentProfileId:id(5),membershipPlanId:id(40),membershipPlanVersion:1,confirmation:CRM_ADULT_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION},id(60)));
  expect(button(render(),'Close adult setup').props.disabled).toBe(true);elements(render()).find(e=>e.type===CrmEnrollmentDiscard)!.props.onDiscard();
  expect(text(render())).toContain('Current setup must be verified again');expect(elements(render()).some(e=>e.type==='form'||e.type===AdultMembershipPlanPicker)).toBe(false);expect(f).toHaveBeenCalledOnce();
  button(render(),'Refresh saved setup').props.onClick();expect(refreshRecovery).toHaveBeenCalledOnce();expect(f).toHaveBeenCalledOnce();
  initialRecovery={...recovered,workflowState:'CURRENT_DRAFT',currentMembershipDraft:{state:'RECORDED_DRAFT',receipt}};render();render();expect(text(render())).toContain('Current DRAFT verified.');expect(f).toHaveBeenCalledOnce();
});
it('retains an unexpected family request visibly without sending it through the adult route', async () => {
  initialRecovery={...recovered,workflowState:'READY_FOR_DRAFT'};const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({studentDisplayName:'Ari Stone',currency:'USD',readiness:'READY_FOR_DRAFT'}));render();button(render(),'Check DRAFT readiness').props.onClick();await settle();
  const {AdultMembershipPlanPicker}=await import('../src/components/membership-plans/picker');const {familyRequest}=await import('../src/components/crm-family-http');const {CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION}=await import('@hon/contracts');
  const request=familyRequest(props,'payer',id(3),{confirmation:CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION},id(60));
  elements(render()).find(e=>e.type===AdultMembershipPlanPicker)!.props.onUncertain(request);
  expect(text(render())).toContain('Unexpected retry request type');expect(button(render(),'Retry exact plan request')).toBeUndefined();expect(button(render(),'Refresh saved setup').props.disabled).toBe(true);expect(f).toHaveBeenCalledOnce();
  elements(render()).find(e=>e.type===CrmEnrollmentDiscard)!.props.onDiscard();expect(text(render())).toContain('Current setup must be verified again');expect(f).toHaveBeenCalledOnce();
});
