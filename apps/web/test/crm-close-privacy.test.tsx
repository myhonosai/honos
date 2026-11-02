import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CrmLeadsWorkbench } from '../src/components/crm-leads-workbench';
import { CrmLeadClosePanel } from '../src/components/crm-lead-close-panel';
import { CrmEnrollmentDiscard } from '../src/components/crm-enrollment-discard';
import { CrmLeadCreatePanel } from '../src/components/crm-lead-create-panel';
import { loadMyLanguage, updateMyLanguage } from '../src/components/localization/http';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
vi.mock('../src/components/localization/provider',()=>({useLocale:()=>({date:(v:string)=>v})}));
type Frame={values:unknown[];cursor:number;effects:(()=>void)[]};
const hooks=vi.hoisted(()=>({frame:null as Frame|null}));
vi.mock('react',async()=>{const r=await vi.importActual<typeof import('react')>('react');return {...r,
 useState:(initial:unknown)=>{const f=hooks.frame!,i=f.cursor++;if(!(i in f.values))f.values[i]=initial;return [f.values[i],(v:unknown)=>{f.values[i]=typeof v==='function'?(v as (old:unknown)=>unknown)(f.values[i]):v;}];},
 useRef:(initial:unknown)=>{const f=hooks.frame!,i=f.cursor++;if(!(i in f.values))f.values[i]={current:initial};return f.values[i];},
 useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const f=hooks.frame!,i=f.cursor++,old=f.values[i] as {deps:unknown[];cleanup?:(()=>void)|undefined}|undefined;if(!old||deps.some((v,j)=>v!==old.deps[j])){old?.cleanup?.();const state:{deps:unknown[];cleanup?:(()=>void)|undefined}={deps};f.values[i]=state;f.effects.push(()=>{state.cleanup=effect()||undefined;});}},
};});
type Element=ReactElement<Record<string,any>>;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),schoolId:id(2)},row={id:id(3),primaryPersonId:id(4),pipelineStageId:id(8),status:'OPEN' as const,version:1,givenName:'Private',familyName:'Lead',createdAt:'2026-10-20T09:00:00.000Z'};
const response=(data:unknown,status=200)=>new Response(JSON.stringify({data,meta:{requestId:id(8),correlationId:id(8),replayed:false}}),{status,headers:{'Content-Type':'application/json'}});
const identity=(subject='close-staff')=>new Response(JSON.stringify({data:{externalSubject:subject}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const receipt=(status:'WON'|'LOST')=>({organizationId:id(1),schoolId:id(2),leadId:id(3),status,priorVersion:1,version:2,closedAt:'2026-10-20T09:00:01.000Z',closeNote:'Private close note',crmOnly:true});
function elements(n:unknown):Element[]{if(Array.isArray(n))return n.flatMap(elements);return React.isValidElement(n)?[n as Element,...elements((n as Element).props.children)]:[];}
function text(n:unknown):string{if(Array.isArray(n))return n.map(text).join('');return React.isValidElement(n)?text((n as Element).props.children):typeof n==='string'?n:'';}
const frame=():Frame=>({values:[],cursor:0,effects:[]});
let parent:Frame,child:Frame,childKey:React.Key|null,subject:string;
function run(f:Frame,view:()=>ReactElement):Element{hooks.frame=f;f.cursor=0;const t=view() as Element;f.effects.splice(0).forEach(e=>e());return t;}
const workbench=()=>run(parent,()=>CrmLeadsWorkbench({initialScope:scope,sessionSubject:subject}));
const panelElement=()=>elements(workbench()).find(e=>e.type===CrmLeadClosePanel)!;
function panel():Element{const p=panelElement();if(childKey!==p.key){childKey=p.key;child=frame();}return run(child,()=>CrmLeadClosePanel(p.props as Parameters<typeof CrmLeadClosePanel>[0]));}
const button=(tree:Element,label:string)=>elements(tree).find(e=>e.type==='button'&&text(e)===label)!;
const click=(label:string)=>button(workbench(),label).props.onClick();
const hidden=()=>elements(workbench()).some(e=>e.props.hidden===true&&e.props.inert===true);
const settle=async()=>{for(let i=0;i<100;i++)await Promise.resolve();};
function cleanup(f:Frame){for(const v of f.values)if(v&&typeof v==='object'&&'cleanup' in v)(v as {cleanup?:(()=>void)|undefined}).cleanup?.();}
beforeEach(()=>{parent=frame();child=frame();childKey=null;subject='close-staff';vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',new EventTarget());});
afterEach(()=>{cleanup(parent);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function open(){const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response([row]));workbench();elements(workbench()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();click('Prepare CRM-only close');panel();return f;}
function command(status:'WON'|'LOST'){elements(panel()).find(e=>e.type==='select')!.props.onChange({target:{value:status}});elements(panel()).find(e=>e.type==='textarea')!.props.onChange({target:{value:'Private close note'}});elements(panel()).find(e=>e.type==='input')!.props.onChange({target:{checked:true}});const submit=elements(panel()).find(e=>e.type==='form')!.props.onSubmit;submit({preventDefault(){}});submit({preventDefault(){}});}
function authorize(f:Awaited<ReturnType<typeof open>>,status:'OPEN'|'WON'|'LOST'='WON'){f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(response([{...row,status,version:status==='OPEN'?1:2}])).mockResolvedValueOnce(identity());}
// Use the actual parent and child handlers with separate persistent hook frames.
it.each(['WON','LOST'] as const)('%s settles behind the shield and restores the same panel without reload or another command',async status=>{
 const f=await open();let finish!:(r:Response)=>void;f.mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));const reload=elements(workbench()).find(e=>e.type==='form')!.props.onSubmit;command(status);reload({preventDefault(){}});expect(f).toHaveBeenCalledTimes(2);
 const key=panelElement().key;window.dispatchEvent(new Event('blur'));expect(hidden()).toBe(true);expect(button(workbench(),'Verify access and resume').props.disabled).toBe(true);const discard=elements(workbench()).find(e=>e.type===CrmEnrollmentDiscard)!;discard.props.onDiscard();expect(panelElement()).toBeDefined();expect(discard.props.disabled).toBe(true);
 finish(response(receipt(status)));await settle();expect(hidden()).toBe(true);expect(button(workbench(),'Verify access and resume').props.disabled).toBe(false);expect(elements(workbench()).find(e=>e.type===CrmEnrollmentDiscard)!.props.disabled).toBe(false);
 authorize(f,status);click('Verify access and resume');await settle();expect(hidden()).toBe(false);expect(panelElement().key).toBe(key);expect(text(panel())).toContain('Returned CRM-only close receipt');expect(panelElement().props.currentRow.status).toBe(status);expect(f.mock.calls[3]![0]).not.toContain('status=');expect(f).toHaveBeenCalledTimes(5);
});
it.each(['network','timeout','503','rejected'] as const)('%s completion clears busy and retains only genuinely uncertain exact retries across repeated focus loss',async outcome=>{
 const f=await open();let finish!:(r:Response)=>void,reject!:(e:Error)=>void;f.mockImplementationOnce(()=>new Promise((yes,no)=>{finish=yes;reject=no;}));command('LOST');window.dispatchEvent(new Event('blur'));
 if(outcome==='network'||outcome==='timeout')reject(outcome==='timeout'?new DOMException('Timed out','TimeoutError'):new Error('Lost response'));else finish(response({},outcome==='503'?503:409));await settle();
 expect(button(workbench(),'Verify access and resume').props.disabled).toBe(false);window.dispatchEvent(new Event('blur'));expect(panelElement()).toBeDefined();authorize(f,outcome==='rejected'?'OPEN':'LOST');click('Verify access and resume');await settle();expect(hidden()).toBe(false);
 const retry=button(panel(),'Retry exact retained close request');if(outcome==='rejected'){expect(retry).toBeUndefined();return;}expect(retry).toBeDefined();expect(f).toHaveBeenCalledTimes(5);
 f.mockResolvedValueOnce(response(receipt('LOST')));retry.props.onClick();retry.props.onClick();await settle();expect(f).toHaveBeenCalledTimes(6);expect(f.mock.calls[1]).toEqual(f.mock.calls[5]);expect(text(panel())).toContain('Returned CRM-only close receipt');
});
it('never accepts late lifecycle callbacks from discarded, other-lead, other-school or session-unmounted panels',async()=>{
 const f=await open(),old=panelElement();old.props.onBusy(true);window.dispatchEvent(new Event('blur'));old.props.onBusy(false);elements(workbench()).find(e=>e.type===CrmEnrollmentDiscard)!.props.onDiscard();
 const input=elements(workbench()).find(e=>e.type==='input'&&e.props.value===scope.schoolId)!;input.props.onChange({target:{value:id(22)}});
 f.mockResolvedValueOnce(response([{...row,id:id(33)}]));elements(workbench()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();click('Prepare CRM-only close');const current=panelElement();current.props.onBusy(true);old.props.onBusy(false);old.props.onCancel();old.props.onStarted();window.dispatchEvent(new Event('blur'));expect(button(workbench(),'Verify access and resume').props.disabled).toBe(true);expect(panelElement().props.row.id).toBe(id(33));current.props.onBusy(false);expect(button(workbench(),'Verify access and resume').props.disabled).toBe(false);
 cleanup(parent);parent=frame();subject='other-session';workbench();old.props.onBusy(true);current.props.onBusy(true);window.dispatchEvent(new Event('blur'));expect(hidden()).toBe(false);
});
it('requires deliberate abandonment after settlement; never loses a close retry through stale Discard during replay',async()=>{
 const f=await open();f.mockRejectedValueOnce(new Error('unknown'));command('WON');await settle();const discard=elements(panel()).find(e=>e.type===CrmEnrollmentDiscard)!;
 let finish!:(r:Response)=>void;f.mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));button(panel(),'Retry exact retained close request').props.onClick();discard.props.onDiscard();expect(panelElement()).toBeDefined();window.dispatchEvent(new Event('blur'));expect(elements(workbench()).find(e=>e.type===CrmEnrollmentDiscard)!.props.disabled).toBe(true);finish(response({},503));await settle();
 elements(workbench()).find(e=>e.type===CrmEnrollmentDiscard)!.props.onDiscard();expect(hidden()).toBe(false);expect(panelElement()).toBeUndefined();expect(f).toHaveBeenCalledTimes(3);
});
it('invalidates a late restoration on repeated blur without unmounting the exact retry',async()=>{
 const f=await open();f.mockRejectedValueOnce(new Error('unknown'));command('WON');await settle();window.dispatchEvent(new Event('blur'));let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(yes=>{finish=yes;})).mockResolvedValueOnce(identity());click('Verify access and resume');await settle();window.dispatchEvent(new Event('blur'));finish(response([{...row,status:'WON',version:2}]));await settle();expect(hidden()).toBe(true);expect(button(panel(),'Retry exact retained close request')).toBeDefined();authorize(f);click('Verify access and resume');await settle();expect(hidden()).toBe(false);
});
it.each(['expired','revoked','changed-user','missing','unavailable'] as const)('fails closed during %s restoration without replaying a command',async reason=>{
 const f=await open();f.mockRejectedValueOnce(new Error('unknown'));command('WON');await settle();window.dispatchEvent(new Event('blur'));
 if(reason==='expired')f.mockResolvedValueOnce(response({},401));else if(reason==='changed-user')f.mockResolvedValueOnce(identity('another-user'));else f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(response(reason==='missing'?[]:{},reason==='revoked'?403:reason==='unavailable'?503:200));
 click('Verify access and resume');await settle();expect(f.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(1);
 // A confirmed global session loss retains the private command capsule; a
 // local revocation or changed identity still follows its access-loss path.
 if(['expired','missing','unavailable'].includes(reason)){expect(hidden()).toBe(true);expect(panelElement()).toBeDefined();}else{expect(panelElement()).toBeUndefined();expect(text(workbench())).not.toContain('Private Lead');}
});
it('blocks new close commands after a changed version while retaining only exact existing requests',async()=>{
 const f=await open();window.dispatchEvent(new Event('blur'));f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(response([{...row,status:'LOST',version:2}])).mockResolvedValueOnce(identity());click('Verify access and resume');await settle();command('WON');expect(f).toHaveBeenCalledTimes(4);expect(text(panel())).toContain('This lead changed');
});

it('ignores a completed callback from an earlier instance of the same lead',async()=>{
 await open();const old=panelElement();old.props.onCancel();click('Prepare CRM-only close');const current=panelElement();expect(current.key).not.toBe(old.key);current.props.onBusy(true);old.props.onBusy(false);window.dispatchEvent(new Event('blur'));expect(button(workbench(),'Verify access and resume').props.disabled).toBe(true);current.props.onBusy(false);expect(button(workbench(),'Verify access and resume').props.disabled).toBe(false);
});

// Exercise the actual authenticated transport, not a mocked invalidation callback.
const languageRequest = (operation: 'read' | 'save') => operation === 'read'
 ? loadMyLanguage() : updateMyLanguage({language:'ko',expectedVersion:1},id(70));
it.each(['read','save'] as const)('language %s 401 immediately conceals loaded CRM facts until explicit authorized restoration',async operation=>{
 const f=await open();const key=panelElement().key;
 f.mockResolvedValueOnce(response({},401));await expect(languageRequest(operation)).rejects.toThrow();
 expect(hidden()).toBe(true);expect(panelElement().key).toBe(key);
 const calls=f.mock.calls.length;window.dispatchEvent(new Event('focus'));await settle();expect(hidden()).toBe(true);expect(f).toHaveBeenCalledTimes(calls);
 authorize(f,'OPEN');click('Verify access and resume');await settle();expect(hidden()).toBe(false);expect(panelElement().key).toBe(key);
});
it.each(['read','save'] as const)('language %s 403 remains local and does not invalidate the staff session',async operation=>{
 const f=await open(),invalidated=vi.fn();window.addEventListener(HON_SESSION_INVALIDATED_EVENT,invalidated);
 f.mockResolvedValueOnce(response({},403));await expect(languageRequest(operation)).rejects.toThrow();
 expect(invalidated).not.toHaveBeenCalled();expect(hidden()).toBe(false);expect(text(workbench())).toContain('Private Lead');
});
it('rejects a pending lead-list success after language 401 without an automatic replacement read',async()=>{
 let finish!:(r:Response)=>void;const f=vi.spyOn(globalThis,'fetch').mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));
 workbench();elements(workbench()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});
 f.mockResolvedValueOnce(response({},401));await expect(loadMyLanguage()).rejects.toThrow();
 finish(response([row]));await settle();expect(text(workbench())).not.toContain('Private Lead');
 window.dispatchEvent(new Event('focus'));await settle();expect(f).toHaveBeenCalledTimes(2);
});
it.each(['WON','LOST'] as const)('%s close settles after session invalidation and retains its exact unknown request behind the shield',async status=>{
 const f=await open();let finish!:(r:Response)=>void;f.mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));command(status);const key=panelElement().key;
 f.mockResolvedValueOnce(response({},401));await expect(updateMyLanguage({language:'ko',expectedVersion:1},id(70))).rejects.toThrow();
 expect(hidden()).toBe(true);expect(panelElement().key).toBe(key);expect(button(workbench(),'Verify access and resume').props.disabled).toBe(true);
 const discard=elements(workbench()).find(e=>e.type===CrmEnrollmentDiscard)!;expect(discard.props.disabled).toBe(true);discard.props.onDiscard();expect(panelElement().key).toBe(key);
 finish(response({},503));await settle();expect(hidden()).toBe(true);expect(button(workbench(),'Verify access and resume').props.disabled).toBe(false);
 // A second invalidation must also preserve a settled uncertain command.
 window.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));expect(panelElement().key).toBe(key);
 authorize(f,status);click('Verify access and resume');await settle();expect(hidden()).toBe(false);expect(f.mock.calls.filter(([,o])=>o?.method==='POST'&&String(o.body).includes('Private close note'))).toHaveLength(1);
 f.mockResolvedValueOnce(response(receipt(status)));const retry=button(panel(),'Retry exact retained close request');retry.props.onClick();retry.props.onClick();await settle();
 expect(f.mock.calls.at(-1)).toEqual(f.mock.calls[1]);expect(text(panel())).toContain('Returned CRM-only close receipt');
});
it('removes the session listener on unmount and rejects old read callbacks',async()=>{
 let finish!:(r:Response)=>void;vi.spyOn(globalThis,'fetch').mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));
 workbench();elements(workbench()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});cleanup(parent);
 const prior=parent;parent=frame();subject='another-user';workbench();window.dispatchEvent(new Event(HON_SESSION_INVALIDATED_EVENT));
 finish(response([row]));await settle();expect(text(workbench())).not.toContain('Private Lead');expect(hidden()).toBe(false);cleanup(prior);
});
it('preserves an already-uncertain lead-create capsule through invalidation, repeated blur and explicit reauthorization',async()=>{
 const f=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('unknown'));
 const creation=frame();const element=()=>elements(workbench()).find(e=>e.type===CrmLeadCreatePanel)!;
 const view=()=>run(creation,()=>CrmLeadCreatePanel(element().props as Parameters<typeof CrmLeadCreatePanel>[0]));
 for(const [label,value] of [['Known pipeline UUID',id(8)],['Known non-terminal stage UUID',id(9)],['Primary contact given name','Private'],['Primary contact family name','Contact']]){
  const field=elements(view()).find(e=>e.type==='label'&&text(e)===label)!;
  elements(field).find(e=>e.type==='input')!.props.onChange({target:{value}});
 }
 elements(view()).find(e=>e.type==='input'&&e.props.type==='checkbox')!.props.onChange({target:{checked:true}});
 const key=element().key;elements(view()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();
 expect(button(view(),'Retry exact retained lead-create request')).toBeDefined();expect(f).toHaveBeenCalledTimes(1);
 f.mockResolvedValueOnce(response({},401));await expect(loadMyLanguage()).rejects.toThrow();window.dispatchEvent(new Event('blur'));
 expect(hidden()).toBe(true);expect(element().key).toBe(key);
 authorize(f,'OPEN');click('Verify access and resume');await settle();expect(hidden()).toBe(false);expect(element().key).toBe(key);expect(f).toHaveBeenCalledTimes(5);
 f.mockRejectedValueOnce(new Error('still unknown'));button(view(),'Retry exact retained lead-create request').props.onClick();await settle();expect(f.mock.calls[5]).toEqual(f.mock.calls[0]);cleanup(creation);
});
