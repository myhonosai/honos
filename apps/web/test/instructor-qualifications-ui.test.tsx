import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InstructorQualificationsWorkbench } from '../src/components/instructor-qualifications-workbench';
import { createInstructorQualification, InstructorQualificationsUiError, instructorQualificationPaths, loadInstructorQualification, loadInstructorQualificationAccess, loadInstructorQualificationEvidence, recordInstructorQualificationEvidence, retireInstructorQualification, reviewInstructorQualificationEvidence } from '../src/components/instructor-qualifications-http';

const staff = '11111111-1111-4111-8111-111111111111';
const program = '22222222-2222-4222-8222-222222222222';
const qualification = '33333333-3333-4333-8333-333333333333';
const evidence = '44444444-4444-4444-8444-444444444444';
const definition = { id: qualification, code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION' as const, courseProgramId: program, version: 1, status: 'ACTIVE' as const, humanRecordedOnly: true as const, qualificationOnly: true as const };
const record = { id: evidence, staffPrincipalId: staff, qualificationId: qualification, qualificationVersion: 1, courseProgramId: program, kind: 'QUALIFICATION' as const, attainedOn: '2026-01-10', expiresOn: '2028-01-10', evidenceRecordedAt: '2026-01-10T00:00:00.000Z', evidenceRecorded: true as const, reviewVersion: 1, reviewStatus: 'RECORDED' as const, reviewedAt: '2026-01-10T00:00:00.000Z', expiredOnRead: false, humanRecordedOnly: true as const, qualificationOnly: true as const, notEligibility: true as const };
const response = (data: unknown) => Response.json({ data, meta: { requestId: evidence, correlationId: evidence } });

describe('instructor qualification evidence UI', () => {
  it('uses fixed same-origin access/known-ID routes, direct-human header, retained idempotency key, and redacted responses only', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ canRead: true, canManage: true, humanRecordedOnly: true, qualificationOnly: true }));
    try {
      await expect(loadInstructorQualificationAccess()).resolves.toEqual({ canRead: true, canManage: true, humanRecordedOnly: true, qualificationOnly: true });
      expect(fetcher).toHaveBeenLastCalledWith('/api/v1/staff/instructor-qualifications/access', expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' }));
      fetcher.mockResolvedValue(response(definition));
      await expect(loadInstructorQualification(qualification)).resolves.toEqual(definition);
      fetcher.mockResolvedValue(response(definition));
      await expect(createInstructorQualification({ code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION', courseProgramId: program }, 'definition-key')).resolves.toEqual(definition);
      expect(fetcher).toHaveBeenLastCalledWith('/api/v1/staff/instructor-qualifications/qualifications', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-HON-Human-Command': 'instructor-qualifications', 'Idempotency-Key': 'definition-key' }) }));
      fetcher.mockResolvedValue(response(record));
      await expect(recordInstructorQualificationEvidence(staff, { qualificationId: qualification, expectedQualificationVersion: 1, attainedOn: '2026-01-10', expiresOn: '2028-01-10', evidenceReference: 'Private evidence reference' }, 'evidence-key')).resolves.toEqual(record);
      fetcher.mockResolvedValue(response(record));
      await expect(loadInstructorQualificationEvidence(staff, evidence)).resolves.toEqual(record);
      fetcher.mockResolvedValue(response(record));
      await expect(reviewInstructorQualificationEvidence(staff, evidence, { expectedReviewVersion: 1, status: 'REVIEWED', reviewNote: 'Private review note' }, 'review-key')).resolves.toEqual(record);
      fetcher.mockResolvedValue(response({ ...definition, version: 2, status: 'RETIRED' }));
      await expect(retireInstructorQualification(qualification, { expectedVersion: 1 }, 'retire-key')).resolves.toMatchObject({ status: 'RETIRED', version: 2 });
    } finally { fetcher.mockRestore(); }
  });

  it('fails closed for cross-origin/list/query paths, missing retry keys, malformed/private records, and uncertain errors', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      for (const id of ['not-a-uuid', `https://evil.test/${qualification}`, `${qualification}?schoolId=${program}`]) {
        const count = fetcher.mock.calls.length;
        await expect(loadInstructorQualification(id)).rejects.toThrow();
        expect(fetcher.mock.calls.length).toBe(count);
      }
      await expect(createInstructorQualification({ code: 'FIRST_AID', title: 'First aid training', kind: 'QUALIFICATION', courseProgramId: program }, '')).rejects.toThrow(/idempotency/i);
      fetcher.mockResolvedValue(response({ ...record, evidenceReference: 'private' }));
      await expect(loadInstructorQualificationEvidence(staff, evidence)).rejects.toThrow(/verified redacted/i);
      fetcher.mockResolvedValue({ ok: false, status: 403 } as Response);
      await expect(loadInstructorQualificationAccess()).rejects.toBeInstanceOf(InstructorQualificationsUiError);
      fetcher.mockResolvedValue({ ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) } as unknown as Response);
      await expect(loadInstructorQualificationAccess()).rejects.toThrow(/No save is assumed/i);
    } finally { fetcher.mockRestore(); }
  });

  it('starts empty, exposes only known-ID human record controls and makes explicit non-eligibility/no-downstream-effect statements', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<InstructorQualificationsWorkbench/>);
      expect(fetcher).not.toHaveBeenCalled();
      for (const phrase of ['Not an eligibility or credential engine.', 'Known qualification UUID', 'No school selector', 'Record immutable evidence', 'It does not hire, fire, discipline, set payroll', 'assign/schedule a class instructor', 'No save is assumed']) expect(html).toContain(phrase);
      expect(html).not.toMatch(/type="file"|payment|provider success|send message/i);
    } finally { fetcher.mockRestore(); }
  });

  it('keeps retry keys in memory, never stores private evidence/note data, and retains the single authenticated route manifest entry', () => {
    const source = [readFileSync('src/components/instructor-qualifications-workbench.tsx', 'utf8'), readFileSync('src/components/instructor-qualifications-http.ts', 'utf8')].join('\n');
    for (const token of ['retries.current', 'evidenceReference', 'reviewNote', 'No success is assumed', 'credentials:\'same-origin\'']) expect(source).toContain(token);
    expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|executeAction|sendMessage|syncCalendar|checkout|fetch\(['"]https?:\/\//);
    const route = readFileSync('src/app/staff/instructor-qualifications/page.tsx', 'utf8');
    expect(route).toContain('InstructorQualificationsWorkbench');
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((route: { path: string }) => route.path === '/staff/instructor-qualifications')).toHaveLength(1);
  });
});
