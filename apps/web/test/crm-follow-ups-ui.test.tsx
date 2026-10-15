import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CrmFollowUpsWorkbench } from '../src/components/crm-follow-ups-workbench';
import { loadFollowUps, readFollowUp, mutateFollowUp } from '../src/components/crm-follow-ups-http';
const id='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',principal='33333333-3333-4333-8333-333333333333',lead='44444444-4444-4444-8444-444444444444';
const body={expectedVersion:0,leadId:lead,assigneeId:principal,subject:'Human review',note:'Private planning note',dueAt:'2027-01-02T09:00:00.000Z',priority:'NORMAL' as const};
const saved={followUpId:id,schoolId:school,leadId:lead,assigneeId:principal,subject:body.subject,note:body.note,dueAt:body.dueAt,priority:body.priority,version:1,status:'OPEN',recordedAt:'2026-10-15T00:00:00.000Z',completedAt:null,cancelledAt:null,humanOnly:true};
const item={followUpId:id,leadId:lead,assigneeId:principal,dueAt:body.dueAt,priority:'NORMAL',version:1,status:'OPEN'};
const queue={schoolId:school,principalId:principal,canManage:false,humanOnly:true,queue:'mine',status:'OPEN',items:[item],nextAfter:null};
const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
describe('human CRM follow-up workbench',()=>{
 it('starts honest and empty, without fetching, execution or fake saved rows',()=>{
  const f=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<CrmFollowUpsWorkbench/>);expect(f).not.toHaveBeenCalled();for(const text of ['CRM follow-ups','No automated outreach','Essential','crm.follow_up.self_manage','crm.follow_up.manage','No staff directory','Load / refresh queue'])expect(html.toLowerCase()).toContain(text.toLowerCase());expect(html).not.toContain('Private follow-up note');expect(html).not.toContain('Create follow-up record');expect(html).not.toContain('type="email"');}finally{f.mockRestore();}
 });
 it('verifies exact saved field/version/state and uses same-origin retained-key human commands',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(saved));try{
   expect(await mutateFollowUp('CREATE',null,body,'retained-key')).toEqual(saved);expect(f).toHaveBeenCalledWith('/api/v1/staff/crm/follow-ups',expect.objectContaining({credentials:'same-origin',cache:'no-store',headers:expect.objectContaining({'X-HON-Human-Command':'crm-follow-ups','Idempotency-Key':'retained-key'})}));
   for(const bad of ['https://evil.test','../follow-ups',id+'?schoolId='+school]){const n=f.mock.calls.length;await expect(readFollowUp(bad)).rejects.toThrow();await expect(mutateFollowUp('UPDATE',bad,{...body,expectedVersion:1},'key')).rejects.toThrow();expect(f.mock.calls.length).toBe(n);}
   for(const patch of [{version:2},{humanOnly:false},{subject:'Other'},{assigneeId:lead},{status:'COMPLETED'},{completedAt:'2027-01-01T00:00:00.000Z'},{recipientEmail:'external@example.test'}]){f.mockResolvedValue(response({...saved,...patch}));await expect(mutateFollowUp('CREATE',null,body,'key')).rejects.toThrow();}
   f.mockResolvedValue(response({...saved,version:2,status:'COMPLETED',completedAt:'2026-10-15T00:01:00.000Z'}));expect((await mutateFollowUp('COMPLETE',id,{expectedVersion:1},'retained-key')).status).toBe('COMPLETED');expect(f).toHaveBeenLastCalledWith(`/api/v1/staff/crm/follow-ups/${id}/lifecycle/complete`,expect.objectContaining({body:'{"expectedVersion":1}'}));
  }finally{f.mockRestore();}
 });
 it('rejects team listing PII/private notes, mismatched own records, duplicates, unbounded and invalid pagination',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(queue));try{
   expect((await loadFollowUps('mine','OPEN')).items).toEqual([item]);
   for(const patch of [{items:[{...item,note:'PRIVATE_NOTE'}]},{items:[{...item,email:'PRIVATE_CONTACT'}]},{items:[{...item,subject:'PRIVATE_SUBJECT'}]},{items:[{...item,assigneeId:lead}]},{items:[item,item]},{items:Array.from({length:51},()=>item)},{nextAfter:id},{queue:'team'},{schoolId:'bad'}]){f.mockResolvedValue(response({...queue,...patch}));await expect(loadFollowUps('mine','OPEN')).rejects.toThrow();}
   f.mockResolvedValue(response({...queue,queue:'team',canManage:true}));expect((await loadFollowUps('team','OPEN')).canManage).toBe(true);
   f.mockResolvedValue({ok:false,status:403,json:async()=>({detail:'PRIVATE_DIRECTORY'})}as Response);await expect(loadFollowUps('mine','OPEN')).rejects.toThrow('Current exact school permission');
   f.mockResolvedValue(response({...saved,followUpId:lead}));await expect(readFollowUp(id)).rejects.toThrow();
  }finally{f.mockRestore();}
 });
 it('has in-memory exact retries, separate current reload, inactive manager recovery and no automation capabilities',()=>{
  const source=readFileSync('src/components/crm-follow-ups-workbench.tsx','utf8');for(const text of ['Retry exact retained request','retry.current','No save is assumed','needsRefresh','Reload current detail','setContext(null)','New follow-up','No records on this page','readonly','reassign'])expect(source.toLowerCase()).toContain(text.toLowerCase());expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|sendMessage|executeAction|type="email"/);
  const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((r:{path:string})=>r.path==='/staff/crm/follow-ups')).toHaveLength(1);
 });
});
