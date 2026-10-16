import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { kioskStaffPath, newKioskSecret, submitKiosk } from '../src/components/kiosk-http';
const secret=()=>randomBytes(32).toString('base64url'),id=randomUUID();
afterEach(()=>vi.unstubAllGlobals());
describe('kiosk handoff UI boundary',()=>{
 it('uses only a fixed relative credential-free public handoff request',async()=>{
  const fetchMock=vi.fn(async()=>new Response(JSON.stringify({result:'NEEDS_STAFF_ASSISTANCE'}),{status:200,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',fetchMock);
  await submitKiosk(secret(),secret());
  expect(fetchMock.mock.calls[0]).toEqual(['/api/v1/kiosk/handoffs',{method:'POST',credentials:'omit',mode:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',headers:{'Content-Type':'application/json'},body:expect.any(String)}]);
  expect(kioskStaffPath({organizationId:id,schoolId:id},'claims',id,'provision')).toBe(`/api/v1/organizations/${id}/schools/${id}/kiosk/claims/${id}/provision`);
  expect(()=>kioskStaffPath({organizationId:'bad',schoolId:id},'claims',id)).toThrow();
  expect(newKioskSecret()).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
 });
 it('renders a resettable needs-staff surface without personal, financial or operational outcomes',()=>{
  const source=readFileSync(new URL('../src/components/kiosk-screen.tsx',import.meta.url),'utf8'),staff=readFileSync(new URL('../src/components/kiosk-workbench.tsx',import.meta.url),'utf8'),http=readFileSync(new URL('../src/components/kiosk-http.ts',import.meta.url),'utf8');
  expect(source).toContain('Need staff assistance?');expect(source).toContain('does NOT admit, redeem, check in, record attendance, take payment or send notifications');
  expect(staff).toContain('NO admission, redemption, check-in, attendance, payment or notification');
  expect(http).toContain("credentials:'omit'");expect(source).toContain("window.addEventListener('pagehide',lock)");
  expect(source).not.toMatch(/localStorage|sessionStorage|studentProfileId|classSessionId|family|payment.*fetch|redeem.*fetch/i);
 });
});
