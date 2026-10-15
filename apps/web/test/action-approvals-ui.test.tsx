import React from 'react';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { actionReviewFingerprint } from '@hon/contracts';
import { ActionApprovalsWorkbench } from '../src/components/action-approvals-workbench';
import { ActionReviewAccessError, decideActionReview, loadActionReviews, readActionReview } from '../src/components/action-approvals-http';

const school = '11111111-1111-4111-8111-111111111111';
const organization = '22222222-2222-4222-8222-222222222222';
const reviewer = '33333333-3333-4333-8333-333333333333';
const requester = '44444444-4444-4444-8444-444444444444';
const id = '55555555-5555-4555-8555-555555555555';
const payload = { pipelineId: '66666666-6666-4666-8666-666666666666', pipelineStageId: '77777777-7777-4777-8777-777777777777', primaryContact: { givenName: 'Exact', familyName: 'Intent' }, sourceId: 'human-review' };
const payloadHash = createHash('sha256').update(actionReviewFingerprint(payload)).digest('hex');
const expiry = '2026-10-15T19:00:00.000Z';
const item = { id, actionCode: 'crm.lead.create', status: 'AWAITING_APPROVAL', requestedByPrincipalId: requester, effectiveAuthorityMode: 'CONFIRM', policyVersion: 1, approvalExpiresAt: expiry, createdAt: '2026-10-15T18:00:00.000Z' };
const queue = { organizationId: organization, schoolId: school, reviewerPrincipalId: reviewer, reviewerPermission: 'action.approve', status: 'AWAITING_APPROVAL', items: [item], nextAfter: null, executionTriggered: false };
const detail = { ...item, organizationId: organization, schoolId: school, payloadHash, requiredPermission: 'crm.lead.create', normalizedPayload: payload, payloadVisibility: 'EXACT', reviewerPrincipalId: reviewer, reviewerPermission: 'action.approve', delegatedByPrincipalId: null, currentPolicyVersion: 1, currentAuthorityMode: 'CONFIRM', reviewBlock: null, decisions: [], decisionsTruncated: false, executionTriggered: false };
const decision = { decision: 'APPROVED' as const, binding: { actionRequestId: id, actionCode: 'crm.lead.create', requestedByPrincipalId: requester, payloadHash, policyVersion: 1, approvalExpiresAt: expiry, effectiveAuthorityMode: 'CONFIRM' as const }, reason: 'Exact human review' };
const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) }) as Response;

describe('Human Action Engine approval workbench', () => {
  it('starts empty and honest: no request, payload, execution, provider or fake success is rendered', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<ActionApprovalsWorkbench />);
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const text of ['Action approvals', 'Two-person review', 'No execution', 'No provider or AI call', 'action.approve', 'Already-known school UUID', 'Load / refresh queue']) expect(html.toLowerCase()).toContain(text.toLowerCase());
      expect(html).not.toContain('Exact human review');
      expect(html).not.toContain('exact@example.test');
      expect(html).not.toMatch(/type="(?:email|file)"/);
    } finally { fetchSpy.mockRestore(); }
  });

  it('uses only the scoped same-origin review routes and verifies queue/detail/receipt responses exactly', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(queue));
    try {
      expect(await loadActionReviews(school, 'AWAITING_APPROVAL')).toEqual(queue);
      expect(fetchSpy).toHaveBeenLastCalledWith(`/api/v1/staff/action-center/approvals/${school}?status=AWAITING_APPROVAL`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
      fetchSpy.mockResolvedValue(response(detail));
      expect(await readActionReview(school, id)).toEqual(detail);
      expect(fetchSpy).toHaveBeenLastCalledWith(`/api/v1/staff/action-center/approvals/${school}/${id}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
      const receipt = { actionRequestId: id, status: 'APPROVED', actionCode: item.actionCode, reviewedAt: '2026-10-15T18:10:00.000Z', payloadHash, policyVersion: 1, executionTriggered: false };
      fetchSpy.mockResolvedValue(response(receipt));
      expect(await decideActionReview(school, id, decision, 'retained-key')).toEqual(receipt);
      expect(fetchSpy).toHaveBeenLastCalledWith(`/api/v1/staff/action-center/approvals/${school}/${id}/decision`, expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: expect.objectContaining({ 'X-HON-Human-Command': 'action-approvals', 'Idempotency-Key': 'retained-key' }) }));
      const calls = fetchSpy.mock.calls.length;
      for (const unsafe of ['https://evil.test', '../approvals', `${id}?schoolId=${school}`]) { await expect(readActionReview(school, unsafe)).rejects.toThrow(); await expect(decideActionReview(school, unsafe, decision, 'key')).rejects.toThrow(); }
      expect(fetchSpy.mock.calls.length).toBe(calls);
    } finally { fetchSpy.mockRestore(); }
  });

  it('fails closed on private/forged output, invalid pagination and access errors without treating a decision as execution', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(queue));
    try {
      for (const patch of [{ items: [{ ...item, normalizedPayload: payload }] }, { items: [item, item] }, { reviewerPermission: 'crm.lead.create' }, { executionTriggered: true }, { nextAfter: id }, { schoolId: requester }]) {
        fetchSpy.mockResolvedValue(response({ ...queue, ...patch })); await expect(loadActionReviews(school, 'AWAITING_APPROVAL')).rejects.toThrow();
      }
      for (const patch of [{ normalizedPayload: { ...payload, providerToken: 'secret' } }, { payloadHash: '0'.repeat(64) }, { reviewBlock: null, payloadVisibility: 'WITHHELD_UNSAFE', normalizedPayload: null }, { decisions: [{ reviewerPrincipalId: reviewer, decision: 'APPROVED', payloadHash: '0'.repeat(64), policyVersion: 1, decidedAt: item.createdAt }] }, { executionTriggered: true }]) {
        fetchSpy.mockResolvedValue(response({ ...detail, ...patch })); await expect(readActionReview(school, id)).rejects.toThrow();
      }
      fetchSpy.mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: 'PRIVATE_DIRECTORY' }) } as Response);
      await expect(loadActionReviews(school, 'AWAITING_APPROVAL')).rejects.toBeInstanceOf(ActionReviewAccessError);
      expect(() => new ActionReviewAccessError('Current exact school review permission is unavailable.')).not.toThrow('PRIVATE_DIRECTORY');
    } finally { fetchSpy.mockRestore(); }
  });

  it('protects the route, retains retry only in memory, and provides real discoverable navigation', () => {
    const workbench = readFileSync('src/components/action-approvals-workbench.tsx', 'utf8');
    for (const text of ['retry.current', 'Retry exact retained decision', 'setUncertain(true)', 'clearScope()', 'setDetail(null)', 'No action was executed', 'Reload current detail']) expect(workbench).toContain(text);
    expect(workbench).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|CrmLeadActionTool|fetch\(['"]https?:\/\//);
    const route = readFileSync('src/app/staff/action-center/approvals/page.tsx', 'utf8');
    for (const text of ['cookies', 'verifySession', 'HON_SESSION_COOKIE', "redirect('/auth/login')", 'force-dynamic', 'index: false']) expect(route).toContain(text);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((r: { path: string }) => r.path === '/staff/action-center/approvals')).toHaveLength(1);
    expect(readFileSync('src/components/hon-reference-suite.tsx', 'utf8')).toContain("item === 'Action Center' ? '/staff/action-center/approvals'");
    expect(readFileSync('src/components/hon-control-shell.tsx', 'utf8')).toContain("label === 'Action Center' ? '/staff/action-center/approvals'");
  });
});
