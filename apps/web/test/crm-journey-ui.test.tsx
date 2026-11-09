import React,{type ReactElement} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CrmJourney} from '../src/components/crm-journey/workbench';
import {journeyCatalog,journeyText} from '../src/components/crm-journey/catalog';
import {CrmJourneyLink} from '../src/components/crm-journey/entry';
import {SchoolOperationsNavigation} from '../src/components/school-operations-navigation';
import {scope,row,identity,envelope,closeReceipt,appointment,queue,id} from './crm-journey-fixtures';
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
const clock={reader:async(..._a:unknown[])=>({state:'UNAVAILABLE'} as any)};
const render=()=>{h.cursor=0;const tree=CrmJourney({sessionSubject:'staff:synthetic',initialScope:scope,initialLeadId:row.id,clockReader:(s,signal)=>clock.reader(s,signal)});h.effects.splice(0).forEach(f=>f());return tree;};
const el=(test:string)=>nodes(render()).find(e=>e.props['data-testid']===test)!;
const click=(test:string)=>el(test).props.onClick();
const change=(test:string,value:string)=>el(test).props.onChange({target:{value}});
const settle=async()=>{for(let i=0;i<120;i++)await Promise.resolve();};
const hidden=()=>nodes(render()).some(e=>e.props.hidden===true&&e.props.inert===true);
function cleanup(){for(const v of h.values)v?.cleanup?.();}
beforeEach(()=>{clock.reader=async()=>({state:'UNAVAILABLE'});h.values=[];h.cursor=0;h.effects=[];h.language='en';vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function loaded(){const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope([row])).mockResolvedValueOnce(identity());click('load');await settle();expect(text(render())).toContain('Private');return f;}
function prepareClose(){click('step-close');el('confirm').props.onChange({target:{checked:true}});return nodes(render()).find(e=>e.type==='form')!.props.onSubmit;}
function authorize(f:Awaited<ReturnType<typeof loaded>>,status='OPEN'){f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope([{...row,status,version:status==='OPEN'?1:2}])).mockResolvedValueOnce(identity());}
function operationalLink(key: string): El | undefined {
 const navigation = nodes(render()).find(node => node.type === SchoolOperationsNavigation);
 return navigation ? nodes(SchoolOperationsNavigation(navigation.props as any)).find(node => node.props['data-testid'] === `operations-${key}`) : undefined;
}
it('offers account navigation only after a verified school read and preserves exact cross-organization selectors', async () => {
 expect(operationalLink('team')).toBeUndefined(); expect(el('journey-entry-back').props.href).toBe('/staff/entry'); const f = await loaded();
 expect(el('journey-entry-back')).toBeUndefined();
 const old = operationalLink('team')!;
 expect(new URL(old.props.href, 'https://hon.invalid').searchParams.get('organizationId')).toBe(scope.organizationId);
 change('organization', id(40));
 const stale = { preventDefault: vi.fn() }; old.props.onClick(stale); expect(stale.preventDefault).toHaveBeenCalledOnce();
 expect(operationalLink('team')).toBeUndefined(); change('school', id(41)); authorize(f); click('load'); await settle();
 const url = new URL(operationalLink('family')!.props.href, 'https://hon.invalid');
 expect(url.pathname).toBe('/staff/family-access'); expect([...url.searchParams.entries()]).toEqual([['organizationId', id(40)], ['schoolId', id(41)]]);
});
it('presentation/language changes keep the same verified navigation without school reads', async () => {
 const f = await loaded(), count = f.mock.calls.length, href = operationalLink('team')!.props.href;
 for (const language of ['en','ko','es']) for (const mode of ['modern','classic','big']) {
  h.language = language; change('mode', mode); expect(operationalLink('team')!.props.href).toBe(href);
 }
 expect(f.mock.calls).toHaveLength(count);
});
it('retires native and retained account links on concealment, denies restoration after revocation, and never auto-restores', async () => {
 const f = await loaded(), old = operationalLink('family')!, native = { removeAttribute: vi.fn() };
 const area = nodes(render()).find(node => node.type === 'div' && node.props.ref && 'inert' in node.props)!;
 area.props.ref.current = { hidden: false, inert: false, querySelectorAll: () => [native] };
 window.dispatchEvent(new Event('blur'));
 expect(area.props.ref.current.hidden).toBe(true); expect(native.removeAttribute).toHaveBeenCalledWith('href');
 const event = { preventDefault: vi.fn() }; old.props.onClick(event); expect(event.preventDefault).toHaveBeenCalledOnce();
 expect(operationalLink('family')).toBeUndefined(); const count = f.mock.calls.length;
 window.dispatchEvent(new Event('focus')); expect(f.mock.calls).toHaveLength(count);
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},403)); click('restore'); await settle(); expect(operationalLink('team')).toBeUndefined();
});
it('keeps new navigation unavailable through dirty, in-flight and unknown command state until the existing deliberate abandonment', async () => {
 const f = await loaded(), old = operationalLink('team')!; click('step-close'); change('note','Draft to preserve');
 expect(operationalLink('team')!.props.href).toBeUndefined(); const stale = { preventDefault: vi.fn() }; old.props.onClick(stale); expect(stale.preventDefault).toHaveBeenCalledOnce();
 el('confirm').props.onChange({target:{checked:true}}); let finish!:(r:Response)=>void;
 f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 nodes(render()).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}}); await settle(); expect(operationalLink('team')!.props.href).toBeUndefined();
 finish(envelope({},503)); await settle(); expect(operationalLink('team')!.props.href).toBeUndefined();
 expect(nodes(render()).filter(node => node.type === 'a').every(node => !node.props.href)).toBe(true);
 click('discard'); expect(el('abandon')).toBeDefined(); click('abandon'); expect(operationalLink('team')).toBeUndefined();
 authorize(f); click('load'); await settle(); expect(operationalLink('team')!.props.href).toBeDefined();
});
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
it('keeps the first controlled edit and invalidates confirmation without capture-phase state updates',async()=>{
 const f=await loaded();click('step-follow');f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({schoolId:scope.schoolId,principalId:'00000000-0000-4000-8000-000000000006',canManage:false,humanOnly:true,queue:'mine',status:'ALL',items:[],nextAfter:null})).mockResolvedValueOnce(identity());click('verify-follow');await settle();
 change('subject','First entered subject');expect(el('subject').props.value).toBe('First entered subject');expect(el('load').props.disabled).toBe(true);
 el('confirm').props.onChange({target:{checked:true}});change('note','Changed content');expect(el('confirm').props.checked).toBe(false);
});
it('shows the exact validated trial window using the shared date formatter',async()=>{
 const f=await loaded();click('step-trial');change('start','2026-11-02T09:00');change('end','2026-11-02T10:00');el('confirm').props.onChange({target:{checked:true}});
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({id:'00000000-0000-4000-8000-000000000008',crmLeadId:row.id,appointmentType:'TRIAL',status:'SCHEDULED',startsAt:'2026-11-02T09:00:00.000Z',endsAt:'2026-11-02T10:00:00.000Z',createdByPrincipalId:'00000000-0000-4000-8000-000000000006',version:1,createdAt:'2026-10-31T05:00:00.000Z',updatedAt:'2026-10-31T05:00:00.000Z'}));
 nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();expect(text(el('trial-window'))).toContain('2026-11-02T09:00:00.000Z');expect(text(el('trial-window'))).toContain('2026-11-02T10:00:00.000Z');
});
it('B-CRM-3: with the server-named school timezone, trial times are entered and shown in school time',async()=>{
 const reads:unknown[]=[];clock.reader=async(s:unknown)=>{reads.push(s);return {state:'READY',clock:{schoolId:scope.schoolId,schoolTimezone:'America/Los_Angeles',localToday:'2026-11-01',asOf:'2026-11-01T17:00:00.000Z'}};};
 const f=await loaded();expect(reads).toHaveLength(1);click('step-trial');
 expect(text(el('time-basis'))).toContain('America/Los_Angeles');expect(text(render())).toContain(`${journeyCatalog.en.startSchool} (America/Los_Angeles)`);
 change('start','2026-11-02T09:00');change('end','2026-11-02T10:00');el('confirm').props.onChange({target:{checked:true}});
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({id:'00000000-0000-4000-8000-000000000008',crmLeadId:row.id,appointmentType:'TRIAL',status:'SCHEDULED',startsAt:'2026-11-02T17:00:00.000Z',endsAt:'2026-11-02T18:00:00.000Z',createdByPrincipalId:'00000000-0000-4000-8000-000000000006',version:1,createdAt:'2026-10-31T05:00:00.000Z',updatedAt:'2026-10-31T05:00:00.000Z'}));
 nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();
 const post=f.mock.calls.find(c=>c[1]?.method==='POST')!;expect(JSON.parse(String(post[1]!.body))).toMatchObject({startsAt:'2026-11-02T17:00:00.000Z',endsAt:'2026-11-02T18:00:00.000Z'});
 expect(text(el('trial-window'))).toMatch(/9:00.*PST/);
});
it('B-CRM-3: a school time skipped by daylight saving is refused before any command',async()=>{
 clock.reader=async()=>({state:'READY',clock:{schoolId:scope.schoolId,schoolTimezone:'America/Los_Angeles',localToday:'2026-03-01',asOf:'2026-03-01T17:00:00.000Z'}});
 const f=await loaded();click('step-trial');change('start','2027-03-14T02:30');change('end','2027-03-14T03:30');el('confirm').props.onChange({target:{checked:true}});
 const n=f.mock.calls.length;nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();
 expect(f.mock.calls.length).toBe(n);expect(text(render())).toContain(journeyCatalog.en.timeSkipped);
});
it('B-CRM-3: without a verified school clock the inputs stay explicit UTC',async()=>{
 const f=await loaded();click('step-trial');expect(text(el('time-basis'))).toBe(journeyCatalog.en.UTC);
 change('start','2026-11-02T09:00');change('end','2026-11-02T10:00');el('confirm').props.onChange({target:{checked:true}});
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();
 const post=f.mock.calls.find(c=>c[1]?.method==='POST')!;expect(JSON.parse(String(post[1]!.body))).toMatchObject({startsAt:'2026-11-02T09:00:00.000Z'});
});
it('clears concealed form details but keeps the exact private note and key for an explicit retry',async()=>{
 const f=await loaded();click('step-close');change('note','Private original note');el('confirm').props.onChange({target:{checked:true}});f.mockResolvedValueOnce(identity()).mockRejectedValueOnce(new Error('Unknown outcome'));
 nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();const original=f.mock.calls[4]!;window.dispatchEvent(new Event('blur'));authorize(f);click('restore');await settle();expect(el('note').props.value).toBe('');
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({...closeReceipt(),closeNote:'Private original note'}));click('retry');await settle();const last=f.mock.calls.at(-1)!;expect(last[1]?.body).toBe(original[1]?.body);expect(last[1]?.headers).toEqual(original[1]?.headers);expect(el('receipt')).toBeDefined();expect(el('note').props.value).toBe('');
});
it('retains an earlier unknown request across replay permission denial until explicit reauthorization',async()=>{
 const f=await loaded();const submit=prepareClose();f.mockResolvedValueOnce(identity()).mockRejectedValueOnce(new Error('Unknown original'));submit({preventDefault(){}});await settle();const original=f.mock.calls[4]!;
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},403));click('retry');await settle();expect(hidden()).toBe(true);expect(el('restore').props.disabled).toBe(false);
 authorize(f,'WON');click('restore');await settle();expect(hidden()).toBe(false);expect(el('retry')).toBeDefined();
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(closeReceipt()));click('retry');await settle();expect(f.mock.calls.at(-1)![1]?.body).toBe(original[1]?.body);expect(f.mock.calls.at(-1)![1]?.headers).toEqual(original[1]?.headers);expect(el('receipt')).toBeDefined();
});
it('keeps a stronger recovery denial local and requires separate preparation without claiming no registration',async()=>{
 const f=await loaded();click('step-register');f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},403));click('verify-registration');await settle();expect(hidden()).toBe(true);expect(el('prepare-record')).toBeUndefined();authorize(f);click('restore');await settle();expect(hidden()).toBe(false);expect(text(render())).toContain('Canary');expect(el('birth')).toBeUndefined();expect(text(render())).toContain(journeyCatalog.en.registrationLimited);expect(text(render())).not.toContain(journeyCatalog.en.registrationReady);
 click('prepare-record');expect(el('birth')).toBeDefined();expect(el('confirm').props.checked).toBe(false);expect(text(render())).toContain(journeyCatalog.en.registrationUnverified);expect(f.mock.calls.filter(c=>String(c[0]).endsWith('/register'))).toHaveLength(0);
});
it('does not mistake a recovery403caused by revoked CRM access for registration-only authority',async()=>{
 const f=await loaded();click('step-register');f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},403));click('verify-registration');await settle();expect(hidden()).toBe(true);
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},403));click('restore');await settle();expect(hidden()).toBe(true);expect(el('prepare-record')).toBeUndefined();expect(el('save-registration')).toBeUndefined();
});
it('requires a fresh acknowledgement after a rejected close and a protected refresh',async()=>{
 const f=await loaded();const submit=prepareClose();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},409));
 submit({preventDefault(){}});await settle();expect(el('confirm').props.checked).toBe(false);
 authorize(f);click('refresh');await settle();expect(el('confirm').props.checked).toBe(false);
 const count=f.mock.calls.length;nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();expect(f.mock.calls.length).toBe(count);
});
it('requires a fresh acknowledgement after revalidating the follow-up queue',async()=>{
 const f=await loaded();click('step-follow');
 const queue={schoolId:scope.schoolId,principalId:'00000000-0000-4000-8000-000000000006',canManage:false,humanOnly:true,queue:'mine',status:'ALL',items:[],nextAfter:null};
 const check=()=>{f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(queue)).mockResolvedValueOnce(identity());click('verify-follow');};
 check();await settle();el('confirm').props.onChange({target:{checked:true}});check();await settle();expect(el('confirm').props.checked).toBe(false);
});
it('keeps an initially empty status region and announces only a verified command result',async()=>{
 const f=await loaded();expect(el('command-status').props.role).toBe('status');expect(el('command-status').props['aria-live']).toBe('polite');expect(text(el('command-status'))).toBe('');
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(closeReceipt()));prepareClose()({preventDefault(){}});await settle();expect(text(el('command-status'))).toContain(journeyCatalog.en.receipt);
 window.dispatchEvent(new Event('blur'));expect(hidden()).toBe(true);authorize(f,'WON');click('restore');await settle();expect(text(el('command-status'))).toBe('');
});
it('announces registration review without claiming enrollment or registration success',async()=>{
 const f=await loaded();click('step-register');f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({leadId:row.id,workflowState:'NOT_REGISTERED'})).mockResolvedValueOnce(identity());click('verify-registration');await settle();
 change('birth','1990-01-02');el('confirm').props.onChange({target:{checked:true}});f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({outcome:'NEEDS_STAFF_REVIEW'}));nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});await settle();
 expect(text(el('command-status'))).toBe(journeyCatalog.en.review);expect(text(render())).not.toContain(journeyCatalog.en.registered);
});
it.each(['en','ko','es'])('%s entry from the existing CRM lead route is inert UUID-only navigation',language=>{
 h.language=language;const f=vi.spyOn(globalThis,'fetch');const link=CrmJourneyLink({...scope,leadId:row.id}) as El;
 const href=new URL(link.props.href,'https://hon.invalid');expect(href.pathname).toBe('/staff/crm/journey');expect([...href.searchParams.keys()].sort()).toEqual(['leadId','organizationId','schoolId']);expect(href.searchParams.get('leadId')).toBe(row.id);expect(text(link)).toBe(journeyText(language,'title'));expect(f).not.toHaveBeenCalled();
});

