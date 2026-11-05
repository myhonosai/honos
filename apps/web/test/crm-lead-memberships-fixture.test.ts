import { expect, it, vi, afterEach } from 'vitest';
import { readLeadMemberships } from '../src/components/crm-lead-memberships-http';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={organizationId:id(1),schoolId:id(2),leadId:id(3)};
afterEach(()=>vi.unstubAllGlobals());
it.each([['adult',1],['family',2],['empty',0]])('the synthetic %s browser fixture obeys the real closed frontend transport',async(mode,count)=>{
  const location=new URL('../scripts/crm-lead-memberships-browser.mjs',import.meta.url).href;
  const {createLeadMembershipRecoveryFixture}=await import(location);
  const fixture=createLeadMembershipRecoveryFixture({id,scope:{organizationId:scope.organizationId,schoolId:scope.schoolId},origin:'http://127.0.0.1',
    send:(res:any,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'private, no-store'});res.end(JSON.stringify({data,meta:{requestId:id(8),correlationId:id(8),replayed:false}}));},
    rejected:()=>{throw new Error('Unexpected fixture refusal');}});
  fixture.reset(mode);
  vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
    let status=0,headers:Record<string,string>={},body='';const res={writeHead:(s:number,h:Record<string,string>)=>{status=s;headers=h;},end:(s:string)=>{body=s;}};
    expect(await fixture.handle({method:'GET',headers:{}},res,new URL(path.slice(4),'http://127.0.0.1'))).toBe(true);
    return new Response(body,{status,headers});
  }));
  const data=await readLeadMemberships(scope,new AbortController().signal);
  expect(data.memberships).toHaveLength(count);expect(data.leadId).toBe(scope.leadId);
});
