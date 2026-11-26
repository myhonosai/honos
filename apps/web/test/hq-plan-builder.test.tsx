import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {en,ko,es,translate,formatLocaleMoney,DEFAULT_LOCALE} from '@hon/design-system';
import {validateSaasHonOsOfferSetDraftInput,validateSaasHonOsOfferSetReviseInput,HON_OS_PRODUCT,HON_OS_PLAN_CAPABILITIES} from '@hon/contracts';
import {createOfferFixtures} from '../scripts/fixtures/hq-offers.mjs';
import {blankSet,formFromSet,formInput} from '../src/components/hq-modern/pricing-offers-model';
import {AI_TEAM_FEATURES,PLAN_FEATURES,addedPlan,allProblems,applyPlansToForm,defaultPlans,emptyPlan,emptyPlans,percentOff,planProblems,plansFromForm,setProblems,yearlySavings,type PlansDraft} from '../src/components/hq-modern/pricing-plan-builder-model';
import {PricingController} from '../src/components/hq-modern/pricing-offers-controller';
import type {PricingRequest,PricingReceipt} from '../src/components/hq-modern/pricing-offers-http';
import {PricingOffersView} from '../src/components/hq-modern/pricing-offers';
vi.mock('../src/components/localization/provider',()=>({useLocale:()=>({t:(key:any,params:any)=>translate('en',key,params),money:(n:number,currency:string)=>formatLocaleMoney(DEFAULT_LOCALE,n,currency),number:(n:number)=>n.toLocaleString('en-US'),date:(s:string)=>s,preferences:{...DEFAULT_LOCALE,timeZone:'UTC'}})}));

