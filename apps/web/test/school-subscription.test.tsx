import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSaasSchoolPlanOptions, validateSaasSchoolCredits } from '@hon/contracts';
import { loadSchoolAccount, loadSchoolAllowance, startSchoolCheckout, hostedCheckoutUrl, canPurchase, offerFingerprint, reviewFingerprint } from '../src/components/school-subscription/http';
import { SchoolSubscription } from '../src/components/school-subscription/subscription';
import { SchoolAccountStatus } from '../src/components/school-subscription/account';
import { INITIAL_SELECTION, OFFER_CHOICES, PLAN_COMPARISON, displayUsd, planDisplay, selectPlan } from '../src/components/school-subscription/catalog';
import { checkoutId, schoolContext, schoolPlanFixture, schoolCreditsFixture, schoolCheckoutReceipt } from '../scripts/fixtures/school-checkout.mjs';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const account = (state = 'ready') => ({ context: { organizationId: schoolContext.organizationId, schoolId: schoolContext.schoolId }, plan: schoolPlanFixture({ state }) });
function mockReads(state = 'ready') { return vi.spyOn(globalThis, 'fetch').mockImplementation(async (path) => ok(String(path).includes('current-reporting') ? schoolContext : String(path).endsWith('ai-credits') ? schoolCreditsFixture(schoolPlanFixture({ state })) : schoolPlanFixture({ state }))); }
function renderAccount(state: string, override?: ReturnType<typeof schoolPlanFixture>) { const a = account(state); if (override) a.plan = override; return renderToStaticMarkup(<SchoolAccountStatus billing={{ account:a,credits:schoolCreditsFixture(a.plan),error:null,creditError:null,commandError:null,loading:false,posting:false,pendingAttempt:false,retryOfferId:null,checkedAt:null,refresh:async()=>{},start:async()=>{} }}/>); }
afterEach(() => vi.restoreAllMocks());

