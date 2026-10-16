import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_CATEGORIES, type ConfigureAttendancePolicyInput, type RecordAttendanceInput } from '@hon/contracts';
import { AttendanceWorkbench } from '../src/components/attendance-workbench';
import {
  assertAttendanceEndpoint,
  attendancePaths,
  loadAttendancePolicy,
  loadExactAttendanceRecord,
  saveAttendancePolicy,
  saveAttendanceRecord,
  validateAttendancePolicyInput,
} from '../src/components/attendance-workbench-http';

const organization = '11111111-1111-4111-8111-111111111111';
const school = '22222222-2222-4222-8222-222222222222';
const program = '33333333-3333-4333-8333-333333333333';
const session = '44444444-4444-4444-8444-444444444444';
const student = '55555555-5555-4555-8555-555555555555';
const recordId = '66666666-6666-4666-8666-666666666666';
const scope = { organizationId: organization, schoolId: school, programId: program, sessionId: session, studentProfileId: student };
const categories = ATTENDANCE_CATEGORIES.map((category, index) => ({ category, operationalAllowed: index !== 1, progressionEnabled: index === 0, weightMilli: index === 0 ? 1000 : 0 }));
const policy = { programId: program, version: 4, categories };
const policyInput: ConfigureAttendancePolicyInput = { expectedVersion: 4, categories };
const record = { id: recordId, classSessionId: session, studentProfileId: student, status: 'PRESENT' as const, category: 'REGULAR_PARTICIPANT' as const, progressionPolicyVersion: 4, progressionEnabled: true, progressionWeightMilli: 1000, progressionCreditMilli: 1000, recordedAt: '2026-10-16T12:00:00.000Z', version: 7, createdAt: '2026-10-16T12:00:00.000Z', updatedAt: '2026-10-16T12:00:00.000Z' };
const recordInput: RecordAttendanceInput = { studentProfileId: student, status: 'PRESENT', category: 'REGULAR_PARTICIPANT', note: 'Arrived ready.', expectedVersion: 7 };
const getResponse = (data: unknown) => Response.json({ data, meta: { requestId: recordId, correlationId: recordId } });
const commandResponse = (data: unknown, replayed = false) => Response.json({ data, meta: { requestId: recordId, correlationId: recordId, replayed } });

