import { afterEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({token:'synthetic-token-a',subject:'synthetic-subject-a',invalid:false}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:state.token})})}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('@hon/auth',()=>({HON_SESSION_COOKIE:'hon_session',sessionConfig:()=>({}),verifySession:()=>{if(state.invalid)throw new Error('invalid');return{externalSubject:state.subject};}}));
import ManagePage from '../src/app/staff/family-access/page';
import AcceptPage from '../src/app/account/family-invitation/page';
// 0714: the acceptance page wraps the ID-and-code workspace as the fallback of the one-press activation; the email it
// shows is the signed session's own (none in this mock), never a URL value.
type Node={props:Record<string,unknown>;key:unknown};
const inner=(view:unknown):Node=>((view as Node).props.fallback??view) as Node;
it('acceptance shows the one-press activation with the session email only and the ID-and-code page as its fallback',async()=>{
 const view=await AcceptPage() as unknown as Node;expect(Object.keys(view.props).sort()).toEqual(['fallback','sessionEmail']);expect(view.props.sessionEmail).toBeNull();expect(String(view.key)).not.toContain(state.token);
});
afterEach(()=>{state.token='synthetic-token-a';state.subject='synthetic-subject-a';state.invalid=false;vi.restoreAllMocks();});
it.each([['management',ManagePage],['acceptance',AcceptPage]] as const)('%s gate passes verified identity only and no role/email/family from URLs',async(_,Page)=>{
 const fetch=vi.spyOn(globalThis,'fetch'),view=await Page({});expect(inner(view).props).toMatchObject({sessionSubject:state.subject});expect(view.props).not.toHaveProperty('schoolId');expect(view.props).not.toHaveProperty('email');expect(view.props).not.toHaveProperty('token');expect(String(view.key)).not.toContain(state.token);expect(fetch).not.toHaveBeenCalled();
});
it.each([['management',ManagePage],['acceptance',AcceptPage]] as const)('%s denies invalid sessions before rendering',async(_,Page)=>{state.invalid=true;await expect(Page({})).rejects.toThrow('REDIRECT /auth/login');});
it.each([['management',ManagePage],['acceptance',AcceptPage]] as const)('%s starts a fresh component lifetime after session replacement',async(_,Page)=>{
 const first=await Page({});state.token='synthetic-token-b';state.subject='synthetic-subject-b';const second=await Page({});expect(second.key).not.toEqual(first.key);expect(inner(second).props).toMatchObject({sessionSubject:state.subject});expect(inner(second).key).not.toEqual(inner(first).key);
});
it('management carries only a closed school selector pair as inert prefills without reading records',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch'),organizationId='00000000-0000-4000-8000-000000000001',schoolId='00000000-0000-4000-8000-000000000002';
 const view=await ManagePage({searchParams:Promise.resolve({organizationId,schoolId})});expect(view.props).toMatchObject({initialOrganizationId:organizationId,initialSchoolId:schoolId});expect(fetch).not.toHaveBeenCalled();
 const rejected=await ManagePage({searchParams:Promise.resolve({organizationId,schoolId,familyId:schoolId})});expect(rejected.props).not.toHaveProperty('initialSchoolId');
});
