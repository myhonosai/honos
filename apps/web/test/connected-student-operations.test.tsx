import React, { type ReactElement } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ConnectedStudentOperations } from '../src/components/connected-student-operations';
import { operationsText as t } from '../src/components/connected-student-operations-copy';
const h = vi.hoisted(() => ({ values: [] as any[], cursor: 0, effects: [] as (() => void)[], language: 'en', session: vi.fn() }));
vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: h.language }, date: (x: string) => x, number: String }) }));
vi.mock('../src/components/crm-enrollment-privacy', () => ({ verifyEnrollmentSession: (...args: unknown[]) => h.session(...args) }));
vi.mock('react', async () => { const actual = await vi.importActual<typeof import('react')>('react'); return { ...actual,
  useState: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = typeof initial === 'function' ? initial() : initial; return [h.values[i], (v: any) => h.values[i] = typeof v === 'function' ? v(h.values[i]) : v]; },
  useRef: (initial: any) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i]; },
  useEffect: (fn: () => any, deps: unknown[]) => { const i = h.cursor++, old = h.values[i]; if (!old || deps.some((v,j) => v !== old.deps[j])) { old?.cleanup?.(); h.values[i] = { deps }; h.effects.push(() => h.values[i].cleanup = fn()); } },
}; });
type E = ReactElement<Record<string, any>>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const selection = { organizationId: id(1), schoolId: id(2), studentProfileId: id(4) };
const stamp = '2026-11-03T12:00:00.000Z';
const session = { sessionId: id(3), name: 'Synthetic Family Class', startsAt: stamp, endsAt: '2026-11-03T13:00:00.000Z', roomName: 'North Hall', capacity: 20, bookingPolicy: 'OPTIONAL_BOOKING', status: 'SCHEDULED', createdAt: stamp };
const attendance = { id: id(10), classSessionId: id(3), studentProfileId: id(4), status: 'PRESENT', category: 'REGULAR_PARTICIPANT', progressionPolicyVersion: 0, progressionEnabled: false, progressionWeightMilli: 0, progressionCreditMilli: 0, recordedAt: stamp, version: 1, createdAt: stamp, updatedAt: stamp };
const booking = { id: id(11), classSessionId: id(3), studentProfileId: id(4), bookingKind: 'REGULAR', status: 'BOOKED', source: 'STAFF', bookedAt: stamp, version: 1, createdAt: stamp, updatedAt: stamp, sessionCapacity: 20, bookingPolicy: 'OPTIONAL_BOOKING', activeSeatCount: 1 };
const envelope = (data: unknown, status = 200, mutation = false, replayed = false) => Response.json({ data, meta: { requestId: id(8), correlationId: id(8), ...(mutation ? { replayed } : {}) } }, { status });
const all = (n: unknown): E[] => Array.isArray(n) ? n.flatMap(all) : React.isValidElement(n) ? [n as E, ...all((n as E).props.children)] : [];
const text = (n: unknown): string => Array.isArray(n) ? n.map(text).join('') : React.isValidElement(n) ? text((n as E).props.children) : typeof n === 'string' || typeof n === 'number' ? String(n) : '';
let props: Parameters<typeof ConnectedStudentOperations>[0];
const render = () => { h.cursor = 0; const wrapper = ConnectedStudentOperations(props) as E; const tree = (wrapper.type as any)(wrapper.props); h.effects.splice(0).forEach(f => f()); return tree; };
const button = (key: Parameters<typeof t>[1]) => all(render()).find(e => e.type === 'button' && text(e) === t(h.language,key))!;
const click = (key: Parameters<typeof t>[1]) => button(key).props.onClick();
const field = (key: Parameters<typeof t>[1]) => all(render()).filter(e => e.type === 'label').find(e => text(e).startsWith(t(h.language,key)))!;
const change = (key: Parameters<typeof t>[1], value: string | boolean) => all(field(key)).find(e => ['input','select','textarea'].includes(e.type as string))!.props.onChange({ target: { value, checked: value } });
const settle = async () => { for (let i=0;i<160;i++) await Promise.resolve(); };
const flush = async () => { await settle(); render(); };
const unmount = () => h.values.forEach(v => v?.cleanup?.());
let posts: RequestInit[], getAttendance: unknown;
let bookingSend: () => Promise<Response>, attendanceSend: () => Promise<Response>;
beforeEach(() => {
  h.values=[]; h.cursor=0; h.effects=[]; h.language='en'; h.session.mockReset().mockResolvedValue(undefined);
  props={ selection, sessionSubject:'staff', verifyStudent:vi.fn().mockResolvedValue(undefined), onReturn:vi.fn() };
  vi.stubGlobal('window',new EventTarget()); vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
  posts=[];getAttendance=null;bookingSend=async()=>envelope(booking,201,true);attendanceSend=async()=>{const {status,category,note}=JSON.parse(posts.at(-1)!.body as string);return envelope({...attendance,status,category,note},201,true);};
  vi.spyOn(globalThis,'fetch').mockImplementation(async (url,init)=>{
    if(init?.method==='POST'){posts.push(init);return String(url).endsWith('/bookings')?bookingSend():attendanceSend();}
    return String(url).includes('/attendance?')?envelope(getAttendance):envelope([session]);
  });
});
afterEach(()=>{unmount();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function choose(){render();click('load');await flush();all(render()).find(e=>e.type==='button'&&text(e)===t(h.language,'choose')+' · '+session.name)!.props.onClick();render();}
async function prepareBooking(){await choose();change('kind','REGULAR');change('bookingConfirm',true);}
it('starts idle with no reads or key allocation; language and presentation are local',()=>{const uuid=vi.spyOn(crypto,'randomUUID');render();all(render()).find(e=>e.type==='select')!.props.onChange({target:{value:'big'}});h.language='ko';render();expect(fetch).not.toHaveBeenCalled();expect(uuid).not.toHaveBeenCalled();expect(text(render())).toContain(t('ko','title'));});
it('loads actual bounded projection with protected student revalidation and no inferred availability',async()=>{await choose();expect(props.verifyStudent).toHaveBeenCalledOnce();expect(text(render())).toContain(session.name);expect(text(render())).toContain(t('en','capacity'));expect(posts).toHaveLength(0);});
it('deliberate confirmation sends canonical body once despite duplicate/stale clicks; returning to class cannot create a replacement',async()=>{
  await prepareBooking();const handler=button('book').props.onClick;handler();handler();await flush();expect(posts).toHaveLength(1);expect(JSON.parse(posts[0]!.body as string)).toEqual({studentProfileId:id(4),bookingKind:'REGULAR'});expect(text(render())).toContain(t('en','bookingReceipt'));
  click('classes');all(render()).find(e=>e.type==='button'&&text(e).includes(t('en','choose')))!.props.onClick();handler();await flush();expect(posts).toHaveLength(1);expect(text(render())).toContain(t('en','bookedOnce'));
});
it('does not send a stale confirmation after booking kind changes',async()=>{await prepareBooking();const old=button('book').props.onClick;change('kind','TRIAL');old();await flush();expect(posts).toHaveLength(0);});
it.each(['blur','pagehide','hon:session-invalidated'])('%s conceals immediately, preserves unsettled request, settles behind shield and retries exact key only explicitly',async event=>{
  await prepareBooking();let reject!:(e:Error)=>void;bookingSend=()=>new Promise((_r,j)=>reject=j);click('book');await flush();expect(posts).toHaveLength(1);
  const area=all(render()).find(e=>e.type==='div'&&e.props.ref)!;const dom={hidden:false,inert:false};area.props.ref.current=dom;
  window.dispatchEvent(new Event(event));expect(dom).toEqual({hidden:true,inert:true});expect(text(render())).not.toContain(id(4));expect(button('abandon').props.disabled).toBe(true);
  reject(new Error('network'));await flush();expect(button('verify').props.disabled).toBe(false);click('verify');await flush();expect(posts).toHaveLength(1);
  bookingSend=async()=>envelope(booking,200,true,true);click('retry');click('retry');await flush();expect(posts).toHaveLength(2);expect(posts[1]!.headers).toEqual(posts[0]!.headers);expect(posts[1]!.body).toBe(posts[0]!.body);expect(text(render())).toContain(t('en','bookingReceipt'));
});
it('successful settlement behind shield clears busy without full-page reload or automatic replay',async()=>{await prepareBooking();let finish!:(v:Response)=>void;bookingSend=()=>new Promise(r=>finish=r);click('book');await flush();window.dispatchEvent(new Event('blur'));finish(envelope(booking,201,true));await flush();expect(button('verify').props.disabled).toBe(false);click('verify');await flush();expect(text(render())).toContain(t('en','bookingReceipt'));expect(posts).toHaveLength(1);});
it('unknown abandonment retains mounted duplicate-prevention evidence',async()=>{await prepareBooking();bookingSend=async()=>{throw Error('lost');};click('book');await flush();change('abandonConfirm',true);click('abandon');click('classes');all(render()).find(e=>e.type==='button'&&text(e).includes(t('en','choose')))!.props.onClick();expect(text(render())).toContain(t('en','bookedOnce'));expect(posts).toHaveLength(1);});
it('exact attendance is explicitly read, then saved with current version; it never marks attendance on open',async()=>{getAttendance=attendance;await choose();expect(posts).toHaveLength(0);click('readAttendance');await flush();change('status','LATE');change('attendanceConfirm',true);click('save');click('save');await flush();expect(posts).toHaveLength(1);expect(JSON.parse(posts[0]!.body as string)).toMatchObject({studentProfileId:id(4),status:'LATE',expectedVersion:1});expect(text(render())).toContain(t('en','saved'));expect(all(render()).find(e=>e.type==='fieldset'&&all(e).some(n=>n.type==='textarea'))!.props.disabled).toBe(true);});
it('rejects late session lists after focus loss even when transport ignores cancellation',async()=>{let finish!:(v:Response)=>void;vi.mocked(fetch).mockImplementation(()=>new Promise(r=>finish=r));render();click('load');await flush();window.dispatchEvent(new Event('blur'));finish(envelope([session]));await flush();expect(text(render())).not.toContain(session.name);expect((vi.mocked(fetch).mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);});
it.each([401,403,404,409,503])('HTTP %i is not an empty result; 401 alone broadcasts session invalidation',async status=>{const event=vi.fn();window.addEventListener('hon:session-invalidated',event);vi.mocked(fetch).mockResolvedValue(new Response('',{status}));render();click('load');await flush();expect(text(render())).not.toContain(t('en','empty'));expect(event).toHaveBeenCalledTimes(status===401?1:0);expect(text(render())).not.toContain(session.name);});
it('school switching prevents old context restoration; no automatically repeated calls',async()=>{await choose();const count=vi.mocked(fetch).mock.calls.length;window.dispatchEvent(new Event('hon:school-context-changed'));click('verify');await flush();expect(vi.mocked(fetch)).toHaveBeenCalledTimes(count);expect(text(render())).not.toContain(id(4));expect(text(render())).toContain(t('en','schoolChanged'));});
it('revoked student access denies the command before the POST',async()=>{await prepareBooking();vi.mocked(props.verifyStudent).mockRejectedValue({status:403});click('book');await flush();expect(posts).toHaveLength(0);expect(text(render())).not.toContain(id(4));});
it('uncertain attendance retains its exact version/body/key and never saves a replacement automatically',async()=>{await choose();click('readAttendance');await flush();change('attendanceConfirm',true);attendanceSend=async()=>{throw Error('lost');};click('save');await flush();expect(posts).toHaveLength(1);expect(button('save').props.disabled).toBe(false);expect(all(render()).find(e=>e.type==='fieldset'&&all(e).some(n=>n.type==='textarea'))!.props.disabled).toBe(true);attendanceSend=async()=>envelope(attendance,200,true,true);click('retry');await flush();expect(posts).toHaveLength(2);expect(posts[0]).toMatchObject({body:posts[1]!.body,headers:posts[1]!.headers});expect(text(render())).toContain(t('en','saved'));});
it('attendance conflict requires a fresh record read before another confirmed change',async()=>{await choose();click('readAttendance');await flush();change('attendanceConfirm',true);attendanceSend=async()=>new Response('',{status:409});click('save');await flush();expect(text(render())).toContain(t('en','CONFLICT'));expect(all(render()).find(e=>e.type==='fieldset'&&all(e).some(n=>n.type==='textarea'))!.props.disabled).toBe(true);expect(posts).toHaveLength(1);});
it.each(['SUCCESS','CONFLICT'])('retained attendance submit after %s cannot allocate another key or command, even before React renders settlement',async outcome=>{
  getAttendance=attendance;await choose();click('readAttendance');await flush();change('attendanceConfirm',true);
  if(outcome==='CONFLICT')attendanceSend=async()=>new Response('',{status:409});
  const old=button('save').props.onClick,uuid=vi.spyOn(crypto,'randomUUID');old();await settle();
  expect(posts).toHaveLength(1);old();await settle();expect(posts).toHaveLength(1);expect(uuid).toHaveBeenCalledOnce();
});
it.each(['SUCCESS','CONFLICT'])('after %s only a fresh attendance read and deliberate confirmation permits a new version-bound command',async outcome=>{
  getAttendance=attendance;await choose();click('readAttendance');await flush();change('attendanceConfirm',true);
  if(outcome==='CONFLICT')attendanceSend=async()=>new Response('',{status:409});
  const old=button('save').props.onClick;old();await flush();const uuid=vi.spyOn(crypto,'randomUUID');
  getAttendance={...attendance,version:2};click('readAttendance');await flush();old();await flush();expect(uuid).not.toHaveBeenCalled();expect(posts).toHaveLength(1);
  const freshUnconfirmed=button('save').props.onClick;freshUnconfirmed();await flush();expect(uuid).not.toHaveBeenCalled();
  change('status','LATE');change('attendanceConfirm',true);attendanceSend=async()=>envelope({...attendance,status:'LATE',version:3},201,true);click('save');await flush();
  expect(posts).toHaveLength(2);expect(uuid).toHaveBeenCalledOnce();expect(JSON.parse(posts[1]!.body as string)).toMatchObject({expectedVersion:2,status:'LATE'});
});
it('attendance read replacement invalidates a callback captured during that read before any render of the replacement',async()=>{
  getAttendance=attendance;await choose();click('readAttendance');await flush();change('attendanceConfirm',true);
  let finish!:(v:Response)=>void;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>finish=r));click('readAttendance');await settle();
  const duringRead=button('save').props.onClick,uuid=vi.spyOn(crypto,'randomUUID');finish(envelope({...attendance,version:2}));await settle();duringRead();await settle();
  expect(posts).toHaveLength(0);expect(uuid).not.toHaveBeenCalled();
});
it('UNKNOWN attendance exposes only the original exact retry; retained submits cannot replace it before or after deliberate abandonment',async()=>{
  getAttendance=attendance;await choose();click('readAttendance');await flush();change('attendanceConfirm',true);
  const old=button('save').props.onClick,uuid=vi.spyOn(crypto,'randomUUID');attendanceSend=async()=>{throw Error('lost');};old();await flush();
  old();const whileUnknown=button('save').props.onClick;whileUnknown();await flush();expect(posts).toHaveLength(1);expect(uuid).toHaveBeenCalledOnce();
  change('abandonConfirm',true);click('abandon');whileUnknown();old();await settle();expect(posts).toHaveLength(1);expect(uuid).toHaveBeenCalledOnce();
});
it('UNKNOWN attendance retry preserves the original URL, body, expectedVersion and key without allocating a replacement',async()=>{
  getAttendance=attendance;await choose();click('readAttendance');await flush();change('attendanceConfirm',true);
  const old=button('save').props.onClick,uuid=vi.spyOn(crypto,'randomUUID');attendanceSend=async()=>{throw Error('lost');};old();await flush();old();await flush();
  const original=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST')[0]!;
  attendanceSend=async()=>envelope({...attendance,version:2},200,true,true);click('retry');click('retry');await flush();old();await settle();
  const attempts=vi.mocked(fetch).mock.calls.filter(([,init])=>init?.method==='POST');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(original);expect(JSON.parse(attempts[1]![1]!.body as string).expectedVersion).toBe(1);expect(uuid).toHaveBeenCalledOnce();
});
it.each(['hon:school-context-changed','hon:session-invalidated','blur'])('%s plus a late attendance read cannot resurrect retained submission after restoration',async event=>{
  getAttendance=attendance;await choose();click('readAttendance');await flush();change('attendanceConfirm',true);const old=button('save').props.onClick;
  let finish!:(v:Response)=>void;vi.mocked(fetch).mockImplementationOnce(()=>new Promise(r=>finish=r));click('readAttendance');await settle();const duringRead=button('save').props.onClick;
  window.dispatchEvent(new Event(event));finish(envelope({...attendance,version:2}));await flush();const uuid=vi.spyOn(crypto,'randomUUID');old();duringRead();await flush();
  expect(text(render())).not.toContain(selection.studentProfileId);expect(posts).toHaveLength(0);expect(uuid).not.toHaveBeenCalled();
  click('verify');await flush();old();duringRead();await flush();expect(posts).toHaveLength(0);expect(uuid).not.toHaveBeenCalled();
});
it('unmounted handlers perform no new requests',async()=>{await prepareBooking();const old=button('book').props.onClick;unmount();const reads=vi.mocked(fetch).mock.calls.length;old();await flush();expect(posts).toHaveLength(0);expect(fetch).toHaveBeenCalledTimes(reads);});
it.each(['en','ko','es'])('%s keeps persistent live status and localized operational controls',language=>{h.language=language;const tree=render();expect(text(tree)).toContain(t(language,'title'));expect(all(tree).some(e=>e.props.role==='status'&&e.props['aria-live']==='polite')).toBe(true);});
