import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMembershipDateHistory, loadMembershipDateQueue, loadMembershipStatusSummary, previewMembershipDates, prepareMembershipDateRevision, reviseMembershipDates, MembershipDatesError } from '../src/components/membership-dates-http';
import { scope, id, history, preview, receipt, input, report, envelope, rejected } from './membership-dates-fixtures';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
const school = { organizationId: scope.organizationId, schoolId: scope.schoolId };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('0178 exact staff frontend transport', () => {
  it.each(['history', 'confirmation'])('broadcasts %s 401 before waiting for the error body', async kind => {
    const events = new EventTarget(); vi.stubGlobal('window', events);
    const invalidated = vi.fn(); events.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated);
    let settle!: (value: string) => void;
    const response = rejected(401, 'VALIDATION_FAILED');
    vi.spyOn(response, 'text').mockImplementation(() => new Promise(done => { settle = done; }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const work = kind === 'history' ? loadMembershipDateHistory(scope) : reviseMembershipDates(prepareMembershipDateRevision(scope, input(), id('8')));
    const refusal = expect(work).rejects.toMatchObject({ status: 401 });
    await Promise.resolve(); await Promise.resolve();
    expect(invalidated).toHaveBeenCalledTimes(1);
    settle('{}'); await refusal;
  });
  it('keeps a school-level 403 local without invalidating authenticated sessions', async () => {
    const events = new EventTarget(); vi.stubGlobal('window', events);
    const invalidated = vi.fn(); events.addEventListener(HON_SESSION_INVALIDATED_EVENT, invalidated);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rejected(403, 'MEMBERSHIP_DATE_HISTORY_FORBIDDEN'));
    await expect(loadMembershipDateHistory(scope)).rejects.toMatchObject({ status: 403 });
    expect(invalidated).not.toHaveBeenCalled();
  });
  it('uses closed POST read markers, no command key, credentials and no-store, and independent report scope', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(history(), false, true)).mockResolvedValueOnce(envelope(preview())).mockResolvedValueOnce(envelope({ items: [], next: null }, false, true)).mockResolvedValueOnce(envelope(report(), false, true));
    await loadMembershipDateHistory(scope); await previewMembershipDates(scope, { changeKind: 'CORRECTION' }); await loadMembershipDateQueue(school, { limit: 10 }); await loadMembershipStatusSummary(school);
    expect(f.mock.calls.map(c => (c[1]!.headers as any)['X-HON-Human-Command'])).toEqual(['billing.membership.dates.history', 'billing.membership.dates.preview', 'billing.membership.dates.queue', undefined]);
    expect(f.mock.calls[2]![1]!.body).toBe('{"limit":10}'); expect(f.mock.calls[3]![1]!.body).toBeUndefined(); expect(f.mock.calls[3]![1]!.method).toBe('GET');
    for (const [, options] of f.mock.calls) { expect(options).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }); expect((options!.headers as any)['Idempotency-Key']).toBeUndefined(); }
  });
  it('freezes scope/body/key, replays identical bytes and validates the request-bound receipt', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(receipt())).mockResolvedValueOnce(envelope(receipt(), true));
    const mutable = { ...scope }, request = prepareMembershipDateRevision(mutable, input(), id('8')); mutable.schoolId = id('9');
    expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.scope)).toBe(true);
    expect((await reviseMembershipDates(request)).replayed).toBe(false); expect((await reviseMembershipDates(request)).replayed).toBe(true);
    expect(f.mock.calls[1]![0]).toBe(f.mock.calls[0]![0]); expect(f.mock.calls[1]![1]!.body).toBe(f.mock.calls[0]![1]!.body); expect(f.mock.calls[1]![1]!.headers).toEqual(f.mock.calls[0]![1]!.headers);
  });
  it.each(['membership', 'school', 'preview-dates', 'receipt-dates', 'financial-effects', 'unknown-field', 'cache', 'meta', 'key-on-read'])('fails closed on %s mismatch', async kind => {
    let data: any = kind === 'school' ? report({ schoolId: id('9') }) : kind.startsWith('receipt') || kind === 'financial-effects' ? receipt() : kind === 'membership' ? history({ membershipId: id('9') }) : preview();
    if (kind === 'receipt-dates') data.effectivePeriod.endDate = '2026-12-31'; if (kind === 'financial-effects') data.financialEffects = ['payment']; if (kind === 'unknown-field') data.privateCanary = 'private';
    const response = kind === 'cache' ? Response.json({ data, meta: {} }) : kind === 'meta' ? Response.json({ data, meta: { requestId: id('6'), correlationId: id('9'), replayed: false } }, { headers: { 'Cache-Control': 'private, no-store' } }) : envelope(data, kind === 'key-on-read', kind === 'membership' || kind === 'school');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const work = kind === 'membership' ? loadMembershipDateHistory(scope) : kind === 'school' ? loadMembershipStatusSummary(school) : kind === 'receipt-dates' || kind === 'financial-effects' ? reviseMembershipDates(prepareMembershipDateRevision(scope, input(), id('8'))) : previewMembershipDates(scope, kind === 'preview-dates' ? { changeKind: 'CORRECTION', startDate: '2026-11-01', endDate: null } : { changeKind: 'CORRECTION' });
    await expect(work).rejects.toThrow();
  });
  it.each([401, 403, 404, 409, 422, 503])('redacts error details and classifies HTTP %s', async status => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rejected(status, status === 409 ? 'DATE_REVISION_PREVIEW_STALE' : 'VALIDATION_FAILED'));
    try { await reviseMembershipDates(prepareMembershipDateRevision(scope, input(), id('8'))); throw new Error('expected refusal'); } catch (e) { expect(e).toBeInstanceOf(MembershipDatesError); const error = e as MembershipDatesError; expect(error.status).toBe(status); expect(error.uncertain).toBe(status === 503); expect(error.message).not.toContain('PRIVATE_CANARY'); }
  });
  it('retains uncertainty for a network failure, invalid success and concurrent in-progress request', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('lost', 'TimeoutError')).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(rejected(409, 'IDEMPOTENCY_IN_PROGRESS'));
    const request = prepareMembershipDateRevision(scope, input(), id('8'));
    for (let i = 0; i < 3; i++) await expect(reviseMembershipDates(request)).rejects.toMatchObject({ uncertain: true }); expect(f).toHaveBeenCalledTimes(3);
  });
  it('rejects extra request fields, URL selectors, unsupported scopes and invalid queue cursors before fetch', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    await expect(loadMembershipDateHistory({ ...scope, membershipId: '../other' })).rejects.toThrow();
    await expect(loadMembershipDateQueue(school, { after: 'invented-cursor' })).rejects.toThrow();
    expect(() => prepareMembershipDateRevision(scope, { ...input(), activate: true } as any, id('8'))).toThrow(); expect(f).not.toHaveBeenCalled();
  });
});
