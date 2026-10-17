import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Deterministic hook harness exercises this component's effects and event handlers
// without a network/browser dependency. All HTTP is mocked; no commands on mount.
const harness=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as (()=>void)[],listeners:new Map<string,()=>void>()}));
vi.mock('react',async importOriginal=>{
 const actual=await importOriginal<typeof import('react')>();
 const same=(a:any[],b:any[])=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 const hooks={
  useState(initial:any){const i=harness.cursor++;if(!harness.slots[i])harness.slots[i]={value:typeof initial==='function'?initial():initial};return[harness.slots[i].value,(v:any)=>{harness.slots[i].value=typeof v==='function'?v(harness.slots[i].value):v;}];},
  useRef(initial:any){const i=harness.cursor++;return harness.slots[i]??(harness.slots[i]={current:initial});},
  useCallback(callback:any,deps:any[]){const i=harness.cursor++;if(!harness.slots[i]||!same(harness.slots[i].deps,deps))harness.slots[i]={callback,deps};return harness.slots[i].callback;},
  useEffect(effect:()=>void,deps:any[]){const i=harness.cursor++;if(!harness.slots[i]||!same(harness.slots[i].deps,deps)){harness.slots[i]={deps};harness.effects.push(effect);}},
 };
 return{...actual,...hooks,default:{...actual,...hooks}};
});
vi.mock('next/link',()=>({default:({children,prefetch,...props}:any)=><a {...props}>{children}</a>}));
import { ParentPlannedAbsenceHistory } from '../src/components/parent-planned-absence-history';
const id='11111111-1111-4111-8111-111111111111',context={children:[{studentProfileId:id,displayName:'Authorized child'}]};
const history={generatedAt:'2026-10-17T00:00:00.000Z',from:'2026-04-20T00:00:00.000Z',to:'2027-01-16T00:00:00.000Z',accessLevel:'PRIMARY_GUARDIAN',requests:{status:'AVAILABLE',items:[],limited:false}};
const envelope=(data:unknown,submit=false)=>Response.json({data,meta:{requestId:id,correlationId:id,...(submit?{replayed:false}:{})}});
const render=()=>{harness.cursor=0;return ParentPlannedAbsenceHistory();};
const nodes=(tree:any,type:string):any[]=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(v=>nodes(v,type)):[...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)];
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const form=()=>{let tree=render();nodes(tree,'select')[0].props.onChange({target:{value:id}});const inputs=nodes(tree,'input');inputs[0].props.onChange({target:{value:'2026-10-18T09:00'}});inputs[1].props.onChange({target:{value:'2026-10-18T11:00'}});nodes(tree,'textarea')[0].props.onChange({target:{value:'Private reason'}});tree=render();return nodes(tree,'form')[0];};
beforeEach(()=>{
 harness.slots=[];harness.cursor=0;harness.effects=[];harness.listeners.clear();
 const events={addEventListener:(key:string,fn:()=>void)=>harness.listeners.set(key,fn),removeEventListener:vi.fn()};
 vi.stubGlobal('document',{...events,visibilityState:'visible'});vi.stubGlobal('window',events);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('parent planned-absence UI lifecycle',()=>{
 it('mounts context first, never posts automatically, then submits by human event and refreshes bounded history without fabricating inclusion',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(context)).mockResolvedValueOnce(envelope(history)).mockResolvedValueOnce(envelope({status:'SUBMITTED',submittedAt:'2026-10-17T00:00:00.000Z'},true)).mockResolvedValueOnce(envelope(history));
  expect(renderToStaticMarkup(render())).toContain('No automatic outcome');expect(fetcher).not.toHaveBeenCalled();harness.effects.splice(0).forEach(fn=>fn());await flush();
  expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['/api/v1/parent/planned-absences/context','/api/v1/parent/planned-absences/history']);
  expect(renderToStaticMarkup(render())).toContain('Authorized child');await form().props.onSubmit({preventDefault:vi.fn()});
  expect(fetcher.mock.calls.map(c=>c[0])).toEqual(['/api/v1/parent/planned-absences/context','/api/v1/parent/planned-absences/history','/api/v1/parent/planned-absences','/api/v1/parent/planned-absences/history']);
  const html=renderToStaticMarkup(render());expect(html).toContain('Request SUBMITTED');expect(html).toContain('No planned-absence request for a current child');expect(html).not.toContain('Private reason');expect(nodes(render(),'select')[0].props.value).toBe('');
 });
 it('truthfully renders empty/unavailable choices and does not fetch history or expose a form after denied context',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response('',{status:403}));render();harness.effects.splice(0).forEach(fn=>fn());await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);expect(renderToStaticMarkup(render())).toContain('Guardian family access unavailable');expect(nodes(render(),'form')).toHaveLength(0);
  harness.slots=[];harness.effects=[];fetcher.mockReset().mockResolvedValueOnce(envelope({children:[]})).mockResolvedValueOnce(envelope(history));render();harness.effects.splice(0).forEach(fn=>fn());await flush();expect(renderToStaticMarkup(render())).toContain('No active authorized child is returned');expect(nodes(render(),'form')).toHaveLength(0);
 });
 it('keeps exact uncertain retry key/payload only in memory and does not refresh history until a verified receipt',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(context)).mockResolvedValueOnce(envelope(history)).mockRejectedValueOnce(new Error('Uncertain result')).mockResolvedValueOnce(envelope({status:'SUBMITTED',submittedAt:'2026-10-17T00:00:00.000Z'},true)).mockResolvedValueOnce(envelope(history));
  render();harness.effects.splice(0).forEach(fn=>fn());await flush();await form().props.onSubmit({preventDefault:vi.fn()});expect(fetcher).toHaveBeenCalledTimes(3);expect(renderToStaticMarkup(render())).toContain('retained key');
  await nodes(render(),'form')[0].props.onSubmit({preventDefault:vi.fn()});expect(fetcher.mock.calls[2]).toEqual(fetcher.mock.calls[3]);expect(fetcher).toHaveBeenCalledTimes(5);
 });
 it('ignores a stale submit receipt after visibility/session boundary clearing and never starts a stale history refresh',async()=>{
  let resolve!:(response:Response)=>void;const deferred=new Promise<Response>(done=>{resolve=done;});
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(context)).mockResolvedValueOnce(envelope(history)).mockReturnValueOnce(deferred);
  render();harness.effects.splice(0).forEach(fn=>fn());await flush();const submitting=form().props.onSubmit({preventDefault:vi.fn()});harness.listeners.get('blur')!();resolve(envelope({status:'SUBMITTED',submittedAt:'2026-10-17T00:00:00.000Z'},true));await submitting;
  const html=renderToStaticMarkup(render());expect(html).not.toContain('Authorized child');expect(html).not.toContain('Request SUBMITTED');expect(html).not.toContain('Private reason');expect(fetcher).toHaveBeenCalledTimes(3);
 });
});
