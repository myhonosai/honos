import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { TestingCertificateWorkbench } from '../src/components/testing-certificate-workbench';
import { issueTestingCertificate, loadTestingCertificate, TestingCertificateAccessError } from '../src/components/testing-certificate-http';

const schoolId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const rankId = '33333333-3333-4333-8333-333333333333';
const certificateId = '44444444-4444-4444-8444-444444444444';
const issuedAt = '2026-10-15T20:00:00.000Z';
const record = { id: certificateId, targetRankId: rankId, targetRankName: 'Blue Rank', title: 'School testing certificate', issuedAt, version: 1, status: 'ISSUED' } as const;
const eligible = { testingCandidateId: candidateId, targetRankId: rankId, candidateVersion: 3, status: 'ELIGIBLE_TO_ISSUE', certificate: null } as const;
const response = (data: unknown) => Response.json({ data, meta: { requestId: certificateId, correlationId: certificateId } });

describe('human testing certificate UI', () => {
  it('uses only fixed same-origin GET/POST transport with direct-human command and an idempotency key', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ certificate: eligible }));
    try {
      await expect(loadTestingCertificate(schoolId, candidateId)).resolves.toEqual(eligible);
      expect(fetcher).toHaveBeenLastCalledWith(`/api/v1/staff/testing/certificates?schoolId=${schoolId}&testingCandidateId=${candidateId}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      fetcher.mockResolvedValue(response({ certificate: record }));
      await expect(issueTestingCertificate(schoolId, candidateId, { expectedCandidateVersion: 3, expectedCertificateVersion: 0, title: record.title }, 'issue-key')).resolves.toEqual(record);
      expect(fetcher).toHaveBeenLastCalledWith('/api/v1/staff/testing/certificates', expect.objectContaining({ method: 'POST', credentials: 'same-origin', headers: expect.objectContaining({ 'X-HON-Human-Command': 'testing-certificate', 'Idempotency-Key': 'issue-key' }) }));
    } finally { fetcher.mockRestore(); }
  });

  it('fails closed for private response fields, malformed eligibility, and denied current scope', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ certificate: { ...eligible, studentProfileId: certificateId } }));
    try { await expect(loadTestingCertificate(schoolId, candidateId)).rejects.toThrow(/not a verified redacted/i); }
    finally { fetcher.mockRestore(); }
    const denied = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);
    try { await expect(loadTestingCertificate(schoolId, candidateId)).rejects.toBeInstanceOf(TestingCertificateAccessError); }
    finally { denied.mockRestore(); }
  });

  it('renders no fabricated certificate or external/provider/action mutation controls', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const markup = renderToStaticMarkup(<TestingCertificateWorkbench/>);
      expect(fetcher).not.toHaveBeenCalled();
      for (const phrase of ['Record only — no downstream change.', 'No certificate record loaded', 'never changes a grade, promotion decision, current rank, attendance, billing']) expect(markup).toContain(phrase);
      expect(markup).not.toMatch(/download certificate|send message|checkout|provider success|invokeLLM|executeAction|revoke certificate/i);
    } finally { fetcher.mockRestore(); }
  });

  it('keeps the route authenticated, dynamic, noindex, manifest-registered, and source-free of provider/action imports', () => {
    const route = readFileSync('src/app/staff/testing/certificates/page.tsx', 'utf8');
    for (const token of ['verifySession', "redirect('/auth/login')", 'force-dynamic', 'index: false']) expect(route).toContain(token);
    const source = [
      readFileSync('src/components/testing-certificate-workbench.tsx', 'utf8'),
      readFileSync('src/components/testing-certificate-http.ts', 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(/from ['"](?:.*provider|.*action|.*ai)|invokeLLM|executeAction|sendMessage|checkout|payment|fetch\(['"]https?:\/\//i);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/testing/certificates')).toHaveLength(1);
  });
});
