import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FamilyAccessController } from '../src/components/family-access/controller';
import { FamilyAccessError, type FamilyAccessApi } from '../src/components/family-access/http';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope = { organizationId:id(1),schoolId:id(2) };
const family = {id:id(3),displayName:'Private Family A',status:'ACTIVE' as const,version:1,memberCount:2,createdAt:'2026-11-04T00:00:00Z'};
const invitation = { invitationId:id(4),schoolId:scope.schoolId,familyId:family.id,familyName:family.displayName,accessLevel:'PRIMARY_GUARDIAN' as const,email:'guardian@example.test',expiresAt:'2026-11-05T00:00:00Z',status:'PENDING' as const };
const token = 'x'.repeat(43);
let api: FamilyAccessApi, c: FamilyAccessController, key: ReturnType<typeof vi.fn>;
beforeEach(()=>{
 api={identity:vi.fn().mockResolvedValue(undefined),load:vi.fn().mockResolvedValue({families:[family],invitations:[invitation]}),send:vi.fn().mockResolvedValue(invitation)};
 key=vi.fn(()=>id(9));c=new FamilyAccessController('owner-a',scope,api,key,()=>token);
});
afterEach(()=>{c.dispose();vi.restoreAllMocks();});
const ticks=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
async function prepare(){await c.load();c.choose(family.id,c.snapshot().revision);return c.snapshot().revision;}
const invite=(revision=c.snapshot().revision)=>c.invite(invitation.email,'PRIMARY_GUARDIAN',24,true,revision);
it('reveals only canonical family records after identity, exact-scope manager read and final same-subject verification',async()=>{
 await c.load();expect(api.identity).toHaveBeenCalledTimes(2);expect(api.load).toHaveBeenCalledWith(scope,expect.any(AbortSignal));expect(c.snapshot().families).toEqual([family]);
 expect(vi.mocked(api.identity).mock.invocationCallOrder[1]).toBeGreaterThan(vi.mocked(api.load).mock.invocationCallOrder[0]!);
});
it('does not accept a forged or inactive family selection or permit an unconfirmed invite',async()=>{
 await c.load();c.choose(id(88),c.snapshot().revision);await invite();expect(api.send).not.toHaveBeenCalled();expect(key).not.toHaveBeenCalled();
 c.choose(family.id,c.snapshot().revision);await c.invite(invitation.email,'PRIMARY_GUARDIAN',24,false,c.snapshot().revision);expect(key).not.toHaveBeenCalled();
});
it.each(['SESSION','IDENTITY','DENIED'] as const)('clears a returned family list when final identity verification returns %s',async kind=>{
 vi.mocked(api.identity).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new FamilyAccessError(kind));await c.load();expect(c.snapshot()).toMatchObject({phase:kind,families:[],invitations:[]});
});
it('late family response after concealment cannot reveal private records',async()=>{
 let settle!:(v:Awaited<ReturnType<FamilyAccessApi['load']>>)=>void;vi.mocked(api.load).mockImplementationOnce(()=>new Promise(r=>{settle=r;}));
 const task=c.load();await ticks();c.conceal();settle({families:[family],invitations:[invitation]});await task;
 expect(c.snapshot()).toMatchObject({phase:'CONCEALED',families:[],invitations:[]});await c.load();expect(c.snapshot().phase).toBe('READY');
});
it.each(['SESSION','IDENTITY'] as const)('keeps %s terminal after blur, cleanup and activation',async kind=>{
 vi.mocked(api.identity).mockRejectedValueOnce(new FamilyAccessError(kind));await c.load();c.conceal();c.dispose();c.activate();await c.load();expect(c.snapshot().phase).toBe(kind);expect(api.identity).toHaveBeenCalledOnce();
});
it('synchronously retires double-click handlers before identity/network completion and generates one key',async()=>{
 const revision=await prepare();let settle!:()=>void;vi.mocked(api.identity).mockImplementationOnce(()=>new Promise<void>(r=>{settle=r;}));const task=invite(revision);await invite(revision);expect(key).toHaveBeenCalledOnce();expect(c.snapshot().active).toBe(true);settle();await task;expect(api.send).toHaveBeenCalledOnce();
});
it('allows a pending command to settle behind concealment without leaking receipt, token or family; restores only through fresh authorization',async()=>{
 await prepare();let settle!:(v:typeof invitation)=>void;vi.mocked(api.send).mockImplementationOnce(()=>new Promise(r=>{settle=r;}));const task=invite();await ticks();c.conceal();
 expect(c.snapshot()).toMatchObject({phase:'CONCEALED',families:[],receipt:null,share:null,active:true,retained:true});c.abandon(true,c.snapshot().revision);expect(c.snapshot().retained).toBe(true);
 settle(invitation);await task;expect(c.snapshot()).toMatchObject({active:false,receipt:null,share:null});await c.load();expect(c.snapshot().share).toEqual({invitationId:invitation.invitationId,token});expect(api.send).toHaveBeenCalledOnce();
});
it('retains only the exact UNKNOWN URL/body/key across ordinary concealment and explicit restoration/retry',async()=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('UNKNOWN'));await invite();const original=vi.mocked(api.send).mock.calls[0]![0];
 c.conceal();expect(c.snapshot().recovery).toBeNull();await c.load();await c.retry(c.snapshot().revision);
 expect(vi.mocked(api.send).mock.calls[1]![0]).toBe(original);expect(key).toHaveBeenCalledOnce();expect(original).toMatchObject({path:'/api/v1/school/family-access-invitations',key:id(9)});expect(JSON.parse(original.body).token).toBe(token);
});
it('never replaces an uncertain invite through selection, another submit or unconfirmed abandonment',async()=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('UNKNOWN'));await invite();c.choose(family.id,c.snapshot().revision);await invite();c.abandon(false,c.snapshot().revision);
 expect(key).toHaveBeenCalledOnce();expect(api.send).toHaveBeenCalledOnce();expect(c.snapshot().retained).toBe(true);
});
it('deliberate UNKNOWN abandonment retires callbacks and requires a fresh read before preparing another action',async()=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('UNKNOWN'));await invite();const revision=c.snapshot().revision;c.abandon(true,revision);await invite(revision);await invite();
 expect(key).toHaveBeenCalledOnce();expect(c.snapshot()).toMatchObject({retained:false,needsRefresh:true});await c.load();c.choose(family.id,c.snapshot().revision);await invite();expect(key).toHaveBeenCalledTimes(2);
});
it.each(['success','conflict'] as const)('retained submit after %s cannot generate a new key or command',async kind=>{
 const revision=await prepare();if(kind==='conflict')vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('REJECTED','ACCOUNT_CONFLICT'));
 await invite(revision);await invite(revision);await invite();expect(key).toHaveBeenCalledOnce();expect(api.send).toHaveBeenCalledOnce();expect(c.snapshot().needsRefresh).toBe(true);
});
it('fresh read and explicit reconfirmation permit a legitimate new request after settlement',async()=>{
 await prepare();await invite();await c.load();c.choose(family.id,c.snapshot().revision);await invite();expect(api.send).toHaveBeenCalledTimes(2);
});
it('edits retire an old confirmed form callback before a new command can be prepared',async()=>{
 const revision=await prepare();expect(c.review(revision)).toBe(true);await invite(revision);expect(key).not.toHaveBeenCalled();expect(api.send).not.toHaveBeenCalled();
});
it('a read replacement retires old selected-family submissions',async()=>{
 const revision=await prepare();await c.load();await invite(revision);expect(key).not.toHaveBeenCalled();expect(c.snapshot().selected).toBe('');
});
it('definitive authorization loss hides information and is never treated as an empty family result',async()=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('DENIED','ACCOUNT_FORBIDDEN'));await invite();expect(c.snapshot()).toMatchObject({phase:'DENIED',families:[],invitations:[],retained:false});
});
it('NOT_SUBMITTED uses an explicit same-key retry, never an automatic command',async()=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('NOT_SUBMITTED','ACCOUNT_BUSY'));await invite();expect(api.send).toHaveBeenCalledOnce();expect(c.snapshot().recovery).toBe('NOT_SUBMITTED');await c.retry(c.snapshot().revision);expect(key).toHaveBeenCalledOnce();expect(vi.mocked(api.send).mock.calls[0]![0]).toBe(vi.mocked(api.send).mock.calls[1]![0]);
});
it('revoke/end are limited to the selected canonical family and appropriate recorded invitation status',async()=>{
 await prepare();await c.change(id(99),'revoke',true,c.snapshot().revision);await c.change(invitation.invitationId,'end',true,c.snapshot().revision);expect(key).not.toHaveBeenCalled();
 vi.mocked(api.send).mockResolvedValue({...invitation,status:'REVOKED'});await c.change(invitation.invitationId,'revoke',true,c.snapshot().revision);expect(JSON.parse(vi.mocked(api.send).mock.calls[0]![0].body)).toEqual({schoolId:scope.schoolId,invitationId:invitation.invitationId});
});
it('a suspended/unavailable scope cannot retain action controls or use the draft revocation exception',async()=>{
 await prepare();vi.mocked(api.load).mockRejectedValue(new FamilyAccessError('DENIED'));await c.load();await c.change(invitation.invitationId,'revoke',true,c.snapshot().revision);expect(api.send).not.toHaveBeenCalled();expect(c.snapshot().invitations).toEqual([]);
});
it('unmounted or session-invalidated retained callbacks cannot prepare a request',async()=>{
 const revision=await prepare();c.conceal(true);await invite(revision);c.dispose();await invite(c.snapshot().revision);expect(key).not.toHaveBeenCalled();
});
it('acceptance uses only the closed invitation input after an explicit identity read; no email/body role claims',async()=>{
 c.dispose();c=new FamilyAccessController('parent-a',null,api,key);await c.accept(invitation.invitationId,token,true,c.snapshot().revision);expect(key).not.toHaveBeenCalled();await c.load();
 vi.mocked(api.send).mockResolvedValue({invitationId:invitation.invitationId,schoolId:scope.schoolId,familyId:family.id,accessLevel:'PRIMARY_GUARDIAN',accountStatus:'FAMILY_ACCESS_BOUND',accessGranted:false,billingActivated:false,aiCreditsGranted:false});await c.accept(invitation.invitationId,token,true,c.snapshot().revision);
 expect(JSON.parse(vi.mocked(api.send).mock.calls[0]![0].body)).toEqual({invitationId:invitation.invitationId,token,confirmation:'ACCEPT_FAMILY_ACCESS_INVITATION'});expect(api.load).not.toHaveBeenCalled();
});
it('mixed identity ACCOUNT_REVIEW_REQUIRED is terminal in the acceptance view and cannot be retried after blur or another read',async()=>{
 c.dispose();c=new FamilyAccessController('parent-a',null,api,key);await c.load();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('REJECTED','ACCOUNT_REVIEW_REQUIRED'));await c.accept(invitation.invitationId,token,true,c.snapshot().revision);c.conceal();await c.load();await c.accept(invitation.invitationId,token,true,c.snapshot().revision);expect(api.send).toHaveBeenCalledOnce();expect(c.snapshot().phase).toBe('REVIEW');
});
it('post-command identity changes keep validated settlement private until same-actor restoration',async()=>{
 await prepare();let settle!:(v:typeof invitation)=>void;vi.mocked(api.send).mockImplementationOnce(()=>new Promise(r=>{settle=r;}));const task=invite();await ticks();vi.mocked(api.identity).mockRejectedValue(new FamilyAccessError('IDENTITY'));settle(invitation);await task;
 expect(c.snapshot()).toMatchObject({phase:'IDENTITY',receipt:null,share:null,retained:true});vi.mocked(api.identity).mockResolvedValue(undefined);await c.load();expect(c.snapshot().receipt).toEqual(invitation);expect(api.send).toHaveBeenCalledOnce();
});
it.each(['DENIED','SESSION','REJECTED'] as const)('an UNKNOWN request survives a later %s and can only reconcile its exact original identity',async kind=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('UNKNOWN'));await invite();const original=vi.mocked(api.send).mock.calls[0]![0];
 if(kind==='REJECTED')vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('REJECTED','ACCOUNT_CONFLICT'));else vi.mocked(api.identity).mockRejectedValueOnce(new FamilyAccessError(kind));
 await c.retry(c.snapshot().revision);expect(c.snapshot().retained).toBe(true);expect(c.snapshot().receipt).toBeNull();vi.mocked(api.identity).mockResolvedValue(undefined);await c.load();await c.retry(c.snapshot().revision);expect(vi.mocked(api.send).mock.calls.at(-1)![0]).toBe(original);expect(key).toHaveBeenCalledOnce();
});
it('school-context changes retire old actions and demand an explicit fresh exact-scope binding',async()=>{
 const revision=await prepare(),reads=vi.mocked(api.load).mock.calls.length;c.contextChanged();await invite(revision);await c.load();await c.load({organizationId:id(77),schoolId:id(88)});
 expect(key).not.toHaveBeenCalled();expect(api.load).toHaveBeenCalledTimes(reads);expect(c.snapshot()).toMatchObject({phase:'CONTEXT',families:[],invitations:[]});
 await c.load(scope);expect(c.snapshot().phase).toBe('READY');expect(c.snapshot().selected).toBe('');c.choose(family.id,c.snapshot().revision);await invite();expect(api.send).toHaveBeenCalledOnce();
});
it('UNKNOWN recovery stays owned by its original school during context edits and cannot become a new school command',async()=>{
 await prepare();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('UNKNOWN'));await invite();const original=vi.mocked(api.send).mock.calls[0]![0];c.contextChanged();await c.load({organizationId:id(77),schoolId:id(88)});await c.retry(c.snapshot().revision);
 expect(c.snapshot().retained).toBe(true);expect(api.send).toHaveBeenCalledOnce();expect(key).toHaveBeenCalledOnce();await c.load(scope);await c.retry(c.snapshot().revision);expect(vi.mocked(api.send).mock.calls[1]![0]).toBe(original);
});
it('a settled command during a school switch stays private and fresh original-scope restoration never resends it',async()=>{
 await prepare();let finish!:(v:typeof invitation)=>void;vi.mocked(api.send).mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const task=invite();await ticks();c.contextChanged();finish(invitation);await task;expect(c.snapshot()).toMatchObject({phase:'CONTEXT',receipt:null,share:null,retained:true,active:false});
 await c.load(scope);expect(c.snapshot().receipt).toEqual(invitation);expect(api.send).toHaveBeenCalledOnce();
});
it('unknown acceptance followed by review-required retains evidence but latches further consequential retries',async()=>{
 c.dispose();c=new FamilyAccessController('parent-a',null,api,key);await c.load();vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('UNKNOWN'));await c.accept(invitation.invitationId,token,true,c.snapshot().revision);
 vi.mocked(api.send).mockRejectedValueOnce(new FamilyAccessError('REJECTED','ACCOUNT_REVIEW_REQUIRED'));await c.retry(c.snapshot().revision);expect(c.snapshot()).toMatchObject({retained:true,reviewRequired:true,recovery:'UNKNOWN'});
 await c.retry(c.snapshot().revision);await c.load();await c.retry(c.snapshot().revision);expect(api.send).toHaveBeenCalledTimes(2);expect(key).toHaveBeenCalledOnce();expect(c.snapshot().retained).toBe(true);
 c.abandon(true,c.snapshot().revision);expect(c.snapshot()).toMatchObject({retained:false,reviewRequired:true,phase:'REVIEW'});await c.load();await c.accept(invitation.invitationId,token,true,c.snapshot().revision);expect(api.send).toHaveBeenCalledTimes(2);
});

