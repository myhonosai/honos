import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const harness = vi.hoisted(() => {
  class Rejected extends Error {}
  class Access extends Rejected { constructor(readonly status: 401 | 403) { super('access unavailable'); } }
  class Uncertain extends Error {}
  return {
    cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
    direct: vi.fn(), preparation: vi.fn(), confirmation: vi.fn(), prepare: vi.fn(), submit: vi.fn(),
    Rejected, Access, Uncertain,
  };
});
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [harness.cells[index], (value: unknown) => { harness.cells[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(harness.cells[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = { current: initial }; return harness.cells[index]; },
    useEffect: (effect: () => (() => void) | void, _deps: unknown[]) => { const index = harness.cursor++; if (!(index in harness.cells)) { harness.cells[index] = {}; harness.effects.push(() => { (harness.cells[index] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
vi.mock('../src/components/current-staff-reporting-school-http', () => ({ loadCurrentStaffReportingSchool: harness.direct }));
vi.mock('../src/components/staff-reporting-schools-http', () => ({ loadStaffReportingSchools: vi.fn() }));
vi.mock('../src/components/crm-adult-membership-draft-http', () => ({
  CrmAdultMembershipDraftRejectedError: harness.Rejected,
  CrmAdultMembershipDraftAccessError: harness.Access,
  CrmAdultMembershipDraftUncertainError: harness.Uncertain,
  loadCrmAdultMembershipDraftConfirmation: harness.confirmation,
  loadCrmAdultMembershipDraftPreparation: harness.preparation,
  prepareCrmAdultMembershipDraftCommand: harness.prepare,
  submitCrmAdultMembershipDraft: harness.submit,
}));
import { CrmAdultMembershipDraftWorkbench } from '../src/components/crm-adult-membership-draft-workbench';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const studentProfileId = id('3');
const scope = { organizationId: id('1'), schoolId: id('2') };
const readiness = { studentDisplayName: 'Jordan Kim', currency: 'USD', readiness: 'READY_FOR_DRAFT' } as const;
const receipt = { membershipId: id('5'), state: 'DRAFT', planCode: 'ADULT-OPAQUE', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-18T20:00:00.000Z' } as const;
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const element = node as Element; return [element, ...elements(element.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { harness.cursor = 0; const tree = CrmAdultMembershipDraftWorkbench({ initialStudentProfileId: studentProfileId }) as Element; harness.effects.splice(0).forEach((run) => run()); return tree; }
function html(): string { return renderToStaticMarkup(render()); }
function field(name: string): Element | undefined { return elements(render()).find((element) => element.props.name === name); }
function button(label: string): Element | undefined { return elements(render()).find((element) => element.type === 'button' && text(element) === label); }
function forms(): Element[] { return elements(render()).filter((element) => element.type === 'form'); }
async function settle(): Promise<void> { for (let index = 0; index < 35; index++) await Promise.resolve(); }
async function loadReadiness(): Promise<void> { forms()[0]!.props.onSubmit({ preventDefault() {} }); await settle(); }
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }

beforeEach(() => {
  harness.cells = []; harness.cursor = 0; harness.effects = [];
  harness.direct.mockReset().mockResolvedValue({ state: 'RESOLVED', ...scope });
  harness.preparation.mockReset().mockResolvedValue(readiness);
  harness.confirmation.mockReset().mockResolvedValue({ state: 'RECORDED_DRAFT', receipt });
  harness.prepare.mockReset().mockImplementation((selectedScope, input, key) => Object.freeze({ path: '/exact-path', organizationId: selectedScope.organizationId, schoolId: selectedScope.schoolId, key, body: JSON.stringify(input) }));
  harness.submit.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('adult CRM membership DRAFT workbench lifecycle', () => {
  it('does nothing until explicit readiness, then sends one closed DRAFT command and retries only the same retained command', async () => {
    const key = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id('9'));
    render(); expect(harness.direct).not.toHaveBeenCalled(); expect(harness.preparation).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    await loadReadiness();
    expect(harness.direct).toHaveBeenCalledTimes(1); expect(harness.preparation).toHaveBeenCalledWith(scope, studentProfileId);
    expect(html()).toContain('Verified adult:'); expect(button('Create membership DRAFT only')!.props.disabled).toBe(true);
    edit('planCode', receipt.planCode); field('confirmAdultCrmMembershipDraft')!.props.onChange({ target: { checked: true } });
    const command = { path: '/exact-path', organizationId: scope.organizationId, schoolId: scope.schoolId, key: id('9'), body: JSON.stringify({ studentProfileId, planCode: receipt.planCode, confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' }) };
    harness.submit.mockRejectedValueOnce(new harness.Uncertain()).mockResolvedValueOnce({ receipt, replayed: true });
    forms()[1]!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(key).toHaveBeenCalledTimes(1); expect(harness.prepare).toHaveBeenCalledWith(scope, { studentProfileId, planCode: receipt.planCode, confirmation: 'I_CONFIRM_DIRECT_HUMAN_ADULT_CRM_MEMBERSHIP_DRAFT' }, id('9'));
    expect(harness.submit).toHaveBeenCalledWith(command); expect(button('Retry exact unchanged membership draft')).toBeDefined();
    button('Retry exact unchanged membership draft')!.props.onClick(); await settle();
    expect(key).toHaveBeenCalledTimes(1); expect(harness.submit.mock.calls[0]).toEqual(harness.submit.mock.calls[1]);
    expect(html()).toContain('Replayed historical DRAFT receipt.'); expect(html()).not.toContain(`href="/staff/billing/memberships?membershipId=${receipt.membershipId}"`);
  });

  it('clears readiness and any retained command on selector edits and ignores a late readiness response', async () => {
    let resolve!: (value: typeof readiness) => void;
    harness.preparation.mockReturnValueOnce(new Promise<typeof readiness>((done) => { resolve = done; }));
    await loadReadiness();
    edit('studentProfileId', id('4')); resolve(readiness); await settle();
    expect(html()).not.toContain('Verified adult:'); expect(button('Create membership DRAFT only')).toBeUndefined(); expect(button('Retry exact unchanged membership draft')).toBeUndefined();
    expect(field('studentProfileId')!.props.value).toBe(id('4'));
  });

  it('clears the scalar selector and all preparation state on access loss without treating it as a membership result', async () => {
    harness.preparation.mockRejectedValueOnce(new harness.Access(403));
    await loadReadiness();
    expect(field('studentProfileId')!.props.value).toBe(''); expect(html()).not.toContain('Verified adult:'); expect(button('Create membership DRAFT only')).toBeUndefined();
    expect(html()).toContain('access unavailable'); expect(html()).not.toContain('Returned membership receipt: DRAFT');
  });

  it('issues current confirmation only after its explicit action and alone may expose the scalar activation handoff', async () => {
    const key = vi.spyOn(crypto, 'randomUUID');
    render(); expect(harness.direct).not.toHaveBeenCalled(); expect(harness.confirmation).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    button('Confirm current source-bound DRAFT')!.props.onClick(); await settle();
    expect(harness.direct).toHaveBeenCalledTimes(1); expect(harness.confirmation).toHaveBeenCalledWith(scope, studentProfileId); expect(harness.preparation).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(html()).toContain('Current source-bound DRAFT confirmation'); expect(html()).toContain(`href="/staff/billing/memberships?membershipId=${receipt.membershipId}"`);
    expect(button('Create membership DRAFT only')).toBeUndefined(); expect(html()).not.toContain('Payment complete');
  });
});
