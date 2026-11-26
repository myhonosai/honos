'use client';
import React,{useEffect,useState} from 'react';
import Link from 'next/link';
import { useLocale } from '../localization/provider';
import type { PricingController, PricingState } from './pricing-offers-controller';
import { AI_TEAM_FEATURES, CREDIT_QUICK_PICKS, MAX_PLANS, PLAN_FEATURES, addedPlan, allProblems, canonicalFeatures, cents, defaultPlans, percentOff,
  planProblems, plansFromForm, yearlySavings, type PlanDraft, type PlansDraft, type PriceKey } from './pricing-plan-builder-model';
import styles from './pricing-plan-builder.module.css';

export const PLAN_STEPS=['type','pricing','included','credits','terms','review'] as const;
export type PlanStep=typeof PLAN_STEPS[number];
const PER_PLAN:readonly PlanStep[]=['pricing','included','credits'];
const LAST='__last__';

/**
 * GoHighLevel-style step editor over the existing whole offer set. Each plan (offers sharing a name) has its own prices,
 * credits and feature list; terms are shared. Every change goes through controller.applyPlans (local form only); saving
 * and publishing reuse the existing server-checked commands. No checkout lives here and no feature is locked here.
 */
export function PlanBuilder({controller,state}:{controller:PricingController;state:PricingState}):React.ReactElement|null {
  const {t,money,number}=useLocale();
  const p=(key:string,params?:Readonly<Record<string,string|number>>)=>t(('planBuilder.'+key) as never,params);
  const form=state.form;
  const [step,setStep]=useState<PlanStep>(form?.offers.length?'pricing':'type');
  const [activeId,setActiveId]=useState<string|null>(null);
  useEffect(()=>{setStep(form?.offers.length?'pricing':'type');setActiveId(null);},[form?.key]);
  if(!form)return null;
  const editable=controller.editable(),dirty=controller.dirty(),draft=plansFromForm(form),problems=allProblems(draft);
  const plan=activeId===LAST?draft.plans.at(-1):draft.plans.find(x=>x.id===activeId)??draft.plans[0];
  const write=(next:PlansDraft)=>controller.applyPlans(next);
  const update=(patch:Partial<PlanDraft>)=>{if(plan)write({...draft,plans:draft.plans.map(x=>x.id===plan.id?{...x,...patch}:x)});};
  const shared=(patch:Partial<Omit<PlansDraft,'plans'>>)=>write({...draft,...patch});
  const usd=(amount:string)=>{const c=cents(amount);return c===null?'—':money(c,'USD');};
  const index=PLAN_STEPS.indexOf(step);
  const go=(next:PlanStep)=>setStep(next);
  const offerCount=draft.plans.reduce((n,x)=>n+(['monthly','annual','lifetime','founderMonthly','founderAnnual','founderLifetime'] as const).filter(k=>x[k].on).length,0);
  // A new plan's local id becomes the key of its first offer once written, so select it as "the last plan".
  const addPlan=()=>{write({...draft,plans:[...draft.plans,addedPlan(draft.plans)]});setActiveId(LAST);go('pricing');};
  const removePlan=()=>{if(plan&&draft.plans.length>1){write({...draft,plans:draft.plans.filter(x=>x.id!==plan.id)});setActiveId(null);}};

  const priceRow=(key:PriceKey,unit:string,hint?:string|null)=>plan&&<div className={styles.priceRow} data-plan-price={key}>
    <label className={styles.toggle}><input type="checkbox" checked={plan[key].on} disabled={!editable}
      onChange={e=>update({[key]:{on:e.target.checked,amount:plan[key].amount}} as Partial<PlanDraft>)}/><span>{p(key)}</span></label>
    {plan[key].on&&<div className={styles.amount}><span aria-hidden="true">$</span><input aria-label={p(key)} inputMode="decimal" autoComplete="off" maxLength={10}
      value={plan[key].amount} disabled={!editable} onChange={e=>update({[key]:{on:true,amount:e.target.value.replace(/[$,\s]/g,'')}} as Partial<PlanDraft>)}/><span className={styles.unit}>{unit}</span></div>}
    {plan[key].on&&hint&&<p className={styles.hint}>{hint}</p>}
  </div>;
  const numberField=(id:string,label:string,value:string,onChange:(v:string)=>void,max=7)=><div className={styles.field}>
    <label htmlFor={'plan-'+id}>{label}</label><input id={'plan-'+id} inputMode="numeric" autoComplete="off" maxLength={max} value={value} disabled={!editable}
      onChange={e=>onChange(e.target.value.replace(/[,\s]/g,''))}/></div>;
  const savingsText=(s:ReturnType<typeof yearlySavings>)=>s&&p('savings',{amount:money(s.savedMinor,'USD'),percent:s.percent,months:s.monthsFree});
  const off=(regular:PriceKey,founder:PriceKey)=>{if(!plan)return null;const v=plan[regular].on?percentOff(plan[regular].amount,plan[founder].amount):null;return v===null?null:p('percentOff',{percent:v});};
  const founderOn=draft.plans.some(x=>x.founderMonthly.on||x.founderAnnual.on||x.founderLifetime.on);
  const toggleFeature=(f:string,on:boolean)=>plan&&update({features:canonicalFeatures(on?[...plan.features,f]:plan.features.filter(x=>x!==f))});
  const featureGroup=(id:'core'|'ai',list:readonly string[])=>plan&&<fieldset className={styles.group} data-plan-features={id}><legend>{p('included.'+id)}</legend>
    <ul className={styles.features}>{list.map(f=><li key={f} data-plan-feature={f}><label className={styles.toggle}>
      <input type="checkbox" checked={plan.features.includes(f)} disabled={!editable} onChange={e=>toggleFeature(f,e.target.checked)}/><span>{p('f.'+f)}</span></label></li>)}</ul></fieldset>;

  const body:Record<PlanStep,React.ReactNode>={
    type:<div className={styles.choiceGrid}>
      <h3 className={styles.question}>{p('type.question')}</h3>
      <button type="button" className={styles.choice} data-plan-choice="regular" disabled={!editable} onClick={()=>{if(!form.offers.length)write(defaultPlans());go('pricing');}}>
        <strong>{p('type.regular')}</strong><span>{p('type.regularNote')}</span>{!form.offers.length&&<em>{p('type.start')}</em>}</button>
      <Link className={styles.choice} data-plan-choice="trial" href="/hq/revenue/trials"><strong>{p('type.trial')}</strong><span>{p('type.trialNote')}</span></Link>
    </div>,
    pricing:plan&&<div className={styles.stack}>
      <div className={styles.field}><label htmlFor="plan-name">{p('name')}</label><input id="plan-name" maxLength={80} autoComplete="off" value={plan.name} disabled={!editable} onChange={e=>update({name:e.target.value})}/></div>
      <fieldset className={styles.group}><legend>{p('regular')}</legend>
        {priceRow('monthly',p('perMonth'))}{priceRow('annual',p('perYear'),plan.monthly.on&&plan.annual.on?savingsText(yearlySavings(plan.monthly.amount,plan.annual.amount)):null)}{priceRow('lifetime',p('once'))}
      </fieldset>
      <fieldset className={styles.group}><legend>{p('founder')}</legend><p className={styles.hint}>{p('founderNote')}</p>
        {priceRow('founderMonthly',p('perMonth'),off('monthly','founderMonthly'))}
        {priceRow('founderAnnual',p('perYear'),[off('annual','founderAnnual'),plan.founderMonthly.on&&plan.founderAnnual.on?savingsText(yearlySavings(plan.founderMonthly.amount,plan.founderAnnual.amount)):null].filter(Boolean).join(' · ')||null)}
        {priceRow('founderLifetime',p('once'),off('lifetime','founderLifetime'))}
        {founderOn&&numberField('founder-spots',p('founderSpots'),draft.founderSpots,v=>shared({founderSpots:v}),4)}
      </fieldset>
      {(plan.lifetime.on||plan.founderLifetime.on)&&<fieldset className={styles.group}><legend>{p('lifetime')}</legend>
        {numberField('lifetime-spots',p('lifetimeSpots'),plan.lifetimeSpots,v=>update({lifetimeSpots:v}),5)}<p className={styles.hint}>{p('lifetimeNote')}</p></fieldset>}
    </div>,
    included:plan&&<div className={styles.stack}><h3 className={styles.question}>{p('included.title',{plan:plan.name||'HON OS'})}</h3>
      <div className={styles.actions}>
        <button type="button" data-plan-features-all disabled={!editable||plan.features.length===PLAN_FEATURES.length} onClick={()=>update({features:[...PLAN_FEATURES]})}>{p('included.all')}</button>
        <button type="button" data-plan-features-school disabled={!editable} onClick={()=>update({features:PLAN_FEATURES.filter(f=>!AI_TEAM_FEATURES.includes(f))})}>{p('included.schoolOnly')}</button>
      </div>
      {featureGroup('core',PLAN_FEATURES.filter(f=>!AI_TEAM_FEATURES.includes(f)))}
      {featureGroup('ai',PLAN_FEATURES.filter(f=>AI_TEAM_FEATURES.includes(f)))}
      <p className={styles.hint}>{p('included.note')}</p></div>,
    credits:plan&&<div className={styles.stack}><h3 className={styles.question}>{p('credits.title')}</h3><p className={styles.hint}>{p('credits.note')}</p>
      <div className={styles.picks}>{CREDIT_QUICK_PICKS.map(c=><button type="button" key={c} aria-pressed={plan.credits===String(c)} disabled={!editable} onClick={()=>update({credits:String(c)})}>{p('credits.pick',{credits:number(c)})}</button>)}</div>
      <div className={styles.stepper}><button type="button" aria-label="−1,000" disabled={!editable||!/^\d+$/.test(plan.credits)||Number(plan.credits)<1000} onClick={()=>update({credits:String(Number(plan.credits)-1000)})}>−</button>
        {numberField('credits',p('credits.custom'),plan.credits,v=>update({credits:v}))}
        <button type="button" aria-label="+1,000" disabled={!editable} onClick={()=>update({credits:String((/^\d+$/.test(plan.credits)?Number(plan.credits):0)+1000)})}>+</button></div>
      <p className={styles.hint}>{p('credits.planning')}</p></div>,
    terms:<div className={styles.stack}>
      {draft.plans.length>1&&<p className={styles.hint}>{p('terms.shared')}</p>}
      {numberField('refund',p('terms.refund'),draft.refundDays,v=>shared({refundDays:v}),3)}
      <fieldset className={styles.group}><legend>{p('terms.who')}</legend>{(['ANY_ACTIVE_ORGANIZATION','NEW_ORGANIZATIONS_ONLY'] as const).map(w=><label key={w} className={styles.toggle}>
        <input type="radio" name="plan-who" checked={draft.who===w} disabled={!editable} onChange={()=>shared({who:w})}/><span>{p(w==='NEW_ORGANIZATIONS_ONLY'?'terms.new':'terms.any')}</span></label>)}</fieldset>
      <div className={styles.pair}>
        <div className={styles.field}><label htmlFor="plan-opens">{p('terms.opens')}</label><input id="plan-opens" type="datetime-local" value={draft.salesOpensAt} disabled={!editable} onChange={e=>shared({salesOpensAt:e.target.value})}/></div>
        <div className={styles.field}><label htmlFor="plan-closes">{p('terms.closes')}</label><input id="plan-closes" type="datetime-local" value={draft.salesClosesAt} disabled={!editable} onChange={e=>shared({salesClosesAt:e.target.value})}/></div>
      </div>
      <div className={styles.field}><label htmlFor="plan-terms">{p('terms.doc')}</label><input id="plan-terms" maxLength={500} autoComplete="off" value={draft.termsReference} disabled={!editable} onChange={e=>shared({termsReference:e.target.value})}/></div>
      <p className={styles.hint}>{p('terms.fixed')}</p></div>,
    review:<div className={styles.stack}><h3 className={styles.question}>{p('review.title')}</h3>
      <ul className={styles.summary} data-plan-summary>{draft.plans.map(x=><li key={x.id}><strong>{x.name||'—'}</strong>
        <span>{p('review.planLine',{features:x.features.length,total:PLAN_FEATURES.length,credits:/^\d+$/.test(x.credits)?number(Number(x.credits)):'—'})}</span></li>)}</ul>
      {problems.length>0&&<ul className={styles.problems} role="alert">{problems.map(x=><li key={x}>{p('problem.'+x)}</li>)}</ul>}
      <div className={styles.actions}>
        <button type="button" data-plan-save disabled={!editable||problems.length>0||(!dirty&&!!form.setId)} onClick={()=>void controller.save()}>{p('review.save')}</button>
        <button type="button" data-plan-check disabled={!editable||dirty||!form.setId} onClick={()=>void controller.review()}>{p('review.check')}</button>
      </div>
      <p className={styles.hint}>{dirty?p('review.saveFirst'):form.setId?p('review.saved'):''}</p></div>,
  };

  const shown=plan?(['monthly','annual','lifetime','founderMonthly','founderAnnual','founderLifetime'] as const).filter(k=>plan[k].on):[];
  const unitOf=(k:PriceKey)=>k.endsWith('onthly')?p('perMonth'):k.endsWith('nnual')?p('perYear'):p('once');
  const perPlan=PER_PLAN.includes(step)&&!!plan;
  return <section className={styles.builder} data-plan-builder data-plan-step={step}>
    <header className={styles.head}><h3>{p('title')}</h3><p>{p('intro')}</p></header>
    <ol className={styles.steps}>{PLAN_STEPS.map((s,i)=><li key={s}><button type="button" aria-current={s===step?'step':undefined} data-done={i<index?'true':undefined}
      disabled={s!=='type'&&!form.offers.length} onClick={()=>go(s)}><span>{i+1}</span>{p('step.'+s)}</button></li>)}</ol>
    <p className={styles.counter}>{p('stepOf',{step:index+1,total:PLAN_STEPS.length})} · {p('step.'+step)}</p>
    {step!=='type'&&plan&&<div className={styles.plans} role="group" aria-label={p('plans.label')} data-plan-tabs>
      {draft.plans.map(x=><button type="button" key={x.id} aria-pressed={x.id===plan.id} data-plan-tab={x.name}
        className={planProblems(x,draft.plans).length?styles.planWarn:undefined} onClick={()=>setActiveId(x.id)}>{x.name||'—'}</button>)}
      <button type="button" data-plan-add disabled={!editable||draft.plans.length>=MAX_PLANS||offerCount>=12} onClick={addPlan}>+ {p('plans.add')}</button>
      {draft.plans.length>1&&perPlan&&<button type="button" data-plan-remove className={styles.planRemove} disabled={!editable} onClick={removePlan}>{p('plans.remove',{plan:plan.name||'—'})}</button>}
    </div>}
    {step!=='type'&&draft.plans.length>1&&perPlan&&<p className={styles.hint}>{p('plans.editing',{plan:plan!.name||'—'})}</p>}
    <div className={styles.layout}>
      <div className={styles.panel}>{body[step]}
        {step!=='type'&&<div className={styles.nav}><button type="button" onClick={()=>go(PLAN_STEPS[index-1]!)}>{p('back')}</button>
          {index<PLAN_STEPS.length-1&&<button type="button" className={styles.primary} onClick={()=>go(PLAN_STEPS[index+1]!)}>{p('next')}</button>}</div>}
      </div>
      {step!=='type'&&plan&&<aside className={styles.preview} data-plan-preview aria-label={p('preview')}><span className={styles.kicker}>{p('preview')}</span><h4>{plan.name||'HON OS'}</h4>
        {shown.length?<ul className={styles.prices}>{shown.map(k=><li key={k}>{k.startsWith('founder')&&<em>{p('preview.founder')}</em>}<strong>{usd(plan[k].amount)}</strong><span>{unitOf(k)}</span></li>)}</ul>:<p className={styles.hint}>{p('preview.empty')}</p>}
        <ul className={styles.perks}>
          <li>✓ {plan.features.length===PLAN_FEATURES.length?p('preview.included'):p('preview.features',{count:plan.features.length,total:PLAN_FEATURES.length})}</li>
          {plan.features.includes('ai.workforce')&&<li>✓ {p('preview.aiTeam')}</li>}
          {/^\d+$/.test(plan.credits)&&<li>✓ {p('preview.credits',{credits:number(Number(plan.credits))})}</li>}
          {/^\d+$/.test(draft.refundDays)&&Number(draft.refundDays)>0&&<li>✓ {p('preview.refund',{days:draft.refundDays})}</li>}</ul>
      </aside>}
    </div>
  </section>;
}
