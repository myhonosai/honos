'use client';
import React,{useEffect,useState} from 'react';
import Link from 'next/link';
import { useLocale } from '../localization/provider';
import type { PricingController, PricingState } from './pricing-offers-controller';
import { CREDIT_QUICK_PICKS, PLAN_FEATURES, cents, defaultPlan, percentOff, planFromForm, planProblems, yearlySavings,
  type PlanDraft, type PriceKey } from './pricing-plan-builder-model';
import styles from './pricing-plan-builder.module.css';

export const PLAN_STEPS=['type','pricing','included','credits','terms','review'] as const;
export type PlanStep=typeof PLAN_STEPS[number];

/**
 * GoHighLevel-style step editor over the existing whole offer set. Every change goes through controller.applyPlan
 * (local form only); saving and publishing reuse the existing server-checked commands. No checkout lives here.
 */
export function PlanBuilder({controller,state}:{controller:PricingController;state:PricingState}):React.ReactElement|null {
  const {t,money,number}=useLocale();
  const p=(key:string,params?:Readonly<Record<string,string|number>>)=>t(('planBuilder.'+key) as never,params);
  const form=state.form;
  const [step,setStep]=useState<PlanStep>(form?.offers.length?'pricing':'type');
  useEffect(()=>{setStep(form?.offers.length?'pricing':'type');},[form?.key]);
  if(!form)return null;
  const editable=controller.editable(),dirty=controller.dirty(),plan=planFromForm(form),problems=planProblems(plan);
  const update=(patch:Partial<PlanDraft>)=>controller.applyPlan({...plan,...patch});
  const usd=(amount:string)=>{const c=cents(amount);return c===null?'—':money(c,'USD');};
  const index=PLAN_STEPS.indexOf(step);
  const go=(next:PlanStep)=>setStep(next);

  const priceRow=(key:PriceKey,unit:string,hint?:string|null)=><div className={styles.priceRow} data-plan-price={key}>
    <label className={styles.toggle}><input type="checkbox" checked={plan[key].on} disabled={!editable}
      onChange={e=>update({[key]:{on:e.target.checked,amount:plan[key].amount}} as Partial<PlanDraft>)}/><span>{p(key)}</span></label>
    {plan[key].on&&<div className={styles.amount}><span aria-hidden="true">$</span><input aria-label={p(key)} inputMode="decimal" autoComplete="off" maxLength={10}
      value={plan[key].amount} disabled={!editable} onChange={e=>update({[key]:{on:true,amount:e.target.value.replace(/[$,\s]/g,'')}} as Partial<PlanDraft>)}/><span className={styles.unit}>{unit}</span></div>}
    {plan[key].on&&hint&&<p className={styles.hint}>{hint}</p>}
  </div>;
  const numberField=(id:string,label:string,value:string,onChange:(v:string)=>void,max=7)=><div className={styles.field}>
    <label htmlFor={'plan-'+id}>{label}</label><input id={'plan-'+id} inputMode="numeric" autoComplete="off" maxLength={max} value={value} disabled={!editable}
      onChange={e=>onChange(e.target.value.replace(/[,\s]/g,''))}/></div>;
  const savings=plan.monthly.on&&plan.annual.on?yearlySavings(plan.monthly.amount,plan.annual.amount):null;
  const founderSavings=plan.founderMonthly.on&&plan.founderAnnual.on?yearlySavings(plan.founderMonthly.amount,plan.founderAnnual.amount):null;
  const off=(regular:PriceKey,founder:PriceKey)=>{const v=plan[regular].on?percentOff(plan[regular].amount,plan[founder].amount):null;return v===null?null:p('percentOff',{percent:v});};
  const savingsText=(s:ReturnType<typeof yearlySavings>)=>s&&p('savings',{amount:money(s.savedMinor,'USD'),percent:s.percent,months:s.monthsFree});
  const founderOn=plan.founderMonthly.on||plan.founderAnnual.on||plan.founderLifetime.on;

  const body:Record<PlanStep,React.ReactNode>={
    type:<div className={styles.choiceGrid}>
      <h3 className={styles.question}>{p('type.question')}</h3>
      <button type="button" className={styles.choice} data-plan-choice="regular" disabled={!editable} onClick={()=>{if(!form.offers.length)controller.applyPlan(defaultPlan());go('pricing');}}>
        <strong>{p('type.regular')}</strong><span>{p('type.regularNote')}</span>{!form.offers.length&&<em>{p('type.start')}</em>}</button>
      <Link className={styles.choice} data-plan-choice="trial" href="/hq/revenue/trials"><strong>{p('type.trial')}</strong><span>{p('type.trialNote')}</span></Link>
    </div>,
    pricing:<div className={styles.stack}>
      <div className={styles.field}><label htmlFor="plan-name">{p('name')}</label><input id="plan-name" maxLength={80} autoComplete="off" value={plan.name} disabled={!editable} onChange={e=>update({name:e.target.value})}/></div>
      <fieldset className={styles.group}><legend>{p('regular')}</legend>
        {priceRow('monthly',p('perMonth'))}{priceRow('annual',p('perYear'),savingsText(savings))}{priceRow('lifetime',p('once'))}
      </fieldset>
      <fieldset className={styles.group}><legend>{p('founder')}</legend><p className={styles.hint}>{p('founderNote')}</p>
        {priceRow('founderMonthly',p('perMonth'),off('monthly','founderMonthly'))}
        {priceRow('founderAnnual',p('perYear'),[off('annual','founderAnnual'),savingsText(founderSavings)].filter(Boolean).join(' · ')||null)}
        {priceRow('founderLifetime',p('once'),off('lifetime','founderLifetime'))}
        {founderOn&&numberField('founder-spots',p('founderSpots'),plan.founderSpots,v=>update({founderSpots:v}),4)}
      </fieldset>
      {(plan.lifetime.on||plan.founderLifetime.on)&&<fieldset className={styles.group}><legend>{p('lifetime')}</legend>
        {numberField('lifetime-spots',p('lifetimeSpots'),plan.lifetimeSpots,v=>update({lifetimeSpots:v}),5)}<p className={styles.hint}>{p('lifetimeNote')}</p></fieldset>}
    </div>,
    included:<div className={styles.stack}><h3 className={styles.question}>{p('included.title')}</h3>
      <ul className={styles.features}>{PLAN_FEATURES.map(f=><li key={f} data-plan-feature={f}><span aria-hidden="true">✓</span>{p('f.'+f)}</li>)}</ul>
      <p className={styles.hint}>{p('included.note')}</p></div>,
    credits:<div className={styles.stack}><h3 className={styles.question}>{p('credits.title')}</h3><p className={styles.hint}>{p('credits.note')}</p>
      <div className={styles.picks}>{CREDIT_QUICK_PICKS.map(c=><button type="button" key={c} aria-pressed={plan.credits===String(c)} disabled={!editable} onClick={()=>update({credits:String(c)})}>{p('credits.pick',{credits:number(c)})}</button>)}</div>
      <div className={styles.stepper}><button type="button" aria-label="−1,000" disabled={!editable||!/^\d+$/.test(plan.credits)||Number(plan.credits)<1000} onClick={()=>update({credits:String(Number(plan.credits)-1000)})}>−</button>
        {numberField('credits',p('credits.custom'),plan.credits,v=>update({credits:v}))}
        <button type="button" aria-label="+1,000" disabled={!editable} onClick={()=>update({credits:String((/^\d+$/.test(plan.credits)?Number(plan.credits):0)+1000)})}>+</button></div>
      <p className={styles.hint}>{p('credits.planning')}</p></div>,
    terms:<div className={styles.stack}>
      {numberField('refund',p('terms.refund'),plan.refundDays,v=>update({refundDays:v}),3)}
      <fieldset className={styles.group}><legend>{p('terms.who')}</legend>{(['ANY_ACTIVE_ORGANIZATION','NEW_ORGANIZATIONS_ONLY'] as const).map(w=><label key={w} className={styles.toggle}>
        <input type="radio" name="plan-who" checked={plan.who===w} disabled={!editable} onChange={()=>update({who:w})}/><span>{p(w==='NEW_ORGANIZATIONS_ONLY'?'terms.new':'terms.any')}</span></label>)}</fieldset>
      <div className={styles.pair}>
        <div className={styles.field}><label htmlFor="plan-opens">{p('terms.opens')}</label><input id="plan-opens" type="datetime-local" value={plan.salesOpensAt} disabled={!editable} onChange={e=>update({salesOpensAt:e.target.value})}/></div>
        <div className={styles.field}><label htmlFor="plan-closes">{p('terms.closes')}</label><input id="plan-closes" type="datetime-local" value={plan.salesClosesAt} disabled={!editable} onChange={e=>update({salesClosesAt:e.target.value})}/></div>
      </div>
      <div className={styles.field}><label htmlFor="plan-terms">{p('terms.doc')}</label><input id="plan-terms" maxLength={500} autoComplete="off" value={plan.termsReference} disabled={!editable} onChange={e=>update({termsReference:e.target.value})}/></div>
      <p className={styles.hint}>{p('terms.fixed')}</p></div>,
    review:<div className={styles.stack}><h3 className={styles.question}>{p('review.title')}</h3>
      {problems.length>0&&<ul className={styles.problems} role="alert">{problems.map(x=><li key={x}>{p('problem.'+x)}</li>)}</ul>}
      <div className={styles.actions}>
        <button type="button" data-plan-save disabled={!editable||problems.length>0||(!dirty&&!!form.setId)} onClick={()=>void controller.save()}>{p('review.save')}</button>
        <button type="button" data-plan-check disabled={!editable||dirty||!form.setId} onClick={()=>void controller.review()}>{p('review.check')}</button>
      </div>
      <p className={styles.hint}>{dirty?p('review.saveFirst'):form.setId?p('review.saved'):''}</p></div>,
  };

  const shown=(['monthly','annual','lifetime','founderMonthly','founderAnnual','founderLifetime'] as const).filter(k=>plan[k].on);
  const unitOf=(k:PriceKey)=>k.endsWith('onthly')?p('perMonth'):k.endsWith('nnual')?p('perYear'):p('once');
  return <section className={styles.builder} data-plan-builder data-plan-step={step}>
    <header className={styles.head}><h3>{p('title')}</h3><p>{p('intro')}</p></header>
    <ol className={styles.steps}>{PLAN_STEPS.map((s,i)=><li key={s}><button type="button" aria-current={s===step?'step':undefined} data-done={i<index?'true':undefined}
      disabled={s!=='type'&&!form.offers.length} onClick={()=>go(s)}><span>{i+1}</span>{p('step.'+s)}</button></li>)}</ol>
    <p className={styles.counter}>{p('stepOf',{step:index+1,total:PLAN_STEPS.length})} · {p('step.'+step)}</p>
    <div className={styles.layout}>
      <div className={styles.panel}>{body[step]}
        {step!=='type'&&<div className={styles.nav}><button type="button" onClick={()=>go(PLAN_STEPS[index-1]!)}>{p('back')}</button>
          {index<PLAN_STEPS.length-1&&<button type="button" className={styles.primary} onClick={()=>go(PLAN_STEPS[index+1]!)}>{p('next')}</button>}</div>}
      </div>
      {step!=='type'&&<aside className={styles.preview} data-plan-preview aria-label={p('preview')}><span className={styles.kicker}>{p('preview')}</span><h4>{plan.name||'HON OS'}</h4>
        {shown.length?<ul className={styles.prices}>{shown.map(k=><li key={k}>{k.startsWith('founder')&&<em>{p('preview.founder')}</em>}<strong>{usd(plan[k].amount)}</strong><span>{unitOf(k)}</span></li>)}</ul>:<p className={styles.hint}>{p('preview.empty')}</p>}
        <ul className={styles.perks}><li>✓ {p('preview.included')}</li><li>✓ {p('preview.aiTeam')}</li>
          {/^\d+$/.test(plan.credits)&&<li>✓ {p('preview.credits',{credits:number(Number(plan.credits))})}</li>}
          {/^\d+$/.test(plan.refundDays)&&Number(plan.refundDays)>0&&<li>✓ {p('preview.refund',{days:plan.refundDays})}</li>}</ul>
      </aside>}
    </div>
  </section>;
}
