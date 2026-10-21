import { afterEach, expect, it, vi } from 'vitest';
import {
  CRM_LEAD_REGISTRATION_CONFIRMATION, CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION,
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION, CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION,
  type CrmGuardianChildFamilyState, type CrmGuardianChildChildState,
} from '@hon/contracts';
import { familyRequest, readFamilyEnrollment, sendFamilyRequest } from '../src/components/crm-family-http';
import { PlanAccessError, PlanRejectedError, PlanUnknownError, PlanReadError } from '../src/components/membership-plans/http';
import { family, scope, id, fields, date, response, registration, receipt, plan, payer } from './crm-family-fixtures';
const add = { ...fields, confirmation: CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION };
const reg = { ...fields, registrationPath: 'GUARDIAN_CHILD', confirmation: CRM_LEAD_REGISTRATION_CONFIRMATION };
const draft = { studentProfileId: id(5), membershipPlanId: plan.planId, membershipPlanVersion: 1, confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
afterEach(() => vi.restoreAllMocks());
it.each(['NOT_REGISTERED','NEEDS_STAFF_REVIEW','ADULT_REGISTRATION','BILLING_ACCOUNT_REQUIRED','PAYER_DESIGNATION_REQUIRED','PAYER_DESIGNATED'] as CrmGuardianChildFamilyState[])('verifies family recovery state %s with exact closed read transport', async state => {
  const data = family(state), fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data));
  expect(await readFamilyEnrollment(scope, id(3), id(4))).toEqual(data);
  expect(fetcher).toHaveBeenCalledWith(`/api/v1/organizations/${id(1)}/schools/${id(2)}/crm/leads/${id(3)}/guardian-child-enrollment`, expect.objectContaining({ method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', body: '{}', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'crm-guardian-child-enrollment-read' } }));
});
it.each(['AWAITING_PAYER_DESIGNATION','READY_FOR_DRAFT','CURRENT_DRAFT','CURRENT_DRAFT_BY_OTHER_STAFF','NEEDS_STAFF_REVIEW'] as CrmGuardianChildChildState[])('verifies child recovery state %s and receipt privacy', async state => {
  const data = family(state === 'AWAITING_PAYER_DESIGNATION' ? 'PAYER_DESIGNATION_REQUIRED' : 'PAYER_DESIGNATED', state);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data));
  const result = await readFamilyEnrollment(scope, id(3), id(4)); expect(result).toEqual(data);
  if (state === 'CURRENT_DRAFT_BY_OTHER_STAFF') expect(JSON.stringify(result)).not.toContain(receipt.membershipId);
});
it.each([
  ['register', id(3), reg, registration, 'crm-lead-register'],
  ['payer', id(3), { confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }, payer, 'crm-guardian-child-payer-designation'],
  ['child', id(3), add, { outcome: 'CHILD_ADDED', leadId: id(3), studentProfileId: id(12), childDisplayName: 'Kai Stone', recordedAt: date }, 'crm-guardian-child-addition'],
  ['childDraft', id(5), draft, { receipt, plan }, 'crm-guardian-child-membership-draft-from-plan'],
] as const)('sends %s through the exact merged route, marker and idempotency key', async (step, selected, input, data, marker) => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data, 200, true)), request = familyRequest(scope, step, selected, input, id(10));
  expect(Object.isFrozen(request)).toBe(true); const result = await sendFamilyRequest(request); expect(result.replayed).toBe(true);
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: request.body, headers: { 'X-HON-Human-Command': marker, 'Idempotency-Key': id(10) } });
});
it('creates/reuses only the verified guardian canonical account through the existing transport', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ id: id(20), responsiblePersonId: id(4), currency: 'USD', classification: 'CANONICAL', reused: true, version: 1, createdAt: date }, 201));
  expect(await sendFamilyRequest(familyRequest(scope, 'account', id(4), { currency: 'USD' }, id(10)))).toMatchObject({ step: 'account', account: { reused: true, responsiblePersonId: id(4), classification: 'CANONICAL' } });
  expect(fetcher.mock.calls[0]![1]!.body).toBe(JSON.stringify({ responsiblePersonId: id(4), currency: 'USD' }));
});
it('rejects selectors, extra bodies, path changes, absent keys and adult payloads before fetching', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  expect(() => familyRequest(scope, 'read', id(3), { familyId: id(6) })).toThrow();
  expect(() => familyRequest(scope, 'read', id(3), {}, id(10))).toThrow();
  expect(() => familyRequest(scope, 'payer', id(3), { confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION, payerId: id(4) }, id(10))).toThrow();
  expect(() => familyRequest(scope, 'child', id(3), add)).toThrow();
  expect(() => familyRequest(scope, 'register', id(3), { registrationPath: 'ADULT', birthDate: '1990-01-01', confirmation: CRM_LEAD_REGISTRATION_CONFIRMATION }, id(10))).toThrow();
  expect(() => familyRequest(scope, 'childDraft', id(12), draft, id(10))).toThrow();
  const request = familyRequest(scope, 'child', id(3), add, id(10));
  await expect(sendFamilyRequest({ ...request, path: request.path + '?schoolId=other' })).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects another family/contact, duplicate children, more than 10 and leaked creator receipts', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  const base = family(); if (!('children' in base)) throw Error();
  for (const data of [{ ...base, leadId: id(33) }, { ...base, children: [base.children[0], base.children[0]] },
    { ...base, children: Array.from({ length: 11 }, (_, n) => ({ ...base.children[0], studentProfileId: id(n + 100), origin: n ? 'ADDITIONAL_CHILD' : 'CRM_REGISTRATION' })) },
    { ...base, children: [{ ...base.children[0], workflowState: 'CURRENT_DRAFT_BY_OTHER_STAFF', currentMembershipDraft: { state: 'RECORDED_DRAFT', receipt, plan } }] }]) {
    f.mockResolvedValueOnce(response(data)); await expect(readFamilyEnrollment(scope, id(3), id(4))).rejects.toBeInstanceOf(PlanReadError);
  }
  f.mockResolvedValueOnce(response(base)); await expect(readFamilyEnrollment(scope, id(3), id(34))).rejects.toBeInstanceOf(PlanReadError);
});
it.each([401,403])('treats %s as access loss without exposing response details', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ code: 'private-canary' }, status));
  await expect(readFamilyEnrollment(scope, id(3), id(4))).rejects.toBeInstanceOf(PlanAccessError);
});
it.each([404,409])('treats %s as a rejected command, never a completed action', async status => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ code: 'private-canary' }, status));
  await expect(sendFamilyRequest(familyRequest(scope, 'child', id(3), add, id(10)))).rejects.toBeInstanceOf(PlanRejectedError);
});
it('preserves exact unknown-result retry and verifies a replay instead of issuing another key', async () => {
  const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response({ outcome: 'NEEDS_STAFF_REVIEW' }));
  const request = familyRequest(scope, 'child', id(3), add, id(10));
  await expect(sendFamilyRequest(request)).rejects.toBeInstanceOf(PlanUnknownError);
  expect(await sendFamilyRequest(request)).toMatchObject({ step: 'child', child: { outcome: 'NEEDS_STAFF_REVIEW' } });
  expect(f.mock.calls[0]![0]).toBe(f.mock.calls[1]![0]); expect(f.mock.calls[0]![1]!.body).toBe(f.mock.calls[1]![1]!.body); expect(f.mock.calls[0]![1]!.headers).toEqual(f.mock.calls[1]![1]!.headers);
});
it('rejects wrong published versions, child names and malformed success envelopes as unknown commands', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  f.mockResolvedValueOnce(response({ receipt, plan: { ...plan, version: 2 } }));
  await expect(sendFamilyRequest(familyRequest(scope, 'childDraft', id(5), draft, id(10)))).rejects.toBeInstanceOf(PlanUnknownError);
  f.mockResolvedValueOnce(response({ outcome: 'CHILD_ADDED', leadId: id(3), studentProfileId: id(12), childDisplayName: 'Other Child', recordedAt: date }));
  await expect(sendFamilyRequest(familyRequest(scope, 'child', id(3), add, id(11)))).rejects.toBeInstanceOf(PlanUnknownError);
  f.mockResolvedValueOnce(new Response(JSON.stringify({ data: payer, meta: {} }), { headers: { 'Content-Type': 'application/json' } }));
  await expect(sendFamilyRequest(familyRequest(scope, 'payer', id(3), { confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }, id(12)))).rejects.toBeInstanceOf(PlanUnknownError);
});
