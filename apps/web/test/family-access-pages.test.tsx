import { afterEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({token:'synthetic-token-a',subject:'synthetic-subject-a',invalid:false}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>({value:state.token})})}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
vi.mock('@hon/auth',()=>({HON_SESSION_COOKIE:'hon_session',sessionConfig:()=>({}),verifySession:()=>{if(state.invalid)throw new Error('invalid');return{externalSubject:state.subject};}}));
import ManagePage from '../src/app/staff/family-access/page';
import AcceptPage from '../src/app/account/family-invitation/page';
afterEach(()=>{state.token='synthetic-token-a';state.subject='synthetic-subject-a';state.invalid=false;vi.restoreAllMocks();});
it.each([['management',ManagePage],['acceptance',AcceptPage]] as const)('%s gate passes verified identity only and no role/email/family from URLs',async(_,Page)=>{
 const fetch=vi.spyOn(globalThis,'fetch'),view=await Page();expect(view.props).toMatchObject({sessionSubject:state.subject});expect(view.props).not.toHaveProperty('schoolId');expect(view.props).not.toHaveProperty('email');expect(view.props).not.toHaveProperty('token');expect(String(view.key)).not.toContain(state.token);expect(fetch).not.toHaveBeenCalled();
});
it.each([['management',ManagePage],['acceptance',AcceptPage]] as const)('%s denies invalid sessions before rendering',async(_,Page)=>{state.invalid=true;await expect(Page()).rejects.toThrow('REDIRECT /auth/login');});
it.each([['management',ManagePage],['acceptance',AcceptPage]] as const)('%s starts a fresh component lifetime after session replacement',async(_,Page)=>{
 const first=await Page();state.token='synthetic-token-b';state.subject='synthetic-subject-b';const second=await Page();expect(second.key).not.toEqual(first.key);expect(second.props).toMatchObject({sessionSubject:state.subject});
});