const secondLead={...row,id:id(30),primaryPersonId:id(31),givenName:'Other'};
async function loadedPair(){const f=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope([row,secondLead])).mockResolvedValueOnce(identity());click('load');await settle();return f;}
function pairRead(f:Awaited<ReturnType<typeof loadedPair>>){f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope([row,secondLead])).mockResolvedValueOnce(identity());}
function prepareTrial(){click('step-trial');change('start','2026-11-02T09:00');change('end','2026-11-02T10:00');el('confirm').props.onChange({target:{checked:true}});return nodes(render()).find(e=>e.type==='form')!.props.onSubmit;}
const postCount=(f:Awaited<ReturnType<typeof loadedPair>>)=>f.mock.calls.filter(c=>c[1]?.method==='POST').length;

it('F1: successful scheduling survives A to B to A, refresh and stale submit callbacks without a new key',async()=>{
 const f=await loadedPair(),keys=vi.spyOn(globalThis.crypto,'randomUUID'),submit=prepareTrial();
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(appointment()));submit({preventDefault(){}});await settle();expect(postCount(f)).toBe(1);expect(keys).toHaveBeenCalledTimes(1);
 change('lead-select',secondLead.id);change('lead-select',row.id);pairRead(f);click('refresh');await settle();
 expect(el('save-trial')).toBeUndefined();const count=f.mock.calls.length;submit({preventDefault(){}});await settle();
 expect(f.mock.calls).toHaveLength(count);expect(keys).toHaveBeenCalledTimes(1);expect(postCount(f)).toBe(1);
});

