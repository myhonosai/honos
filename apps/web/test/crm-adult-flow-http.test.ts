import { afterEach, describe, expect, it, vi } from 'vitest';
import { adultRequest, sendAdultRequest, AdultAccessError, AdultUncertainError, AdultRejectedError } from '../src/components/crm-adult-flow-http';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: id(1), schoolId: id(2) }, key = id(9), date = '2026-10-20T09:00:00.000Z';
const meta = { requestId: id(8), correlationId: id(8), replayed: false };
const reply = (data: unknown, status = 200, patch = {}) => new Response(JSON.stringify({ data, meta: { ...meta, ...patch } }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const register = () => adultRequest(scope, 'register', id(3), '1990-01-02', key);
const registration = { outcome: 'REGISTERED', leadId: id(3), sourceContactPersonId: id(4), registrationPath: 'ADULT', studentProfileId: id(5), familyId: null, recordedAt: date };
const account = { id: id(6), responsiblePersonId: id(4), currency: 'USD', classification: 'CANONICAL', reused: true, version: 1, createdAt: date };
const receipt = { membershipId: id(7), state: 'DRAFT', planCode: 'ADULT-MONTHLY', termStartedAt: null, termEndsAt: null, recordedAt: date };
afterEach(() => { vi.restoreAllMocks(); });
describe('merged adult CRM transport integration', () => {
  it('uses only the closed existing APIs, exact markers, scope and distinct caller-supplied command keys', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(registration)).mockResolvedValueOnce(reply(account))
      .mockResolvedValueOnce(reply({ studentDisplayName: 'Ari Stone', currency: 'USD', readiness: 'READY_FOR_DRAFT' }))
      .mockResolvedValueOnce(reply(receipt)).mockResolvedValueOnce(reply({ state: 'RECORDED_DRAFT', receipt }));
    const steps = [register(), adultRequest(scope, 'account', id(4), 'USD', id(10)), adultRequest(scope, 'prepare', id(5), ''), adultRequest(scope, 'draft', id(5), 'ADULT-MONTHLY', id(11)), adultRequest(scope, 'confirm', id(5), '')];
    for (const request of steps) expect((await sendAdultRequest(request)).step).toBe(request.step);
    expect(f).toHaveBeenCalledTimes(5);
    for (const [i, request] of steps.entries()) {
      expect(f.mock.calls[i]).toEqual([request.path, expect.objectContaining({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', body: request.body })]);
      const h = f.mock.calls[i]![1]!.headers as Record<string, string>;
      expect(h['X-HON-Human-Command']).toBe(['crm-lead-register', 'billing.account.create', 'crm-adult-membership-prepare', 'crm-adult-membership-draft', 'crm-adult-membership-draft-confirmation'][i]);
      expect(h['Idempotency-Key']).toBe(request.key);
    }
    expect(JSON.parse(steps[1]!.body)).toEqual({ responsiblePersonId: id(4), currency: 'USD' });
    expect(JSON.parse(steps[3]!.body)).not.toHaveProperty('billingAccountId');
  });
  it('rejects forged scope, paths, extra financial selectors and malformed input before any request', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    for (const patch of [{ path: 'https://evil.test' }, { path: register().path + '?payer=forged' }, { body: JSON.stringify({ ...JSON.parse(register().body), payment: true }) }, { step: 'activate' }, { key: 'invalid' }]) {
      await expect(sendAdultRequest({ ...register(), ...patch } as any)).rejects.toThrow();
    }
    expect(() => adultRequest({ ...scope, schoolId: '../foreign' }, 'register', id(3), '1990-01-01', key)).toThrow();
    expect(() => adultRequest(scope, 'prepare', id(5), '', key)).toThrow();
    expect(f).not.toHaveBeenCalled();
  });
  it.each([401, 403])('fails closed on %s independently at every step without echoing private errors', async status => {
    const f = vi.spyOn(globalThis, 'fetch');
    for (const r of [register(), adultRequest(scope, 'account', id(4), 'USD', key), adultRequest(scope, 'prepare', id(5), ''), adultRequest(scope, 'draft', id(5), 'P', key), adultRequest(scope, 'confirm', id(5), '')]) {
      f.mockResolvedValue(reply({ secret: 'private-customer-canary' }, status)); await expect(sendAdultRequest(r)).rejects.toBeInstanceOf(AdultAccessError);
    }
  });
  it.each([400, 404, 409, 422])('treats %s as rejected without claiming completion or automatic retries', async status => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({}, status));
    await expect(sendAdultRequest(register())).rejects.toBeInstanceOf(AdultRejectedError); expect(f).toHaveBeenCalledTimes(1);
  });
  it('retains immutable request data after unknown outcome, including an invalid or mismatched success receipt', async () => {
    const r = register(), f = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(reply(registration, 200, { replayed: true }));
    await expect(sendAdultRequest(r)).rejects.toBeInstanceOf(AdultUncertainError);
    const result = await sendAdultRequest(r); expect(result).toMatchObject({ step: 'register', replayed: true }); expect(f.mock.calls[0]).toEqual(f.mock.calls[1]); expect(Object.isFrozen(r)).toBe(true);
    for (const data of [{ ...registration, leadId: id(99) }, { ...registration, secret: 'extra' }, { ...registration, registrationPath: 'GUARDIAN_CHILD' }]) {
      f.mockResolvedValue(reply(data)); await expect(sendAdultRequest(r)).rejects.toBeInstanceOf(AdultUncertainError);
    }
  });
  it('validates payer/currency/classification and accepts only genuine legacy replay shape', async () => {
    const r = adultRequest(scope, 'account', id(4), 'USD', key), f = vi.spyOn(globalThis, 'fetch');
    for (const data of [{ ...account, responsiblePersonId: id(99) }, { ...account, currency: 'EUR' }, { ...account, classification: 'ADDITIONAL' }, { ...account, version: 0 }]) {
      f.mockResolvedValue(reply(data)); await expect(sendAdultRequest(r)).rejects.toBeInstanceOf(AdultUncertainError);
    }
    const { classification: _c, reused: _r, ...legacy } = account;
    f.mockResolvedValue(reply(legacy)); await expect(sendAdultRequest(r)).rejects.toBeInstanceOf(AdultUncertainError);
    f.mockResolvedValue(reply(legacy, 200, { replayed: true })); expect(await sendAdultRequest(r)).toMatchObject({ step: 'account', replayed: true });
  });
  it('keeps preparation and current confirmation read-only, separately verified and non-replayed', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply({ state: 'RECORDED_DRAFT', receipt: { ...receipt, state: 'ACTIVE' } }));
    await expect(sendAdultRequest(adultRequest(scope, 'confirm', id(5), ''))).rejects.toBeInstanceOf(AdultRejectedError);
    f.mockResolvedValue(reply({ studentDisplayName: 'Ari', currency: 'USD', readiness: 'READY_FOR_DRAFT' }, 200, { replayed: true }));
    await expect(sendAdultRequest(adultRequest(scope, 'prepare', id(5), ''))).rejects.toBeInstanceOf(AdultRejectedError);
    f.mockResolvedValue(reply({ outcome: 'NEEDS_STAFF_REVIEW' })); expect(await sendAdultRequest(register())).toMatchObject({ registration: { outcome: 'NEEDS_STAFF_REVIEW' } });
  });
});