describe('human staff attendance workbench', () => {
  it('starts with no fabricated records or calls and states its conventional operational boundary', () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      const html = renderToStaticMarkup(<AttendanceWorkbench />);
      expect(fetcher).not.toHaveBeenCalled();
      for (const phrase of ['Attendance workbench', 'Conventional staff recordkeeping only.', 'existing server authorization, tenant RLS', 'no Action Engine, AI, provider, payment, message', 'Organization UUID', 'Student profile UUID', 'No policy is loaded', 'No current record lookup has completed']) expect(html).toContain(phrase);
      expect(html).not.toContain('11111111-1111-4111-8111-111111111111');
      expect(html).not.toContain('PRESENT');
      expect(html).not.toMatch(/type="(?:email|file)"/);
    } finally { fetcher.mockRestore(); }
  });

  it('uses only generated fixed relative policy/record paths, direct-human header, expected versions, and idempotency keys', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(getResponse(policy));
    try {
      await expect(loadAttendancePolicy(scope)).resolves.toEqual(policy);
      expect(fetcher).toHaveBeenLastCalledWith(attendancePaths.policy(scope), expect.objectContaining({
        method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: expect.objectContaining({ Accept: 'application/json', 'X-HON-Human-Command': 'attendance' }),
      }));
      fetcher.mockResolvedValue(commandResponse({ ...policy, version: 5 }));
      await expect(saveAttendancePolicy(scope, policyInput, 'policy-retained-key')).resolves.toMatchObject({ policy: { programId: program, version: 5 }, replayed: false });
      expect(fetcher).toHaveBeenLastCalledWith(attendancePaths.policy(scope), expect.objectContaining({
        method: 'POST', headers: expect.objectContaining({ 'X-HON-Human-Command': 'attendance', 'Idempotency-Key': 'policy-retained-key', 'Content-Type': 'application/json' }),
        body: JSON.stringify(policyInput),
      }));
      fetcher.mockResolvedValue(getResponse(record));
      await expect(loadExactAttendanceRecord(scope)).resolves.toEqual(record);
      expect(fetcher).toHaveBeenLastCalledWith(attendancePaths.exactRecordLookup(scope), expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
      fetcher.mockResolvedValue(commandResponse({ ...record, note: 'Arrived ready.' }, true));
      await expect(saveAttendanceRecord(scope, recordInput, 'record-retained-key')).resolves.toMatchObject({ attendance: { id: recordId, version: 7, progressionCreditMilli: 1000 }, replayed: true });
      expect(fetcher).toHaveBeenLastCalledWith(attendancePaths.record(scope), expect.objectContaining({
        method: 'POST', headers: expect.objectContaining({ 'X-HON-Human-Command': 'attendance', 'Idempotency-Key': 'record-retained-key' }), body: JSON.stringify(recordInput),
      }));
    } finally { fetcher.mockRestore(); }
  });

  it('rejects URL, selector, query, method, and cross-origin injection before fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const policyPath = attendancePaths.policy(scope);
    const recordPath = attendancePaths.record(scope);
    try {
      for (const unsafe of [
        'https://evil.test/api/v1/organizations/' + organization,
        '//evil.test/api/v1/organizations/' + organization,
        policyPath + '?schoolId=' + school,
        recordPath + '?studentProfileId=' + student + '&method=POST',
        recordPath + '/anything',
      ]) expect(() => assertAttendanceEndpoint(unsafe, 'POLICY_LOAD')).toThrow();
      expect(() => assertAttendanceEndpoint(recordPath, 'RECORD_LOAD')).toThrow();
      const calls = fetcher.mock.calls.length;
      await expect(loadAttendancePolicy({ ...scope, programId: `https://evil.test/${program}` })).rejects.toThrow(/five exact/i);
      await expect(loadExactAttendanceRecord({ ...scope, studentProfileId: `${student}&extra=1` })).rejects.toThrow(/five exact/i);
      await expect(saveAttendanceRecord({ ...scope, sessionId: `${session}?path=POST` }, recordInput, 'key')).rejects.toThrow(/five exact/i);
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally { fetcher.mockRestore(); }
  });

  it('closes the seven-category policy and verifies returned scope, categories, and credit facts', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    try {
      expect(() => validateAttendancePolicyInput({ ...policyInput, categories: [...categories.slice(0, 6), categories[0]!] })).toThrow();
      expect(() => validateAttendancePolicyInput({ ...policyInput, categories: categories.map((rule, index) => index === 0 ? { ...rule, weightMilli: 10001 } : rule) })).toThrow();
      fetcher.mockResolvedValue(getResponse({ ...policy, programId: school }));
      await expect(loadAttendancePolicy(scope)).rejects.toThrow(/not verified/i);
      fetcher.mockResolvedValue(getResponse({ ...record, classSessionId: school }));
      await expect(loadExactAttendanceRecord(scope)).rejects.toThrow(/not verified/i);
      fetcher.mockResolvedValue(getResponse({ ...record, progressionCreditMilli: -1 }));
      await expect(loadExactAttendanceRecord(scope)).rejects.toThrow(/not verified/i);
    } finally { fetcher.mockRestore(); }
  });

  it('keeps retry keys only in memory for unchanged bodies, clears stale loaded facts on selectors, and makes no unsafe operational claim', () => {
    const workbench = readFileSync('src/components/attendance-workbench.tsx', 'utf8');
    const http = readFileSync('src/components/attendance-workbench-http.ts', 'utf8');
    for (const token of ['retries.current', 'retainedKey', 'fingerprint !== fingerprint', 'clearLoaded()', 'expectedVersion: policy.version', 'expectedVersion: record.version', 'ATTENDANCE_CATEGORIES', 'does not auto-progress or pass anyone', 'does not determine class eligibility']) expect(workbench).toContain(token);
    for (const token of ["'X-HON-Human-Command': 'attendance'", "credentials: 'same-origin'", "mode: 'same-origin'", 'assertAttendanceEndpoint', 'progressionCreditMilli']) expect(http).toContain(token);
    expect([workbench, http].join('\n')).not.toMatch(/localStorage|sessionStorage|invokeLLM|executeAction|fetch\(['"]https?:\/\//);
    const route = readFileSync('src/app/staff/attendance/page.tsx', 'utf8');
    for (const token of ['cookies', 'verifySession', 'HON_SESSION_COOKIE', "redirect('/auth/login')", 'force-dynamic', 'index: false']) expect(route).toContain(token);
    const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
    expect(manifest.routes.filter((item: { path: string }) => item.path === '/staff/attendance')).toHaveLength(1);
  });
});
