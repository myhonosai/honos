import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION,
  CrmGuardianChildPayerDesignationAccessError,
  CrmGuardianChildPayerDesignationRejectedError,
  CrmGuardianChildPayerDesignationUncertainError,
  crmGuardianChildPayerDesignationPath,
  crmGuardianChildPayerDesignationPreparationPath,
  loadCrmGuardianChildPayerDesignationPreparation,
  parseCrmGuardianChildPayerDesignationPreparation,
  parseCrmGuardianChildPayerDesignationResult,
  prepareCrmGuardianChildPayerDesignationCommand,
  submitCrmGuardianChildPayerDesignation,
} from '../src/components/crm-guardian-child-payer-designation-http';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const studentProfileId = id('3'); const key = id('4');
const readiness = { studentDisplayName: 'Avery Kim', guardianDisplayName: 'Morgan Kim', currency: 'USD', readiness: 'READY_FOR_PAYER_DESIGNATION' } as const;
const receipt = { studentDisplayName: 'Avery Kim', guardianDisplayName: 'Morgan Kim', currency: 'USD', state: 'PAYER_DESIGNATED', recordedAt: '2026-10-18T20:00:00.000Z' } as const;
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('6'), correlationId: id('6'), replayed } });
const response = (data: unknown, status = 200, type = 'application/json; charset=utf-8') => new Response(JSON.stringify(status === 200 ? data : { detail: 'hidden' }), { status, headers: { 'Content-Type': type } });
afterEach(() => vi.restoreAllMocks());

describe('guardian-child payer designation transport', () => {
  it('accepts only closed readiness and historical PAYER_DESIGNATED receipt envelopes', () => {
    expect(crmGuardianChildPayerDesignationPreparationPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-payer-designations/preparation`);
    expect(crmGuardianChildPayerDesignationPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-payer-designations`);
    expect(parseCrmGuardianChildPayerDesignationPreparation(envelope(readiness))).toEqual(readiness);
    const command = prepareCrmGuardianChildPayerDesignationCommand(scope, { studentProfileId, confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }, key);
    expect(parseCrmGuardianChildPayerDesignationResult(envelope(receipt), command)).toEqual({ receipt, replayed: false });
    for (const malformed of [envelope({ ...readiness, guardianId: id('7') }), { data: readiness, meta: { requestId: id('6'), correlationId: id('6'), replayed: true } }]) expect(() => parseCrmGuardianChildPayerDesignationPreparation(malformed)).toThrow();
    for (const malformed of [envelope({ ...receipt, accountId: id('7') }), envelope({ ...receipt, state: 'DRAFT' }), { data: receipt, meta: { requestId: id('6'), correlationId: id('7'), replayed: false } }]) expect(() => parseCrmGuardianChildPayerDesignationResult(malformed, command)).toThrow();
  });

  it('posts one explicit readiness body and exact closed designation body with same-origin no-store headers', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope(readiness))).mockResolvedValueOnce(response(envelope(receipt, true)));
    const random = vi.spyOn(crypto, 'randomUUID');
    await expect(loadCrmGuardianChildPayerDesignationPreparation(scope, studentProfileId)).resolves.toEqual(readiness);
    expect(fetcher.mock.calls[0]).toEqual([crmGuardianChildPayerDesignationPreparationPath(scope), expect.objectContaining({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: JSON.stringify({ studentProfileId }) })]);
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-guardian-child-payer-designation-prepare' });
    expect(random).not.toHaveBeenCalled();
    const command = prepareCrmGuardianChildPayerDesignationCommand(scope, { studentProfileId, confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }, key);
    await expect(submitCrmGuardianChildPayerDesignation(command)).resolves.toEqual({ receipt, replayed: true });
    expect(command.body).toBe(JSON.stringify({ studentProfileId, confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }));
    expect((fetcher.mock.calls[1]![1] as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-guardian-child-payer-designation' });
  });

  it('fails closed for access, unavailable/non-child readiness, malformed output, and uncertain command outcomes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403] as const) { fetcher.mockResolvedValueOnce(response({}, status)); await expect(loadCrmGuardianChildPayerDesignationPreparation(scope, studentProfileId)).rejects.toBeInstanceOf(CrmGuardianChildPayerDesignationAccessError); }
    for (const status of [400, 404, 409, 422]) { fetcher.mockResolvedValueOnce(response({}, status)); await expect(loadCrmGuardianChildPayerDesignationPreparation(scope, studentProfileId)).rejects.toBeInstanceOf(CrmGuardianChildPayerDesignationRejectedError); }
    fetcher.mockResolvedValueOnce(response(envelope({ ...readiness, readiness: 'READY_FOR_DRAFT' }))); await expect(loadCrmGuardianChildPayerDesignationPreparation(scope, studentProfileId)).rejects.toBeInstanceOf(CrmGuardianChildPayerDesignationRejectedError);
    const command = prepareCrmGuardianChildPayerDesignationCommand(scope, { studentProfileId, confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }, key);
    fetcher.mockRejectedValueOnce(new Error('network')); await expect(submitCrmGuardianChildPayerDesignation(command)).rejects.toBeInstanceOf(CrmGuardianChildPayerDesignationUncertainError);
    fetcher.mockResolvedValueOnce(response(envelope(receipt), 200, 'text/plain')); await expect(submitCrmGuardianChildPayerDesignation(command)).rejects.toBeInstanceOf(CrmGuardianChildPayerDesignationUncertainError);
  });
});
