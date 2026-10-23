import {afterEach,describe,it,expect,vi} from 'vitest';
import {HQ_OVERVIEW_UNAVAILABLE_REASONS,SAAS_COMMANDS} from '@hon/contracts';
import {createOfferFixtures,syntheticSetInput} from '../scripts/fixtures/hq-offers.mjs';
import {readPricingAccess,preparePricingRequest,sendPricingRequest,readPricingSet} from '../src/components/hq-modern/pricing-offers-http';
const subject='synthetic-owner',key=()=>crypto.randomUUID();
function setup(){
  const f=createOfferFixtures();let identity=subject,role='OWNER',deny=false,lose=false,drift=false;
  const calls:{path:string;options:RequestInit}[]=[];
  const overview=()=>({asOf:'2026-10-23T12:00:00.000Z',callerHqRole:role,organizationCount:0,schoolCount:0,onboarding:{availability:'AVAILABLE',requestCount:0,inProgressRequestCount:0,completedRequestCount:0},configuredProviderStates:{disabled:0,configured:0,healthy:0,degraded:0,unavailable:0},taskProfileCount:0,financialMetrics:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.financialMetrics},aiUsage:{availability:'UNAVAILABLE',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.aiUsage},durableHqWork:{availability:'UNAVAILABLE',state:'NO_RECORDED_WORK',reason:HQ_OVERVIEW_UNAVAILABLE_REASONS.durableHqWork}});
  const fetch=vi.fn(async(path:string,options:RequestInit={})=>{
    calls.push({path,options});const reply=(data:unknown,status=200)=>new Response(JSON.stringify(status===200?{data}:{code:data}),{status,headers:{'Content-Type':'application/json','Cache-Control':'private, no-store'}});
    if(path==='/api/v1/identity/me')return reply({externalSubject:identity});
    if(deny)return reply('SAAS_FORBIDDEN',403);if(path==='/api/v1/hq/overview')return reply({overview:overview()});
    if(options.method==='GET')return reply(path==='/api/v1/hq/saas/offers'?f.management():f.detail(path.split('/').at(-1)!));
    const parts=path.split('/'),kind=path.endsWith('/sets')?'create':path.endsWith('/stop-sales')?'stop':parts.at(-1)!,target=kind==='create'?null:parts.at(-2)!;
    const result=f.command(kind,target,JSON.parse(options.body as string),new Headers(options.headers).get('Idempotency-Key')!,identity);
    if(lose){lose=false;throw new DOMException('lost response','TimeoutError');}return reply(drift?{...result,chargesEnabled:true}:result);
  });vi.stubGlobal('fetch',fetch);
  return{f,calls,fetch,identity:(s:string)=>{identity=s;},role:(s:string)=>{role=s;},deny:()=>{deny=true;},lose:()=>{lose=true;},drift:()=>{drift=true;}};
}
afterEach(()=>vi.unstubAllGlobals());
describe('fixed HQ offer APIs and closed verified commands',()=>{
  it('freshly verifies identity, billing access and owner role before an exact complete-set command',async()=>{
    const s=setup(),r=preparePricingRequest('create',null,syntheticSetInput(),key(),subject);expect(Object.isFrozen(r)).toBe(true);
    const result=await sendPricingRequest(r);expect(result.kind).toBe('create');
    const post=s.calls.find(c=>c.options.method==='POST')!;expect(post.path).toBe('/api/v1/hq/saas/offers/sets');expect(post.options.body).toBe(r.body);expect(post.options).toMatchObject({mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
    expect(post.options.headers).toMatchObject({'X-HON-Human-Command':SAAS_COMMANDS.createOfferSetDraft,'Idempotency-Key':r.key});
    expect(s.calls.slice(0,s.calls.indexOf(post)).some(c=>c.path==='/api/v1/hq/saas/offers')).toBe(true);
  });
  it('denies changed identity, revoked billing access and operators before any mutation',async()=>{
    for(const mode of ['identity','billing','operator']){const s=setup(),r=preparePricingRequest('create',null,syntheticSetInput(),key(),subject);
      if(mode==='identity')s.identity('another-owner');if(mode==='billing')s.deny();if(mode==='operator')s.role('OPERATOR');
      await expect(sendPricingRequest(r)).rejects.toBeDefined();expect(s.calls.filter(c=>c.options.method==='POST')).toHaveLength(0);vi.unstubAllGlobals();}
  });
  it('retains exact retry after a real-shaped committed response is lost and does not duplicate the action',async()=>{
    const s=setup(),r=preparePricingRequest('create',null,syntheticSetInput(),key(),subject);s.lose();await expect(sendPricingRequest(r)).rejects.toMatchObject({code:'UNKNOWN',uncertain:true});
    expect(s.f.mutations).toBe(1);const replay=await sendPricingRequest(r,true);expect(replay.data.replayed).toBe(true);expect(s.f.mutations).toBe(1);
    const posts=s.calls.filter(c=>c.options.method==='POST');expect(posts[0]!.options.body).toBe(posts[1]!.options.body);expect(posts[0]!.options.headers).toEqual(posts[1]!.options.headers);
  });
  it('refuses a stale revision or changed publication digest before sending, while exact replay bypasses a now-advanced lifecycle',async()=>{
    const s=setup(),d=s.f.detail(s.f.draftId);const r=preparePricingRequest('publish',d.set.setId,{expectedRevision:1,previewDigest:d.preview.previewDigest,approval:'APPROVE_FOR_NEW_PURCHASES_ONLY'},key(),subject);
    s.f.sets.get(d.set.setId)!.revision=2;await expect(sendPricingRequest(r)).rejects.toMatchObject({code:'SAAS_VERSION_CONFLICT'});expect(s.f.mutations).toBe(0);
    s.f.sets.get(d.set.setId)!.revision=1;s.f.sets.get(d.set.setId)!.termsReference='Changed';await expect(sendPricingRequest(r)).rejects.toMatchObject({code:'SAAS_OFFER_PREVIEW_CHANGED'});expect(s.f.mutations).toBe(0);
  });
  it('does not trust drifted success, foreign detail IDs, unsafe selectors or extra input fields',async()=>{
    const s=setup(),r=preparePricingRequest('create',null,syntheticSetInput(),key(),subject);s.drift();await expect(sendPricingRequest(r)).rejects.toMatchObject({code:'UNKNOWN',uncertain:true});
    expect(()=>preparePricingRequest('create',null,{...syntheticSetInput(),currency:'USD'},key(),subject)).toThrow();await expect(readPricingSet('../foreign')).rejects.toThrow();
    const data=s.f.detail(s.f.draftId);vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data}),{headers:{'content-type':'application/json','cache-control':'private, no-store'}})));
    await expect(readPricingSet(s.f.originalId)).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
});