it('F1: an abandoned unknown schedule stays held after reload and reselect with no replacement key or POST',async()=>{
 const f=await loadedPair(),keys=vi.spyOn(globalThis.crypto,'randomUUID'),submit=prepareTrial();
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));submit({preventDefault(){}});await settle();expect(el('retry')).toBeDefined();
 click('discard');click('abandon');pairRead(f);click('load');await settle();change('lead-select',secondLead.id);change('lead-select',row.id);
 expect(operationalLink('team')!.props.href).toBeUndefined();expect(operationalLink('family')!.props.href).toBeUndefined();
 expect(el('journey-entry-back')).toBeUndefined();expect(el('membership-recovery').props.href).toBeUndefined();
 expect(el('save-trial')).toBeUndefined();const count=f.mock.calls.length;submit({preventDefault(){}});await settle();
 expect(f.mock.calls).toHaveLength(count);expect(keys).toHaveBeenCalledTimes(1);expect(postCount(f)).toBe(1);
});

it('F1: an unknown schedule still permits its explicit immutable exact-key retry behind the scheduling hold',async()=>{
 const f=await loadedPair(),keys=vi.spyOn(globalThis.crypto,'randomUUID'),submit=prepareTrial();
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));submit({preventDefault(){}});await settle();const original=f.mock.calls.at(-1)!;
 window.dispatchEvent(new Event('blur'));pairRead(f);click('restore');await settle();
 expect(el('retry').props.disabled).toBe(true); readTrialResponses(f); click('read-trials'); await settle();
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedTrials()).mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(appointment()));click('retry');await settle();
 expect(f.mock.calls.at(-1)![1]?.body).toBe(original[1]?.body);expect(f.mock.calls.at(-1)![1]?.headers).toEqual(original[1]?.headers);
 expect(keys).toHaveBeenCalledTimes(1);expect(postCount(f)).toBe(2);expect(el('save-trial')).toBeUndefined();
});

