import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {issueSession,SESSION_SECONDS} from '@hon/auth';
import Page from '../src/app/staff/crm/journey/page';
import {id} from './crm-journey-fixtures';
const state=vi.hoisted(()=>({token:''}));
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>state.token?{value:state.token}:undefined})}));
vi.mock('next/navigation',()=>({redirect:(path:string):never=>{throw new Error(`Redirect:${path}`);}}));
const config={mode:'OIDC' as const,audience:'journey-session-proof',secret:'synthetic-journey-session-secret-123456789012345'};
beforeEach(()=>{state.token='';vi.stubEnv('HON_AUTH_MODE',config.mode);vi.stubEnv('HON_SESSION_AUDIENCE',config.audience);vi.stubEnv('HON_SESSION_JWT_SECRET',config.secret);});
afterEach(()=>vi.unstubAllEnvs());
it.each(['missing','invalid','expired','forged'])('%s session cannot mount private journey memory',async kind=>{
 state.token=kind==='missing'?'':kind==='invalid'?'invalid':issueSession({externalSubject:'synthetic'},kind==='forged'?{...config,secret:'another-synthetic-journey-session-key-12345'}:config,Math.floor(Date.now()/1000)-(kind==='expired'?SESSION_SECONDS+1:0));
 await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow('Redirect:/auth/login');
});
it('binds mounted memory to the signed session and accepts only inert UUID selectors',async()=>{
 state.token=issueSession({externalSubject:'synthetic'},config);
 const p=await Page({searchParams:Promise.resolve({organizationId:id(1),schoolId:'not-a-school',leadId:id(3)})});
 expect(p.props.sessionSubject).toBe('synthetic');expect(p.props.initialScope).toEqual({organizationId:id(1),schoolId:''});expect(p.props.initialLeadId).toBe(id(3));expect(JSON.stringify(p)).not.toContain(state.token);
});
it.each(['organizationId','schoolId','leadId'] as const)('isolates mounted private memory when the %s selector changes',async field=>{
 state.token=issueSession({externalSubject:'synthetic'},config);
 const selectors={organizationId:id(1),schoolId:id(2),leadId:id(3)};
 const first=await Page({searchParams:Promise.resolve(selectors)});
 const next=await Page({searchParams:Promise.resolve({...selectors,[field]:id(20)})});
 expect(next.key).not.toBe(first.key);
 expect(next.props.sessionSubject).toBe(first.props.sessionSubject);
});
it('does not reset private memory solely for equivalent normalized UUID selectors',async()=>{
 state.token=issueSession({externalSubject:'synthetic'},config);
 const selectors={organizationId:'abcdefff-0000-4000-8000-000000000001',schoolId:id(2),leadId:id(3)};
 const first=await Page({searchParams:Promise.resolve(selectors)});
 const next=await Page({searchParams:Promise.resolve({...selectors,organizationId:selectors.organizationId.toUpperCase()})});
 expect(next.key).toBe(first.key);
});
