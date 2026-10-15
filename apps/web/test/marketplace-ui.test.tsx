import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MarketplaceWorkbench } from '../src/components/marketplace-workbench';
import { loadMarketplace, loadMarketplaceAccess, loadMarketplaceSelections, loadMarketplaceHistory, saveMarketplace, MarketplaceAccessError } from '../src/components/marketplace-http';
const school='11111111-1111-4111-8111-111111111111', id='22222222-2222-4222-8222-222222222222';
const a={id,version:2,title:'General owner blueprint',category:'OPERATIONS',assetKind:'BLUEPRINT',targetModule:'WORK_ITEMS',requiredPermissions:['work_item.read'],releaseNotes:'General release',previewText:'General planning checklist.',status:'PUBLISHED'};
const selected={id:'33333333-3333-4333-8333-333333333333',assetId:id,assetVersion:2,version:1,status:'REQUIRES_REVIEW',enabled:false,asset:a};
const page=(items:unknown[])=>({items,nextAfter:null,executionAllowed:false});
const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
describe('private descriptive marketplace',()=>{
 it('starts without content, network calls, purchasing/installing or unverified creator controls',()=>{
  const f=vi.spyOn(globalThis,'fetch');try{
   const html=renderToStaticMarkup(<MarketplaceWorkbench/>);expect(f).not.toHaveBeenCalled();
   for(const text of ['Blueprints, not installations','Browse and save for review only','No purchase, installation or automation','School UUID','explicit community','descriptive templates','customer PII','No AI'])expect(html).toContain(text);
   expect(html).not.toContain('General owner blueprint');expect(html).not.toContain('Save private draft');expect(html).not.toMatch(/type="(?:email|file)"/);
  }finally{f.mockRestore();}
 });
 it('save helpers bind exact asset version and keep the retained key for a manually retried uncertain request only',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status:503} as Response);try{
   const m={op:'SAVE' as const,id,input:{expectedVersion:0 as const,assetVersion:2}};
   await expect(saveMarketplace(school,m,'retained-key')).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);
   f.mockResolvedValue(response(selected));expect(await saveMarketplace(school,m,'retained-key')).toEqual(selected);expect(f).toHaveBeenCalledTimes(2);
   expect(f.mock.calls[0]).toEqual(f.mock.calls[1]);
   expect(f).toHaveBeenLastCalledWith(`/api/v1/staff/marketplace/${id}/selections?schoolId=${school}`,expect.objectContaining({method:'POST',credentials:'same-origin',cache:'no-store',body:JSON.stringify(m.input),headers:expect.objectContaining({'X-HON-Human-Command':'marketplace','Idempotency-Key':'retained-key'})}));
   for(const p of [{enabled:true},{status:'APPLIED'},{assetVersion:3},{configuration:{}},{asset:{...a,schoolId:school}}]){f.mockResolvedValue(response({...selected,...p}));await expect(saveMarketplace(school,m,'retained-key')).rejects.toThrow();}
   const n=f.mock.calls.length;await expect(saveMarketplace(school,{...m,input:{...m.input,enabled:true} as never},'key')).rejects.toThrow();expect(f).toHaveBeenCalledTimes(n);
  }finally{f.mockRestore();}
 });
 it('rejects sensitive metadata, unsafe browse projections and wrong history binding; unavailable saved assets expose no copied text',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(page([a])));try{
   expect((await loadMarketplace(school,'BROWSE')).items).toEqual([a]);
   for(const p of [{principalId:'PRIVATE'},{schoolId:school},{displayName:'PRIVATE'},{body:'PRIVATE'},{status:'DRAFT'},{previewText:'password abc'}]){f.mockResolvedValue(response(page([{...a,...p}])));await expect(loadMarketplace(school,'BROWSE')).rejects.toThrow();}
   f.mockResolvedValue(response(page([{...selected,asset:null}])));expect((await loadMarketplaceSelections(school)).items[0]?.asset).toBeNull();
   const h={id,items:[{version:2,status:'PUBLISHED'}],nextBefore:null,executionAllowed:false};f.mockResolvedValue(response(h));expect(await loadMarketplaceHistory(school,id)).toEqual(h);
   f.mockResolvedValue(response({...h,items:[{version:2,status:'PUBLISHED',previewText:'PRIVATE'}]}));await expect(loadMarketplaceHistory(school,id)).rejects.toThrow();
   f.mockResolvedValue({ok:false,status:403} as Response);await expect(loadMarketplaceAccess(school)).rejects.toBeInstanceOf(MarketplaceAccessError);
   const n=f.mock.calls.length;for(const bad of ['https://evil.test','../marketplace',id+'?schoolId='+school])await expect(loadMarketplaceAccess(bad)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(n);
  }finally{f.mockRestore();}
 });
 it('creator save helper accepts only own exact descriptive version and closed bounded fields',async()=>{
  const {id:ignored,version,...fields}=a;void ignored;const m={op:'ASSET' as const,id,input:{expectedVersion:version-1,...fields} as never};
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(a));try{
   expect(await saveMarketplace(school,m,'key')).toEqual(a);
   for(const patch of [{version:3},{title:'Changed title'},{id:selected.id},{provider:'PRIVATE'}]){f.mockResolvedValue(response({...a,...patch}));await expect(saveMarketplace(school,m,'key')).rejects.toThrow();}
  }finally{f.mockRestore();}
 });
 it('clears old scope/access/content, prevents automatic retries, and protects authenticated non-indexable same-origin route',()=>{
  const source=readFileSync('src/components/marketplace-workbench.tsx','utf8');for(const text of ['setAccess(null)','setAssets([])','setOwn([])','setSaved([])','setHistory(null)','setDraft(fresh())','setPending(null)','generation.current !== token','Retry unchanged request','Nothing is automatically retried','access?.canBrowse','access?.canCreate','access?.canSave','Requires review · Disabled','<button disabled>No apply or installation available','Archive unchanged release permanently'])expect(source).toContain(text);
  expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|dangerouslySetInnerHTML/);
  const route=readFileSync('src/app/community/marketplace/page.tsx','utf8');for(const text of ['verifySession',"redirect('/auth/login')",'index: false','force-dynamic'])expect(route).toContain(text);
  const http=readFileSync('src/components/marketplace-http.ts','utf8');expect(http).toContain("credentials: 'same-origin'");expect(http).not.toMatch(/https:\/\/|purchase\(|install\(|apply\(|invokeLLM/);
  const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((r:{path:string})=>r.path==='/community/marketplace')).toHaveLength(1);
 });
});
