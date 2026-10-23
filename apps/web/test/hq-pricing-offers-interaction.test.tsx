import {describe,it,expect,vi} from 'vitest';
import {PricingController} from '../src/components/hq-modern/pricing-offers-controller';
import {PricingError,type PricingApi,type PricingRequest,type PricingReceipt} from '../src/components/hq-modern/pricing-offers-http';
import {createOfferFixtures} from '../scripts/fixtures/hq-offers.mjs';
function setup(owner=true){
  const fixture=createOfferFixtures();let allowed=owner,subject='owner';
  const access=vi.fn(async(expected?:string)=>{if(expected&&subject!==expected)throw new PricingError('IDENTITY_CHANGED',401);return{subject,owner:allowed,management:fixture.management()};});
  const send=vi.fn(async(request:PricingRequest,_retry=false)=>({kind:request.kind,data:fixture.command(request.kind,request.target,JSON.parse(request.body),request.key,request.subject)}) as PricingReceipt);
  const api:PricingApi={access,detail:async id=>fixture.detail(id),send},c=new PricingController(api);
  return{c,fixture,api,send,access,setOwner:(v:boolean)=>{allowed=v;},setSubject:(v:string)=>{subject=v;}};
}
const deferred=<T,>()=>{let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function edit(s:ReturnType<typeof setup>){await s.c.load();await s.c.open(s.fixture.draftId);s.c.editOffer('amount','321.45');}
describe('operational pricing controller, explicit commands and independent read/command lifetimes',()=>{
  it('loads real-shaped records without commands and saves all six offers with exact revision after explicit action',async()=>{
    const s=setup();await edit(s);expect(s.send).not.toHaveBeenCalled();await s.c.save();expect(s.send).toHaveBeenCalledTimes(1);
    const request=s.send.mock.calls[0]![0],body=JSON.parse(request.body);expect(body.offers).toHaveLength(6);expect(body.expectedRevision).toBe(1);expect(body.offers[0].priceMinor).toBe(32145);
    expect(s.c.snapshot().receipt?.kind).toBe('revise');expect(s.c.snapshot().detail?.set.revision).toBe(2);expect(s.c.dirty()).toBe(false);
  });
  it('preserves all edited fields while switching options and never writes a per-option save',async()=>{
    const s=setup();await edit(s);const first=s.c.snapshot().selected!,other=s.c.snapshot().form!.offers[1]!.key;
    s.c.editOffer('aiFairUseReference','Unfinished terms');s.c.selectOffer(other);s.c.editOffer('annualRenewal','AUTO_RENEW_AT_CURRENT_PRICE');s.c.selectOffer(first);
    expect(s.c.snapshot().form!.offers[0]!.amount).toBe('321.45');expect(s.c.snapshot().form!.offers[0]!.aiFairUseReference).toBe('Unfinished terms');expect(s.send).not.toHaveBeenCalled();
  });
  it('guards replacing a dirty set; Continue, local save/restore and deliberate discard preserve the right copy',async()=>{
    const s=setup();await edit(s);await s.c.open(null);expect(s.c.snapshot().intent).toBeTruthy();await s.c.decide('continue');expect(s.c.snapshot().form!.offers[0]!.amount).toBe('321.45');
    await s.c.open(null);await s.c.decide('save');expect(s.c.snapshot().localCopies).toContain(s.fixture.draftId);expect(s.c.snapshot().form!.offers).toHaveLength(0);
    await s.c.restoreLocal(s.fixture.draftId);expect(s.c.snapshot().form!.offers[0]!.amount).toBe('321.45');await s.c.open(s.fixture.originalId);await s.c.decide('discard');
    expect(s.c.snapshot().detail!.set.status).toBe('PUBLISHED');expect(s.c.snapshot().localCopies).toContain(s.fixture.draftId);expect(s.send).not.toHaveBeenCalled();
  });
  it('retains incomplete new-set local copies and allows explicit restoration without backend writes',async()=>{
    const s=setup();await s.c.load();await s.c.open(null);s.c.addOffer('FOUNDER_LIFETIME');s.c.editOffer('amount','31.');await s.c.open(s.fixture.draftId);await s.c.decide('save');
    const key=s.c.snapshot().localCopies[0]!;await s.c.restoreLocal(key);expect(s.c.snapshot().form!.offers[0]!.amount).toBe('31.');expect(s.c.snapshot().form!.setId).toBeNull();expect(s.send).not.toHaveBeenCalled();
  });
  it('publishes only a saved reviewed complete set with explicit acknowledgement and the server digest',async()=>{
    const s=setup();await edit(s);await s.c.review();expect(s.c.snapshot().review).toBeNull();await s.c.save();await s.c.review();const digest=s.c.snapshot().review!.preview.previewDigest;
    await s.c.publish();expect(s.send).toHaveBeenCalledTimes(1);s.c.acknowledge(true);await s.c.publish();expect(s.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(s.send.mock.calls[1]![0].body)).toEqual({expectedRevision:2,previewDigest:digest,approval:'APPROVE_FOR_NEW_PURCHASES_ONLY'});
    expect(s.fixture.detail(s.fixture.originalId).set.status).toBe('RETIRED');expect(s.c.snapshot().detail!.set.status).toBe('PUBLISHED');expect(s.fixture.management().chargesEnabled).toBe(false);
  });
  it('blocks unauthorized writes and never edits a published historical price',async()=>{
    const s=setup(false);await s.c.load();await s.c.open(s.fixture.draftId);s.c.editOffer('amount','999');await s.c.save();expect(s.send).not.toHaveBeenCalled();
    s.setOwner(true);await s.c.open(s.fixture.originalId);s.c.editOffer('amount','999');await s.c.save();expect(s.send).not.toHaveBeenCalled();expect(s.fixture.detail(s.fixture.originalId).set.offers[0]!.priceMinor).toBe(31700);
  });
  it('settles an in-flight command behind the shield without a read epoch unlocking or stranding it',async()=>{
    const s=setup();await edit(s);const original=s.api.send,wait=deferred<PricingReceipt>();s.api.send=vi.fn(()=>wait.promise);const run=s.c.save();const request=s.c.snapshot().pending!;
    s.c.conceal();expect(s.c.snapshot().busy).toBe(true);await s.c.abandon();expect(s.c.snapshot().pending).toBe(request);await s.c.load(true);expect(s.c.snapshot().concealed).toBe(true);
    wait.resolve(await original(request));await run;expect(s.c.snapshot().busy).toBe(false);expect(s.c.snapshot().concealed).toBe(true);await s.c.load(true);expect(s.c.snapshot().concealed).toBe(false);expect(s.c.snapshot().pending).toBeNull();
  });
  it('retains the exact unknown request across restoration and blocks duplicates and edits until explicit retry',async()=>{
    const s=setup();await edit(s);const original=s.api.send,wait=deferred<PricingReceipt>();s.api.send=vi.fn(()=>wait.promise);const run=s.c.save();await s.c.save();expect(s.api.send).toHaveBeenCalledTimes(1);const request=s.c.snapshot().pending!;
    s.c.conceal();wait.reject(new PricingError('UNKNOWN',0,true));await run;expect(s.c.snapshot().busy).toBe(false);expect(s.c.snapshot().pending).toBe(request);expect(s.c.snapshot().receipt).toBeNull();
    await s.c.load(true);s.c.editOffer('amount','999');expect(s.c.snapshot().form!.offers[0]!.amount).toBe('321.45');s.api.send=vi.fn(original);expect(s.api.send).not.toHaveBeenCalled();
    await s.c.retry();expect(s.api.send).toHaveBeenCalledWith(request,true);expect(s.c.snapshot().pending).toBeNull();
  });
  it('fails closed for expired sessions, switched identities, revoked owner access and repeated concealment during restoration',async()=>{
    const s=setup();await edit(s);s.c.conceal();s.setSubject('another-owner');await s.c.load(true);expect(s.c.snapshot().concealed).toBe(true);expect(s.c.snapshot().error!.code).toBe('IDENTITY_CHANGED');
    s.setSubject('owner');s.setOwner(false);await s.c.load(true);expect(s.c.snapshot().owner).toBe(false);await s.c.save();expect(s.send).not.toHaveBeenCalled();
    s.c.conceal();const wait=deferred<Awaited<ReturnType<PricingApi['access']>>>();s.api.access=vi.fn(()=>wait.promise);const restoration=s.c.load(true);s.c.conceal();wait.resolve({subject:'owner',owner:true,management:s.fixture.management()});await restoration;expect(s.c.snapshot().concealed).toBe(true);
  });
  it('invalidates publication review after edits, rejects stale results and distinguishes a verified receipt from failed refresh',async()=>{
    const s=setup();await s.c.load();await s.c.open(s.fixture.draftId);await s.c.review();s.c.acknowledge(true);s.c.editOffer('amount','323');expect(s.c.snapshot().review).toBeNull();
    s.api.send=vi.fn(async()=>{throw new PricingError('SAAS_VERSION_CONFLICT',409);});await s.c.save();expect(s.c.snapshot().pending).toBeTruthy();expect(s.c.snapshot().receipt).toBeNull();expect(s.c.snapshot().stale).toBe(true);
    const t=setup();await edit(t);t.api.access=vi.fn(async()=>{throw new PricingError('UNAVAILABLE');});await t.c.save();expect(t.c.snapshot().receipt?.kind).toBe('revise');expect(t.c.snapshot().stale).toBe(true);expect(t.c.snapshot().pending).toBeNull();
  });
});