it('F1: the hold is exact-school scoped and returning to the original school cannot discard it',async()=>{
 const f=await loadedPair(),submit=prepareTrial();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(appointment()));submit({preventDefault(){}});await settle();pairRead(f);click('refresh');await settle();
 change('school',id(20));pairRead(f);click('load');await settle();change('lead-select',row.id);expect(el('save-trial')).toBeDefined();
 expect(f.mock.calls.some(c=>String(c[0]).includes(`/schools/${id(20)}/crm/leads`))).toBe(true);
 change('school',scope.schoolId);pairRead(f);click('load');await settle();change('lead-select',row.id);expect(el('save-trial')).toBeUndefined();expect(postCount(f)).toBe(1);
});

it('F1: a definitely rejected first schedule is not treated as an existing appointment after a fresh read',async()=>{
 const f=await loadedPair(),submit=prepareTrial();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},409));submit({preventDefault(){}});await settle();pairRead(f);click('refresh');await settle();
 expect(el('save-trial')).toBeDefined();expect(el('confirm').props.checked).toBe(false);expect(postCount(f)).toBe(1);
});

it.each(['CLOSE','FOLLOW_UP'] as const)('F2: %s requires an authorized refresh after A to B to A and cannot prepare stale follow-ups or allocate a key',async kind=>{
 const f=await loadedPair(),keys=vi.spyOn(globalThis.crypto,'randomUUID');let submit:(e:{preventDefault():void})=>void;
 if(kind==='CLOSE'){submit=prepareClose();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(closeReceipt()));}
 else{
  click('step-follow');f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(queue)).mockResolvedValueOnce(identity());click('verify-follow');await settle();change('subject','Internal planning');el('confirm').props.onChange({target:{checked:true}});submit=nodes(render()).find(e=>e.type==='form')!.props.onSubmit;
  f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({followUpId:id(10),schoolId:scope.schoolId,leadId:row.id,assigneeId:queue.principalId,subject:'Internal planning',note:'',dueAt:null,priority:'NORMAL',version:1,status:'OPEN',recordedAt:'2026-10-31T05:00:00.000Z',completedAt:null,cancelledAt:null,humanOnly:true}));
 }
 submit({preventDefault(){}});await settle();expect(el('receipt')).toBeDefined();
 change('lead-select',secondLead.id);change('lead-select',row.id);expect(text(render())).toContain(journeyCatalog.en.needsRefresh);
 const count=f.mock.calls.length,keyCount=keys.mock.calls.length;submit({preventDefault(){}});click('step-close');el('confirm').props.onChange({target:{checked:true}});nodes(render()).find(e=>e.type==='form')!.props.onSubmit({preventDefault(){}});
 click('step-follow');expect(el('verify-follow').props.disabled).toBe(true);click('verify-follow');await settle();expect(el('subject')).toBeUndefined();expect(f.mock.calls).toHaveLength(count);expect(keys).toHaveBeenCalledTimes(keyCount);expect(postCount(f)).toBe(1);
 pairRead(f);click('refresh');await settle();expect(text(render())).not.toContain(journeyCatalog.en.needsRefresh);expect(el('verify-follow').props.disabled).toBe(false);
});

