import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { StaffAvailabilityWorkbench } from '../src/components/staff-availability-workbench';
import { staffAvailabilityPath, staffAvailabilityRequest } from '../src/components/staff-availability-http';
const id='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',profile='33333333-3333-4333-8333-333333333333';
const body={expectedVersion:0,status:'ACTIVE' as const,effectiveFrom:'2026-01-01',endsOn:null,windows:[{weekday:1,start:'09:00',end:'10:00'}]};
const revision={...body,profileId:profile,principalId:id,schoolId:school,kind:'AVAILABILITY',version:1,timezone:'America/New_York',recordedAt:'2026-10-01T00:00:00Z',planningOnly:true};
describe('human staff availability foundation UI',()=>{
 it('starts empty with no calls, explicit self/known-ID management and honest planning-only help',()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<StaffAvailabilityWorkbench/>);expect(fetcher).not.toHaveBeenCalled();for(const text of ['Load my own staff profile','already-known staff principal UUID','No directory','No scheduling or employment decisions','Qualification metadata is unverified','No classes or sessions change','no payroll','Essential, Core and Complete','No save is assumed']){if(text==='No save is assumed')continue;expect(html).toContain(text);}expect(html).not.toContain('Append availability revision');expect(html).not.toContain('Verified append-only');expect(html).not.toContain('School UUID');expect(html).not.toContain('type="file"');}finally{fetcher.mockRestore();}
 });
 it('only uses fixed same-origin self/known-ID endpoints, rejects listing/queries/external routes and verifies saved content',async()=>{
  const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>({data:revision})} as Response);try{
   const url=staffAvailabilityPath('self','AVAILABILITY');expect(await staffAvailabilityRequest(url,body,'retained-key')).toEqual(revision);expect(mock).toHaveBeenCalledWith(url,expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store',headers:expect.objectContaining({'X-HON-Human-Command':'staff-availability','Idempotency-Key':'retained-key'})}));
   for(const url of ['https://evil.test/api/v1/staff/team/availability/self','//evil.test/api/v1/staff/team/availability/self','/api/v1/staff/team/availability','/api/v1/staff/team/availability/self?schoolId='+school,'/api/v1/staff/team/availability/self/assign','/api/v1/staff/team/availability/self/availability/versions','/api/v1/ai/providers']){const n=mock.mock.calls.length;await expect(staffAvailabilityRequest(url)).rejects.toThrow();expect(mock.mock.calls.length).toBe(n);}
   expect(()=>staffAvailabilityPath('a name')).toThrow();expect(()=>staffAvailabilityPath(id,'AVAILABILITY',0)).toThrow();
   for(const patch of [{version:2},{planningOnly:false},{principalId:school},{status:'ASSIGNED'},{windows:[]}]){mock.mockResolvedValue({ok:true,json:async()=>({data:{...revision,...patch}})} as Response);await expect(staffAvailabilityRequest(staffAvailabilityPath(id,'AVAILABILITY'),body,'key')).rejects.toThrow();}
  }finally{mock.mockRestore();}
 });
 it('never exposes backend error PII or treats missing data as a save',async()=>{
  const mock=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status:403,json:async()=>({detail:'PRIVATE_DIRECTORY'})} as Response);try{await expect(staffAvailabilityRequest(staffAvailabilityPath('self'))).rejects.toThrow('Current exact school permission');mock.mockResolvedValue({ok:true,json:async()=>({})} as Response);await expect(staffAvailabilityRequest(staffAvailabilityPath('self','AVAILABILITY'),body,'key')).rejects.toThrow('Outcome uncertain');}finally{mock.mockRestore();}
 });
 it('keeps retries and history separate from current editors; exposes no payroll/AI/provider/class effect',()=>{
  const source=readFileSync('src/components/staff-availability-workbench.tsx','utf8');for(const text of ['retries.current','setSaved(null)','Remove from draft','End availability stream','unverified','Saved history is never overwritten','No save is assumed'])expect(source).toContain(text);expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|assignStaff|sendMessage|syncCalendar|type="file"/);const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((r:{path:string})=>r.path==='/staff/team/availability')).toHaveLength(1);
 });
});
