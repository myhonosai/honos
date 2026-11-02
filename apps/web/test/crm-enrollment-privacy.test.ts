import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { verifyEnrollmentSession } from '../src/components/crm-enrollment-privacy';
import { PlanAccessError, PlanReadError } from '../src/components/membership-plans/http';
const signal = () => new AbortController().signal;
const response = (data: unknown, status = 200, cache = 'no-store') => new Response(JSON.stringify(data), {status,headers:{'Content-Type':'application/json','Cache-Control':cache}});
afterEach(()=>{ vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses the existing signed-session read without a command, key, storage or identity selector',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response({data:{externalSubject:'staff-one'}}));
  await verifyEnrollmentSession('staff-one',signal());
  expect(fetcher).toHaveBeenCalledWith('/api/identity/me',expect.objectContaining({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'}}));
  expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('body');
});
it.each([401,403])('rejects expired or unavailable session %s',async status=>{
  const target = new EventTarget(), invalidated = vi.fn(); target.addEventListener('hon:session-invalidated',invalidated); vi.stubGlobal('window',target);
  const denied=response({detail:'private-canary'},status), consumed=vi.spyOn(denied,'json');
  vi.spyOn(globalThis,'fetch').mockResolvedValue(denied);
  await expect(verifyEnrollmentSession('staff-one',signal())).rejects.toBeInstanceOf(PlanAccessError);
  expect(consumed).not.toHaveBeenCalled();expect(invalidated).toHaveBeenCalledTimes(status===401?1:0);
});
it('rejects changed users, absent baseline, cached and malformed results',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');
  await expect(verifyEnrollmentSession(undefined,signal())).rejects.toBeInstanceOf(PlanAccessError);expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(response({data:{externalSubject:'staff-two'}}));await expect(verifyEnrollmentSession('staff-one',signal())).rejects.toBeInstanceOf(PlanAccessError);
  for(const r of [response({data:{externalSubject:'staff-one'}},200,'public'),response({data:{externalSubject:'staff-one',permission:'all'}}),response({data:{externalSubject:'staff-one'},extra:'unexpected'}),response({},503)]){
    fetcher.mockResolvedValueOnce(r);await expect(verifyEnrollmentSession('staff-one',signal())).rejects.toBeInstanceOf(PlanReadError);
  }
});
it('never installs automatic focus restoration or persists enrollment or retry information',()=>{
  const root='src/components/';
  for(const file of ['crm-enrollment-privacy.ts','crm-leads-workbench.tsx','crm-family-flow.tsx','crm-adult-flow.tsx'])expect(readFileSync(root+file,'utf8')).not.toMatch(/localStorage|sessionStorage|document\.cookie|sendBeacon|telemetry/);
  const source=readFileSync(root+'crm-leads-workbench.tsx','utf8');expect(source).not.toContain("addEventListener('focus'");expect(source).toContain('hidden={concealed} inert={concealed}');
});
