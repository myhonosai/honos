/** Isolated synthetic browser/unit fixtures only. These calculations are NEVER imported by application code. */
import {randomUUID,createHash} from 'node:crypto';
import {HON_OS_PRODUCT,SAAS_HON_OS_OFFER_KINDS,saasHonOsOfferBillingInterval,validateSaasHonOsOfferSetDraftInput,
  validateSaasHonOsOfferSetReviseInput,validateSaasHonOsOfferSetPublishInput,validateSaasHonOsOfferSetDiscardInput,validateSaasHonOsOfferStopSalesInput} from '@hon/contracts';
const T='2026-10-23T12:00:00.000Z';
const input=(kind,i)=>({offerCode:kind,offerKind:kind,displayName:'HON OS',priceMinor:[31700,317000,18300,183000,950000,640000][i],
  salesOpensAt:'2026-01-01T00:00:00.000Z',salesClosesAt:null,eligibility:kind.startsWith('FOUNDER')?'NEW_ORGANIZATIONS_ONLY':'ANY_ACTIVE_ORGANIZATION',
  saleLimit:kind.endsWith('LIFETIME')?20:null,priceLock:kind.endsWith('LIFETIME')?'NONE':'WHILE_CONTINUOUSLY_SUBSCRIBED',priceLockMonths:null,
  annualRenewal:kind.endsWith('ANNUAL')?'NO_AUTO_RENEWAL':null,plannedMonthlyPremiumCredits:12000,
  aiFairUseReference:'Synthetic fair-use terms',refundWindowDays:30,cancellationTiming:kind.endsWith('LIFETIME')?null:'END_OF_PAID_PERIOD'});
