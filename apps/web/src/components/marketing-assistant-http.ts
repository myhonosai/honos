import { validateMarketingDraft, type MarketingInvocationView } from '@hon/contracts';
const base='/api/v1/marketing/assistant';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export class MarketingUiError extends Error { constructor(readonly status:number) { super(status===401?'Sign in again.':status===403?'Current Complete school owner permission is unavailable.':'No verified result. Retain the request key and refresh durable status; never resend an unknown provider outcome.'); } }
export async function marketingRequest(url:string,body?:object,key?:string):Promise<unknown> {
  const parsed=new URL(url,'https://hon.invalid'); const parts=parsed.pathname.slice(base.length).split('/').filter(Boolean);
  const allowed=parsed.pathname===base || (parts.length===1&&uuid.test(parts[0]!)) || (parts.length===2&&uuid.test(parts[0]!)&&['retry','save-approved'].includes(parts[1]!)) || (parts.length===3&&parts[0]==='campaigns'&&uuid.test(parts[1]!)&&parts[2]==='content');
  if(!url.startsWith(base)||parsed.origin!=='https://hon.invalid'||parsed.search||parsed.hash||!allowed) throw new Error('Only fixed same-origin marketing requests are allowed.');
  const r=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:body?{'Content-Type':'application/json','X-HON-Human-Command':'marketing-assistant',...(key?{'Idempotency-Key':key}:{})}:{},...(body?{body:JSON.stringify(body)}:{})});
  if(r.redirected || (r.url && new URL(r.url,window.location.origin).origin!==window.location.origin)) throw new Error('Untrusted response.');
  if(!r.ok) throw new MarketingUiError(r.status);
  const v=await r.json() as {data?:unknown}; if(!v||typeof v!=='object'||!Object.hasOwn(v,'data')) throw new Error('Unverified marketing response.'); return v.data;
}
export function verifyMarketingView(v:unknown,campaignId?:string,invocationId?:string):MarketingInvocationView {
  const keys=['id','schoolId','campaignId','workItemId','status','reason','actionRequestId','draft','inputTokens','outputTokens','providerCostMicrounits','customerCredits'];
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))) throw new Error('Unverified marketing response.');
  const r=v as MarketingInvocationView;
  if([r.id,r.schoolId,r.campaignId,r.workItemId].some(i=>typeof i!=='string'||!uuid.test(i)) || (campaignId&&r.campaignId!==campaignId) || (invocationId&&r.id!==invocationId) || !['PENDING','CONFIGURATION_REQUIRED','BLOCKED','SENDING','UNKNOWN','FAILED','AWAITING_APPROVAL','SAVED','REJECTED'].includes(r.status) || (r.reason!==null&& !['CONFIGURATION_REQUIRED','NO_ELIGIBLE_ROUTE','CUSTOMER_BUDGET_EXCEEDED','UNSUPPORTED_PROVIDER','INVALID_REQUEST','PROVIDER_REJECTED','PROVIDER_UNKNOWN','ROUTE_STALE','RESULT_BUDGET_EXCEEDED'].includes(r.reason)) || (r.actionRequestId!==null&&!uuid.test(r.actionRequestId)) || [r.inputTokens,r.outputTokens,r.providerCostMicrounits,r.customerCredits].some(n=>n!==null&&(!Number.isSafeInteger(n)||n<0))) throw new Error('Unverified marketing response.');
  if(r.draft!==null) validateMarketingDraft(r.draft);
  if(['AWAITING_APPROVAL','SAVED','REJECTED'].includes(r.status)&&(!r.draft||!r.actionRequestId)) throw new Error('Missing exact draft binding.');
  return r;
}
