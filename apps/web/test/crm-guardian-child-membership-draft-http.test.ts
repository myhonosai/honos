import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION,
  CrmGuardianChildMembershipDraftAccessError,
  CrmGuardianChildMembershipDraftRejectedError,
  CrmGuardianChildMembershipDraftUncertainError,
  crmGuardianChildMembershipDraftConfirmationPath,
  crmGuardianChildMembershipDraftPath,
  crmGuardianChildMembershipDraftPreparationPath,
  loadCrmGuardianChildMembershipDraftConfirmation,
  loadCrmGuardianChildMembershipDraftPreparation,
  parseCrmGuardianChildMembershipDraftConfirmation,
  parseCrmGuardianChildMembershipDraftPreparation,
  parseCrmGuardianChildMembershipDraftResult,
  prepareCrmGuardianChildMembershipDraftCommand,
  submitCrmGuardianChildMembershipDraft,
} from '../src/components/crm-guardian-child-membership-draft-http';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') }; const studentProfileId = id('3'); const key = id('4');
const readiness = { studentDisplayName: 'Avery Kim', guardianDisplayName: 'Morgan Kim', currency: 'USD', readiness: 'READY_FOR_DRAFT' } as const;
const receipt = { membershipId: id('5'), state: 'DRAFT', planCode: 'CHILD-OPAQUE', termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-18T20:00:00.000Z' } as const;
const confirmation = { state: 'RECORDED_DRAFT', receipt } as const;
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('6'), correlationId: id('6'), replayed } });
const response = (data: unknown, status = 200, type = 'application/json; charset=utf-8') => new Response(JSON.stringify(status === 200 ? data : { detail: 'hidden' }), { status, headers: { 'Content-Type': type } });
afterEach(() => vi.restoreAllMocks());

describe('source-bound guardian-child membership DRAFT transport', () => {
  it('accepts only closed child/guardian readiness, current DRAFT confirmation, and historical DRAFT receipt envelopes', () => {
    expect(crmGuardianChildMembershipDraftPreparationPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-membership-drafts/preparation`);
    expect(crmGuardianChildMembershipDraftConfirmationPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-membership-drafts/confirmation`);
    expect(crmGuardianChildMembershipDraftPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-guardian-child-membership-drafts`);
    expect(parseCrmGuardianChildMembershipDraftPreparation(envelope(readiness))).toEqual(readiness);
    expect(parseCrmGuardianChildMembershipDraftConfirmation(envelope(confirmation))).toEqual(confirmation);
    const command = prepareCrmGuardianChildMembershipDraftCommand(scope, { studentProfileId, planCode: receipt.planCode, confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION }, key);
    expect(parseCrmGuardianChildMembershipDraftResult(envelope(receipt), command)).toEqual({ receipt, replayed: false });
    for (const malformed of [envelope({ ...readiness, familyId: id('7') }), envelope({ ...confirmation, receipt: { ...receipt, guardianId: id('7') } }), envelope({ state: 'ACTIVE', receipt })]) expect(() => parseCrmGuardianChildMembershipDraftConfirmation(malformed)).toThrow();
    for (const malformed of [envelope({ ...receipt, payerId: id('7') }), envelope({ ...receipt, state: 'ACTIVE' })]) expect(() => parseCrmGuardianChildMembershipDraftResult(malformed, command)).toThrow();
  });

  it('posts separately explicit preparation/current confirmation and one exact draft command with no generic endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope(readiness))).mockResolvedValueOnce(response(envelope(confirmation))).mockResolvedValueOnce(response(envelope({ ...receipt, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z' }, true)));
    const random = vi.spyOn(crypto, 'randomUUID');
    await expect(loadCrmGuardianChildMembershipDraftPreparation(scope, studentProfileId)).resolves.toEqual(readiness);
    await expect(loadCrmGuardianChildMembershipDraftConfirmation(scope, studentProfileId)).resolves.toEqual(confirmation);
    for (const [index, marker] of [['crm-guardian-child-membership-prepare', 0], ['crm-guardian-child-membership-confirmation', 1]] as const) {
      const options = fetcher.mock.calls[marker]![1] as RequestInit; expect(options).toMatchObject({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: JSON.stringify({ studentProfileId }) }); expect(options.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': index });
    }
    expect(random).not.toHaveBeenCalled();
    const command = prepareCrmGuardianChildMembershipDraftCommand(scope, { studentProfileId, planCode: receipt.planCode, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z', confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION }, key);
    await submitCrmGuardianChildMembershipDraft(command);
    expect(JSON.parse(command.body)).toEqual({ studentProfileId, planCode: receipt.planCode, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z', confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION });
    expect((fetcher.mock.calls[2]![1] as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-guardian-child-membership-draft' });
    expect(fetcher.mock.calls.map(([path]) => path)).not.toContain(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/memberships`);
  });

  it('fails closed for unavailable/non-child responses, access failure, malformed output, and uncertain command outcomes', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const loader of [loadCrmGuardianChildMembershipDraftPreparation, loadCrmGuardianChildMembershipDraftConfirmation]) {
      for (const status of [401, 403] as const) { fetcher.mockResolvedValueOnce(response({}, status)); await expect(loader(scope, studentProfileId)).rejects.toBeInstanceOf(CrmGuardianChildMembershipDraftAccessError); }
      for (const status of [400, 404, 409, 422]) { fetcher.mockResolvedValueOnce(response({}, status)); await expect(loader(scope, studentProfileId)).rejects.toBeInstanceOf(CrmGuardianChildMembershipDraftRejectedError); }
    }
    fetcher.mockResolvedValueOnce(response(envelope({ ...readiness, studentDisplayName: '' }))); await expect(loadCrmGuardianChildMembershipDraftPreparation(scope, studentProfileId)).rejects.toBeInstanceOf(CrmGuardianChildMembershipDraftRejectedError);
    const command = prepareCrmGuardianChildMembershipDraftCommand(scope, { studentProfileId, planCode: receipt.planCode, confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_CONFIRMATION }, key);
    fetcher.mockRejectedValueOnce(new Error('network')); await expect(submitCrmGuardianChildMembershipDraft(command)).rejects.toBeInstanceOf(CrmGuardianChildMembershipDraftUncertainError);
    fetcher.mockResolvedValueOnce(response(envelope(receipt), 200, 'text/plain')); await expect(submitCrmGuardianChildMembershipDraft(command)).rejects.toBeInstanceOf(CrmGuardianChildMembershipDraftUncertainError);
  });
});
