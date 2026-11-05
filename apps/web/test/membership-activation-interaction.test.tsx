import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => unknown>, session: vi.fn() }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const hooks = {
    useState(initial: any) { const i = harness.cursor++; if (!harness.slots[i]) harness.slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [harness.slots[i].value, (value: any) => { harness.slots[i].value = typeof value === 'function' ? value(harness.slots[i].value) : value; }]; },
    useRef(initial: any) { const i = harness.cursor++; return harness.slots[i] ?? (harness.slots[i] = { current: initial }); },
    useEffect(callback: () => unknown) { harness.effects.push(callback); },
  };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock('../src/components/crm-enrollment-privacy', () => ({ verifyEnrollmentSession: harness.session }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en', region: 'auto', timeZone: 'UTC', currencyDisplay: 'symbol' }, date: (s: string) => s }) }));
import { MembershipActivationWorkbench } from '../src/components/membership-activation-workbench';
import { MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION } from '@hon/contracts';
import { PlanAccessError } from '../src/components/membership-plans/http';
import { scope, id, current, preview, receipt, envelope, rejected } from './membership-activation-fixtures';
let props: Parameters<typeof MembershipActivationWorkbench>[0] = { sessionSubject: 'synthetic-staff' };
const render = () => { harness.cursor = 0; return MembershipActivationWorkbench(props); };
const nodes = (tree: any, type: string): any[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(value => nodes(value, type)) : [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const text = (tree: any): string => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
const html = () => renderToStaticMarkup(render());
const button = (name: string) => nodes(render(), 'button').find(node => text(node) === name);
const field = (name: string) => { const label = nodes(render(), 'label').find(node => text(node).includes(name)); return label ? [...nodes(label, 'input'), ...nodes(label, 'select'), ...nodes(label, 'textarea')][0] : undefined; };
const fill = (name: string, value: string) => field(name).props.onChange({ target: { value } });
const tick = (name: string) => field(name).props.onChange({ target: { checked: true } });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
async function load() {
  render(); Object.entries(scope).forEach(([key, value]) => fill(key === 'organizationId' ? 'Organization ID' : key === 'schoolId' ? 'School ID' : 'Already-known membership ID', value));
  nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); await flush();
}
function final() { nodes(render(), 'form')[1].props.onSubmit({ preventDefault: vi.fn() }); }
function confirm() { final(); tick('I confirm this membership'); button('Confirm membership activation').props.onClick(); }
beforeEach(() => { props = { sessionSubject: 'synthetic-staff' }; harness.slots = []; harness.cursor = 0; harness.effects = []; harness.session.mockReset().mockResolvedValue(undefined); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('E1a explicit two-step activation lifecycle', () => {
  it('does nothing on mount, requires a preview and a separate final confirmation, and duplicate clicks submit once', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(); expect(f).not.toHaveBeenCalled(); await load();
    final(); expect(button('Confirm membership activation').props.disabled).toBe(true); tick('I confirm this membership');
    const click = button('Confirm membership activation').props.onClick; click(); click(); await flush();
    expect(f).toHaveBeenCalledTimes(2); expect(button('Retry exact retained activation').props.disabled).toBe(true);
    resolve(envelope(receipt())); await flush(); expect(html()).toContain('Membership confirmation receipt'); expect(button('Confirm membership activation')).toBeUndefined();
  });
  it('does not block a missing birth date, requires its warning, and supports optional staff attestation', async () => {
    const p = preview({ birthDateRecorded: false, warnings: [{ code: 'BIRTH_DATE_MISSING' }] });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(p)).mockResolvedValueOnce(envelope(receipt({ acknowledgedWarnings: ['BIRTH_DATE_MISSING'], adultVerification: { kind: 'STAFF_ATTESTATION', method: 'DOCUMENT_REVIEWED' }, followUps: [{ kind: 'BIRTH_DATE_MISSING', workItemId: id('a') }] })));
    await load(); expect(button('Review final confirmation').props.disabled).toBe(true); tick('Birth date is missing.'); tick('Optional: I attest'); fill('Adult verification method', 'DOCUMENT_REVIEWED');
    confirm(); await flush(); expect(JSON.parse(f.mock.calls[1]![1]!.body as string).adultVerification.method).toBe('DOCUMENT_REVIEWED'); expect(html()).toContain('Record birth date for an activated membership');
  });
  it('uses backend override capabilities instead of roles and requires the reason plus secondary confirmation', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview({ warnings: [{ code: 'CRM_IDENTITY_REVIEW_PENDING' }], overridableWarnings: ['CRM_IDENTITY_REVIEW_PENDING'], availableOverrides: ['CRM_IDENTITY_REVIEW_PENDING'] }))).mockResolvedValueOnce(envelope(receipt({ acknowledgedWarnings: ['CRM_IDENTITY_REVIEW_PENDING'], overridePermission: 'billing.membership.activation.override', overridesUsed: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', resolved: false }], followUps: [{ kind: 'IDENTITY_REVIEW_UNRESOLVED', workItemId: id('a') }] })));
    await load(); tick('An identity review is unresolved.'); final(); expect(button('Confirm membership activation')).toBeUndefined(); fill('Identity override reason', 'Authorized staff reviewed the distinct records.'); tick('I separately confirm');
    confirm(); await flush(); expect(JSON.parse(f.mock.calls[1]![1]!.body as string).overrides[0].confirmation).toBe(MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION); expect(html()).toContain('review remains unresolved');
  });
  it('has no actionable override without server capability and preserves known-minor blocks', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview({ warnings: [{ code: 'CRM_IDENTITY_REVIEW_PENDING' }], overridableWarnings: ['CRM_IDENTITY_REVIEW_PENDING'], availableOverrides: [], canConfirm: false })));
    await load(); expect(field('Identity override reason')).toBeUndefined(); expect(button('Review final confirmation').props.disabled).toBe(true); expect(html()).toContain('appropriately authorized staff member');
    f.mockResolvedValueOnce(envelope(preview({ knownMinor: true, blocks: [{ code: 'MINOR_GUARDIAN_OF_RECORD_REQUIRED' }], canConfirm: false })));
    button('Review activation').props.onClick?.(); nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); await flush(); expect(html()).toContain('verified guardian of record'); expect(button('Review final confirmation').props.disabled).toBe(true);
  });
  it('invalidates the old digest and acknowledgements on date edits, shows inclusive dates and SCHEDULED receipt', async () => {
    const p = preview({ proposedDates: { startDate: '2026-11-01', endDate: '2027-10-31', dateSource: 'STAFF_ADJUSTED' }, warnings: [{ code: 'START_DATE_IN_FUTURE', days: 10 }], effectiveStatusIfConfirmedNow: 'SCHEDULED', previewDigest: 'b'.repeat(64) });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope(p)).mockResolvedValueOnce(envelope(receipt({ effectiveStatusAtActivation: 'SCHEDULED', effectivePeriod: { ...receipt().effectivePeriod, startDate: '2026-11-01', endDate: '2027-10-31', dateSource: 'STAFF_ADJUSTED', termStartedAt: '2026-11-01T07:00:00.000Z', termEndsAt: '2027-11-01T07:00:00.000Z' }, acknowledgedWarnings: ['START_DATE_IN_FUTURE'] })));
    await load(); final(); fill('Start date', '2026-11-01'); expect(button('Confirm membership activation')).toBeUndefined(); await flush();
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ startDate: '2026-11-01', endDate: null });
    tick('scheduled to start in the future'); fill('Date adjustment reason', 'School confirmed the selected dates.'); confirm(); await flush();
    const body = JSON.parse(f.mock.calls[2]![1]!.body as string); expect(body.previewDigest).toBe('b'.repeat(64)); expect(body.endDate).toBe('2027-10-31'); expect(html()).toContain('scheduled to begin'); expect(html()).toContain('Oct 31, 2027'); expect(html()).not.toContain('IN_EFFECT at the recorded');
  });
  it.each(['ACTIVATION_PREVIEW_STALE', 'VERSION_CONFLICT', 'MEMBERSHIP_NOT_DRAFT'])('requires a new review after %s, without retrying automatically', async code => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(rejected(409, code));
    await load(); confirm(); await flush(); expect(button('Confirm membership activation')).toBeUndefined(); expect(button('Retry exact retained activation')).toBeUndefined(); expect(f).toHaveBeenCalledTimes(2);
  });
  it('settles an unknown command behind the privacy shield; verifies access then explicitly retries identical bytes without a reload', async () => {
    let reject!: (e: Error) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockImplementationOnce(() => new Promise((_, no) => { reject = no; })).mockResolvedValueOnce(envelope(current, false, true)).mockResolvedValueOnce(envelope(receipt(), true));
    render(); harness.effects[0]!(); await load(); confirm(); await flush(); window.dispatchEvent(new Event('blur'));
    expect(html()).toContain('Membership information hidden'); expect(html()).not.toContain('Synthetic Student'); expect(button('Verify access and resume').props.disabled).toBe(true);
    reject(new DOMException('Unknown timeout', 'TimeoutError')); await flush(); expect(button('Verify access and resume').props.disabled).toBe(false);
    button('Verify access and resume').props.onClick(); await flush(); expect(html()).not.toContain('Membership information hidden'); expect(harness.session).toHaveBeenCalledTimes(5); expect(f).toHaveBeenCalledTimes(3);
    expect(html().match(/Session and exact-school activation access verified\./g)).toHaveLength(1);
    button('Retry exact retained activation').props.onClick(); await flush();
    expect(f.mock.calls[3]![0]).toBe(f.mock.calls[1]![0]); expect(f.mock.calls[3]![1]!.body).toBe(f.mock.calls[1]![1]!.body); expect(f.mock.calls[3]![1]!.headers).toEqual(f.mock.calls[1]![1]!.headers); expect(html()).toContain('idempotent replay');
  });
  it('keeps the view hidden after session loss, and repeated blur invalidates an in-flight restoration', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview()));
    render(); harness.effects[0]!(); await load(); window.dispatchEvent(new Event('blur')); harness.session.mockRejectedValueOnce(new Error('expired'));
    button('Verify access and resume').props.onClick(); await flush(); expect(html()).toContain('Information remains hidden'); expect(f).toHaveBeenCalledTimes(1);
    let resolve!: (r: Response) => void; f.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    button('Verify access and resume').props.onClick(); await flush(); window.dispatchEvent(new Event('blur')); resolve(envelope(current, false, true)); await flush(); expect(html()).toContain('Membership information hidden');
  });
  it('announces failed restoration even when a real 401 simultaneously invalidates its read epoch', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview()));
    render(); harness.effects[0]!(); await load(); window.dispatchEvent(new Event('blur'));
    harness.session.mockImplementationOnce(async () => { window.dispatchEvent(new Event('hon:session-invalidated')); throw new PlanAccessError('expired'); });
    button('Verify access and resume').props.onClick(); await flush();
    expect(html()).toContain('Access could not be verified. Information remains hidden.'); expect(html()).not.toContain('Synthetic Student');
    expect(button('Verify access and resume').props.disabled).toBe(false); expect(f).toHaveBeenCalledOnce();
  });
  it('a superseded restoration cannot insert its error into a newer authorized attempt', async () => {
    let refuseOld!: (value: Error) => void, finishNew!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockImplementationOnce(() => new Promise(done => { finishNew = done; }));
    render(); harness.effects[0]!(); await load(); window.dispatchEvent(new Event('blur'));
    harness.session.mockImplementationOnce(() => new Promise((_, reject) => { refuseOld = reject; }));
    button('Verify access and resume').props.onClick(); await flush(); window.dispatchEvent(new Event('blur'));
    button('Verify access and resume').props.onClick(); await flush(); refuseOld(new Error('old network outcome')); await flush();
    expect(html()).not.toContain('Access could not be verified. Information remains hidden.');
    finishNew(envelope(current, false, true)); await flush();
    expect(html()).toContain('Current membership observation'); expect(html()).not.toContain('Access could not be verified. Information remains hidden.');
  });
  it('does not shield an empty view and ignores a late preview for edited selectors', async () => {
    let resolve!: (r: Response) => void; const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(); harness.effects[0]!(); window.dispatchEvent(new Event('blur')); expect(html()).not.toContain('Membership information hidden'); await load(); fill('Already-known membership ID', id('9')); resolve(envelope(preview())); await flush(); expect(html()).not.toContain('Synthetic Student'); expect(f).toHaveBeenCalledTimes(1);
  });
  it('binds CRM selectors without an automatic read and refuses selector editing', async () => {
    props = { ...props, initialMembership: scope, onReturn: vi.fn() };
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(envelope(preview()));
    render(); expect(f).not.toHaveBeenCalled();
    expect(field('Already-known membership ID').props.readOnly).toBe(true);
    fill('Already-known membership ID', id('9')); expect(field('Already-known membership ID').props.value).toBe(scope.membershipId);
    nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); await flush();
    expect(f.mock.calls[0]![0]).toContain(scope.membershipId); expect(harness.session.mock.calls.every(call => call[0] === 'synthetic-staff')).toBe(true);
  });
  it('requires the original identity before dispatch and never reports a new unknown command when preflight failed', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())); await load();
    harness.session.mockRejectedValueOnce(new Error('identity changed')); confirm(); await flush();
    expect(f).toHaveBeenCalledTimes(1); expect(html()).toContain('No activation request was sent.');
    expect(button('Retry exact retained activation')).toBeUndefined(); expect(html()).not.toContain('Membership confirmation receipt');
  });
  it('preserves the exact unknown request when a later retry fails session verification before dispatch', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    render(); harness.effects[0]!(); await load(); confirm(); await flush();
    const original = f.mock.calls[1]!; harness.session.mockRejectedValueOnce(new PlanAccessError('expired'));
    button('Retry exact retained activation').props.onClick(); await flush(); expect(f).toHaveBeenCalledTimes(2);
    f.mockResolvedValueOnce(envelope(current, false, true)); button('Verify access and resume').props.onClick(); await flush();
    expect(button('Retry exact retained activation')).toBeDefined();
    f.mockResolvedValueOnce(envelope(receipt(), true)); button('Retry exact retained activation').props.onClick(); await flush();
    expect(f.mock.calls[3]![0]).toBe(original[0]); expect(f.mock.calls[3]![1]!.body).toBe(original[1]!.body); expect(f.mock.calls[3]![1]!.headers).toEqual(original[1]!.headers);
  });
  it.each(['pagehide', 'hon:session-invalidated', 'hon:school-context-changed'])('%s conceals loaded facts, rejects a late read and never auto-restores', async event => {
    let settle!: (value: Response) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(done => { settle = done; }));
    render(); harness.effects[0]!(); await load(); window.dispatchEvent(new Event(event));
    settle(envelope(preview())); await flush(); expect(html()).not.toContain('Synthetic Student'); expect(html()).toContain('Membership information hidden');
    window.dispatchEvent(new Event('focus')); await flush(); expect(f).toHaveBeenCalledTimes(1);
  });
  it('blocks return and discard during a command, and deliberate bound abandonment returns to an empty CRM without revealing IDs', async () => {
    const back = vi.fn(); props = { ...props, initialMembership: scope, onReturn: back };
    let reject!: (value: Error) => void;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(); harness.effects[0]!(); nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); await flush(); confirm(); await flush();
    button('Return to CRM registration').props.onClick(); expect(back).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('blur'));
    const findDiscard = (tree: any): any => !tree || typeof tree !== 'object' ? undefined : Array.isArray(tree) ? tree.map(findDiscard).find(Boolean) : tree.type?.name === 'CrmEnrollmentDiscard' ? tree : findDiscard(tree.props?.children);
    let control = findDiscard(render()); expect(control.props.disabled).toBe(true); control.props.onDiscard(); expect(back).not.toHaveBeenCalled();
    reject(new DOMException('Unknown', 'TimeoutError')); await flush(); control = findDiscard(render()); expect(control.props.disabled).toBe(false); control.props.onDiscard();
    expect(back).toHaveBeenCalledOnce(); expect(html()).toContain('Membership information hidden'); expect(html()).not.toContain(scope.membershipId);
  });
  it('a successful current-context refresh is distinct from historical receipt or effective status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope(receipt())).mockResolvedValueOnce(envelope({ ...current, state: 'ACTIVE', version: 2 }, false, true));
    await load(); confirm(); await flush(); button('Check current membership status').props.onClick(); await flush();
    expect(html()).toContain('Current membership observation'); expect(html()).toContain('ACTIVE alone does not prove current effective dates, payment or agreement.'); expect(harness.session).toHaveBeenCalledTimes(6);
  });
  it('requires a fresh ACTIVE read for date handoff and invalidates captured handoffs on session loss or another read',async()=>{
    const manage=vi.fn();props={...props,initialMembership:scope,onManageDates:manage};
    const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope(receipt())).mockResolvedValueOnce(envelope({...current,state:'ACTIVE',version:2},false,true));
    await load();expect(button('Review membership dates and history')).toBeUndefined();confirm();await flush();expect(button('Review membership dates and history')).toBeUndefined();
    button('Check current membership status').props.onClick();await flush();const old=button('Review membership dates and history').props.onClick;old();expect(manage).toHaveBeenCalledExactlyOnceWith(scope);expect(Object.isFrozen(manage.mock.calls[0]![0])).toBe(true);manage.mockClear();
    harness.effects[0]!();window.dispatchEvent(new Event('hon:session-invalidated'));old();expect(manage).not.toHaveBeenCalled();expect(html()).toContain('Membership information hidden');
    expect(f.mock.calls.filter(([,o])=>String(o?.method)==='POST')).toHaveLength(2);
  });
});
