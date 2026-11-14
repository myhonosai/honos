import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { StaffSearch } from '../src/components/staff-search';
import { NO_SCHOOL_SHELL, SchoolShellProvider } from '../src/components/school-shell/context';
import { StaffSearchRecord } from '../src/components/staff-search-record';
import { safeSearchCard, safeSearchResults, searchApiPath, searchFailure } from '../src/components/staff-search-http';
import { ACTION_CATALOG, STAFF_SEARCH_READ_REGISTRY } from '../../../packages/config/dist/index.js';
const org='11111111-1111-4111-8111-111111111111';const school='22222222-2222-4222-8222-222222222222';const id='33333333-3333-4333-8333-333333333333';
const card=()=>({kind:'STUDENT',entityId:id,title:'Ada Lee',subtitle:'Student · ACTIVE',route:`/staff/search/${org}/${school}/STUDENT/${id}`});

describe('conventional staff search',()=>{
  it('has conventional empty, scoped, permission and type affordances without fabricated data',()=>{
    const html=renderToStaticMarkup(<StaffSearch />);
    expect(html).toContain('<h1>Search</h1>');expect(html).toContain('Choose your school at the top of the page to search it.');
    for(const jargon of ['SINGLE-SCHOOL SEARCH','search.global','Essential, Core and Complete','Organization UUID','School UUID'])expect(html).not.toContain(jargon);
    expect(html).toContain('type="search"');expect(html).toContain('maxLength="120"');expect(html.match(/type="checkbox"/g)).toHaveLength(5);expect(html).not.toContain('Ada Lee');
    expect(html).toContain('aria-live="polite"');expect(html).toContain('Results never show contact details.');
  });
  it('searches the school the shell verified, with no school ID boxes and no page-level view picker',()=>{
    const html=renderToStaticMarkup(<SchoolShellProvider value={{...NO_SCHOOL_SHELL,phase:'READY',selection:{organizationId:org,schoolId:school},schoolName:'Sunrise'}}><StaffSearch /></SchoolShellProvider>);
    expect(html).not.toContain('Choose your school at the top');expect(html).not.toMatch(/<input[^>]*disabled/);
    expect(html).not.toContain(org);expect(html).not.toMatch(/Organization UUID|School UUID|Platform View|data-platform-view/);
  });
  it('known-ID landing explicitly rechecks live authority and displays only a read card',()=>{
    const html=renderToStaticMarkup(<StaffSearchRecord organizationId={org} schoolId={school} kind="STUDENT" entityId={id}/>);
    expect(html).toContain('Access is checked again');expect(html).toContain('Verifying staff access');expect(html).toContain('not an expanded profile or action surface');expect(html).not.toContain('Ada Lee');
  });
  it('only creates same-origin school API paths with validated current IDs',()=>{
    expect(searchApiPath(org.toUpperCase(),school)).toBe(`/api/v1/organizations/${org}/schools/${school}/search`);
    for(const scope of ['https://evil.test','../secret','//evil.test','school?sql='])expect(()=>searchApiPath(scope,school)).toThrow();
  });
  it('validates current-scope navigation, closed kinds and display data; strips all extra fields',()=>{
    const output=safeSearchCard({...card(),email:'PRIVATE',note:'PRIVATE'},org,school);expect(Object.keys(output)).toEqual(['kind','entityId','title','subtitle','route']);
    expect(JSON.stringify(output)).not.toContain('PRIVATE');
    for(const changes of [{route:'https://evil.test'},{route:'//evil.test'},{route:'javascript:alert(1)'},{route:`/staff/search/${school}/${org}/STUDENT/${id}`},{kind:'HQ'},{entityId:'../secret'},{title:'\u202eevil'}])expect(()=>safeSearchCard({...card(),...changes},org,school)).toThrow();
    expect(()=>safeSearchResults({organizationId:org,schoolId:org,results:[card()]},org,school)).toThrow();
    expect(()=>safeSearchResults({organizationId:org,schoolId:school,results:Array.from({length:21},card)},org,school)).toThrow();
    expect(()=>safeSearchResults({organizationId:org,schoolId:school,results:[card(),card()]},org,school)).toThrow();
  });
  it('shows clear denied/unavailable/not-found states with no upgrade or success fiction',()=>{
    expect(searchFailure(403)).toContain('no plan upgrade');expect(searchFailure(401)).toContain('Sign in again');expect(searchFailure(503)).toContain('Nothing was changed');expect(searchFailure(404)).toContain('no longer available');
  });
  it('read registry does not register action execution, AI or tier escalation',()=>{
    expect(STAFF_SEARCH_READ_REGISTRY.requiredPermission).toBe('search.global');expect(STAFF_SEARCH_READ_REGISTRY.minimumTier).toBe('ESSENTIAL');expect(STAFF_SEARCH_READ_REGISTRY.operation).toBe('READ_ONLY');
    expect(ACTION_CATALOG.some(action=>action.code==='search.global')).toBe(false);
    for(const file of ['staff-search.tsx','staff-search-record.tsx']){
      const source=readFileSync(resolve('src/components',file),'utf8');expect(source).toContain("credentials: 'same-origin'");expect(source).toContain("method: 'GET'");expect(source).toContain("cache: 'no-store'");expect(source).toContain('AbortController');expect(source).not.toMatch(/localStorage|dangerouslySetInnerHTML|method: 'POST'|invokeLLM|openrouter|apiKey/);
    }
  });
  it('manifest matches every real page including safe dynamic search routes, not API paths',()=>{
    const root=resolve('src/app');
    const pages=readdirSync(root,{recursive:true}).filter((path): path is string=>typeof path==='string'&&path.endsWith('page.tsx')).map(path=>'/'+relative(root,resolve(root,path)).replace(/\/page\.tsx$|^page\.tsx$/,'').replace(/\[([^\]]+)\]/g,':$1'));
    const manifest=JSON.parse(readFileSync(resolve('public/manus-routes.json'),'utf8'));
    expect(manifest.routes.map((row:{path:string})=>row.path).sort()).toEqual(pages.sort());
  });
});
