import React, { type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const harness = vi.hoisted(() => {
  class Rejected extends Error {}
  class Access extends Rejected { constructor(readonly status: 401 | 403) { super('access unavailable'); } }
  class Uncertain extends Error {}
  return { cells: [] as unknown[], cursor: 0, effects: [] as (() => void)[], preparation: vi.fn(), prepare: vi.fn(), submit: vi.fn(), Rejected, Access, Uncertain };
});
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual,
    useState: (initial: unknown) => { const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [harness.cells[index], (value: unknown) => { harness.cells[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(harness.cells[index]) : value; }]; },
    useRef: (initial: unknown) => { const index = harness.cursor++; if (!(index in harness.cells)) harness.cells[index] = { current: initial }; return harness.cells[index]; },
    useEffect: (effect: () => (() => void) | void, _deps: unknown[]) => { const index = harness.cursor++; if (!(index in harness.cells)) { harness.cells[index] = {}; harness.effects.push(() => { (harness.cells[index] as { cleanup?: (() => void) | undefined }).cleanup = effect() || undefined; }); } },
  };
});
vi.mock('../src/components/crm-guardian-child-payer-designation-http', () => ({
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION',
  CrmGuardianChildPayerDesignationRejectedError: harness.Rejected,
  CrmGuardianChildPayerDesignationAccessError: harness.Access,
  CrmGuardianChildPayerDesignationUncertainError: harness.Uncertain,
  loadCrmGuardianChildPayerDesignationPreparation: harness.preparation,
  prepareCrmGuardianChildPayerDesignationCommand: harness.prepare,
  submitCrmGuardianChildPayerDesignation: harness.submit,
}));
import { CrmGuardianChildPayerDesignationWorkbench } from '../src/components/crm-guardian-child-payer-designation-workbench';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const organizationId = id('1'); const schoolId = id('2'); const studentProfileId = id('3'); const key = id('4');
const readiness = { studentDisplayName: 'Avery Kim', guardianDisplayName: 'Morgan Kim', currency: 'USD', readiness: 'READY_FOR_PAYER_DESIGNATION' } as const;
type Element = ReactElement<Record<string, any>>;
function elements(node: unknown): Element[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; const element = node as Element; return [element, ...elements(element.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(' '); if (React.isValidElement(node)) return text((node as Element).props.children); return typeof node === 'string' || typeof node === 'number' ? String(node) : ''; }
function render(): Element { harness.cursor = 0; const tree = CrmGuardianChildPayerDesignationWorkbench({ initialStudentProfileId: studentProfileId }) as Element; harness.effects.splice(0).forEach((run) => run()); return tree; }
function html(): string { return renderToStaticMarkup(render()); }
function field(name: string): Element | undefined { return elements(render()).find((element) => element.props.name === name); }
function forms(): Element[] { return elements(render()).filter((element) => element.type === 'form'); }
function button(label: string): Element | undefined { return elements(render()).find((element) => element.type === 'button' && text(element) === label); }
async function settle(): Promise<void> { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function edit(name: string, value: string): void { field(name)!.props.onChange({ target: { value } }); }

beforeEach(() => { harness.cells = []; harness.cursor = 0; harness.effects = []; harness.preparation.mockReset().mockResolvedValue(readiness); harness.prepare.mockReset().mockImplementation((scope, input, passedKey) => Object.freeze({ path: '/exact-payer-path', organizationId: scope.organizationId, schoolId: scope.schoolId, key: passedKey, body: JSON.stringify(input) })); harness.submit.mockReset().mockResolvedValue({ receipt: { studentDisplayName: 'Avery Kim', guardianDisplayName: 'Morgan Kim', currency: 'USD', state: 'PAYER_DESIGNATED', recordedAt: '2026-10-18T20:00:00.000Z' }, replayed: false }); });

describe('guardian-child payer designation workbench interaction', () => {
  it('does nothing until manual organization/school/child preparation, then creates one fresh closed command and clears it on selector edit', async () => {
    const random = vi.spyOn(crypto, 'randomUUID').mockReturnValue(key);
    render(); expect(harness.preparation).not.toHaveBeenCalled(); expect(harness.prepare).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
    edit('organizationId', organizationId); edit('schoolId', schoolId); forms()[0]!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(harness.preparation).toHaveBeenCalledWith({ organizationId, schoolId }, studentProfileId); expect(html()).toContain('Verified child:'); expect(button('Designate source guardian as payer')!.props.disabled).toBe(true);
    field('confirmGuardianChildPayerDesignation')!.props.onChange({ target: { checked: true } }); forms()[1]!.props.onSubmit({ preventDefault() {} }); await settle();
    expect(random).toHaveBeenCalledTimes(1); expect(harness.prepare).toHaveBeenCalledWith({ organizationId, schoolId }, { studentProfileId, confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION' }, key); expect(harness.submit).toHaveBeenCalledWith({ path: '/exact-payer-path', organizationId, schoolId, key, body: JSON.stringify({ studentProfileId, confirmation: 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_PAYER_DESIGNATION' }) }); expect(html()).toContain('Historical payer-designation receipt');
    edit('studentProfileId', id('5')); expect(html()).not.toContain('Verified child:'); expect(html()).not.toContain('Historical payer-designation receipt'); expect(button('Retry exact unchanged payer designation')).toBeUndefined();
  });
});
