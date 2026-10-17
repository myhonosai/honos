import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadParentPlannedAbsenceRequestContext, submitParentPlannedAbsence, plannedAbsenceAttempt, ParentPlannedAbsenceRequestAccessError } from '../src/components/parent-planned-absence-request-http';
import { verifyParentPlannedAbsenceRequestContext, verifyParentPlannedAbsenceSubmittedReceipt } from '@hon/contracts';
const id='11111111-1111-4111-8111-111111111111', context={children:[{studentProfileId:id,displayName:'Authorized child'}]}, receipt={status:'SUBMITTED',submittedAt:'2026-10-17T00:00:00.000Z'};
const input={studentProfileId:id,startsAt:'2026-10-18T00:00:00.000Z',endsAt:'2026-10-19T00:00:00.000Z',reason:'Private reason'};
const response=(data:unknown,submit=false)=>Response.json({data,meta:{requestId:id,correlationId:id,...(submit?{replayed:false}:{})}});
describe('selector-free parent absence request HTTP',()=>{
 it('starts with fixed context GET then explicit same-origin human POST and returns only verified SUBMITTED receipt',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response(context)).mockResolvedValueOnce(response(receipt,true));
  try {
   await expect(loadParentPlannedAbsenceRequestContext()).resolves.toEqual(context);await expect(submitParentPlannedAbsence(input,'retained-key')).resolves.toEqual(receipt);
   expect(fetcher).toHaveBeenNthCalledWith(1,'/api/v1/parent/planned-absences/context',expect.objectContaining({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'}}));
   expect(fetcher).toHaveBeenNthCalledWith(2,'/api/v1/parent/planned-absences',expect.objectContaining({method:'POST',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',headers:expect.objectContaining({'X-HON-Human-Command':'parent-planned-absence','Idempotency-Key':'retained-key'}),body:JSON.stringify(input)}));
   expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/schoolId|familyId|organizationId|principalId|provider/);
  }finally{fetcher.mockRestore();}
 });
 it('rejects extra/private choices, unsafe display names, duplicate/unbounded selectors and fabricated downstream receipts',()=>{
  for(const field of ['familyId','schoolId','organizationId','principalId','notes','schedule','attendance','booking','payment','contact','reviewer','provider']){
   expect(()=>verifyParentPlannedAbsenceRequestContext({...context,[field]:id})).toThrow();expect(()=>verifyParentPlannedAbsenceRequestContext({children:[{...context.children[0],[field]:id}]})).toThrow();expect(()=>verifyParentPlannedAbsenceSubmittedReceipt({...receipt,[field]:id})).toThrow();
  }
  expect(()=>verifyParentPlannedAbsenceRequestContext({children:[context.children[0],context.children[0]]})).toThrow();expect(()=>verifyParentPlannedAbsenceRequestContext({children:Array(101).fill(context.children[0])})).toThrow();
  for(const name of ['',' child','child\n','child\u202e'])expect(()=>verifyParentPlannedAbsenceRequestContext({children:[{studentProfileId:id,displayName:name}]})).toThrow();
  for(const status of ['APPROVED','BOOKED','ATTENDED','PAID','SENT'])expect(()=>verifyParentPlannedAbsenceSubmittedReceipt({...receipt,status})).toThrow();
  expect(()=>verifyParentPlannedAbsenceSubmittedReceipt({...receipt,submittedAt:'2026-02-30T00:00:00.000Z'})).toThrow();
 });
 it('retains exact key and frozen payload across uncertain human retries without automatically submitting',async()=>{
  const key=vi.fn().mockReturnValueOnce('first-key').mockReturnValueOnce('new-key'),attempt=plannedAbsenceAttempt(input,null,key);
  expect(plannedAbsenceAttempt({...input},attempt,key)).toBe(attempt);expect(key).toHaveBeenCalledTimes(1);
  const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('uncertain')).mockResolvedValueOnce(response(receipt,true));
  try{await expect(submitParentPlannedAbsence(attempt.input,attempt.key)).rejects.toThrow('uncertain');expect(fetcher).toHaveBeenCalledTimes(1);await submitParentPlannedAbsence(attempt.input,attempt.key);expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);expect(plannedAbsenceAttempt({...input,reason:'Changed'},attempt,key).key).toBe('new-key');}finally{fetcher.mockRestore();}
 });
 it.each([401,403])('refuses %s without consuming upstream private error details',async status=>{
  const json=vi.fn(),fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status,json} as unknown as Response);
  try{await expect(loadParentPlannedAbsenceRequestContext()).rejects.toBeInstanceOf(ParentPlannedAbsenceRequestAccessError);await expect(submitParentPlannedAbsence(input,'key')).rejects.toBeInstanceOf(ParentPlannedAbsenceRequestAccessError);expect(json).not.toHaveBeenCalled();}finally{fetcher.mockRestore();}
 });
 it('rejects malformed envelopes and tenant-shaped input before showing or making a command',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({data:receipt,meta:{requestId:id,correlationId:id,replayed:false,familyId:id}}));
  try{await expect(submitParentPlannedAbsence(input,'key')).rejects.toThrow('could not be verified');fetcher.mockClear();await expect(submitParentPlannedAbsence({...input,familyId:id} as typeof input,'key')).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();}finally{fetcher.mockRestore();}
 });
 it('form has no technical tenant IDs, persistence, staff review UI, or external effects',()=>{
  const component=readFileSync('src/components/parent-planned-absence-history.tsx','utf8'),http=readFileSync('src/components/parent-planned-absence-request-http.ts','utf8');
  expect(component+http).not.toMatch(/schoolId|familyId|organizationId|principalId|localStorage|sessionStorage|indexedDB|invokeLLM|executeAction|sendMessage/);
  expect(component).toContain('maxLength={1000}');expect(component).toContain('onSubmit={submit}');expect(component).toContain('await loadParentPlannedAbsenceHistory()');expect(component).toContain('No inclusion is assumed.');expect(component).not.toMatch(/setInterval|setTimeout/);
 });
});
