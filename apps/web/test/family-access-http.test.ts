import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { familyAccessApi, familyCommand } from '../src/components/family-access/http';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),schoolId:id(2)},family={id:id(3),displayName:'Private Family',status:'ACTIVE',version:1,memberCount:2,createdAt:'2026-11-04T00:00:00Z'};
const invitation={invitationId:id(4),schoolId:scope.schoolId,familyId:family.id,familyName:family.displayName,accessLevel:'PRIMARY_GUARDIAN',email:'guardian@example.test',expiresAt:'2026-11-05T00:00:00Z',status:'PENDING'};
const token='a'.repeat(43),input={schoolId:scope.schoolId,familyId:family.id,email:invitation.email,accessLevel:'PRIMARY_GUARDIAN',ttlHours:24,token};
const signal=()=>new AbortController().signal;
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
let invalidations:ReturnType<typeof vi.fn>;
beforeEach(()=>{const w=new EventTarget();invalidations=vi.fn();w.addEventListener(HON_SESSION_INVALIDATED_EVENT,invalidations);vi.stubGlobal('window',w);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('loads actual bounded FamilySummary shape before the final dedicated school authorization read',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(reply({data:[family],meta:{requestId:id(8),correlationId:id(8)}})).mockResolvedValueOnce(reply({data:[invitation]}));
 expect(await familyAccessApi.load(scope,signal())).toEqual({families:[family],invitations:[invitation]});expect(fetch.mock.calls.map(x=>x[0])).toEqual([`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/families`,`/api/v1/school/schools/${scope.schoolId}/family-access-invitations`]);
 for(const [,options] of fetch.mock.calls)expect(options).toMatchObject({method:'GET',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
});
it('rejects family results if final family-manager read is denied; 403 stays local',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(reply({data:[family],meta:{requestId:id(8),correlationId:id(8)}})).mockResolvedValueOnce(reply({code:'ACCOUNT_FORBIDDEN'},403));
 await expect(familyAccessApi.load(scope,signal())).rejects.toMatchObject({kind:'DENIED',code:'ACCOUNT_FORBIDDEN'});expect(invalidations).not.toHaveBeenCalled();
});
it.each([401,403])('HTTP %s has distinct shared/local handling',async status=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(reply({code:'ACCOUNT_FORBIDDEN'},status));await expect(familyAccessApi.identity('parent-a',signal())).rejects.toMatchObject({kind:status===401?'SESSION':'DENIED'});expect(invalidations).toHaveBeenCalledTimes(status===401?1:0);
});
it('late retired-read 401 cannot invalidate a newer identity',async()=>{
 const abort=new AbortController();let settle!:(r:Response)=>void;vi.spyOn(globalThis,'fetch').mockImplementationOnce(()=>new Promise(r=>{settle=r;}));const task=familyAccessApi.identity('owner-a',abort.signal);abort.abort();settle(reply({},401));await expect(task).rejects.toThrow();expect(invalidations).not.toHaveBeenCalled();
});
it('a 401 from an unmounted old command does not invalidate the replacement session',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(reply({},401));await expect(familyAccessApi.send(familyCommand('invite',input,id(9)),()=>false)).rejects.toMatchObject({kind:'SESSION'});expect(invalidations).not.toHaveBeenCalled();
});
it('never dispatches an already aborted read',async()=>{
 const abort=new AbortController();abort.abort();const f=vi.spyOn(globalThis,'fetch');await expect(familyAccessApi.identity('owner-a',abort.signal)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
});
it('does not accept another signed identity or browser authority fields as continuity',async()=>{
 const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(reply({data:{externalSubject:'parent-b'}}));await expect(familyAccessApi.identity('parent-a',signal())).rejects.toMatchObject({kind:'IDENTITY'});
 f.mockResolvedValue(reply({data:{externalSubject:'parent-a',role:'OWNER'}}));await expect(familyAccessApi.identity('parent-a',signal())).rejects.toMatchObject({kind:'IDENTITY'});
});
it('uses an immutable closed command and preserves exact URL, serialized body, key and human marker',async()=>{
 const command=familyCommand('invite',input,id(9));expect(Object.isFrozen(command)).toBe(true);const f=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>reply({data:invitation}));await familyAccessApi.send(command);await familyAccessApi.send(command);
 for(const [path,options] of f.mock.calls){expect(path).toBe('/api/v1/school/family-access-invitations');expect(options).toMatchObject({method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',body:command.body,headers:{'Content-Type':'application/json','X-HON-Human-Command':'school-family-account','Idempotency-Key':id(9)}});}
});
it.each(['amount','organizationId','principalId','role','activation'])('rejects extra %s authority/business field before dispatch',field=>{
 expect(()=>familyCommand('invite',{...input,[field]:field==='amount'?1:id(99)},id(9))).toThrow();
});
it('refuses unsupported command kinds and noncanonical modified request bodies before dispatch',async()=>{
 expect(()=>familyCommand('publish' as never,input,id(9))).toThrow();const f=vi.spyOn(globalThis,'fetch');const cmd=familyCommand('invite',input,id(9));await expect(familyAccessApi.send({...cmd,body:cmd.body+' '})).rejects.toThrow();expect(f).not.toHaveBeenCalled();
});
it.each(['family','school','status','extra'])('unknown result is retained when invitation response has invalid %s binding',async mode=>{
 const value=mode==='family'?{...invitation,familyId:id(88)}:mode==='school'?{...invitation,schoolId:id(88)}:mode==='status'?{...invitation,status:'ACCEPTED'}:{...invitation,staffRole:'OWNER'};
 vi.spyOn(globalThis,'fetch').mockResolvedValue(reply({data:value}));await expect(familyAccessApi.send(familyCommand('invite',input,id(9)))).rejects.toMatchObject({kind:'UNKNOWN'});
});
it('acceptance receipt cannot imply paid access, billing or AI activation',async()=>{
 const cmd=familyCommand('accept',{invitationId:id(4),token,confirmation:'ACCEPT_FAMILY_ACCESS_INVITATION'},id(9));const f=vi.spyOn(globalThis,'fetch');
 const data={invitationId:id(4),schoolId:scope.schoolId,familyId:family.id,accessLevel:'VIEWER',accountStatus:'FAMILY_ACCESS_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false};f.mockResolvedValue(reply({data}));await expect(familyAccessApi.send(cmd)).resolves.toEqual(data);
 for(const flag of ['accessGranted','billingActivated','aiCreditsGranted']){f.mockResolvedValue(reply({data:{...data,[flag]:true}}));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind:'UNKNOWN'});}
});
it.each([['ACCOUNT_BUSY',503],['ACCOUNT_RATE_LIMITED',429]] as const)('explicit %s NOT_SUBMITTED differs from unknown failures',async(code,status)=>{
 const cmd=familyCommand('invite',input,id(9));const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(reply({code,outcome:'NOT_SUBMITTED'},status));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind:'NOT_SUBMITTED',code});
 f.mockResolvedValue(reply({code:'ACCOUNT_UNAVAILABLE',outcome:'UNKNOWN_OR_RETRY_REQUIRED'},503));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind:'UNKNOWN'});expect(f).toHaveBeenCalledTimes(2);
});
it('maps concrete review/expiry/verified-email errors without exposing arbitrary server details',async()=>{
 const f=vi.spyOn(globalThis,'fetch'),cmd=familyCommand('invite',input,id(9));
 for(const [status,code,kind]of [[409,'ACCOUNT_REVIEW_REQUIRED','REJECTED'],[404,'ACCOUNT_UNAVAILABLE','REJECTED'],[403,'VERIFIED_EMAIL_REQUIRED','DENIED']]as const){f.mockResolvedValue(reply({code,detail:'PRIVATE SERVER DETAIL'},status));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind,code});}
 f.mockResolvedValue(new Response('PRIVATE SERVER DETAIL',{status:403}));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind:'DENIED',message:'ACCOUNT_UNAVAILABLE'});
});
it('does not confuse network failure or invalid success payload with successful creation',async()=>{
 const cmd=familyCommand('invite',input,id(9));const f=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('PRIVATE NETWORK DETAIL'));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind:'UNKNOWN',message:'ACCOUNT_UNAVAILABLE'});
 f.mockResolvedValue(reply({data:invitation,unexpected:true}));await expect(familyAccessApi.send(cmd)).rejects.toMatchObject({kind:'UNKNOWN'});
});
it('rejects oversized, duplicate, expanded or foreign-school directory records',async()=>{
 const f=vi.spyOn(globalThis,'fetch');for(const records of [[family,family],Array(101).fill(family),[{...family,privateNote:'PRIVATE'}]]){f.mockResolvedValue(reply({data:records,meta:{requestId:id(8),correlationId:id(8)}}));await expect(familyAccessApi.load(scope,signal())).rejects.toThrow();}
 f.mockResolvedValueOnce(reply({data:[family],meta:{requestId:id(8),correlationId:id(8)}})).mockResolvedValueOnce(reply({data:[{...invitation,schoolId:id(88)}]}));await expect(familyAccessApi.load(scope,signal())).rejects.toThrow();
});
it.each(['revoke','end'] as const)('known-reference %s accepts only exact invitation/school/status receipts and preserves no-referrer',async kind=>{
 const command=familyCommand(kind,{schoolId:scope.schoolId,invitationId:invitation.invitationId,...(kind==='end'?{confirmation:'END_FAMILY_ACCESS'}:{})},id(9)),status=kind==='end'?'ENDED':'REVOKED';
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(reply({data:{...invitation,status}}));await expect(familyAccessApi.send(command)).resolves.toMatchObject({status});
 expect(fetch.mock.calls[0]![1]).toMatchObject({referrerPolicy:'no-referrer',body:command.body,headers:{'Idempotency-Key':command.key}});
 for(const change of [{schoolId:id(91)},{invitationId:id(92)},{status:kind==='end'?'REVOKED':'ENDED'},{extra:'private'}]){fetch.mockResolvedValue(reply({data:{...invitation,status,...change}}));await expect(familyAccessApi.send(command)).rejects.toMatchObject({kind:'UNKNOWN'});}
});