describe('school subscription — merged B5/B3 integration boundaries', () => {
  it('uses six approved informational prices, exact cents and canonical capabilities', () => {
    expect(OFFER_CHOICES.map((o) => o.kind)).toEqual(['REGULAR_MONTHLY','FOUNDER_MONTHLY','FOUNDER_LIFETIME']);
    for (const [tier, prices, credits] of [['CORE',[14900,7900,189600],5000],['COMPLETE',[24900,14900,357600],12000]] as const) OFFER_CHOICES.forEach((o,i)=>{ expect(planDisplay(tier,o.kind).priceMinor).toBe(prices[i]); expect(planDisplay(tier,o.kind).premiumAiCreditPlanningAllowance).toBe(credits); });
    expect(displayUsd(14901)).toBe('$149.01'); expect(displayUsd(189600)).toBe('$1,896'); expect(PLAN_COMPARISON.filter((r)=>!r.core)).toHaveLength(5);
    for (const t of ['ESSENTIAL','../hq']) expect(()=>planDisplay(t as never,'REGULAR_MONTHLY')).toThrow();
    expect(()=>planDisplay('CORE','REGULAR_ANNUAL' as never)).toThrow();
  });
  it('resolves server identity then independently reads B5 plan and B3 allowance', async () => {
    const fetch = mockReads('paid'), abort = new AbortController(), a = await loadSchoolAccount(abort.signal); await loadSchoolAllowance(a,abort.signal);
    expect(fetch.mock.calls.map((c)=>c[0])).toEqual(['/api/v1/staff/current-reporting-school',`/api/v1/schools/${schoolContext.schoolId}/hon-plan`,`/api/v1/schools/${schoolContext.schoolId}/ai-credits`]);
    for (const [,init] of fetch.mock.calls) expect(init).toMatchObject({ method:'GET',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},signal:abort.signal });
  });
  it('refuses ambiguous, denied or malformed identity without a plan read', async () => {
    const fetch = mockReads();
    for (const data of [{ state:'MANUAL_ENTRY_REQUIRED' },{...schoolContext,schoolId:'../hq'}, {...schoolContext,role:'OWNER'}]) { fetch.mockResolvedValue(ok(data));fetch.mockClear();await expect(loadSchoolAccount()).rejects.toBeInstanceOf(Error); expect(fetch).toHaveBeenCalledTimes(1); }
    for (const status of [401,403]) { const json=vi.fn();fetch.mockResolvedValue({ok:false,status,json} as unknown as Response);fetch.mockClear();await expect(loadSchoolAccount()).rejects.toMatchObject({kind:status===401?'UNAUTHORIZED':'DENIED'}); expect(fetch).toHaveBeenCalledTimes(1);expect(json).not.toHaveBeenCalled(); }
  });
  it('treats B5 denial as independent of successful reporting scope', async () => {
    const fetch=mockReads();fetch.mockImplementation(async(path)=>String(path).includes('current-reporting')?ok(schoolContext):new Response('{}',{status:403}));
    await expect(loadSchoolAccount()).rejects.toMatchObject({kind:'DENIED'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('binds school, organization, checkout and current subscription before displaying facts', async () => {
    const fetch=mockReads('paid');
    for (const mutate of [(p:ReturnType<typeof schoolPlanFixture>)=>{p.schoolId=checkoutId(99);},(p:ReturnType<typeof schoolPlanFixture>)=>{p.subscription!.organizationId=checkoutId(99);},(p:ReturnType<typeof schoolPlanFixture>)=>{p.checkout!.schoolId=checkoutId(99);},(p:ReturnType<typeof schoolPlanFixture>)=>{p.checkout!.subscriptionId=checkoutId(99);},(p:ReturnType<typeof schoolPlanFixture>)=>{p.offers.push(p.offers[0]!);}]) {
      const p=schoolPlanFixture({state:'paid'});mutate(p);fetch.mockImplementation(async(path)=>ok(String(path).includes('current-reporting')?schoolContext:p));await expect(loadSchoolAccount()).rejects.toMatchObject({kind:'INVALID'});
    }
  });
  it('rejects contract, envelope, cache and live-mode drift without exposing private error details', async () => {
    const fetch=mockReads();
    for (const response of [ok({...schoolPlanFixture(),privateEmail:'private'}),ok({...schoolPlanFixture(),payments:{status:'LIVE',mode:'LIVE'}}),new Response(JSON.stringify({data:schoolPlanFixture(),role:'OWNER'}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}}),new Response('{}',{headers:{'Content-Type':'application/json'}}),new Response('bad-json',{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}})]) {
      fetch.mockImplementation(async(path)=>String(path).includes('current-reporting')?ok(schoolContext):response);await expect(loadSchoolAccount()).rejects.toMatchObject({kind:'INVALID'});
    }
    fetch.mockRejectedValue(Error('private network details'));await expect(loadSchoolAccount()).rejects.toMatchObject({message:expect.not.stringContaining('private network details')});
  });
  it('binds actual credits to the authorized subscription, never substituting planning allowances', async () => {
    const fetch=mockReads('paid'), a=account('paid');await expect(loadSchoolAllowance(a)).resolves.toMatchObject({currentAllowance:{balance:{allowanceCredits:5000,availableCredits:4000}}});
    for (const mutate of [(c:ReturnType<typeof schoolCreditsFixture>)=>{c.schoolId=checkoutId(99);},(c:ReturnType<typeof schoolCreditsFixture>)=>{c.currentAllowance!.subscriptionId=checkoutId(99);},(c:ReturnType<typeof schoolCreditsFixture>)=>{c.subscriptionStatus='SUSPENDED';}]) {const c=schoolCreditsFixture(a.plan);mutate(c);fetch.mockResolvedValue(ok(c));await expect(loadSchoolAllowance(a)).rejects.toMatchObject({kind:'INVALID'});}
    fetch.mockResolvedValue(new Response('{}',{status:403}));await expect(loadSchoolAllowance(a)).rejects.toMatchObject({kind:'DENIED'});
  });
  it('sends only the merged offer ID with exact human-command and idempotency headers', async () => {
    const a=account(),offer=a.plan.offers[0]!, key=checkoutId(90), fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>ok(schoolCheckoutReceipt()));
    await expect(startSchoolCheckout(a,offer,key)).resolves.toMatchObject({providerCall:'OPENED'});
    expect(fetch).toHaveBeenCalledWith(`/api/v1/schools/${schoolContext.schoolId}/hon-plan/checkout`,expect.objectContaining({method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json','Content-Type':'application/json','Idempotency-Key':key,'X-HON-Human-Command':'saas-checkout-start'},body:JSON.stringify({offerId:offer.offerId})}));
    await startSchoolCheckout(a,offer,key);expect(fetch.mock.calls[0]![1]!.body).toBe(fetch.mock.calls[1]![1]!.body);
    await expect(startSchoolCheckout(a,offer,'invalid')).rejects.toMatchObject({kind:'INVALID'});expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('refuses foreign, repriced, unrecognized and unsafe command receipts', async () => {
    const a=account(),o=a.plan.offers[0]!,fetch=vi.spyOn(globalThis,'fetch');
    for (const mutate of [(r:ReturnType<typeof schoolCheckoutReceipt>)=>{r.checkout.amountMinor=15000;},(r:ReturnType<typeof schoolCheckoutReceipt>)=>{r.checkout.schoolId=checkoutId(99);},(r:ReturnType<typeof schoolCheckoutReceipt>)=>{r.checkout.organizationId=checkoutId(99);},(r:ReturnType<typeof schoolCheckoutReceipt>)=>{r.checkout.offerId=checkoutId(99);},(r:ReturnType<typeof schoolCheckoutReceipt>)=>{r.checkout.checkoutUrl='https://checkout.stripe.com.evil.test/c/pay/cs_test_synthetic';}]) {const r=schoolCheckoutReceipt();mutate(r);fetch.mockResolvedValue(ok(r));await expect(startSchoolCheckout(a,o,checkoutId(90))).rejects.toMatchObject({kind:'INVALID'});}
    for (const r of [{...schoolCheckoutReceipt(),providerCall:'CHARGED'},{...schoolCheckoutReceipt(),customerSecret:'private'}]) {fetch.mockResolvedValue(ok(r));await expect(startSchoolCheckout(a,o,checkoutId(90))).rejects.toMatchObject({kind:'INVALID'});}
  });
  it('distinguishes simulator and Stripe test links and refuses unsafe host/credential/port values', () => {
    expect(hostedCheckoutUrl(schoolPlanFixture({state:'open'}).checkout!)).toBeNull();
    const c=schoolPlanFixture({state:'open',provider:'STRIPE'}).checkout!;expect(hostedCheckoutUrl(c)).toBe('https://checkout.stripe.com/c/pay/cs_test_synthetic');
    for (const url of ['https://checkout.stripe.com@evil.test/x','https://checkout.stripe.com:444/x','http://checkout.stripe.com/x','https://checkout.simulated.invalid/x']) expect(()=>hostedCheckoutUrl({...c,checkoutUrl:url})).toThrow();
    expect(hostedCheckoutUrl({...c,mode:'LIVE' as never})).toBeNull();
  });
  it('handles provider and unknown outcomes once, with safe local copy and no false success', async () => {
    const a=account(),fetch=vi.spyOn(globalThis,'fetch');
    for (const [code,status,kind] of [['SAAS_OUTCOME_UNKNOWN',409,'UNKNOWN'],['SAAS_PAYMENTS_NOT_CONFIGURED',503,'PROVIDER'],['SAAS_PAYMENT_PROVIDER_UNAVAILABLE',502,'PROVIDER']] as const) {fetch.mockResolvedValue(new Response(JSON.stringify({code,private:'sensitive'}),{status}));fetch.mockClear();await expect(startSchoolCheckout(a,a.plan.offers[0]!,checkoutId(90))).rejects.toMatchObject({kind,message:expect.not.stringContaining('sensitive')});expect(fetch).toHaveBeenCalledTimes(1);}
  });
  it('gates disabled, sold-out, unsupported-tier, existing-subscription and open/review states', () => {
    const a=account();expect(canPurchase(a,a.plan.offers[0])).toBe(true);
    for (const state of ['disabled','empty','paid','open','created','review']) {const b=account(state);expect(canPurchase(b,b.plan.offers[0])).toBe(false);}
    const sold=schoolPlanFixture({stock:0});expect(canPurchase({...a,plan:sold},sold.offers[1])).toBe(false);expect(canPurchase(a,{...a.plan.offers[0]!,planCode:'COMPLETE'})).toBe(false);
    const oldOpen=schoolPlanFixture({state:'open',provider:'STRIPE'});oldOpen.payments={status:'DISABLED',mode:null};
    const html=renderAccount('open',oldOpen);expect(html).not.toContain('href="https://checkout.stripe.com');expect(html).toContain('unavailable while payments are disabled');
  });
  it('fingerprints immutable offer terms and resets confirmation on changed selection', () => {
    const a=account(),o=a.plan.offers[1]!;expect(offerFingerprint(a,o)).toBe(offerFingerprint(a,{...o,founderSlotsRemaining:1}));expect(offerFingerprint(a,o)).not.toBe(offerFingerprint(a,{...o,priceMinor:o.priceMinor+1}));expect(reviewFingerprint(a,o)).not.toBe(reviewFingerprint({...a,plan:schoolPlanFixture({state:'created'})},o));
    let s=selectPlan(INITIAL_SELECTION,{type:'REVIEW'});s=selectPlan(s,{type:'ACKNOWLEDGE',checked:true});expect(selectPlan(s,{type:'OFFER',offer:'FOUNDER_LIFETIME'}).acknowledged).toBe(false);
  });
  it('shows pending activation after verified test payment, preserving attestation, dispute and invoice distinctions', () => {
    const sim=renderAccount('paid');expect(sim).toContain('Simulator-verified test payment');expect(sim).toContain('Pending Account Activation');expect(sim).toContain('4,000');expect(sim).toContain('School invoice details and download are unavailable');
    expect(renderAccount('attested')).not.toContain('Pending Account Activation');expect(renderAccount('attested')).toContain('Manual HON attestation');
    for (const state of ['disputed','past-due','refunded','review']) expect(renderAccount(state)).not.toContain('Pending Account Activation');
  });
  it('validates every deterministic state against merged canonical contracts', () => {
    for (const tier of ['CORE','COMPLETE'] as const) for (const state of ['ready','disabled','empty','created','open','paid','attested','disputed','past-due','refunded','failed','expired','canceled','review']) {const p=schoolPlanFixture({tier,state});expect(validateSaasSchoolPlanOptions(p)).toEqual(p);expect(validateSaasSchoolCredits(schoolCreditsFixture(p))).toBeTruthy();}
  });
  it('keeps return selectors inert behind the session gate and preserves all modes', () => {
    const route=readFileSync('src/app/schools/[schoolId]/hon-plan/page.tsx','utf8');expect(route).toContain('await requireVerifiedWebSession()');expect(route).not.toMatch(/params|searchParams|result=|checkoutId|fetch\(/);
    const source=readFileSync('src/components/school-subscription/subscription.tsx','utf8');expect(source).toContain('HON_INTERFACE_THEMES.map');expect(source).toContain('AI conversation and voice are unavailable');expect(source).not.toMatch(/localStorage|sessionStorage|searchParams|window\.location/);
    const html=renderToStaticMarkup(<SchoolSubscription/>);expect(html).toContain('Test-mode purchasing');expect(html).toContain('Informational comparison price');expect(html).toContain('Big Button');expect(html).not.toContain('SYNTHETIC');
  });
});
