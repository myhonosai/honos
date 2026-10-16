import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync('src/app/staff/layout.tsx', 'utf8');

describe('staff route session layout', () => {
  it('uses the existing signed session verifier and fails closed before rendering any staff child route', () => {
    expect(layout).toContain("HON_SESSION_COOKIE, sessionConfig, verifySession");
    expect(layout).toContain('await cookies()');
    expect(layout).toContain('verifySession(token, sessionConfig())');
    expect(layout).toContain("redirect('/auth/login')");
    expect(layout).toContain("export const dynamic = 'force-dynamic'");
    expect(layout).toContain('Fail closed');
  });

  it('keeps API authorization separate from the browser page gate', () => {
    expect(layout).not.toMatch(/fetch\(|load[A-Z]|save[A-Z]|executeAction|invokeLLM|Idempotency-Key|X-HON-Human-Command/);
  });
});