describe('HQ plan builder model',()=>{
  const apply=(plans:PlansDraft)=>validateSaasHonOsOfferSetDraftInput(formInput(applyPlansToForm(blankSet(),plans)));
  it('fills a new regular plan with the owner-approved prices, credits, terms and every feature, passing the shared validator',()=>{
    const input=apply(defaultPlans());
    expect(input.offers.map(o=>[o.offerKind,o.priceMinor])).toEqual([['REGULAR_MONTHLY',24900],['REGULAR_ANNUAL',209700]]);
    for(const o of input.offers){expect(o.plannedMonthlyPremiumCredits).toBe(12000);expect(o.refundWindowDays).toBe(30);expect(o.cancellationTiming).toBe('END_OF_PAID_PERIOD');expect(o.capabilities).toEqual([...HON_OS_PLAN_CAPABILITIES]);}
    expect(input.offers[1]!.annualRenewal).toBe('AUTO_RENEW_AT_LOCKED_PRICE');expect(input.termsReference).toBe('https://myhonos.com/terms/');expect(input.founderTotalLimit).toBeNull();
  });
  it('adds founder and lifetime prices with policy terms and spot limits',()=>{
    const d=defaultPlans(),plan={...d.plans[0]!,founderMonthly:{on:true,amount:'199.20'},founderAnnual:{on:true,amount:'1494'},lifetime:{on:true,amount:'1896'},lifetimeSpots:'25'};
    const draft={...d,plans:[plan],founderSpots:'50'};
    expect(allProblems(draft)).toEqual([]);
    const input=apply(draft);
    expect(input.offers.map(o=>o.offerKind)).toEqual(['REGULAR_MONTHLY','REGULAR_ANNUAL','FOUNDER_MONTHLY','FOUNDER_ANNUAL','LIFETIME']);
    expect(input.founderTotalLimit).toBe(50);
    const fm=input.offers.find(o=>o.offerKind==='FOUNDER_MONTHLY')!;expect(fm.priceMinor).toBe(19920);expect(fm.priceLock).toBe('WHILE_CONTINUOUSLY_SUBSCRIBED');
    const life=input.offers.find(o=>o.offerKind==='LIFETIME')!;expect(life.priceLock).toBe('NONE');expect(life.cancellationTiming).toBeNull();expect(life.saleLimit).toBe(25);expect(life.aiFairUseReference).toBe('https://myhonos.com/terms/');
  });
  it('builds several plans, each with its own name, prices, credits and feature list (David: pick features per plan)',()=>{
    const d=defaultPlans(),school=PLAN_FEATURES.filter(f=>!AI_TEAM_FEATURES.includes(f));
    const core={...addedPlan(d.plans),name:'HON OS Core',monthly:{on:true,amount:'149'},credits:'5000',features:[...school].reverse()};
    const input=apply({...d,plans:[d.plans[0]!,core]});
    expect(input.offers.map(o=>[o.displayName,o.offerKind,o.priceMinor,o.plannedMonthlyPremiumCredits,o.capabilities.length])).toEqual([
      ['HON OS','REGULAR_MONTHLY',24900,12000,16],['HON OS','REGULAR_ANNUAL',209700,12000,16],['HON OS Core','REGULAR_MONTHLY',14900,5000,11]]);
    expect(input.offers[2]!.capabilities).toEqual(school);expect(input.offers[2]!.capabilities).not.toContain('ai.workforce');
    expect(new Set(input.offers.map(o=>o.offerCode)).size).toBe(3);
    // Reading the form back gives the same plans, and the set-wide terms stay shared.
    const back=plansFromForm(applyPlansToForm(blankSet(),{...d,plans:[d.plans[0]!,core]}));
    expect(back.plans.map(x=>[x.name,x.monthly.amount,x.credits,x.features.length])).toEqual([['HON OS','249.00','12000',16],['HON OS Core','149','5000',11]]);
    expect(back.refundDays).toBe('30');
  });
  it('round trips an existing draft in place, keeping offer ids and codes through a rename, and removes switched-off prices and plans',()=>{
    const f=createOfferFixtures(),set=f.detail(f.draftId).set,form=formFromSet(set),draft=plansFromForm(form);
    expect(draft.plans.length).toBe(1);expect(draft.plans[0]!.monthly.on).toBe(true);expect(draft.plans[0]!.features).toEqual([...HON_OS_PLAN_CAPABILITIES]);
    const plan={...draft.plans[0]!,name:'HON OS Complete',monthly:{on:true,amount:'259'},lifetime:{on:false,amount:''},founderLifetime:{on:false,amount:''}};
    const next=applyPlansToForm(form,{...draft,plans:[plan]});
    const monthly=next.offers.find(o=>o.offerKind==='REGULAR_MONTHLY')!,before=form.offers.find(o=>o.offerKind==='REGULAR_MONTHLY')!;
    expect(monthly.key).toBe(before.key);expect(monthly.offerCode).toBe(before.offerCode);expect(monthly.amount).toBe('259');expect(monthly.displayName).toBe('HON OS Complete');
    expect(next.offers.some(o=>o.offerKind.endsWith('LIFETIME'))).toBe(false);
    expect(validateSaasHonOsOfferSetReviseInput(formInput(next)).expectedRevision).toBe(set.revision);
    // Editing again after the rename still edits the same offers (the plan keeps its local id).
    const again=plansFromForm(next);expect(again.plans[0]!.id).toBe(plan.id);
    const two=applyPlansToForm(next,{...again,plans:[...again.plans,{...addedPlan(again.plans),monthly:{on:true,amount:'99'}}]});
    expect(two.offers.find(o=>o.offerKind==='REGULAR_MONTHLY'&&o.displayName==='HON OS Complete')!.key).toBe(before.key);
    const one=applyPlansToForm(two,{...plansFromForm(two),plans:plansFromForm(two).plans.slice(0,1)});
    expect(one.offers.every(o=>o.displayName==='HON OS Complete')).toBe(true);
  });
  it('explains savings and founder discounts in plain numbers',()=>{
    expect(yearlySavings('249','2097')).toEqual({savedMinor:89100,percent:30,monthsFree:3.6});
    expect(yearlySavings('249','2988')).toBeNull();expect(yearlySavings('abc','2097')).toBeNull();
    expect(percentOff('249','199.20')).toBe(20);expect(percentOff('249','300')).toBeNull();
  });
  it('lists friendly problems before the server is asked',()=>{
    const d=defaultPlans(),plan=d.plans[0]!;
    expect(planProblems(emptyPlan())).toEqual(expect.arrayContaining(['NO_PRICE','CREDITS']));
    expect(setProblems(emptyPlans())).toEqual(expect.arrayContaining(['NO_PLAN','REFUND','TERMS']));
    expect(planProblems({...plan,monthly:{on:true,amount:'0.50'}})).toContain('BAD_PRICE');
    expect(planProblems({...plan,features:[]})).toContain('FEATURES');
    expect(planProblems({...plan,lifetime:{on:true,amount:'1896'}})).toContain('LIFETIME_SPOTS');
    expect(planProblems({...plan,id:'b'},[plan,{...plan,id:'b'}])).toContain('SAME_NAME');
    expect(setProblems({...d,plans:[{...plan,founderMonthly:{on:true,amount:'199.20'}}]})).toContain('FOUNDER_SPOTS');
    expect(setProblems({...d,salesOpensAt:'2027-01-02T00:00',salesClosesAt:'2027-01-01T00:00'})).toContain('SALES_WINDOW');
    expect(setProblems({...d,plans:Array.from({length:7},(_,i)=>({...plan,id:String(i),name:'P'+i}))})).toContain('TOO_MANY');
  });
  it('offers exactly the one HON OS product feature list, translated in every language',()=>{
    expect([...PLAN_FEATURES]).toEqual([...HON_OS_PRODUCT.capabilities]);
    expect(AI_TEAM_FEATURES.every(f=>PLAN_FEATURES.includes(f))).toBe(true);
    const keys=Object.keys(en).filter(k=>k.startsWith('planBuilder.')) as (keyof typeof en)[];
    for(const f of PLAN_FEATURES)expect(keys).toContain('planBuilder.f.'+f);
    for(const key of keys){expect(ko[key],key).toBeTruthy();expect(es[key],key).toBeTruthy();}
  });
});

