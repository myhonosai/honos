import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {StaffCurriculumLibraryWorkbench} from '../src/components/curriculum-library';
import {ParentCurriculumLibraryPage} from '../src/components/parent-curriculum-library';
import {loadParentLibrary,loadStaffLibrary,createLibraryReference} from '../src/components/curriculum-library-http';
const school='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const parentData={resources:[{title:'Basics',description:'Optional approved reference.',kind:'VIDEO',url:'https://www.youtube.com/watch?v=approved',curriculumName:'Main',rankName:'White',childDisplayName:'Child Safe'}]};
const record={id,curriculumId:id,rankId:null,kind:'VIDEO',url:'https://www.youtube.com/watch?v=approved',title:'Basics',description:'Optional approved reference.',audience:'PARENT',status:'ACTIVE',version:1};
const response=(data:unknown,parent=true)=>({ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>({data,meta:{requestId:id,correlationId:id,...(parent?{}:{replayed:false})}})} as Response);
describe('metadata curriculum library',()=>{
 it('starts empty and explains scope, no preview/player and presentation-only modes',()=>{
  const fetch=vi.spyOn(globalThis,'fetch');try{for(const component of [<StaffCurriculumLibraryWorkbench/>,<ParentCurriculumLibraryPage/>]){const html=renderToStaticMarkup(component);expect(html).toContain('Metadata references only');expect(html).toContain('Big-Button');expect(html).toContain('Modern');expect(html).toContain('Classic');expect(html).not.toMatch(/<iframe|<video|<audio|<img|target="_blank"/);}expect(fetch).not.toHaveBeenCalled();}finally{fetch.mockRestore();}
 });
 it('uses fixed same-origin parent read, no selectors and strict whitelist before returning links',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(parentData));try{
   expect(await loadParentLibrary()).toEqual(parentData);
   expect(fetch).toHaveBeenCalledWith('/api/v1/parent/curriculum-library',expect.objectContaining({method:'GET',mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'}));
   for(const patch of [{id},{staffIdentity:'private'},{url:'https://127.0.0.1/x'},{url:'http://youtube.com/'},{url:'https://youtube.com/#fragment'},{description:'<script>'},{progress:'MET'}]){fetch.mockResolvedValue(response({resources:[{...parentData.resources[0],...patch}]}));await expect(loadParentLibrary()).rejects.toThrow();}
   fetch.mockResolvedValue(response({...parentData,audit:[]}));await expect(loadParentLibrary()).rejects.toThrow();
   fetch.mockResolvedValue({ok:false,status:403} as Response);await expect(loadParentLibrary()).rejects.toThrow(/No success is assumed/);
  }finally{fetch.mockRestore();}
 });
 it('staff fixed known-school endpoint retains expected version and explicit idempotency key',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response({resources:[],curricula:[]},false));try{
   await loadStaffLibrary(school);expect(fetch).toHaveBeenCalledWith(`/api/v1/staff/schools/${school}/curriculum-library`,expect.objectContaining({method:'GET',mode:'same-origin'}));
   await expect(loadStaffLibrary('https://attacker.invalid')).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
   fetch.mockResolvedValue(response(record,false));await createLibraryReference(school,{expectedVersion:0,curriculumId:id,rankId:null,kind:'VIDEO',url:record.url,title:record.title,description:record.description,audience:'PARENT'},'retained-key');
   expect(fetch).toHaveBeenLastCalledWith(`/api/v1/staff/schools/${school}/curriculum-library`,expect.objectContaining({method:'POST',headers:expect.objectContaining({'X-Hon-Human-Command':'curriculum-library','Idempotency-Key':'retained-key'}),body:expect.stringContaining('"expectedVersion":0')}));
  }finally{fetch.mockRestore();}
 });
 it('routes protected and listed; links require verified data plus noopener noreferrer user gesture only',()=>{
  const staff=readFileSync('src/components/curriculum-library.tsx','utf8'),parent=readFileSync('src/components/parent-curriculum-library.tsx','utf8'),client=readFileSync('src/components/curriculum-library-http.ts','utf8');
  for(const source of [staff,parent]){expect(source).toContain('target="_blank" rel="noopener noreferrer"');expect(source).not.toMatch(/<iframe|<video|dangerouslySetInnerHTML|window\.open|fetch\(r\.url|invokeLLM|executeAction/);}
  expect(parent).not.toMatch(/<input|familyId|schoolId|studentId/);expect(parent).toContain('generation.current');expect(parent).toContain('setView(null)');
  expect(client).not.toMatch(/fetch\(.*\.url|https:\/\/|preview|embed/);
  const routes=JSON.parse(readFileSync('public/manus-routes.json','utf8')).routes;
  for(const path of ['/staff/curriculum/library','/parent/curriculum-library']){expect(routes.filter((r:{path:string})=>r.path===path)).toHaveLength(1);const page=readFileSync(`src/app${path}/page.tsx`,'utf8');for(const token of ['verifySession',"redirect('/auth/login')",'force-dynamic','index:false','follow:false'])expect(page).toContain(token);}
 });
});
