import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {en,ko,es,translate} from '@hon/design-system';
import {validateSaasHonOsOfferSetDraftInput,validateSaasHonOsOfferSetReviseInput} from '@hon/contracts';
import {createOfferFixtures} from '../scripts/fixtures/hq-offers.mjs';
import {blankSet,blankOffer,formFromSet,formInput,usdMinor} from '../src/components/hq-modern/pricing-offers-model';
import {PricingController} from '../src/components/hq-modern/pricing-offers-controller';
import {PricingOffersView} from '../src/components/hq-modern/pricing-offers';
vi.mock('../src/components/localization/provider',()=>({useLocale:()=>({t:(key:any,params:any)=>translate('en',key,params),money:(n:number)=>'USD '+n.toFixed(2),number:String,date:(s:string)=>s})}));
describe('whole HON OS offer-set form and source boundaries',()=>{
  it('round trips all six backend options without authoring IDs, currency or lifecycle fields',()=>{
    const fixture=createOfferFixtures(),set=fixture.detail(fixture.draftId).set,form=formFromSet(set),input=validateSaasHonOsOfferSetReviseInput(formInput(form));
    expect(input.offers).toHaveLength(6);expect(input.expectedRevision).toBe(set.revision);expect(input.offers[0]!.priceMinor).toBe(31700);
    for(const o of input.offers)for(const key of ['offerId','currency','founder','billingInterval','premiumCreditsStatus','salesStop'])expect(Object.keys(o)).not.toContain(key);
    expect(input.offers[0]!.salesOpensAt).toBe(set.offers[0]!.salesOpensAt);
  });
  it('creates no sample price or credit default and keeps complete historical sets when cloning',()=>{
    const blank=blankSet(),offer=blankOffer('REGULAR_MONTHLY',[]);expect(blank.offers).toEqual([]);expect(offer.amount).toBe('');expect(offer.plannedMonthlyPremiumCredits).toBe('');
    const fixture=createOfferFixtures(),original=fixture.detail(fixture.originalId).set,copy=formFromSet(original,true),input=validateSaasHonOsOfferSetDraftInput(formInput(copy));
    expect(copy.setId).toBeNull();expect(input.basedOnSetId).toBe(original.setId);expect(input.offers).toHaveLength(6);expect(original.status).toBe('PUBLISHED');
  });
  it('uses exact USD minor units and rejects rounding, bad policy fields and non-calendar timestamps',()=>{
    expect(usdMinor('249.01')).toBe(24901);expect(usdMinor('100000.00')).toBe(10000000);
    for(const s of ['1.001','-2','1e3','NaN',' 249','1,00'])expect(()=>usdMinor(s)).toThrow();
    const f=createOfferFixtures(),form=formFromSet(f.detail(f.draftId).set);form.offers[0]!.eligibility='MADE_UP';expect(()=>formInput(form)).toThrow();
    form.offers[0]!.eligibility='ANY_ACTIVE_ORGANIZATION';form.offers[0]!.salesOpensAt='2027-02-30T12:00';expect(()=>formInput(form)).toThrow();
    form.offers[0]!.salesOpensAt='2026-11-01T12:00:00.123';expect(validateSaasHonOsOfferSetReviseInput(formInput(form)).offers[0]!.salesOpensAt).toBe('2026-11-01T12:00:00.123Z');
  });
  it('retains inactive price-lock notes locally without sending inconsistent fields',()=>{
    const f=createOfferFixtures(),form=formFromSet(f.detail(f.draftId).set);form.offers[0]!.priceLockMonths='24';form.offers[0]!.priceLock='NONE';
    expect(validateSaasHonOsOfferSetReviseInput(formInput(form)).offers[0]!.priceLockMonths).toBeNull();expect(form.offers[0]!.priceLockMonths).toBe('24');
    form.offers[0]!.priceLock='FIXED_MONTHS';expect(validateSaasHonOsOfferSetReviseInput(formInput(form)).offers[0]!.priceLockMonths).toBe(24);
  });
  it('has complete English/Korean/Spanish operational copy with safe interpolation',()=>{
    const keys=Object.keys(en).filter(k=>k.startsWith('pricing.op.')) as (keyof typeof en)[];expect(keys.length).toBeGreaterThan(100);
    for(const key of keys){expect(ko[key],key).toBeTruthy();expect(es[key],key).toBeTruthy();}
    expect(translate('ko','pricing.op.version',{version:2,revision:3})).toContain('2');expect(translate('es','pricing.op.version',{version:2,revision:3})).toContain('3');
  });
  it('does not introduce checkout, persistence, direct tables or an alternative product tier',()=>{
    for(const file of ['pricing-offers.tsx','pricing-offers-controller.ts','pricing-offers-http.ts','pricing-offers-model.ts']){
      const source=readFileSync('src/components/hq-modern/'+file,'utf8');expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|\/checkout|stripe\.com|supabase|INSERT INTO|UPDATE hon\./);
    }
    expect(readFileSync('src/components/hq-modern/pricing-offers.tsx','utf8')).toContain('<button type="button" disabled>{t(\'pricing.checkout-unavailable\')}</button>');
  });
  it('renders only authorized backend values, readonly history and an honestly disabled customer preview',async()=>{
    const fixture=createOfferFixtures();const c=new PricingController({access:async()=>({subject:'owner',owner:true,management:fixture.management()}),detail:async id=>fixture.detail(id),send:vi.fn()});
    await c.load();expect(renderToStaticMarkup(<PricingOffersView controller={c}/>)).toContain('USD 317.00');
    await c.previewPublished();const html=renderToStaticMarkup(<PricingOffersView controller={c}/>);expect(html).toContain('Checkout unavailable');expect(html).toContain('Founder offers are hidden');expect(html).not.toContain('USD 183.00');
  });
});
