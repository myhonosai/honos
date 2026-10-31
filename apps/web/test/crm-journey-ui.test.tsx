import React,{type ReactElement} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CrmJourney} from '../src/components/crm-journey/workbench';
import {journeyCatalog,journeyText} from '../src/components/crm-journey/catalog';
import {scope,row,identity,envelope,closeReceipt} from './crm-journey-fixtures';
const h=vi.hoisted(()=>({values:[] as any[],cursor:0,effects:[] as (()=>void)[],language:'en'}));
vi.mock('react',async()=>{const r=await vi.importActual<typeof import('react')>('react');return {...r,
 useState:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.values))h.values[i]=initial;return [h.values[i],(v:any)=>{h.values[i]=typeof v==='function'?v(h.values[i]):v;}];},
 useRef:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.values))h.values[i]={current:initial};return h.values[i];},
 useEffect:(effect:()=>unknown)=>{const i=h.cursor++;if(!(i in h.values)){h.values[i]={};h.effects.push(()=>{h.values[i].cleanup=effect();});}},
};});
vi.mock('../src/components/localization/provider',()=>({useLocale:()=>({preferences:{language:h.language},date:(v:string)=>v,number:(v:number)=>String(v)})}));
type El=ReactElement<Record<string,any>>;
const nodes=(v:unknown):El[]=>Array.isArray(v)?v.flatMap(nodes):React.isValidElement(v)?[v as El,...nodes((v as El).props.children)]:[];
const text=(v:unknown):string=>Array.isArray(v)?v.map(text).join(''):React.isValidElement(v)?text((v as El).props.children):typeof v==='string'?v:'';
const render=()=>{h.cursor=0;const tree=CrmJourney({sessionSubject:'staff:synthetic',initialScope:scope,initialLeadId:row.id});h.effects.splice(0).forEach(f=>f());return tree;};
const el=(test:string)=>nodes(render()).find(e=>e.props['data-testid']===test)!;
const click=(test:string)=>el(test).props.onClick();
const change=(test:string,value:string)=>el(test).props.onChange({target:{value}});
const settle=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
const hidden=()=>nodes(render()).some(e=>e.props.hidden===true&&e.props.inert===true);
function cleanup(){for(const v of h.values)v?.cleanup?.();}
beforeEach(()=>{h.values=[];h.cursor=0;h.effects=[];h.language='en';vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function loaded(){const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope([row])).mockResolvedValueOnce(identity());click('load');await settle();expect(text(render())).toContain('Private');return f;}
function prepareClose(){click('step-close');el('confirm').props.onChange({target:{checked:true}});return nodes(render()).find(e=>e.type==='form')!.props.onSubmit;}
function authorize(f:Awaited<ReturnType<typeof loaded>>,status='OPEN'){f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope([{...row,status,version:status==='OPEN'?1:2}])).mockResolvedValueOnce(identity());}
it('starts idle; modes, language, tabs and empty focus loss do not fetch',()=>{const f=vi.spyOn(globalThis,'fetch');render();change('mode','classic');change('mode','big');click('step-history');h.language='ko';render();window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));expect(f).not.toHaveBeenCalled();expect(hidden()).toBe(false);});
it.each(['WON','LOST'])('%s settles behind the shield without a reload or duplicate command',async decision=>{
 const f=await loaded();prepareClose();change('decision',decision);el('confirm').props.onChange({target:{checked:true}});const submit=nodes(render()).find(e=>e.type==='form')!.props.onSubmit;
 let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));submit({preventDefault(){}});submit({preventDefault(){}});await settle();expect(f).toHaveBeenCalledTimes(5);
 window.dispatchEvent(new Event('blur'));expect(hidden()).toBe(true);expect(el('restore').props.disabled).toBe(true);expect(el('shield-discard').props.disabled).toBe(true);
 finish(envelope(closeReceipt(decision)));await settle();expect(el('restore').props.disabled).toBe(false);authorize(f,decision);click('restore');await settle();expect(hidden()).toBe(false);expect(text(render())).toContain(journeyCatalog.en.receiptLost);expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
});
it.each(['network','timeout','503','malformed'])('%s preserves exact request through restoration and explicit retry',async outcome=>{
 const f=await loaded();const submit=prepareClose();f.mockResolvedValueOnce(identity());if(outcome==='503')f.mockResolvedValueOnce(envelope({},503));else if(outcome==='malformed')f.mockResolvedValueOnce(new Response('bad',{headers:{'content-type':'application/json'}}));else f.mockRejectedValueOnce(new DOMException(outcome,'TimeoutError'));
 submit({preventDefault(){}});await settle();expect(el('retry')).toBeDefined();const original=f.mock.calls[4]!;window.dispatchEvent(new Event('blur'));authorize(f);click('restore');await settle();expect(hidden()).toBe(false);const n=f.mock.calls.length;
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(closeReceipt()));const retry=el('retry').props.onClick;retry();retry();await settle();expect(f.mock.calls.length).toBe(n+2);expect(f.mock.calls[n+1]![0]).toBe(original[0]);expect(f.mock.calls[n+1]![1]?.body).toBe(original[1]?.body);expect(f.mock.calls[n+1]![1]?.headers).toEqual(original[1]?.headers);
});
it('a rejected first request has no success receipt; a rejected retry preserves prior uncertainty',async()=>{
 const f=await loaded();const submit=prepareClose();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},409));submit({preventDefault(){}});await settle();expect(el('receipt')).toBeUndefined();expect(el('retry')).toBeUndefined();expect(text(render())).toContain(journeyCatalog.en.rejected);
 authorize(f);click('refresh');await settle();const again=prepareClose();f.mockResolvedValueOnce(identity()).mockRejectedValueOnce(new Error('lost'));again({preventDefault(){}});await settle();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},409));click('retry');await settle();expect(el('retry')).toBeDefined();expect(text(render())).toContain(journeyCatalog.en.retryRejected);
});
it('focus loss during identity preflight prevents starting the command',async()=>{const f=await loaded();let finish!:(r:Response)=>void;f.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));prepareClose()({preventDefault(){}});window.dispatchEvent(new Event('blur'));finish(identity());await settle();expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(0);expect(el('restore').props.disabled).toBe(false);});
it.each(['pagehide','visibilitychange','hon:school-context-changed'])('%s invalidates late reads',async event=>{
 const f=await loaded();let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));click('refresh');await settle();if(event==='visibilitychange'){Object.assign(document,{visibilityState:'hidden'});document.dispatchEvent(new Event(event));}else window.dispatchEvent(new Event(event));finish(envelope([{...row,givenName:'Late'}]));await settle();expect(hidden()).toBe(true);expect(text(render())).not.toContain('Late');
});
it('session invalidation clears facts and rejects a late command result',async()=>{const f=await loaded();let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));prepareClose()({preventDefault(){}});await settle();window.dispatchEvent(new Event('hon:session-invalidated'));expect(text(render())).not.toContain('Canary');finish(envelope(closeReceipt()));await settle();expect(el('receipt')).toBeUndefined();expect(text(render())).toContain(journeyCatalog.en.reauth);});
it('permission revocation during restoration fails closed',async()=>{const f=await loaded();window.dispatchEvent(new Event('blur'));f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},403));click('restore');await settle();expect(hidden()).toBe(true);expect(text(render())).toContain(journeyCatalog.en.denied);});
it('repeated focus loss cannot reveal stale restoration or auto-read',async()=>{const f=await loaded();window.dispatchEvent(new Event('blur'));let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));click('restore');await settle();window.dispatchEvent(new Event('blur'));finish(envelope([row]));await settle();expect(hidden()).toBe(true);const n=f.mock.calls.length;window.dispatchEvent(new Event('focus'));expect(f.mock.calls.length).toBe(n);});
it('discard requires deliberate confirmation and refuses in-flight abandonment',async()=>{const f=await loaded();let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));prepareClose()({preventDefault(){}});await settle();click('discard');expect(el('abandon').props.disabled).toBe(true);el('abandon').props.onClick();finish(envelope({},503));await settle();expect(el('retry')).toBeDefined();click('discard');expect(text(render())).toContain(journeyCatalog.en.discardWarning);click('abandon');expect(el('retry')).toBeUndefined();expect(text(render())).not.toContain('Canary');});
it('unmount does not share late receipts with a new session view',async()=>{const f=await loaded();let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));prepareClose()({preventDefault(){}});await settle();cleanup();finish(envelope(closeReceipt()));await settle();h.values=[];h.cursor=0;h.effects=[];render();expect(el('receipt')).toBeUndefined();});
it('catalogs preserve exact key coverage and English fallback',()=>{const keys=Object.keys(journeyCatalog.en).sort();for(const lang of ['ko','es'] as const){expect(Object.keys(journeyCatalog[lang]).sort()).toEqual(keys);expect(Object.values(journeyCatalog[lang]).every(s=>s.trim())).toBe(true);}expect(journeyText('future','title')).toBe(journeyCatalog.en.title);});