it('scope changes remain explicit binding requirements after later blur concealment',async()=>{await prepare();c.contextChanged();c.conceal();expect(c.snapshot().phase).toBe('CONTEXT');await c.load();expect(c.snapshot().phase).toBe('CONTEXT');await c.load(scope);expect(c.snapshot().phase).toBe('READY');});

it('copies and freezes the original school binding instead of retaining a caller-mutable selector',()=>{const value={...scope};c.dispose();c=new FamilyAccessController('owner-a',value,api,key);value.schoolId=id(77);expect(c.scope).toEqual(scope);expect(Object.isFrozen(c.scope)).toBe(true);});
it('a read deadline produces unavailable recovery rather than a permanently loading view',async()=>{
 const timeout=new AbortController();vi.spyOn(AbortSignal,'timeout').mockReturnValueOnce(timeout.signal);
 vi.mocked(api.load).mockImplementationOnce((_,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Deadline','TimeoutError')),{once:true})));
 const task=c.load();await ticks();timeout.abort();await task;expect(c.snapshot().phase).toBe('UNAVAILABLE');vi.mocked(AbortSignal.timeout).mockRestore();await c.load();expect(c.snapshot().phase).toBe('READY');
});
it('unavailable post-command identity verification hides all private facts and retains settlement without resending',async()=>{
 await prepare();vi.mocked(api.identity).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new FamilyAccessError('READ'));await invite();
 expect(c.snapshot()).toMatchObject({phase:'UNAVAILABLE',families:[],receipt:null,share:null,retained:true});await c.load();expect(c.snapshot().receipt).toEqual(invitation);expect(api.send).toHaveBeenCalledOnce();
});
