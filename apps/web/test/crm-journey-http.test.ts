import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readLeads,readQueue,readRegistration,verifyJourneySession,prepareCommand,sendCommand,JourneyError,CRM_LEAD_REGISTRATION_CONFIRMATION} from '../src/components/crm-journey/http';
import {HON_SESSION_INVALIDATED_EVENT} from '../src/components/session-invalidation';
import {scope,row,id,identity,envelope,queue,closeReceipt,appointment} from './crm-journey-fixtures';
beforeEach(()=>vi.stubGlobal('window',new EventTarget()));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each([401,403])('distinguishes authenticated %i and emits only confirmed session invalidation',async status=>{
 const signal=vi.fn();window.addEventListener(HON_SESSION_INVALIDATED_EVENT,signal);vi.spyOn(globalThis,'fetch').mockResolvedValue(envelope({},status));
 await expect(readLeads(scope,new AbortController().signal)).rejects.toMatchObject({kind:status===401?'SESSION':'DENIED'});expect(signal).toHaveBeenCalledTimes(status===401?1:0);
});
it('verifies exact session continuity; never derives school authority from identity',async()=>{
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(identity());await verifyJourneySession('staff:synthetic',new AbortController().signal);
 f.mockResolvedValue(identity('different'));await expect(verifyJourneySession('staff:synthetic',new AbortController().signal)).rejects.toMatchObject({kind:'SESSION'});
});
it('uses shared bounded lead and self-queue validators and refuses a different resolved school',async()=>{
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(envelope([row]));expect(await readLeads(scope,new AbortController().signal)).toEqual([row]);
 f.mockResolvedValue(envelope(queue));expect((await readQueue(scope,new AbortController().signal)).principalId).toBe(id(6));
 f.mockResolvedValue(envelope({...queue,schoolId:id(22)}));await expect(readQueue(scope,new AbortController().signal)).rejects.toMatchObject({kind:'DENIED'});
 f.mockResolvedValue(envelope([{...row,privateConfiguration:'forbidden'}]));await expect(readLeads(scope,new AbortController().signal)).rejects.toThrow();
});
it('freezes exact close request identity and verifies receipt school, version, status and evidence',async()=>{
 const c=prepareCommand('CLOSE',scope,row,{status:'WON',expectedVersion:1},id(10));expect(Object.isFrozen(c)).toBe(true);expect(Object.isFrozen(c.scope)).toBe(true);
 const f=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>envelope(closeReceipt()));expect((await sendCommand(c,new AbortController().signal)).kind).toBe('CLOSE');
 const first=f.mock.calls[0];await sendCommand(c,new AbortController().signal);expect(f.mock.calls[1]![0]).toEqual(first![0]);expect(f.mock.calls[1]![1]?.body).toEqual(first![1]?.body);expect(f.mock.calls[1]![1]?.headers).toEqual(first![1]?.headers);
 f.mockResolvedValue(envelope({...closeReceipt(),schoolId:id(99)}));await expect(sendCommand(c,new AbortController().signal)).rejects.toMatchObject({kind:'UNKNOWN'});
});
it.each([503,'network','malformed'] as const)('does not invent success after %s',async kind=>{
 const c=prepareCommand('CLOSE',scope,row,{status:'LOST',expectedVersion:1},id(11));const f=vi.spyOn(globalThis,'fetch');if(kind==='network')f.mockRejectedValue(new Error('lost'));else f.mockResolvedValue(kind==='malformed'?new Response('broken',{headers:{'content-type':'application/json'}}):envelope({},503));
 await expect(sendCommand(c,new AbortController().signal)).rejects.toMatchObject({kind:'UNKNOWN'});
});
it('creates self-assigned internal follow-up only from exact fields, validating school and assignee',async()=>{
 const body={leadId:row.id,assigneeId:id(6),expectedVersion:0,subject:'Internal only',note:'No message',dueAt:null,priority:'NORMAL'};
 const c=prepareCommand('FOLLOW_UP',scope,row,body,id(12));const saved={...body,schoolId:scope.schoolId,followUpId:id(13),version:1,status:'OPEN',recordedAt:'2026-10-30T12:00:00.000Z',completedAt:null,cancelledAt:null,humanOnly:true};delete (saved as Partial<typeof saved>).expectedVersion;
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(envelope(saved));expect((await sendCommand(c,new AbortController().signal)).kind).toBe('FOLLOW_UP');
 f.mockResolvedValue(envelope({...saved,assigneeId:id(99)}));await expect(sendCommand(c,new AbortController().signal)).rejects.toMatchObject({kind:'UNKNOWN'});
});
it('binds trial scheduling and terminal outcome to the exact receipt and version',async()=>{
 const a=appointment(), c=prepareCommand('SCHEDULE',scope,row,{startsAt:a.startsAt,endsAt:a.endsAt},id(14));const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(envelope(a));await sendCommand(c,new AbortController().signal);
 const o=prepareCommand('OUTCOME',scope,row,{status:'NO_SHOW',expectedVersion:1},id(15),a as never);f.mockResolvedValue(envelope({...a,status:'NO_SHOW',version:2}));await sendCommand(o,new AbortController().signal);
 expect(()=>prepareCommand('OUTCOME',scope,row,{status:'COMPLETED',expectedVersion:2},id(16),a as never)).toThrow();f.mockResolvedValue(envelope({...a,id:id(90),status:'NO_SHOW',version:2}));await expect(sendCommand(o,new AbortController().signal)).rejects.toMatchObject({kind:'UNKNOWN'});
});
it.each(['ADULT','GUARDIAN_CHILD'] as const)('registration %s reuses closed canonical contract without financial effects',async path=>{
 const body=path==='ADULT'?{registrationPath:path,birthDate:'1990-01-02',confirmation:CRM_LEAD_REGISTRATION_CONFIRMATION}:{registrationPath:path,childGivenName:'Child',childFamilyName:'Canary',childBirthDate:'2018-01-02',confirmation:CRM_LEAD_REGISTRATION_CONFIRMATION};
 const c=prepareCommand('REGISTER',scope,row,body,id(17));const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(envelope({outcome:'REGISTERED',leadId:row.id,sourceContactPersonId:row.primaryPersonId,registrationPath:path,studentProfileId:id(18),familyId:path==='ADULT'?null:id(19),recordedAt:'2026-10-30T12:00:00.000Z'}));
 expect((await sendCommand(c,new AbortController().signal)).kind).toBe('REGISTER');expect(f.mock.calls[0]![0]).toMatch(/\/register$/);expect(f.mock.calls[0]![1]?.body).not.toMatch(/billing|payment|membership/);
 f.mockResolvedValue(envelope({outcome:'NEEDS_STAFF_REVIEW'}));expect((await sendCommand(c,new AbortController().signal)).kind).toBe('REGISTER');
});
it('recovery is an explicit existing read-only POST and never registers automatically',async()=>{
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(envelope({leadId:row.id,workflowState:'NOT_REGISTERED'}));expect(await readRegistration(scope,row,new AbortController().signal)).toBe('NOT_REGISTERED');expect(f.mock.calls[0]![1]?.body).toBe('{}');expect(f.mock.calls[0]![1]?.headers).not.toHaveProperty('Idempotency-Key');
 f.mockResolvedValue(envelope({leadId:row.id,workflowState:'NEEDS_STAFF_REVIEW'}));expect(await readRegistration(scope,row,new AbortController().signal)).toBe('EXISTING_RECORD');
});
it('refuses a replay-tagged recovery response as current registration evidence',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:{leadId:row.id,workflowState:'NOT_REGISTERED'},meta:{requestId:id(9),correlationId:id(9),replayed:true}}),{headers:{'content-type':'application/json'}}));
 await expect(readRegistration(scope,row,new AbortController().signal)).rejects.toMatchObject({kind:'READ'});
});
