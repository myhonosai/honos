import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION } from '@hon/contracts';
import {
  CrmAdultMembershipDraftAccessError,
  CrmAdultMembershipDraftRejectedError,
  CrmAdultMembershipDraftUncertainError,
  crmAdultMembershipDraftPath,
  crmAdultMembershipDraftPreparationPath,
  loadCrmAdultMembershipDraftPreparation,
  parseCrmAdultMembershipDraftPreparation,
  parseCrmAdultMembershipDraftResult,
  prepareCrmAdultMembershipDraftCommand,
  submitCrmAdultMembershipDraft,
} from '../src/components/crm-adult-membership-draft-http';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const studentProfileId = id('3');
const key = id('4');
const input = { studentProfileId, planCode: 'ADULT-OPAQUE', confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION } as const;
const readiness = { studentDisplayName: 'Jordan Kim', currency: 'USD', readiness: 'READY_FOR_DRAFT' } as const;
const receipt = { membershipId: id('5'), state: 'DRAFT', planCode: input.planCode, termStartedAt: null, termEndsAt: null, recordedAt: '2026-10-18T20:00:00.000Z' } as const;
const envelope = (data: unknown, replayed = false) => ({ data, meta: { requestId: id('6'), correlationId: id('6'), replayed } });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(status === 200 ? data : { detail: 'hidden' }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

afterEach(() => vi.restoreAllMocks());
describe('adult CRM membership draft transport', () => {
  it('accepts only closed readiness and DRAFT receipt envelopes', () => {
    expect(crmAdultMembershipDraftPreparationPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-adult-membership-drafts/preparation`);
    expect(crmAdultMembershipDraftPath(scope)).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/crm-adult-membership-drafts`);
    expect(parseCrmAdultMembershipDraftPreparation(envelope(readiness))).toEqual(readiness);
    const command = prepareCrmAdultMembershipDraftCommand(scope, input, key);
    expect(parseCrmAdultMembershipDraftResult(envelope(receipt), command)).toEqual({ receipt, replayed: false });
    for (const malformed of [
      envelope({ ...readiness, accountId: id('7') }),
      { data: readiness, meta: { requestId: id('6'), correlationId: id('6'), replayed: true } },
    ]) expect(() => parseCrmAdultMembershipDraftPreparation(malformed)).toThrow();
    for (const malformed of [
      envelope({ ...receipt, state: 'ACTIVE' }),
      envelope({ ...receipt, personId: id('8') }),
    ]) expect(() => parseCrmAdultMembershipDraftResult(malformed, command)).toThrow();
  });

  it('posts one explicit preparation request with the exact marker and no idempotency key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(envelope(readiness)));
    const random = vi.spyOn(crypto, 'randomUUID');
    await expect(loadCrmAdultMembershipDraftPreparation(scope, studentProfileId)).resolves.toEqual(readiness);
    const [path, options] = fetcher.mock.calls[0]!;
    expect(path).toBe(crmAdultMembershipDraftPreparationPath(scope));
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: JSON.stringify({ studentProfileId }) });
    expect((options as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-adult-membership-prepare' });
    expect(random).not.toHaveBeenCalled();
  });

  it('posts the exact closed command and reuses an identical frozen request for retry', async () => {
    const command = prepareCrmAdultMembershipDraftCommand(scope, { ...input, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z' }, key);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(envelope({ ...receipt, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z' }))).mockResolvedValueOnce(response(envelope({ ...receipt, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z' }, true)));
    await submitCrmAdultMembershipDraft(command); await submitCrmAdultMembershipDraft(command);
    expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
    const [path, options] = fetcher.mock.calls[0]!;
    expect(path).toBe(crmAdultMembershipDraftPath(scope));
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: command.body });
    expect((options as RequestInit).headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-adult-membership-draft' });
    expect(JSON.parse(command.body)).toEqual({ studentProfileId, planCode: input.planCode, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION, termStartedAt: '2026-10-18T20:00:00.000Z', termEndsAt: '2027-10-18T20:00:00.000Z' });
  });

  it('clears on access denial and never treats unavailable, malformed, or uncertain results as success', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const status of [401, 403] as const) { fetcher.mockResolvedValueOnce(response({}, status)); await expect(loadCrmAdultMembershipDraftPreparation(scope, studentProfileId)).rejects.toBeInstanceOf(CrmAdultMembershipDraftAccessError); }
    for (const status of [400, 404, 409, 422]) { fetcher.mockResolvedValueOnce(response({}, status)); await expect(loadCrmAdultMembershipDraftPreparation(scope, studentProfileId)).rejects.toBeInstanceOf(CrmAdultMembershipDraftRejectedError); }
    const command = prepareCrmAdultMembershipDraftCommand(scope, input, key);
    fetcher.mockRejectedValueOnce(new Error('network')); await expect(submitCrmAdultMembershipDraft(command)).rejects.toBeInstanceOf(CrmAdultMembershipDraftUncertainError);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(envelope(receipt)), { status: 200, headers: { 'Content-Type': 'text/plain' } })); await expect(submitCrmAdultMembershipDraft(command)).rejects.toBeInstanceOf(CrmAdultMembershipDraftUncertainError);
  });
});