it.each([401,403])('F2: a denied refresh (%s) clears private facts and cannot make stale command callbacks usable',async status=>{
 const f=await loadedPair(),keys=vi.spyOn(globalThis.crypto,'randomUUID'),reload=el('load').props.onClick,submit=prepareClose();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(closeReceipt()));submit({preventDefault(){}});await settle();
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},status));click('refresh');await settle();const count=f.mock.calls.length;
 expect(text(render())).not.toContain('Canary');expect(el('receipt')).toBeUndefined();submit({preventDefault(){}});await settle();expect(f.mock.calls).toHaveLength(count);expect(keys).toHaveBeenCalledTimes(1);
 if(status===401){expect(text(render())).toContain(journeyCatalog.en.reauth);expect(el('load')).toBeUndefined();pairRead(f);reload();await settle();expect(f.mock.calls).toHaveLength(count);}
 else{pairRead(f);click('load');await settle();expect(text(render())).toContain('Canary');}
});

const savedTrials = (activeTrial: unknown = null, trials: unknown[] = []) => new Response(JSON.stringify({data:{activeTrial,trials},meta:{requestId:id(9),correlationId:id(9)}}),{headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
const savedDetail = (record:unknown) => new Response(JSON.stringify({data:record,meta:{requestId:id(9),correlationId:id(9)}}),{headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
function readTrialResponses(f:Awaited<ReturnType<typeof loaded>>, active:unknown=null, trials:unknown[]=[]) { f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedTrials(active,trials)).mockResolvedValueOnce(identity()); }
async function savedTrialLoaded(record={...appointment(),version:4}) { const f=await loaded();click('step-outcome');readTrialResponses(f,record,[record]);click('read-trials');await settle();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedDetail(record)).mockResolvedValueOnce(identity());click('inspect-trial-'+record.id);await settle();return {f,record}; }
it('recovers a persisted trial on a fresh mounted view without a creation receipt or automatic command',async()=>{
 const {f,record}=await savedTrialLoaded();expect(el('verified-trial')).toBeDefined();expect(el('save-outcome')).toBeDefined();expect(text(render())).toContain('4');expect(postCount(f)).toBe(0);
 const reads=f.mock.calls.length;change('mode','classic');change('mode','big');h.language='ko';render();click('step-history');expect(f.mock.calls).toHaveLength(reads);expect(el('receipt')).toBeUndefined();expect(record.version).toBe(4);
});
it('keeps an independently active trial outside the full newest-50 history visible and blocks replacement scheduling',async()=>{
 const f=await loaded();click('step-trial');const active={...appointment(),id:id(80),version:3};const history=Array.from({length:50},(_,n)=>({...appointment(),id:id(200-n),status:'CANCELLED',createdAt:'2026-11-01T12:00:00.000Z'}));
 readTrialResponses(f,active,history);click('read-trials');await settle();expect(el('inspect-trial-'+active.id)).toBeDefined();expect(el('save-trial')).toBeUndefined();expect(postCount(f)).toBe(0);expect(el('receipt')).toBeUndefined();
});
it('fresh detail and a separate confirmation bind an outcome to the persisted appointment version',async()=>{
 const {f,record}=await savedTrialLoaded();el('confirm').props.onChange({target:{checked:true}});const submit=nodes(render()).find(e=>e.type==='form')!.props.onSubmit;
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedDetail(record)).mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({...record,status:'COMPLETED',version:5}));submit({preventDefault(){}});submit({preventDefault(){}});await settle();
 const posts=f.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts).toHaveLength(1);expect(JSON.parse(posts[0]![1]!.body as string).expectedVersion).toBe(4);expect(posts[0]![0]).toContain('/appointments/'+record.id+'/outcome');expect(text(render())).toContain(journeyCatalog.en.needsRefresh);expect(el('verified-trial')).toBeUndefined();
});
it('a changed persisted version refuses outcome before dispatch and requires another authorized review',async()=>{
 const {f,record}=await savedTrialLoaded();el('confirm').props.onChange({target:{checked:true}});const submit=nodes(render()).find(e=>e.type==='form')!.props.onSubmit;
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedDetail({...record,version:5,status:'CANCELLED'})).mockResolvedValueOnce(identity());submit({preventDefault(){}});await settle();expect(postCount(f)).toBe(0);expect(text(render())).toContain(journeyCatalog.en.needsRefresh);expect(el('confirm').props.checked).toBe(false);
});
it('an unknown schedule needs an explicit read, does not settle from null, and retries only the original body and key',async()=>{
 const f=await loadedPair(),keys=vi.spyOn(crypto,'randomUUID'),submit=prepareTrial();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));submit({preventDefault(){}});await settle();const original=f.mock.calls.at(-1)!;
 expect(el('retry').props.disabled).toBe(true);click('retry');await settle();expect(postCount(f)).toBe(1);
 readTrialResponses(f);click('read-trials');await settle();expect(postCount(f)).toBe(1);expect(el('receipt')).toBeUndefined();expect(el('save-trial')).toBeUndefined();expect(el('retry').props.disabled).toBe(false);expect(text(render())).toContain(journeyCatalog.en.noActiveTrial);
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedTrials()).mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope(appointment()));const retry=el('retry').props.onClick;retry();retry();await settle();const posts=f.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1]![1]!.body).toBe(original[1]!.body);expect(posts[1]![1]!.headers).toEqual(original[1]!.headers);expect(keys).toHaveBeenCalledTimes(1);
});
it('abandoning an unknown schedule cannot release the hold from an empty authoritative read',async()=>{
 const f=await loadedPair(),submit=prepareTrial();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));submit({preventDefault(){}});await settle();click('discard');click('abandon');pairRead(f);click('load');await settle();change('lead-select',row.id);click('step-trial');readTrialResponses(f);click('read-trials');await settle();expect(el('save-trial')).toBeUndefined();expect(text(render())).toContain(journeyCatalog.en.trialUnresolvedHold);expect(postCount(f)).toBe(1);
});
it('a duplicate409 shows the existing trial without inventing a receipt or matching rejected requested dates',async()=>{
 const f=await loadedPair(),submit=prepareTrial();const existing={...appointment('2026-11-10T09:00:00.000Z','2026-11-10T10:00:00.000Z'),id:id(88),version:2};
 f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(new Response(JSON.stringify({code:'TRIAL_ALREADY_SCHEDULED',detail:'private server detail',existingAppointment:existing}),{status:409,headers:{'Content-Type':'application/json'}}));submit({preventDefault(){}});await settle();expect(el('receipt')).toBeUndefined();expect(el('save-trial')).toBeUndefined();expect(el('retry')).toBeUndefined();expect(text(render())).toContain(journeyCatalog.en.trialConflict);expect(text(render())).not.toContain('private server detail');expect(postCount(f)).toBe(1);
});
it.each(['blur','pagehide','visibilitychange','hon:school-context-changed'])('saved trial %s concealment invalidates a pending read and its late response',async event=>{
 const f=await loaded();click('step-trial');let finish!:(r:Response)=>void;f.mockResolvedValueOnce(identity()).mockImplementationOnce(()=>new Promise(r=>finish=r));click('read-trials');await settle();
 if(event==='visibilitychange')Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});(event==='visibilitychange'?document:window).dispatchEvent(new Event(event));expect(hidden()).toBe(true);finish(savedTrials(appointment(),[appointment()]));await settle();expect(el('verified-trial')).toBeUndefined();expect(el('inspect-trial-'+appointment().id)).toBeUndefined();expect(postCount(f)).toBe(0);
});
it.each([401,403])('saved trial denial %s clears facts and never confirms an unknown scheduling command',async status=>{
 const f=await loadedPair(),submit=prepareTrial();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));submit({preventDefault(){}});await settle();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(new Response('{}',{status}));click('read-trials');await settle();expect(el('inspect-trial-'+appointment().id)).toBeUndefined();expect(el('receipt')).toBeUndefined();expect(postCount(f)).toBe(1);if(status===401){expect(text(render())).toContain(journeyCatalog.en.reauth);expect(text(render())).not.toContain('Private');}else expect(hidden()).toBe(true);
});
it('a conflicting exact retry retains its key and permits another protected recovery read without a reload or abandonment',async()=>{
 const f=await loadedPair(),submit=prepareTrial();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(envelope({},503));submit({preventDefault(){}});await settle();const original=f.mock.calls.at(-1)!;const existing={...appointment(),id:id(88)};
 readTrialResponses(f,existing,[existing]);click('read-trials');await settle();f.mockResolvedValueOnce(identity()).mockResolvedValueOnce(savedTrials(existing,[existing])).mockResolvedValueOnce(identity()).mockResolvedValueOnce(new Response(JSON.stringify({code:'TRIAL_ALREADY_SCHEDULED',detail:'Already scheduled',existingAppointment:existing}),{status:409,headers:{'Content-Type':'application/json'}}));click('retry');await settle();
 expect(el('read-trials').props.disabled).toBe(false);expect(el('retry').props.disabled).toBe(true);expect(el('receipt')).toBeUndefined();expect(el('save-trial')).toBeUndefined();readTrialResponses(f,existing,[existing]);click('read-trials');await settle();expect(el('retry').props.disabled).toBe(false);const posts=f.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1]![1]!.body).toBe(original[1]!.body);expect(posts[1]![1]!.headers).toEqual(original[1]!.headers);
});
it.each(['en','ko','es'])('%s announces saved-trial verification as a read, never as a command receipt',async language=>{
 h.language=language;const f=await loaded();click('step-trial');readTrialResponses(f);click('read-trials');await settle();expect(text(el('command-status'))).toBe(journeyText(language,'trialReadComplete'));expect(el('receipt')).toBeUndefined();window.dispatchEvent(new Event('blur'));expect(text(el('command-status'))).toBe('');
});