describe('HQ plan builder screen',()=>{
  const setup=()=>{const fixture=createOfferFixtures();return new PricingController({access:async()=>({subject:'owner',owner:true,management:fixture.management()}),detail:async id=>fixture.detail(id),
    send:async(request:PricingRequest)=>({kind:request.kind,data:fixture.command(request.kind,request.target,JSON.parse(request.body),request.key,request.subject)}) as PricingReceipt});};
  it('starts a new plan with the regular-or-trial choice and links trials to Free Trials',async()=>{
    const c=setup();await c.load();await c.open(null);const html=renderToStaticMarkup(<PricingOffersView controller={c}/>);
    expect(html).toContain('data-plan-step="type"');expect(html).toContain('Regular plan');expect(html).toContain('href="/hq/revenue/trials"');
  });
  it('shows price boxes, savings and the school preview without any dropdown, then saves through the existing command',async()=>{
    const c=setup();await c.load();await c.open(null);c.applyPlans(defaultPlans());
    const html=renderToStaticMarkup(<PricingOffersView controller={c}/>);
    expect(html).toContain('data-plan-step="pricing"');expect(html).toContain('value="249.00"');expect(html).toContain('Save $891 a year (30%)');
    expect(html).toContain('data-plan-preview');expect(html).toContain('12,000 creative credits a month');expect(html).toContain('30-day money-back guarantee');
    expect(c.dirty()).toBe(true);await c.save();expect(c.snapshot().form?.setId).toBeTruthy();expect(c.dirty()).toBe(false);
    expect(c.snapshot().form?.offers.map(o=>o.amount)).toEqual(['249.00','2097.00']);
  });
  it('shows plan tabs, an Add a plan button and a feature checklist per plan, and saves two plans through the existing command',async()=>{
    const c=setup();await c.load();await c.open(null);
    const d=defaultPlans(),school=PLAN_FEATURES.filter(f=>!AI_TEAM_FEATURES.includes(f));
    c.applyPlans({...d,plans:[d.plans[0]!,{...addedPlan(d.plans),name:'HON OS Core',monthly:{on:true,amount:'149'},credits:'5000',features:school}]});
    const html=renderToStaticMarkup(<PricingOffersView controller={c}/>);
    expect(html).toContain('data-plan-tabs');expect(html).toContain('data-plan-tab="HON OS"');expect(html).toContain('data-plan-tab="HON OS Core"');expect(html).toContain('data-plan-add');
    expect(html).toContain('You are editing HON OS.');
    await c.save();expect(c.snapshot().form?.setId).toBeTruthy();
    const saved=c.snapshot().form!.offers;
    expect(saved.map(o=>[o.displayName,o.amount,o.capabilities.length])).toEqual([['HON OS','249.00',16],['HON OS','2097.00',16],['HON OS Core','149.00',11]]);
  });
  it('does not hide HQ pricing when the tab goes to the background and adds no checkout',()=>{
    const source=readFileSync('src/components/hq-modern/pricing-offers.tsx','utf8');
    expect(source).not.toMatch(/addEventListener\('blur'|visibilitychange/);
    for(const file of ['pricing-plan-builder.tsx','pricing-plan-builder-model.ts'])expect(readFileSync('src/components/hq-modern/'+file,'utf8')).not.toMatch(/localStorage|\/checkout|stripe|supabase|fetch\(/);
  });
});
