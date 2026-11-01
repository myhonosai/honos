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
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en', region: 'auto', timeZone: 'UTC', currencyDisplay: 'symbol' }, date: (s: string) => s, number: (n: number) => String(n) }) }));
import { MembershipDatesWorkbench } from '../src/components/membership-dates-workbench';
import { scope, id, history, preview, receipt, period, report, envelope, rejected } from './membership-dates-fixtures';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../src/components/session-invalidation';
import { PlanAccessError } from '../src/components/membership-plans/http';
const render = () => { harness.cursor = 0; return MembershipDatesWorkbench({ sessionSubject: 'synthetic-staff' }); };
const nodes = (tree: any, type: string): any[] => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(value => nodes(value, type)) : [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
const text = (tree: any): string => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : '';
const html = () => renderToStaticMarkup(render());
const button = (name: string) => nodes(render(), 'button').find(node => text(node) === name);
const field = (name: string) => { const label = nodes(render(), 'label').find(node => text(node).includes(name)); return label ? [...nodes(label, 'input'), ...nodes(label, 'select'), ...nodes(label, 'textarea')][0] : undefined; };
const fill = (name: string, value: string) => field(name).props.onChange({ target: { value } });
const tick = (name: string) => field(name).props.onChange({ target: { checked: true } });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function selectors() { render(); fill('Organization ID', scope.organizationId); fill('School ID', scope.schoolId); fill('Already-known membership ID', scope.membershipId); }
async function load() { selectors(); nodes(render(), 'form')[0].props.onSubmit({ preventDefault: vi.fn() }); await flush(); }
function final() { fill('Reason category', 'DATA_ENTRY_ERROR'); fill('Reason for this change', 'Staff verified the correct membership dates.'); nodes(render(), 'form')[1].props.onSubmit({ preventDefault: vi.fn() }); }
function confirm() { final(); tick('I confirm this exact date change'); button('Confirm membership date change').props.onClick(); }
beforeEach(() => { harness.slots = []; harness.cursor = 0; harness.effects = []; harness.session.mockReset().mockResolvedValue(undefined); vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('E1b-1 independent staff date-management lifecycle', () => {
  it.each(['pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT])('conceals on %s and rejects late reads until an explicit authorized restoration', async event => {
    let settle!: (value: Response) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(done => { settle = done; }))
      .mockResolvedValueOnce(envelope(history(), false, true));
    render(); harness.effects[0]!(); await load();
    window.dispatchEvent(new Event(event));
    expect(html()).toContain('Membership information hidden');
    settle(envelope(history(), false, true)); await flush();
    expect(html()).not.toContain('Verified current membership'); expect(f).toHaveBeenCalledTimes(1);
    button('Verify access and resume').props.onClick(); await flush();
    expect(html()).toContain('Verified current membership'); expect(f).toHaveBeenCalledTimes(2);
  });
  it('refuses a completed read when the verified identity changes before display', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview()));
    harness.session.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PlanAccessError('identity changed'));
    await load(); expect(html()).toContain('Membership information hidden');
    expect(html()).not.toContain('Verified current membership'); expect(button('Confirm membership date change')).toBeUndefined();
  });
  it('preserves an immutable command after a success response whose final identity check fails', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope(receipt()));
    await load();
    harness.session.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PlanAccessError('identity changed'));
    confirm(); await flush();
    expect(html()).toContain('Membership information hidden'); expect(html()).not.toContain('Membership date revision receipt');
    expect(f).toHaveBeenCalledTimes(3); expect(button('Verify access and resume').props.disabled).toBe(false);
    f.mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope(receipt(), true));
    button('Verify access and resume').props.onClick(); await flush();
    expect(f).toHaveBeenCalledTimes(5); button('Retry exact retained date change').props.onClick(); await flush();
    expect(f.mock.calls[5]![1]!.body).toBe(f.mock.calls[2]![1]!.body);
    expect(f.mock.calls[5]![1]!.headers).toEqual(f.mock.calls[2]![1]!.headers);
    expect(html()).toContain('Verified idempotent replay');
  });
  it('mounts idle, verifies history and capability, and requires a separate reason/review/confirmation', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(); expect(f).not.toHaveBeenCalled(); await load(); expect(button('Extend')).toBeDefined(); final(); expect(button('Confirm membership date change').props.disabled).toBe(true);
    tick('I confirm this exact date change'); const click = button('Confirm membership date change').props.onClick; click(); click(); await flush(); expect(f).toHaveBeenCalledTimes(3);
    expect(button('Retry exact retained date change').props.disabled).toBe(true); expect(nodes(render(), 'CrmEnrollmentDiscard')).toHaveLength(0);
    resolve(envelope(receipt())); await flush(); expect(html()).toContain('Membership date revision receipt'); expect(html()).toContain('No financial effects'); expect(button('Confirm membership date change')).toBeUndefined();
  });
  it('displays authorized read-only history without granting date controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(rejected(403, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
    await load(); expect(html()).toContain('Verified current membership'); expect(button('Extend')).toBeUndefined(); expect(button('Confirm membership date change')).toBeUndefined();
  });
  it('shows retroactive permission refusal and financial blockers without an actionable confirmation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview({ canConfirm: false, requiredPermissions: ['billing.membership.dates.revise', 'billing.membership.dates.retroactive'], retroactiveDays: { added: 3, removed: 0 }, warnings: [{ code: 'RETROACTIVE_CHANGE', added: 3, removed: 0 }], blocks: [{ code: 'DATE_CHANGE_CONFLICTS_WITH_OPEN_INVOICE' }] })));
    await load(); expect(html()).toContain('date change conflicts with open invoice'); tick('retroactive change'); final(); expect(button('Confirm membership date change')).toBeUndefined();
  });
  it('invalidates the old digest and every acknowledgement on valid and invalid edits', async () => {
    const fresh = preview({ previewDigest: 'b'.repeat(64), proposedDates: { startDate: '2026-10-25', endDate: period.endDate, dateSource: 'STAFF_ADJUSTED' }, effectiveStatusIfConfirmedNow: 'SCHEDULED', warnings: [{ code: 'START_DATE_IN_FUTURE', days: 9 }] });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope(fresh));
    await load(); final(); fill('Start date', '2026-10-25'); expect(button('Confirm membership date change')).toBeUndefined(); await flush(); expect(html()).toContain('not currently IN_EFFECT');
    expect(JSON.parse(f.mock.calls[2]![1]!.body as string)).toEqual({ changeKind: 'CORRECTION', startDate: '2026-10-25', endDate: period.endDate });
    expect(field('start date in future').props.checked).toBe(false); fill('Last valid day (inclusive)', '2020-01-01'); expect(html()).not.toContain('Step 1 · Review date change'); expect(f).toHaveBeenCalledTimes(3);
  });
  it.each(['DATE_REVISION_PREVIEW_STALE', 'VERSION_CONFLICT', 'PERIOD_VERSION_CONFLICT', 'MEMBERSHIP_NOT_ACTIVE', 'IDEMPOTENCY_KEY_REUSED'])('requires new facts after %s without automatic retries', async code => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(rejected(409, code));
    await load(); confirm(); await flush(); expect(button('Retry exact retained date change')).toBeUndefined(); expect(button('Confirm membership date change')).toBeUndefined(); expect(f).toHaveBeenCalledTimes(3);
  });
  it.each(['success', 'unknown', 'rejected'])('settles %s behind the privacy shield without stranding busy or reloading', async outcome => {
    let resolve!: (r: Response) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(); harness.effects[0]!(); await load(); confirm(); await flush(); window.dispatchEvent(new Event('blur'));
    expect(html()).toContain('Membership information hidden'); expect(html()).not.toContain('Synthetic Student'); expect(button('Verify access and resume').props.disabled).toBe(true);
    resolve(outcome === 'success' ? envelope(receipt()) : rejected(outcome === 'unknown' ? 503 : 409, 'VERSION_CONFLICT')); await flush(); expect(button('Verify access and resume').props.disabled).toBe(false);
    f.mockResolvedValueOnce(envelope(history(), false, true)); if (outcome === 'unknown') f.mockResolvedValueOnce(envelope(preview()));
    button('Verify access and resume').props.onClick(); await flush(); expect(html()).not.toContain('Membership information hidden');
    if (outcome === 'unknown') { const original = f.mock.calls[2]!; f.mockResolvedValueOnce(envelope(receipt(), true)); const calls = f.mock.calls.length; button('Retry exact retained date change').props.onClick(); await flush(); expect(f.mock.calls[calls]![1]!.body).toBe(original[1]!.body); expect(f.mock.calls[calls]![1]!.headers).toEqual(original[1]!.headers); expect(html()).toContain('Verified idempotent replay'); }
    else expect(button('Retry exact retained date change')).toBeUndefined();
  });
  it.each([401, 403])('conceals on command access failure %s and retains the immutable request', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(rejected(status, 'MEMBERSHIP_DATE_REVISION_FORBIDDEN'));
    await load(); confirm(); await flush(); expect(html()).toContain('Membership information hidden'); expect(button('Verify access and resume').props.disabled).toBe(false);
  });
  it('repeated focus loss invalidates restoration, and changed/expired sessions never reveal data', async () => {
    let resolve!: (r: Response) => void;
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview()));
    render(); harness.effects[0]!(); await load(); window.dispatchEvent(new Event('blur')); f.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    button('Verify access and resume').props.onClick(); await flush(); window.dispatchEvent(new Event('blur')); resolve(envelope(history(), false, true)); await flush(); expect(html()).toContain('Membership information hidden');
    harness.session.mockRejectedValueOnce(new Error('expired or changed')); button('Verify access and resume').props.onClick(); await flush(); expect(html()).toContain('Information remains hidden'); expect(f).toHaveBeenCalledTimes(3);
  });
  it('does not conceal empty screens, ignores stale scope reads and never fetches from a URL', async () => {
    let resolve!: (r: Response) => void; const f = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(); harness.effects[0]!(); window.dispatchEvent(new Event('blur')); expect(html()).not.toContain('Membership information hidden');
    await load(); fill('School ID', id('9')); resolve(envelope(history(), false, true)); await flush(); expect(html()).not.toContain('Verified current membership');
    // A late first read may finish, but its already-aborted signal must not reveal old-scope facts.
    expect(button('Confirm membership date change')).toBeUndefined();
  });
  it('loads individual legacy items and backend summary through separate authorized reads, without bulk commands', async () => {
    const q = { items: [{ membershipId: scope.membershipId, participantDisplayName: 'Synthetic Legacy Student', planCode: 'LEGACY', legacyStoredTerm: { termStartedAt: period.termStartedAt, termEndsAt: period.termEndsAt }, createdAt: '2026-10-01T12:00:00.000Z' }], next: scope.membershipId };
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(q, false, true)).mockResolvedValueOnce(envelope({ items: [], next: null }, false, true)).mockResolvedValueOnce(envelope(report(), false, true));
    selectors(); button('Review legacy date queue').props.onClick(); await flush(); expect(html()).toContain('unconfirmed'); expect(html()).toContain('Review individual membership');
    button('Next legacy queue page').props.onClick(); await flush(); expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ after: scope.membershipId, limit: 10 });
    button('Load status summary').props.onClick(); await flush(); expect(html()).toContain('ACTIVE by confirmed effective status'); expect(html()).toContain('UNDATED'); expect(f.mock.calls.some(c => String(c[0]).endsWith('/revisions'))).toBe(false);
  });
  it('supports a legacy INITIAL_CONFIRMATION with null period version and required staff reason', async () => {
    const h = history({ datesConfirmed: false, currentPeriod: null, legacyStoredTerm: { termStartedAt: null, termEndsAt: null }, versions: [], effectiveStatus: 'UNDATED' });
    const p = preview({ changeKind: 'INITIAL_CONFIRMATION', currentPeriod: null, legacyStoredTerm: h.legacyStoredTerm, suggestedDates: null, proposedDates: { startDate: '2026-11-01', endDate: null, dateSource: 'STAFF_ENTERED' }, effectiveStatusNow: 'UNDATED' });
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(h, false, true)).mockResolvedValueOnce(envelope(p)).mockResolvedValueOnce(rejected(409, 'DATE_REVISION_PREVIEW_STALE'));
    await load(); fill('Start date', '2026-11-01'); await flush(); expect(button('Confirm dates')).toBeDefined(); fill('Reason category', 'LEGACY_RECORDS_REVIEWED'); fill('Reason for this change', 'School verified legacy records individually.'); nodes(render(), 'form')[1].props.onSubmit({ preventDefault: vi.fn() }); tick('I confirm this exact date change'); button('Confirm membership date change').props.onClick(); await flush(); expect(JSON.parse(f.mock.calls[2]![1]!.body as string).expectedPeriodVersion).toBeNull();
  });
});