export const syntheticSetInput=()=>({basedOnSetId:null,termsReference:'Synthetic terms; not a commercial offer',founderTotalLimit:30,offers:SAAS_HON_OS_OFFER_KINDS.map(input)});
function responseOffer(value,position){return {...value,offerId:randomUUID(),position,billingInterval:saasHonOsOfferBillingInterval(value.offerKind),founder:value.offerKind.startsWith('FOUNDER'),currency:'USD',premiumCreditsStatus:'PLANNING_ONLY_NOT_A_CREDIT_GRANT',salesStop:null};}
const fail=(code,status)=>{throw Object.assign(new Error(code),{code,status});};
export function createOfferFixtures(){
  const sets=new Map(),requests=new Map();let next=1,mutations=0;
  const make=(body)=>{const set={setId:randomUUID(),setVersion:next++,productCode:'HON_OS',status:'DRAFT',revision:1,basedOnSetId:body.basedOnSetId??null,
    termsReference:body.termsReference,founderTotalLimit:body.founderTotalLimit,offers:body.offers.map((o,i)=>responseOffer(o,i+1)),approvedPreviewDigest:null,
    chargesEnabled:false,creditGrantsEnabled:false,createdAt:T,updatedAt:T,publishedAt:null,retiredAt:null,discardedAt:null};sets.set(set.setId,set);return set;};
  function preview(set){
    const monthly=set.offers.find(o=>o.offerKind==='REGULAR_MONTHLY');const issues=[];
    if(!set.termsReference)issues.push({code:'TERMS_REFERENCE_REQUIRED',offerCode:null});
    for(const o of set.offers){if(o.founder&&(!set.founderTotalLimit||set.founderTotalLimit<1))issues.push({code:'FOUNDER_LIMIT_REQUIRED',offerCode:o.offerCode});
      for(const [missing,code]of [[o.refundWindowDays===null,'REFUND_WINDOW_REQUIRED'],[o.billingInterval!=='ONE_TIME'&&o.cancellationTiming===null,'CANCELLATION_TIMING_REQUIRED'],[o.billingInterval==='ONE_TIME'&&!o.aiFairUseReference,'LIFETIME_FAIR_USE_REQUIRED'],[o.billingInterval==='ONE_TIME'&&!o.saleLimit,'LIFETIME_SALE_LIMIT_REQUIRED']])if(missing)issues.push({code,offerCode:o.offerCode});}
    return {setId:set.setId,revision:set.revision,previewDigest:createHash('sha256').update(JSON.stringify(set)).digest('hex'),ready:issues.length===0,issues,
      quotes:set.offers.map(o=>({offerCode:o.offerCode,offerKind:o.offerKind,billingInterval:o.billingInterval,priceMinor:o.priceMinor,currency:'USD',
        monthlyEquivalentMinor:o.billingInterval==='ONE_TIME'?null:o.billingInterval==='ANNUAL'?Math.round(o.priceMinor/12):o.priceMinor,
        annualSavingsVsRegularMonthlyMinor:o.billingInterval==='ANNUAL'&&monthly?monthly.priceMinor*12-o.priceMinor:null,
        lifetimeBreakEvenMonths:o.billingInterval==='ONE_TIME'&&monthly?Math.ceil(o.priceMinor/monthly.priceMinor):null,founderDiscountPercentVsRegular:null})),
      comparisonOfferCode:monthly?.offerCode??null,effect:'NEW_PURCHASES_ONLY',existingSubscriptionsRepriced:false,product:structuredClone(HON_OS_PRODUCT)};
  }
  const original=make(syntheticSetInput());original.status='PUBLISHED';original.publishedAt=T;original.approvedPreviewDigest=preview(original).previewDigest;
  const draft=make(syntheticSetInput());
  const detail=id=>{const set=sets.get(id);if(!set)fail('SAAS_UNAVAILABLE',404);return structuredClone({set,preview:preview(set)});};
  const management=()=>{const published=[...sets.values()].find(s=>s.status==='PUBLISHED')??null;return structuredClone({product:HON_OS_PRODUCT,published,
    onSaleOfferIds:published?.offers.filter(o=>!o.salesStop).map(o=>o.offerId)??[],drafts:[...sets.values()].filter(s=>s.status==='DRAFT'),
    history:[...sets.values()].map(s=>({setId:s.setId,setVersion:s.setVersion,status:s.status,revision:s.revision,offerCount:s.offers.length,createdAt:s.createdAt,publishedAt:s.publishedAt,retiredAt:s.retiredAt,discardedAt:s.discardedAt})).reverse(),
    honOsSales:{offers:(published?.offers??[]).map(o=>({offerId:o.offerId,setVersion:published.setVersion,offerCode:o.offerCode,offerKind:o.offerKind,displayName:o.displayName,priceMinor:o.priceMinor,saleLimit:o.saleLimit,
      saleStatus:o.salesStop?'NOT_ON_SALE':o.annualRenewal==='AUTO_RENEW_AT_CURRENT_PRICE'?'TERMS_UNSUPPORTED':'ON_SALE',subscriptions:0,openCheckouts:0,paidNeedsReview:0})),
      founderPool:{limit:published?.founderTotalLimit??null,allocated:2,held:1,remaining:published?.founderTotalLimit===null||!published?null:Math.max(published.founderTotalLimit-3,0)}},
    legacySales:[],paidAccessProgram:'INACTIVE',purchase:'UNAVAILABLE',chargesEnabled:false,creditGrantsEnabled:false});};
  function command(kind,target,body,key,subject='owner'){
    const fingerprint=JSON.stringify([kind,target,body]),requestKey=subject+key;
    if(requests.has(requestKey)){const prior=requests.get(requestKey);if(prior.fingerprint!==fingerprint)fail('IDEMPOTENCY_KEY_REUSED',409);return {...structuredClone(prior.result),replayed:true};}
    let result;
    if(kind==='create'){validateSaasHonOsOfferSetDraftInput(body);const set=make(body);result={...detail(set.setId),replayed:false};}
    else if(kind==='stop'){
      validateSaasHonOsOfferStopSalesInput(body);const set=[...sets.values()].find(s=>s.offers.some(o=>o.offerId===target)),offer=set?.offers.find(o=>o.offerId===target);
      if(!offer)fail('SAAS_UNAVAILABLE',404);if(set.status!=='PUBLISHED')fail('SAAS_OFFER_NOT_PUBLISHED',422);if(offer.salesStop)fail('SAAS_OFFER_SALES_ALREADY_STOPPED',422);
      offer.salesStop={reasonCode:body.reasonCode,stoppedAt:T};result={offer:structuredClone(offer),replayed:false};
    }else{
      ({revise:validateSaasHonOsOfferSetReviseInput,publish:validateSaasHonOsOfferSetPublishInput,discard:validateSaasHonOsOfferSetDiscardInput})[kind](body);
      const set=sets.get(target);if(!set)fail('SAAS_UNAVAILABLE',404);if(set.status!=='DRAFT')fail('SAAS_OFFER_SET_NOT_DRAFT',409);if(set.revision!==body.expectedRevision)fail('SAAS_VERSION_CONFLICT',409);
      if(kind==='revise'){set.revision++;set.termsReference=body.termsReference;set.founderTotalLimit=body.founderTotalLimit;set.offers=body.offers.map((o,i)=>responseOffer(o,i+1));result={...detail(target),replayed:false};}
      else if(kind==='discard'){set.status='DISCARDED';set.discardedAt=T;result={set:structuredClone(set),replayed:false};}
      else{const review=preview(set);if(body.previewDigest!==review.previewDigest)fail('SAAS_OFFER_PREVIEW_CHANGED',422);if(!review.ready)fail('SAAS_OFFER_SET_NOT_READY',422);
        const previous=[...sets.values()].find(s=>s.status==='PUBLISHED');if(previous){previous.status='RETIRED';previous.retiredAt=T;}
        set.status='PUBLISHED';set.approvedPreviewDigest=body.previewDigest;set.publishedAt=T;result={set:structuredClone(set),retiredSetId:previous?.setId??null,replayed:false};}
    }
    mutations++;requests.set(requestKey,{fingerprint,result:structuredClone(result)});return result;
  }
  return {sets,originalId:original.setId,draftId:draft.setId,detail,management,command,get mutations(){return mutations;}};
}
