import React,{type ReactElement} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CrmFollowUpsWorkbench} from '../src/components/crm-follow-ups-workbench';
import {readSessionSchoolClock,SESSION_SCHOOL_CLOCK_PATH} from '../src/components/school-time';

// B-CRM-3 follow-up: the standalone follow-ups page takes and shows due times in the server-named school time.
const h=vi.hoisted(()=>({values:[] as any[],cursor:0}));
vi.mock('react',async()=>{const r=await vi.importActual<typeof import('react')>('react');return {...r,
 useState:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.values))h.values[i]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [h.values[i],(v:any)=>{h.values[i]=typeof v==='function'?v(h.values[i]):v;}];},
 useRef:(initial:unknown)=>{const i=h.cursor++;if(!(i in h.values))h.values[i]={current:initial};return h.values[i];},
};});
type El=ReactElement<Record<string,any>>;
const nodes=(v:unknown):El[]=>Array.isArray(v)?v.flatMap(nodes):React.isValidElement(v)?[v as El,...nodes((v as El).props.children)]:[];
const text=(v:unknown):string=>Array.isArray(v)?v.map(text).join(''):React.isValidElement(v)?text((v as El).props.children):typeof v==='string'||typeof v==='number'?String(v):'';
const school='22222222-2222-4222-8222-222222222222',principal='33333333-3333-4333-8333-333333333333',lead='44444444-4444-4444-8444-444444444444',id='11111111-1111-4111-8111-111111111111';
const queue={schoolId:school,principalId:principal,canManage:false,humanOnly:true,queue:'mine',status:'OPEN',items:[{followUpId:id,leadId:lead,assigneeId:principal,dueAt:'2026-07-01T17:00:00.000Z',priority:'NORMAL',version:1,status:'OPEN'}],nextAfter:null};
const LA={state:'READY' as const,clock:{schoolId:school,schoolTimezone:'America/Los_Angeles',localToday:'2026-06-30',asOf:'2026-06-30T17:00:00.000Z'}};
const response=(data:unknown)=>({ok:true,status:200,json:async()=>({data})}) as Response;
const clock={reader:async(..._a:unknown[])=>({state:'UNAVAILABLE'} as any),reads:[] as unknown[]};
const render=()=>{h.cursor=0;return CrmFollowUpsWorkbench({clockReader:(s,signal)=>{clock.reads.push(s);return clock.reader(s,signal);}});};
const settle=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
const basis=()=>nodes(render()).find(e=>e.props['data-testid']==='due-time-basis')!;
const dueInput=()=>nodes(basis().props.children).find(e=>e.type==='input')!;
const form=()=>nodes(render()).filter(e=>e.type==='form').at(-1)!; // the create/revise form (the first form opens a known record)
const field=(label:string)=>nodes(render()).filter(e=>e.type==='label').find(e=>text(e).startsWith(label))!;
const set=(label:string,value:string)=>nodes(field(label).props.children).find(e=>e.type==='input'||e.type==='textarea')!.props.onChange({target:{value}});
async function loaded(){
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response(queue));
 nodes(render()).find(e=>e.type==='button'&&text(e)==='Load / refresh queue')!.props.onClick();await settle();return f;
}
beforeEach(()=>{h.values=[];h.cursor=0;clock.reader=async()=>({state:'UNAVAILABLE'});clock.reads=[];});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('reads the clock for the verified queue school and takes due times in school time',async()=>{
 clock.reader=async()=>LA;const f=await loaded();
 expect(clock.reads).toEqual([school]);
 expect(text(basis())).toContain('America/Los_Angeles');expect(text(render())).toContain('Due dates use school time (America/Los_Angeles)');
 expect(text(render())).toMatch(/due Jul 1, 2026,? 10:00\s?AM PDT/);
 set('Known lead ID',lead);set('Subject','Call back');dueInput().props.onChange({target:{value:'2026-12-01T10:00'}});
 f.mockResolvedValueOnce(response({followUpId:id,schoolId:school,leadId:lead,assigneeId:principal,subject:'Call back',note:'',dueAt:'2026-12-01T18:00:00.000Z',priority:'NORMAL',version:1,status:'OPEN',recordedAt:'2026-06-30T17:00:00.000Z',completedAt:null,cancelledAt:null,humanOnly:true}));
 await form().props.onSubmit({preventDefault(){}});await settle();
 const sent=JSON.parse(String((f.mock.calls[1]![1] as RequestInit).body));expect(sent.dueAt).toBe('2026-12-01T18:00:00.000Z');
});

it('refuses a school time skipped by daylight saving before any command',async()=>{
 clock.reader=async()=>LA;const f=await loaded();
 set('Known lead ID',lead);set('Subject','Call back');dueInput().props.onChange({target:{value:'2027-03-14T02:30'}});
 await form().props.onSubmit({preventDefault(){}});await settle();
 expect(f).toHaveBeenCalledTimes(1);expect(text(render())).toContain('skipped by a daylight-saving change');
});

it('keeps explicit UTC entry when the clock is unavailable',async()=>{
 const f=await loaded();expect(clock.reads).toEqual([school]);
 expect(text(basis())).toContain('Due at UTC');expect(text(render())).toContain('Due dates use UTC');expect(text(render())).toContain('due 2026-07-01T17:00:00.000Z');
 set('Known lead ID',lead);set('Subject','Call back');dueInput().props.onChange({target:{value:'2026-12-01T10:00'}});
 f.mockResolvedValueOnce(response({followUpId:id,schoolId:school,leadId:lead,assigneeId:principal,subject:'Call back',note:'',dueAt:'2026-12-01T10:00:00.000Z',priority:'NORMAL',version:1,status:'OPEN',recordedAt:'2026-06-30T17:00:00.000Z',completedAt:null,cancelledAt:null,humanOnly:true}));
 await form().props.onSubmit({preventDefault(){}});await settle();
 expect(JSON.parse(String((f.mock.calls[1]![1] as RequestInit).body)).dueAt).toBe('2026-12-01T10:00:00.000Z');
});

it('reads the session-scoped clock through the /api proxy and verifies the shown school',async()=>{
 const f=vi.fn(async()=>new Response(JSON.stringify({data:LA.clock,meta:{}}),{status:200}));vi.stubGlobal('fetch',f);
 expect(await readSessionSchoolClock(school,new AbortController().signal)).toEqual(LA);
 expect((f.mock.calls[0] as unknown[])[0]).toBe('/api/v1/staff/crm/school-clock');expect(SESSION_SCHOOL_CLOCK_PATH).toBe('/api/v1/staff/crm/school-clock');
 expect(await readSessionSchoolClock(principal,new AbortController().signal)).toEqual({state:'UNAVAILABLE'});
 expect(await readSessionSchoolClock('not-a-uuid',new AbortController().signal)).toEqual({state:'UNAVAILABLE'});
});
