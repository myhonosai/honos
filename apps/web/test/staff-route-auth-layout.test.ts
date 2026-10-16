import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const guard = readFileSync('src/server/require-web-session.ts', 'utf8');
const staffLayout = readFileSync('src/app/staff/layout.tsx', 'utf8');
const hqLayout = readFileSync('src/app/hq/layout.tsx', 'utf8');

describe('staff and HQ route session layouts', () => {
  it('uses the existing signed session verifier and fails closed before rendering protected children', () => {
    expect(guard).toContain("HON_SESSION_COOKIE, sessionConfig, verifySession");
    expect(guard).toContain('await cookies()');
    expect(guard).toContain('verifySession(token, sessionConfig())');
    expect(guard).toContain("redirect('/auth/login')");
    expect(guard).toContain('Fail closed');
    for (const layout of [staffLayout, hqLayout]) {
      expect(layout).toContain("export const dynamic = 'force-dynamic'");
      expect(layout).toContain('await requireVerifiedWebSession()');
    }
  });

  it('keeps domain authorization out of the shared browser gate', () => {
    for (const source of [guard, staffLayout, hqLayout]) {
      expect(source).not.toMatch(/fetch\(|load[A-Z]|save[A-Z]|executeAction|invokeLLM|Idempotency-Key|X-HON-Human-Command|organizationId|schoolId|familyId/);
    }
    expect(hqLayout).toContain('HQ APIs establish that separately.');
  });
});
