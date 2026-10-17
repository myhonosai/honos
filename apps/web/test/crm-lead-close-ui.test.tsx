import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CrmLeadClosePanel } from '../src/components/crm-lead-close-panel';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';

// Tiny deterministic hook runner: invoke the actual components and their event
// handlers without adding a DOM/testing dependency or an application capability.
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0}));
vi.mock('react',async()=>{const actual=await vi.importActual<typeof import('react')>('react');return {...actual,
 useEffect:()=>undefined,
 useState:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=initial;return [hooks.values[i],(value:unknown)=>{hooks.values[i]=typeof value==='function'?(value as (v:unknown)=>unknown)(hooks.values[i]):value;}];},
 useRef:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]={current:initial};return hooks.values[i];}
};});
const org='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const row={id,status:'OPEN' as const,pipelineStageId:org,primaryPersonId:school,version:3,createdAt:'2026-10-16T00:00:00.000Z',givenName:'Ari',familyName:'Stone'};
type Element=ReactElement<Record<string, any>>;
function elements(node:unknown):Element[]{if(Array.isArray(node))return node.flatMap(elements);if(React.isValidElement(node)){const e=node as Element;return [e,...elements(e.props.children)];}return [];}
function text(node:unknown):string{if(Array.isArray(node))return node.map(text).join('');if(React.isValidElement(node))return text((node as Element).props.children);return typeof node==='string'||typeof node==='number'?String(node):'';}
const button=(tree:Element,label:string)=>elements(tree).find(e=>e.type==='button'&&text(e)===label)!;
function render(component:()=>ReactElement):Element{hooks.cursor=0;return component() as Element;}
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const reply=(status=200)=>new Response(JSON.stringify({data:{organizationId:org,schoolId:school,leadId:id,status:'WON',priorVersion:3,version:4,closedAt:'2026-10-17T01:02:03.000Z',closeNote:null,crmOnly:true},meta:{requestId:org,correlationId:org,replayed:false}}),{status,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{hooks.values=[];hooks.cursor=0;});afterEach(()=>vi.restoreAllMocks());

describe('explicit direct-human row close UI',()=>{
 it('stays inert until independent explicit list load, offers only OPEN rows, and discards everything on reload/scope edit',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[row,{...row,id:school,status:'LOST'}],meta:{}}),{status:200}));
  const view=()=>CrmLeadsWorkbench({initialScope:{organizationId:org,schoolId:school}});let tree=render(view);
  expect(f).not.toHaveBeenCalled();expect(button(tree,'Prepare CRM-only close')).toBeUndefined();
  elements(tree).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();tree=render(view);
  expect(f).toHaveBeenCalledTimes(1);expect(elements(tree).filter(e=>e.type==='button'&&text(e)==='Prepare CRM-only close')).toHaveLength(1);
  button(tree,'Prepare CRM-only close').props.onClick();tree=render(view);
  const panel=elements(tree).find(e=>e.type===CrmLeadClosePanel)!;expect(panel.props.row.id).toBe(row.id);expect(panel.props.row.version).toBe(3);expect(f).toHaveBeenCalledTimes(1);
  const originalList=hooks.values[3];panel.props.onStarted();tree=render(view);expect(hooks.values[3]).toBe(originalList);expect(text(tree)).toContain('Status: OPEN');expect(text(tree)).toContain('2 verified CRM leads');expect(text(tree)).toContain('Loaded list snapshot only');expect(button(tree,'Prepare CRM-only close').props.disabled).toBe(true);
  elements(tree).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();tree=render(view);expect(elements(tree).some(e=>e.type===CrmLeadClosePanel)).toBe(false);expect(f).toHaveBeenCalledTimes(2);
  elements(tree).find(e=>e.type==='input')!.props.onChange({target:{value:school}});tree=render(view);expect(text(tree)).toContain('No verified school list is loaded.');expect(button(tree,'Prepare CRM-only close')).toBeUndefined();
 });
 it('requires explicit choice and confirmation; clears confirmation on edit; only uncertain requests expose exact retained retry',async()=>{
  const started=vi.fn(),onBusy=vi.fn(),props={row,organizationId:org,schoolId:school,onStarted:started,onBusy,onCancel:vi.fn()};
  const f=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('uncertain')).mockResolvedValueOnce(reply());
  const view=()=>CrmLeadClosePanel(props);let tree=render(view);expect(f).not.toHaveBeenCalled();expect(button(tree,'Confirm CRM-only close').props.disabled).toBe(true);
  const submit=()=>elements(tree).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});
  submit();await settle();expect(f).not.toHaveBeenCalled();
  elements(tree).find(e=>e.type==='select')!.props.onChange({target:{value:'WON'}});tree=render(view);submit();await settle();expect(f).not.toHaveBeenCalled();
  elements(tree).find(e=>e.type==='input'&&e.props.type==='checkbox')!.props.onChange({target:{checked:true}});tree=render(view);
  elements(tree).find(e=>e.type==='textarea')!.props.onChange({target:{value:'Draft edit'}});tree=render(view);expect(button(tree,'Confirm CRM-only close').props.disabled).toBe(true);
  elements(tree).find(e=>e.type==='textarea')!.props.onChange({target:{value:''}});tree=render(view);elements(tree).find(e=>e.type==='input')!.props.onChange({target:{checked:true}});tree=render(view);
  submit();await settle();tree=render(view);expect(f).toHaveBeenCalledTimes(1);expect(elements(tree).find(e=>e.type==='fieldset')!.props.disabled).toBe(true);expect(button(tree,'Retry exact retained close request')).toBeDefined();
  button(tree,'Retry exact retained close request').props.onClick();await settle();tree=render(view);expect(f.mock.calls[0]).toEqual(f.mock.calls[1]);expect(text(tree)).toContain('Returned CRM-only close receipt');expect(text(tree)).toContain('Explicitly use Load CRM leads');expect(button(tree,'Retry exact retained close request')).toBeUndefined();expect(started).toHaveBeenCalledTimes(2);
  submit();await settle();expect(f).toHaveBeenCalledTimes(2);
 });
 it('never offers retry after definite rejection and cannot issue a second close until explicit list reload',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(reply(409)),view=()=>CrmLeadClosePanel({row,organizationId:org,schoolId:school,onStarted(){},onBusy(){},onCancel(){}});let tree=render(view);
  elements(tree).find(e=>e.type==='select')!.props.onChange({target:{value:'WON'}});tree=render(view);elements(tree).find(e=>e.type==='input')!.props.onChange({target:{checked:true}});tree=render(view);elements(tree).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();tree=render(view);
  expect(f).toHaveBeenCalledTimes(1);expect(button(tree,'Retry exact retained close request')).toBeUndefined();expect(elements(tree).find(e=>e.type==='fieldset')!.props.disabled).toBe(true);
 });
 it('has no persistence, inferred list rewrite, automatic work or cross-domain command capability',()=>{
  const panel=readFileSync('src/components/crm-lead-close-panel.tsx','utf8'),http=readFileSync('src/components/crm-lead-close-http.ts','utf8'),list=readFileSync('src/components/crm-leads-workbench.tsx','utf8');
  expect(panel+http).not.toMatch(/localStorage|sessionStorage|useEffect|setInterval|sendMessage|executeAction|invokeLLM|\/trials|\/appointments|\/enroll|\/billing|\/automation/);
  expect(panel).not.toMatch(/setLeads|loadCrmLeads/);expect(list).toContain("lead.status === 'OPEN'");expect(list).toContain('onStarted={() => setNeedsReload(true)}');expect(list).toContain('Explicitly reload');
 });
});
