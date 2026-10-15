import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { CommunityWorkbench } from '../src/components/community-workbench';
import { loadCommunity, loadCommunityProfile, readCommunity, saveCommunity, loadCommunityHistory, CommunityAccessError } from '../src/components/community-http';
const school='11111111-1111-4111-8111-111111111111', id='22222222-2222-4222-8222-222222222222', parent='33333333-3333-4333-8333-333333333333';
const input={expectedVersion:0,kind:'TOPIC' as const,parentId:null,title:'General owner practice',body:'General owner discussion',status:'DRAFT' as const,reason:'Human author draft'};
const record={id,version:1,kind:'TOPIC',parentId:null,title:input.title,body:input.body,status:'DRAFT',displayName:'Owner alias',canEdit:true,reason:input.reason,recordedAt:'2026-01-01T00:00:00.000Z'};
const profile={version:1,displayName:'Owner alias',enabled:true,organizationVersion:1,organizationEnabled:true,canManageOrganization:true,humanOnly:true,executionAllowed:false};
const page={items:[record],nextAfter:null,humanOnly:true,executionAllowed:false};
const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
describe('closed human owner community',()=>{
 it('starts empty without calls, member content, contacts, external publishing or action UI',()=>{
  const f=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<CommunityWorkbench/>);expect(f).not.toHaveBeenCalled();for(const text of ['HON Community','Member-only published discussions','Never public','Already-known school ID','manual','No personal contact directory','moderation','payments','operator'])expect(html.toLowerCase()).toContain(text.toLowerCase());expect(html).not.toContain('Owner alias');expect(html).not.toContain('Save private draft');expect(html).not.toMatch(/type="(?:email|file)"/);}finally{f.mockRestore();}
 });
 it('uses only the authenticated same-origin human staff boundary and exact version fields',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(record));try{
   expect(await saveCommunity(school,{op:'CONTENT',id:null,input},'retained-key')).toEqual(record);
   expect(f).toHaveBeenLastCalledWith(`/api/v1/staff/community?schoolId=${school}`,expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store',headers:expect.objectContaining({'X-HON-Human-Command':'community','Idempotency-Key':'retained-key'})}));
   for(const patch of [{email:'PRIVATE'},{principalId:id},{schoolId:school},{provider:'PRIVATE'},{body:'Different'},{version:2},{canEdit:false,status:'PUBLISHED',reason:null}]){f.mockResolvedValue(response({...record,...patch}));await expect(saveCommunity(school,{op:'CONTENT',id:null,input},'retained-key')).rejects.toThrow();}
   const calls=f.mock.calls.length;
   for(const bad of ['https://evil.test','../community',id+'?schoolId='+school]){await expect(loadCommunityProfile(bad)).rejects.toThrow();await expect(readCommunity(school,'TOPIC',null,bad)).rejects.toThrow();await expect(loadCommunity(school,'POST',bad)).rejects.toThrow();}expect(f.mock.calls.length).toBe(calls);
   await expect(saveCommunity(school,{op:'CONTENT',id,input},'key')).rejects.toThrow();expect(f.mock.calls.length).toBe(calls);
  }finally{f.mockRestore();}
 });
 it('fails closed on operational/private fields, invalid visibility, cardinality and cross-thread outputs',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(page));try{
   expect((await loadCommunity(school,'TOPIC',null)).items).toEqual([record]);
   for(const patch of [{items:[{...record,student:{name:'PRIVATE'}}]},{items:[{...record,billingAccountId:id}]},{items:[{...record,organizationId:school}]},{items:[{...record,canEdit:false}]},{items:[{...record,kind:'POST',parentId:parent}]},{items:[record,record]},{items:Array.from({length:31},()=>record)},{nextAfter:id},{humanOnly:false},{executionAllowed:true}]){f.mockResolvedValue(response({...page,...patch}));await expect(loadCommunity(school,'TOPIC',null)).rejects.toThrow();}
   f.mockResolvedValue(response({...record,id:parent}));await expect(readCommunity(school,'TOPIC',null,id)).rejects.toThrow();
   f.mockResolvedValue(response({...record,canEdit:false,status:'PUBLISHED',reason:null}));expect((await readCommunity(school,'TOPIC',null,id)).reason).toBeNull();
   f.mockResolvedValue({ok:false,status:403,json:async()=>({detail:'PRIVATE_DIRECTORY'})}as Response);await expect(loadCommunity(school,'TOPIC',null)).rejects.toBeInstanceOf(CommunityAccessError);await expect(loadCommunityProfile(school)).rejects.not.toThrow('PRIVATE_DIRECTORY');
  }finally{f.mockRestore();}
 });
 it('verifies minimal profile output and author-private metadata-only history',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(profile));try{
   expect(await loadCommunityProfile(school)).toEqual(profile);
   for(const patch of [{email:'PRIVATE'},{schoolId:school},{externalSubject:'PRIVATE'},{displayName:'owner@example.test'},{avatarUrl:'https://example.test'},{executionAllowed:true}]){f.mockResolvedValue(response({...profile,...patch}));await expect(loadCommunityProfile(school)).rejects.toThrow();}
   const h={id,items:[{version:1,status:'DRAFT',recordedAt:record.recordedAt}],nextBefore:null,humanOnly:true,executionAllowed:false};f.mockResolvedValue(response(h));expect((await loadCommunityHistory(school,id)).items).toHaveLength(1);
   for(const patch of [{items:[{...h.items[0],body:'PRIVATE_DRAFT'}]},{items:[{...h.items[0],reason:'PRIVATE'}]},{id:parent},{items:[h.items[0],h.items[0]]},{nextBefore:1}]){f.mockResolvedValue(response({...h,...patch}));await expect(loadCommunityHistory(school,id)).rejects.toThrow();}
  }finally{f.mockRestore();}
 });
 it('protects the page, uses explicit privacy/lifecycle and clears state on access loss with no automatic effects',()=>{
  const source=readFileSync('src/components/community-workbench.tsx','utf8');for(const text of ['clearAll()','setPage(null)','setSelected(null)','setProfile(null)','retry.current = null','setDisplayName(\'\')','CommunityAccessError','Retry exact retained request','setUncertain(true)','Explicitly publish to verified members','Archive and retain private history','No hard delete','needsRefresh','Reload current detail','expectedVersion'])expect(source).toContain(text);
  expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|sendMessage|dangerouslySetInnerHTML|type="(?:email|file)"/);
  const route=readFileSync('src/app/community/page.tsx','utf8');for(const text of ['cookies','verifySession','HON_SESSION_COOKIE','redirect(\'/auth/login\')','force-dynamic','index: false'])expect(route).toContain(text);
  const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((r:{path:string})=>r.path==='/community')).toHaveLength(1);
  expect(readFileSync('src/components/hon-reference-suite.tsx','utf8')).toContain("item === 'Community' ? '/community'");
 });
});
