import { validateSaasHonOsOfferSetDraftInput, validateSaasHonOsOfferSetReviseInput,
  type SaasHonOsOfferKind, type SaasHonOsOfferSet, type SaasHonOsOfferSetContent, type SaasHonOsOfferSetDraftInput } from '@hon/contracts';
import { pricingOfferInput } from './pricing-offers-http';

export type OfferFields = {
  key:string; offerKind:SaasHonOsOfferKind; offerCode:string; displayName:string; amount:string;
  salesOpensAt:string; salesClosesAt:string; eligibility:string; saleLimit:string; priceLock:string;
  priceLockMonths:string; annualRenewal:string; plannedMonthlyPremiumCredits:string;
  aiFairUseReference:string; refundWindowDays:string; cancellationTiming:string;
};
export type OfferSetForm = { key:string; setId:string|null; revision:number|null; basedOnSetId:string|null;
  termsReference:string; founderTotalLimit:string; offers:OfferFields[] };
export const kindLabels = { REGULAR_MONTHLY:'monthly', REGULAR_ANNUAL:'annual', FOUNDER_MONTHLY:'founder-monthly',
  FOUNDER_ANNUAL:'founder-annual', LIFETIME:'lifetime', FOUNDER_LIFETIME:'founder-lifetime' } as const;
export function blankSet(): OfferSetForm { return { key:crypto.randomUUID(),setId:null,revision:null,basedOnSetId:null,termsReference:'',founderTotalLimit:'',offers:[] }; }
export function blankOffer(kind:SaasHonOsOfferKind, existing:OfferFields[]): OfferFields {
  let code:string = kind; for(let i=2;existing.some(o=>o.offerCode===code);i++) code=kind+'_'+i;
  return { key:crypto.randomUUID(),offerKind:kind,offerCode:code,displayName:'HON OS',amount:'',salesOpensAt:'',salesClosesAt:'',
    eligibility:'ANY_ACTIVE_ORGANIZATION',saleLimit:'',priceLock:'NONE',priceLockMonths:'',annualRenewal:'',
    plannedMonthlyPremiumCredits:'',aiFairUseReference:'',refundWindowDays:'',cancellationTiming:'' };
}
export function formFromSet(set:SaasHonOsOfferSet, clone=false):OfferSetForm {
  return { key:clone?crypto.randomUUID():set.setId,setId:clone?null:set.setId,revision:clone?null:set.revision,
    basedOnSetId:clone?set.setId:set.basedOnSetId,termsReference:set.termsReference??'',founderTotalLimit:set.founderTotalLimit?.toString()??'',
    offers:set.offers.map(o=>{ const v=pricingOfferInput(o);return { ...v,key:clone?crypto.randomUUID():o.offerId,
      amount:`${Math.floor(v.priceMinor/100)}.${String(v.priceMinor%100).padStart(2,'0')}`,
      salesOpensAt:v.salesOpensAt?.slice(0,-1)??'',salesClosesAt:v.salesClosesAt?.slice(0,-1)??'',
      saleLimit:v.saleLimit?.toString()??'',priceLockMonths:v.priceLockMonths?.toString()??'',annualRenewal:v.annualRenewal??'',
      plannedMonthlyPremiumCredits:v.plannedMonthlyPremiumCredits?.toString()??'',aiFairUseReference:v.aiFairUseReference??'',
      refundWindowDays:v.refundWindowDays?.toString()??'',cancellationTiming:v.cancellationTiming??'' }; }) };
}
const optionalText=(s:string)=>s===''?null:s;
function integer(s:string):number|null { if(s==='')return null;if(!/^\d{1,10}$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error('INVALID_SAAS_INPUT');return Number(s); }
export function usdMinor(s:string):number { if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(s))throw Error('INVALID_SAAS_INPUT');const [whole,frac='']=s.split('.');return Number(whole)*100+Number(frac.padEnd(2,'0')); }
function utc(s:string):string|null {
  if(!s)return null;
  if(!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(s))throw Error('INVALID_SAAS_INPUT');
  const [base,fraction]=s.split('.'), expected=(base!.length===16?base+':00':base)+'.'+(fraction??'').padEnd(3,'0')+'Z';
  const date=new Date(expected);if(!Number.isFinite(date.getTime())||date.toISOString()!==expected)throw Error('INVALID_SAAS_INPUT');return expected;
}
/** Exact display-to-input mapping only. Shared validators own term rules; no official quote is calculated here. */
export function formContent(form:OfferSetForm):SaasHonOsOfferSetContent {
  const input:SaasHonOsOfferSetDraftInput = validateSaasHonOsOfferSetDraftInput({ basedOnSetId:form.basedOnSetId,
    termsReference:optionalText(form.termsReference),founderTotalLimit:integer(form.founderTotalLimit),offers:form.offers.map(o=>({
      offerCode:o.offerCode,offerKind:o.offerKind,displayName:o.displayName,priceMinor:usdMinor(o.amount),
      salesOpensAt:utc(o.salesOpensAt),salesClosesAt:utc(o.salesClosesAt),eligibility:o.eligibility,saleLimit:integer(o.saleLimit),
      priceLock:o.priceLock,priceLockMonths:o.priceLock==='FIXED_MONTHS'?integer(o.priceLockMonths):null,annualRenewal:optionalText(o.annualRenewal),
      plannedMonthlyPremiumCredits:integer(o.plannedMonthlyPremiumCredits),aiFairUseReference:optionalText(o.aiFairUseReference),
      refundWindowDays:integer(o.refundWindowDays),cancellationTiming:optionalText(o.cancellationTiming),
    })) });
  const {basedOnSetId,...content}=input;return content;
}
export function formInput(form:OfferSetForm):unknown {
  const content=formContent(form);
  return form.setId?validateSaasHonOsOfferSetReviseInput({expectedRevision:form.revision,...content})
    :validateSaasHonOsOfferSetDraftInput({basedOnSetId:form.basedOnSetId,...content});
}
export const formFingerprint=(form:OfferSetForm)=>JSON.stringify(form);
