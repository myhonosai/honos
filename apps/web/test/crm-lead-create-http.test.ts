import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrmLeadCreateAccessError, CrmLeadCreateRejectedError, CrmLeadCreateUncertainError, crmLeadCreatePath, parseCrmLeadCreateResult, prepareCrmLeadCreate, submitCrmLeadCreate } from '../src/components/crm-lead-create-http';
const org = '11111111-1111-4111-8111-111111111111', school = '22222222-2222-4222-8222-222222222222', stage = '33333333-3333-4333-8333-333333333333', key = '44444444-4444-4444-8444-444444444444';
const input = { pipelineId: org, pipelineStageId: stage, primaryContact: { givenName: 'Ari', familyName: 'Stone', email: 'ari@example.test', phoneE164: '+15551234567' } };
const prepared = () => prepareCrmLeadCreate(org, school, input, key);
const envelope = (replayed = false) => ({ data: { id: key, status: 'OPEN', pipelineStageId: stage, primaryPersonId: school, version: 1, createdAt: '2026-10-17T01:02:03.000Z' }, meta: { requestId: org, correlationId: org, replayed } });
const response = (value: unknown, status = 201, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...headers } });
afterEach(() => vi.restoreAllMocks());
describe('bounded canonical CRM create transport', () => {
 it('prepares a closed frozen exact command, with no key generation or context fields', () => {
  const p = prepared(); expect(Object.isFrozen(p)).toBe(true); expect(p.body).toBe(JSON.stringify(input)); expect(p.path).toBe(crmLeadCreatePath(org, school));
  for (const patch of [{ pipelineId: 'bad' }, { campaignId: key }, { sourceId: 'x' }, { attribution: {} }, { nextFollowUpAt: '2026-10-17T01:02:03.000Z' }, { principalType: 'HUMAN_USER' }, { primaryContact: { ...input.primaryContact, personId: key } }, { primaryContact: { givenName: ' ', familyName: 'Stone' } }]) expect(() => prepareCrmLeadCreate(org, school, { ...input, ...patch }, key)).toThrow();
  for (const bad of ['bad', 'https://evil.test', '../x']) { expect(() => crmLeadCreatePath(bad, school)).toThrow(); expect(() => prepareCrmLeadCreate(org, school, input, bad)).toThrow(); }
 });
 it('accepts only six exact creation facts linked to the submitted stage with exact closed correlation metadata', () => {
  const p = prepared(), v = envelope(); expect(parseCrmLeadCreateResult(v, p)).toEqual({ lead: v.data, replayed: false });
  for (const patch of [{ pipelineStageId: key }, { status: 'WON' }, { status: 'SCHEDULED' }, { version: 2 }, { version: '1' }, { id: 'bad' }, { createdAt: '2026-02-30T01:02:03.000Z' }, { createdAt: '2026-10-17T01:02:03Z' }, { givenName: 'Ari' }, { duplicateResolved: true }, { enrollmentId: key }, { paymentReceived: true }, { conversion: true }, { pipelineId: org }]) expect(() => parseCrmLeadCreateResult({ ...v, data: { ...v.data, ...patch } }, p)).toThrow();
  for (const meta of [{}, { ...v.meta, replayed: 'true' }, { ...v.meta, correlationId: key }, { ...v.meta, requestId: 'bad' }, { ...v.meta, source: 'HUMAN_UI' }]) expect(() => parseCrmLeadCreateResult({ ...v, meta }, p)).toThrow();
  for (const value of [{ ...v, extra: true }, { ...v, data: [] }]) expect(() => parseCrmLeadCreateResult(value, p)).toThrow();
 });
 it('uses exact fixed same-origin transport and retries only when explicitly called with the retained request', async () => {
  const p = prepared(), f = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response(envelope(true), 200));
  await expect(submitCrmLeadCreate(p)).rejects.toBeInstanceOf(CrmLeadCreateUncertainError); expect(f).toHaveBeenCalledTimes(1);
  expect((await submitCrmLeadCreate(p)).replayed).toBe(true); expect(f.mock.calls[0]).toEqual(f.mock.calls[1]);
  expect(f).toHaveBeenCalledWith(p.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-lead-create' }, body: p.body });
 });
 it('rejects changed prepared contracts before fetch and separates definite/access denials from all unverified outcomes', async () => {
  const f = vi.spyOn(globalThis, 'fetch');
  for (const patch of [{ path: 'https://evil.test' }, { path: prepared().path + '?x=1' }, { body: JSON.stringify({ ...input, source: 'HUMAN_UI' }) }, { body: 'not-json' }, { key: 'bad' }, { extra: true }]) await expect(submitCrmLeadCreate({ ...prepared(), ...patch })).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
  for (const status of [400, 404, 409, 413, 415, 422]) { f.mockResolvedValueOnce(response({}, status)); await expect(submitCrmLeadCreate(prepared())).rejects.toBeInstanceOf(CrmLeadCreateRejectedError); }
  for (const status of [401, 403]) { f.mockResolvedValueOnce(response({}, status)); await expect(submitCrmLeadCreate(prepared())).rejects.toBeInstanceOf(CrmLeadCreateAccessError); }
  const redirected = response(envelope()); Object.defineProperty(redirected, 'redirected', { value: true });
  for (const r of [response({}, 500), response({}, 503), response(envelope(), 202), response(envelope(), 200), response(envelope(true), 201), response(envelope(), 201, { 'Content-Type': 'text/html' }), response(envelope(), 201, { 'Cache-Control': 'public' }), response({ ...envelope(), data: { ...envelope().data, version: 2 } }), new Response('not-json', { status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }), new Response('x'.repeat(12001), { status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }), redirected]) { f.mockResolvedValueOnce(r); await expect(submitCrmLeadCreate(prepared())).rejects.toBeInstanceOf(CrmLeadCreateUncertainError); }
  expect(f).toHaveBeenCalledTimes(19);
 });
});
