/** SYNTHETIC disposable/test inputs only. No seed, publication authority or real customer. */
import { randomUUID as K } from 'node:crypto';
export const pricingReason='DISPOSABLE SYNTHETIC PRICE SCHEDULE ONLY';
export const pricingOffers=(patch={})=>[
 ['REGULAR_MONTHLY',24900],['REGULAR_ANNUAL',209700],['FOUNDER_MONTHLY',19920],['FOUNDER_ANNUAL',149400],
].map(([kind,price])=>({offerCode:kind,offerKind:kind,displayName:kind,priceMinor:price,
 salesOpensAt:new Date(Date.now()-3600_000).toISOString(),salesClosesAt:null,
 eligibility:kind.startsWith('FOUNDER_')?'NEW_ORGANIZATIONS_ONLY':'ANY_ACTIVE_ORGANIZATION',saleLimit:null,
 priceLock:'NONE',priceLockMonths:null,annualRenewal:kind.endsWith('ANNUAL')?(kind.startsWith('FOUNDER_')?'AUTO_RENEW_AT_CURRENT_PRICE':'AUTO_RENEW_AT_LOCKED_PRICE'):null,
 plannedMonthlyPremiumCredits:12000,aiFairUseReference:'SYNTHETIC_PLANNING_ONLY',refundWindowDays:30,cancellationTiming:'END_OF_PAID_PERIOD',...patch[kind]}));
export const scheduleInput=(offer,renewal,expectedVersion=0)=>({offerId:offer.offerId,renewalOfferId:renewal.offerId,
 expectedOfferSetRevision:1,expectedVersion,disclosureVersion:'HON_OS_PRICING_EN_V1',confirmation:'RECORD_IMMUTABLE_PRICING_SCHEDULE_ONLY',reason:pricingReason});
export const acceptanceInput=preview=>({scheduleId:preview.schedule.scheduleId,scheduleDigest:preview.schedule.scheduleDigest,
 acceptanceDigest:preview.acceptanceDigest,confirmation:'ACCEPT_INITIAL_AND_SCHEDULED_RENEWAL_PRICES'});
export function sampleSchedule(terms){
 const offer=pricingOffers().find(x=>x.offerKind===terms.offerKind),offerId=K(),set=K();
 return {scheduleId:K(),version:1,offerId,offerSetId:set,offerSetVersion:1,offerSetRevision:1,renewalOfferId:K(),terms,
  acceptedOffer:{...offer,offerId,billingInterval:terms.billingInterval,founder:terms.offerKind.startsWith('FOUNDER_'),currency:'USD',
   premiumCreditsStatus:'PLANNING_ONLY_NOT_A_CREDIT_GRANT',productCode:'HON_OS',capabilityPolicyVersion:1,planCode:'COMPLETE',
   offerSetId:set,offerSetVersion:1,termsReference:'SYNTHETIC_TERMS_V1',approvedPreviewDigest:'a'.repeat(64),recurringBilling:terms.billingInterval==='MONTHLY'?'MONTH':'YEAR'},
  acceptedOfferDigest:'b'.repeat(64),disclosureVersion:'HON_OS_PRICING_EN_V1',disclosureLanguage:'en',
  disclosureText:'Synthetic exact pricing disclosure only.',termsReference:'SYNTHETIC_TERMS_V1',
  refundTerms:{termsReference:'SYNTHETIC_TERMS_V1',windowDays:30},cancellationTerms:{termsReference:'SYNTHETIC_TERMS_V1',timing:'END_OF_PAID_PERIOD'},
  scheduleDigest:'c'.repeat(64),actorPrincipalId:K(),recordedAt:'2026-10-24T00:00:00.000Z',providerBinding:'UNAVAILABLE_COMMERCIAL_B',billingEnabled:false};
}
