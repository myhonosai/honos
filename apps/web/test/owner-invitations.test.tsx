import React,{type ReactElement} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {SchoolOwnerInvitations} from '../src/components/owner-invitations/workbench';
import {accountRequest} from '../src/components/owner-invitations/http';
const hooks=vi.hoisted(()=>({values:[] as any[],cursor:0,effects:[] as (()=>void)[]}));
vi.mock('react',async()=>{const a=await vi.importActual<typeof import('react')>('react');return {...a,useState:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=initial;return [hooks.values[i],(v:unknown)=>hooks.values[i]=v];},useRef:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]={current:initial};return hooks.values[i];},useEffect:(effect:()=>void|(()=>void))=>{const i=hooks.cursor++;if(!(i in hooks.values)){hooks.values[i]={};hooks.effects.push(()=>{hooks.values[i].cleanup=effect();});}}};});
type El=ReactElement<Record<string,any>>;
function nodes(v:unknown):El[]{return Array.isArray(v)?v.flatMap(nodes):React.isValidElement(v)?[v as El,...nodes((v as El).props.children)]:[];}
function text(v:unknown):string{return Array.isArray(v)?v.map(text).join(''):React.isValidElement(v)?text((v as El).props.children):typeof v==='string'?v:'';}
function render(){hooks.cursor=0;const t=SchoolOwnerInvitations({}) as El;hooks.effects.splice(0).forEach(f=>f());return t;}
const button=(label:string)=>nodes(render()).find(e=>e.type==='button'&&text(e)===label)!;
const click=(label:string)=>button(label).props.onClick();
const settle=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const response=(data:unknown,status=200)=>new Response(JSON.stringify({data}),{status,headers:{'Content-Type':'application/json'}});
const id='00000000-0000-4000-8000-000000000001';
function fill(){for(const e of nodes(render()).filter(e=>e.type==='input')){if(e.props.type==='checkbox')e.props.onChange({target:{checked:true}});else e.props.onChange({target:{value:e.props.type==='password'?'A'.repeat(43):id}});}}
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.effects=[];vi.stubGlobal('window',Object.assign(new EventTarget(),{confirm:()=>true}));vi.stubGlobal('document',new EventTarget());});
afterEach(()=>{for(const v of hooks.values)v?.cleanup?.();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('no automatic reads/commands; empty blur causes no unnecessary shield',()=>{const f=vi.spyOn(globalThis,'fetch');render();window.dispatchEvent(new Event('blur'));expect(text(render())).not.toContain('is concealed');expect(f).not.toHaveBeenCalled();});
it.each(['blur','pagehide','hon:session-invalidated','hon:school-context-changed'])('conceals immediately on %s and ignores late reads',async signal=>{
 let yes!:(r:Response)=>void;const f=vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(r=>yes=r));click('Verify access');window.dispatchEvent(new Event(signal));yes(response({externalSubject:'canary'}));await settle();expect(text(render())).toContain('is concealed');expect(nodes(render()).some(e=>e.type==='input')).toBe(false);expect(f).toHaveBeenCalledTimes(1);
});
it('command settles behind shield; restoration requires explicit fresh auth; exact retry key/body survive; duplicate click blocked',async()=>{
 let finish!:(r:Response)=>void;const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({externalSubject:'oidc:fixture:owner'}));click('Verify access');await settle();fill();
 f.mockImplementationOnce(()=>new Promise(r=>finish=r));click('Accept invitation');click('Accept invitation');expect(f).toHaveBeenCalledTimes(2);
 window.dispatchEvent(new Event('blur'));expect(button('Verify access').props.disabled).toBe(true);
 finish(response({invitationId:id,organizationId:id,schoolId:id,accountStatus:'OWNER_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false}));await settle();expect(button('Verify access').props.disabled).toBe(false);expect(text(render())).not.toContain('account bound');
 f.mockResolvedValueOnce(response({externalSubject:'oidc:fixture:owner'}));click('Verify access');await settle();expect(f).toHaveBeenCalledTimes(3);expect(text(render())).toContain('exact request remains');
 f.mockResolvedValueOnce(response({invitationId:id,organizationId:id,schoolId:id,accountStatus:'OWNER_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false}));click('Retry exact request');await settle();expect(f.mock.calls[1]![1]!.body).toBe(f.mock.calls[3]![1]!.body);expect(f.mock.calls[1]![1]!.headers).toEqual(f.mock.calls[3]![1]!.headers);expect(text(render())).toContain('account bound');
});
it('401 broadcasts shared invalidation; 403 remains local and neither automatically retries',async()=>{let invalidations=0;window.addEventListener('hon:session-invalidated',()=>invalidations++);for(const status of [403,401]){const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response({},status));await expect(accountRequest('hq/session',new AbortController().signal)).rejects.toMatchObject({status});expect(f).toHaveBeenCalledTimes(1);f.mockRestore();expect(invalidations).toBe(status===401?1:0);}});
it('different signed identity cannot recover or reveal the original capsule',async()=>{
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response({externalSubject:'first'}));click('Verify access');await settle();fill();window.dispatchEvent(new Event('blur'));f.mockResolvedValueOnce(response({externalSubject:'second'}));click('Verify access');await settle();expect(text(render())).toContain('ACCOUNT_CHANGED_RESTART_REQUIRED');expect(nodes(render()).some(e=>e.type==='input')).toBe(false);
});
