import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const harness=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as (()=>void)[],listeners:new Map<string,()=>void>()}));
vi.mock('react',async importOriginal=>{
 const actual=await importOriginal<typeof import('react')>();
 const same=(a:any[],b:any[])=>a.length===b.length&&a.every((value,i)=>value===b[i]);
 const hooks={
  useState(initial:any){const i=harness.cursor++;if(!(i in harness.slots))harness.slots[i]=typeof initial==='function'?initial():initial;return[harness.slots[i],(value:any)=>{harness.slots[i]=typeof value==='function'?value(harness.slots[i]):value;}];},
  useRef(initial:any){const i=harness.cursor++;return harness.slots[i]??(harness.slots[i]={current:initial});},
  useCallback(callback:any,deps:any[]){const i=harness.cursor++;if(!harness.slots[i]||!same(harness.slots[i].deps,deps))harness.slots[i]={callback,deps};return harness.slots[i].callback;},
  useEffect(effect:()=>void,deps:any[]){const i=harness.cursor++;if(!harness.slots[i]||!same(harness.slots[i].deps,deps)){harness.slots[i]={deps};harness.effects.push(effect);}},
 };return{...actual,...hooks,default:{...actual,...hooks}};
});
import { PlannedAbsenceReviewWorkbench } from '../src/components/planned-absence-review-workbench';
const id='11111111-1111-4111-8111-111111111111',schoolId='22222222-2222-4222-8222-222222222222',studentProfileId='33333333-3333-4333-8333-333333333333';
const item={id,studentProfileId,startsAt:'2026-10-18T09:00:00.000Z',endsAt:'2026-10-18T11:00:00.000Z',reason:'PRIVATE_SUBMITTED_REASON',version:1,submittedAt:'2026-10-17T00:00:00.000Z'},queue={organizationId:id,schoolId,items:[item]},receipt={id,status:'APPROVED',version:2,reviewedAt:'2026-10-17T01:00:00.000Z'};
const envelope=(data:unknown,command=false)=>Response.json({data,meta:{requestId:id,correlationId:id,...(command?{replayed:false}:{})}});
const render=()=>{harness.cursor=0;return PlannedAbsenceReviewWorkbench();};
const nodes=(tree:any,type:string):any[]=>!tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(value=>nodes(value,type)):[...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)];
const button=(text:string)=>nodes(render(),'button').find(node=>[node.props.children].flat().join('')===text);
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const prepare=()=>{nodes(render(),'textarea')[0].props.onChange({target:{value:'PRIVATE_REVIEW_NOTE'}});};
const load=async()=>{button('Load current submitted requests').props.onClick();await flush();};
const select=()=>button('Review request '+id).props.onClick();
beforeEach(()=>{
 harness.slots=[];harness.cursor=0;harness.effects=[];harness.listeners.clear();
 const events={addEventListener:(key:string,fn:()=>void)=>harness.listeners.set(key,fn),removeEventListener:vi.fn()};
 vi.stubGlobal('document',{...events,visibilityState:'visible'});vi.stubGlobal('window',events);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('manual human planned absence review interaction',()=>{
 it('never loads or posts on mount/focus; explicitly loads minimum facts, records one decision, clears private state without auto refresh',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(queue)).mockResolvedValueOnce(envelope(receipt,true));
  render();harness.effects.splice(0).forEach(fn=>fn());expect(fetcher).not.toHaveBeenCalled();expect(harness.listeners.has('focus')).toBe(false);
  prepare();await load();expect(renderToStaticMarkup(render())).toContain('PRIVATE_SUBMITTED_REASON');select();button('Record APPROVED decision').props.onClick();await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({decision:'APPROVED',reviewNote:'PRIVATE_REVIEW_NOTE',expectedVersion:1});
  const html=renderToStaticMarkup(render());expect(html).toContain('APPROVED, version 2');expect(html).not.toContain('PRIVATE_SUBMITTED_REASON');expect(html).not.toContain('PRIVATE_REVIEW_NOTE');expect(html).toContain('No verified review queue is loaded');
 });
 it('retains exactly one uncertain decision snapshot and key for explicit exact retry only',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(queue)).mockRejectedValueOnce(new Error('Uncertain network')).mockResolvedValueOnce(envelope(receipt,true));
  prepare();await load();select();button('Record APPROVED decision').props.onClick();await flush();expect(fetcher).toHaveBeenCalledTimes(2);expect(button('Record APPROVED decision').props.disabled).toBe(true);
  const first=fetcher.mock.calls[1]!;button('Retry exact retained decision').props.onClick();await flush();const second=fetcher.mock.calls[2]!;
  expect(second[0]).toBe(first[0]);expect(second[1]!.body).toBe(first[1]!.body);expect(second[1]!.headers).toEqual(first[1]!.headers);expect(fetcher).toHaveBeenCalledTimes(3);expect(renderToStaticMarkup(render())).not.toContain('Retry exact retained decision');
 });
 it('changing note or decision clears queue, detail and exact retry instead of rebinding an old key',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(queue)).mockRejectedValueOnce(new Error('Uncertain network')).mockResolvedValueOnce(envelope(queue));
  prepare();await load();select();button('Record APPROVED decision').props.onClick();await flush();expect(button('Retry exact retained decision')).toBeTruthy();
  nodes(render(),'textarea')[0].props.onChange({target:{value:'Changed note'}});let html=renderToStaticMarkup(render());expect(html).not.toContain('PRIVATE_SUBMITTED_REASON');expect(html).not.toContain('Confirm one');expect(html).not.toContain('Retry exact');
  await load();select();nodes(render(),'select')[0].props.onChange({target:{value:'DECLINED'}});html=renderToStaticMarkup(render());expect(html).not.toContain('PRIVATE_SUBMITTED_REASON');expect(html).not.toContain('Confirm one');expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it.each([401,403,404,409])('clears all review/retry state on terminal response %s',async status=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(queue)).mockResolvedValueOnce(new Response('',{status}));
  prepare();await load();select();button('Record APPROVED decision').props.onClick();await flush();const html=renderToStaticMarkup(render());expect(html).not.toContain('PRIVATE_SUBMITTED_REASON');expect(html).not.toContain('PRIVATE_REVIEW_NOTE');expect(html).not.toContain('Retry exact');expect(html).toContain('No verified review queue');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('hiding the page ignores stale queue/decision responses and clears note/retry without automatic reauthorization',async()=>{
  let resolve!:(value:Response)=>void;const deferred=new Promise<Response>(done=>{resolve=done;});const fetcher=vi.spyOn(globalThis,'fetch').mockReturnValueOnce(deferred);
  render();harness.effects.splice(0).forEach(fn=>fn());prepare();button('Load current submitted requests').props.onClick();harness.listeners.get('blur')!();resolve(envelope(queue));await flush();expect(renderToStaticMarkup(render())).not.toContain('PRIVATE_SUBMITTED_REASON');expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(envelope(queue));prepare();await load();select();let decideResolve!:(value:Response)=>void;fetcher.mockReturnValueOnce(new Promise<Response>(done=>{decideResolve=done;}));button('Record APPROVED decision').props.onClick();harness.listeners.get('hon:session-changed')!();decideResolve(envelope(receipt,true));await flush();
  const html=renderToStaticMarkup(render());expect(html).not.toContain('APPROVED, version 2');expect(html).not.toContain('PRIVATE_SUBMITTED_REASON');expect(html).not.toContain('PRIVATE_REVIEW_NOTE');expect(fetcher).toHaveBeenCalledTimes(3);
 });
});
