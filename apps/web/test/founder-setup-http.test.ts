import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFounderEvidence } from '../src/components/founder-setup/http';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projection = { organizationId: id(1), schoolId: id(2), schoolName: 'Verified school', tier: 'COMPLETE', program: { id: id(3), version: 1, status: 'DRAFT' }, classSession: null, registration: null, guardianChildRegistration: null };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const me = (subject = 'oidc:synthetic:owner') => response({ externalSubject: subject, displayName: 'PRIVATE_NAME', email: 'synthetic@example.invalid' });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(value: unknown = projection) { return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(response(value)).mockResolvedValueOnce(me()); }
describe('founder setup existing-contract reads', () => {
  it('uses only selector-free GETs and minimizes receipts and identity before returning', async () => {
    const f = setup(); const out = await readFounderEvidence('school', new AbortController().signal);
    expect(out).toEqual({ schoolName: 'Verified school', program: true, classSession: false, registration: false });
    expect(Object.isFrozen(out)).toBe(true); expect(JSON.stringify(out)).not.toMatch(/PRIVATE|example.invalid|organizationId|schoolId|tier|version/);
    expect(f.mock.calls.map(c => c[0])).toEqual(['/api/identity/me','/api/v1/owner-launch','/api/identity/me']);
    for (const [, o] of f.mock.calls) expect(o).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error' });
    expect(f.mock.calls.every(([, o]) => !o?.body && !JSON.stringify(o?.headers).includes('Idempotency'))).toBe(true);
  });
  it.each([401, 403, 503])('does not accept denied owner data (%s) or repeat the request', async status => {
    vi.stubGlobal('window', new EventTarget()); let invalidations = 0; window.addEventListener('hon:session-invalidated', () => invalidations++);
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(response({ schoolName: 'PRIVATE_DENIED' }, status));
    await expect(readFounderEvidence('school', new AbortController().signal)).rejects.toMatchObject({ status });
    expect(f).toHaveBeenCalledTimes(2); expect(invalidations).toBe(status === 401 ? 1 : 0);
  });
  it('refuses an identity change after a successful read', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me('first')).mockResolvedValueOnce(response(projection)).mockResolvedValueOnce(me('second'));
    await expect(readFounderEvidence('school', new AbortController().signal)).rejects.toMatchObject({ kind: 'IDENTITY' });
  });
  it('refuses final session expiration and broadcasts shared invalidation', async () => {
    vi.stubGlobal('window', new EventTarget()); let n = 0; window.addEventListener('hon:session-invalidated', () => n++);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(me()).mockResolvedValueOnce(response(projection)).mockResolvedValueOnce(response({}, 401));
    await expect(readFounderEvidence('school', new AbortController().signal)).rejects.toMatchObject({ status: 401 }); expect(n).toBe(1);
  });
  it.each([
    { ...projection, role: 'OWNER' }, { ...projection, tier: 'UNKNOWN' },
    { ...projection, classSession: { id: id(4), programId: id(999), status: 'SCHEDULED', version: 1 } },
    { ...projection, registration: { registrationId: id(8), schoolId: id(999), status: 'ACTIVE' } },
  ])('rejects unsupported and cross-related response contracts', async value => {
    const f = setup(value); await expect(readFounderEvidence('school', new AbortController().signal)).rejects.toThrow(); expect(f).toHaveBeenCalledTimes(2);
  });
  it('keeps a cancelled program as historical creation evidence, never active readiness', async () => {
    setup({ ...projection, program: { ...projection.program, status: 'CANCELLED' } });
    expect(await readFounderEvidence('school', new AbortController().signal)).toEqual({ schoolName: 'Verified school', program: true, classSession: false, registration: false });
  });
  it('uses the minimized production HQ directory, with no staff fanout or inferred founder status', async () => {
    const directory = { schools: Array.from({ length: 51 }, (_, i) => ({ schoolId: id(i + 1), organizationDisplayName: 'Synthetic org', schoolDisplayName: `School ${i}`, organizationOperationalStatus: 'ACTIVE', schoolOperationalStatus: 'ACTIVE', entitlementTier: 'COMPLETE', createdAt: `2026-01-01T00:00:00.000Z` })) };
    const f = setup({ directory }); const out = await readFounderEvidence('hq', new AbortController().signal);
    expect(out).toHaveLength(50); expect(out[0]).toEqual({ schoolName: 'School 0', organizationName: 'Synthetic org' });
    expect(f.mock.calls.map(c => c[0])).toEqual(['/api/identity/me','/api/v1/hq/schools','/api/identity/me']);
    expect(JSON.stringify(out)).not.toMatch(/schoolId|entitlement|progress|founder/);
  });
  it('rejects enhanced HQ fixture fields instead of trusting browser organization authority', async () => {
    const f = setup({ directory: { schools: [{ organizationId: id(99), schoolId: id(2) }] } });
    await expect(readFounderEvidence('hq', new AbortController().signal)).rejects.toThrow(); expect(f).toHaveBeenCalledTimes(2);
  });
  it('does not begin requests already cancelled', async () => {
    const c = new AbortController(); const f = setup(); c.abort();
    await expect(readFounderEvidence('school', c.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(f).not.toHaveBeenCalled();
  });
});
