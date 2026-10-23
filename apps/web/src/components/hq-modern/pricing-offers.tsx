'use client';
import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import Link from 'next/link';
import { SAAS_HON_OS_OFFER_KINDS, type SaasHonOsOffer, type SaasHonOsOfferSet, type SaasHonOsOfferSetDetail, type SaasHonOsOfferStopReason } from '@hon/contracts';
import { en, formatLocaleDateTime } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { HqIcon } from './icon';
import { PricingController, type PricingScreen } from './pricing-offers-controller';
import { kindLabels, type OfferFields } from './pricing-offers-model';
import base from './hq-modern.module.css';
import styles from './pricing-offers.module.css';

type OpKey=Extract<keyof typeof en,`pricing.op.${string}`> extends `pricing.op.${infer K}`?K:never;
type Confirmation='publish'|'discard'|'abandon'|{offer:SaasHonOsOffer};
function DecisionDialog({title,description,children,cancel,cancelLabel}:{title:string;description:string;children:React.ReactNode;cancel:()=>void;cancelLabel?:string}):React.ReactElement {
  const ref=useRef<HTMLDialogElement>(null),back=useRef<HTMLButtonElement>(null);const {t}=useLocale();
  useEffect(()=>{const opener=document.activeElement as HTMLElement|null;ref.current?.showModal();back.current?.focus();return()=>{if(opener?.isConnected)opener.focus();};},[]);
  return <dialog ref={ref} className={styles.switchDialog} aria-labelledby="pricing-decision-title" aria-describedby="pricing-decision-description" onCancel={e=>{e.preventDefault();cancel();}} onKeyDown={e=>{
    if(e.key!=='Tab')return;const buttons=e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)');
    const first=buttons[0],last=buttons[buttons.length-1];if(first&&last&&(e.shiftKey?document.activeElement===first:document.activeElement===last)){e.preventDefault();(e.shiftKey?last:first).focus();}
  }}><h2 id="pricing-decision-title">{title}</h2><p id="pricing-decision-description">{description}</p><div className={styles.actions}>{children}<button ref={back} type="button" onClick={cancel}>{cancelLabel??t('pricing.continue-editing')}</button></div></dialog>;
}
export function HqPricingOffers():React.ReactElement {
  const [controller]=useState(()=>new PricingController());
  useEffect(()=>{
    controller.start();
    const conceal=()=>controller.conceal(),visibility=()=>{if(document.visibilityState==='hidden')conceal();};
    const leave=(e:BeforeUnloadEvent)=>{if(controller.dirty()||controller.snapshot().pending){e.preventDefault();e.returnValue='';}};
    window.addEventListener('blur',conceal);document.addEventListener('visibilitychange',visibility);window.addEventListener('beforeunload',leave);
    return()=>{window.removeEventListener('blur',conceal);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('beforeunload',leave);controller.destroy();};
  },[controller]);
  return <PricingOffersView controller={controller}/>;
}
/** The same view is rendered in tests with a controller using the real transport contract. No bypass route exists. */
export function PricingOffersView({controller}:{controller:PricingController}):React.ReactElement {
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  const {t,money,number,date,preferences}=useLocale();const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const [stopReason,setStopReason]=useState<SaasHonOsOfferStopReason>('OWNER_DISABLED');
  const heading=useRef<HTMLHeadingElement>(null),reviewHeading=useRef<HTMLHeadingElement>(null);
  const op=(key:OpKey,params?:Readonly<Record<string,string|number>>)=>t(`pricing.op.${key}`,params);
  const label=(key:string|null)=>key&&Object.hasOwn(en,'pricing.op.'+key)?op(key as OpKey):op('notRecorded');
  const title=(kind:typeof SAAS_HON_OS_OFFER_KINDS[number])=>t(`pricing.${kindLabels[kind]}`);
  const price=(minor:number)=>money(minor,'USD');
  const utcDate=(value:string)=>formatLocaleDateTime({...preferences,timeZone:'UTC'},value);
  const dirty=controller.dirty(),editable=controller.editable(),form=state.form,detail=state.detail;
  const offer=form?.offers.find(o=>o.key===state.selected);
  useEffect(()=>{if(state.concealed)setConfirmation(null);},[state.concealed]);
  useEffect(()=>{if(state.form?.key)requestAnimationFrame(()=>heading.current?.focus());},[state.form?.key]);
  useEffect(()=>{if(state.review)requestAnimationFrame(()=>reviewHeading.current?.focus());},[state.review?.preview.previewDigest]);
  const navigate=(screen:PricingScreen)=>{if(screen==='preview')void controller.previewPublished();else controller.navigate(screen);requestAnimationFrame(()=>heading.current?.focus());};
  const error=state.error&&<p role="alert" className={styles.warning}>{Object.hasOwn(en,'pricing.op.'+state.error.code)?label(state.error.code):op('UNAVAILABLE')}</p>;
  const pending=state.pending&&<section className={styles.warning} aria-live="polite"><p>{op(state.busy?'working':'unknown')}</p>{!state.busy&&<div className={styles.actions}><button type="button" disabled={state.concealed||!state.owner} onClick={()=>void controller.retry()}>{op('retry')}</button><button type="button" onClick={()=>setConfirmation('abandon')}>{op('abandon')}</button></div>}</section>;
  const confirmationDialog=confirmation&&(!state.concealed||confirmation==='abandon')&&<DecisionDialog
    title={op(confirmation==='publish'?'publishConfirm':confirmation==='discard'?'discardBackend':confirmation==='abandon'?'abandon':'stop')}
    description={op(confirmation==='publish'?'publishWarning':confirmation==='discard'?'discardWarning':confirmation==='abandon'?'abandonWarning':'stopWarning')}
    cancel={()=>setConfirmation(null)} cancelLabel={op('cancel')}>
    {typeof confirmation==='object'&&<div className={styles.field}><label htmlFor="pricing-stop-reason">{op('stopReason')}</label><select id="pricing-stop-reason" value={stopReason} onChange={e=>setStopReason(e.target.value as SaasHonOsOfferStopReason)}>{(['OWNER_DISABLED','PRICE_CHANGE_PENDING','TERMS_REVIEW'] as const).map(value=><option key={value} value={value}>{label(value)}</option>)}</select></div>}
    <button type="button" disabled={state.busy} onClick={()=>{const action=confirmation;setConfirmation(null);if(action==='publish')void controller.publish();else if(action==='discard')void controller.discard();else if(action==='abandon')void controller.abandon();else void controller.stop(action.offer.offerId,stopReason);}}>{op('confirm')}</button>
  </DecisionDialog>;
  if(state.concealed)return <div className={styles.workbench} data-pricing-design data-pricing-busy={state.busy?'true':'false'} data-pricing-concealed><section className={base.panel}><HqIcon name="shield"/><h2>{op('concealed')}</h2><p>{op('concealNote')}</p>{error}<button type="button" disabled={state.busy} onClick={()=>void controller.load(true)}>{op('verify')}</button>{state.error&&['UNAUTHORIZED','IDENTITY_CHANGED'].includes(state.error.code)&&<Link className={styles.historyLink} href="/auth/login">{op('signin')}</Link>}</section>{pending}{confirmationDialog}</div>;
  const setName=(s:SaasHonOsOfferSet)=>op('version',{version:s.setVersion,revision:s.revision});
  const openSet=(id:string,clone=false)=>void controller.open(id,clone);
  const field=(key:Exclude<keyof OfferFields,'key'|'offerKind'>,copy:OpKey,{type='text',max=160}:{type?:string;max?:number}={})=><div className={styles.field}><label htmlFor={'offer-'+key}>{op(copy)}</label><input id={'offer-'+key} value={offer?.[key]??''} type={type} step={type==='datetime-local'?'0.001':undefined} autoComplete="off" maxLength={max} inputMode={['amount','saleLimit','priceLockMonths','plannedMonthlyPremiumCredits','refundWindowDays'].includes(key)?'decimal':undefined} onChange={e=>controller.editOffer(key,e.target.value)}/></div>;
  const select=(key:'eligibility'|'priceLock'|'annualRenewal'|'cancellationTiming',copy:OpKey,values:readonly string[],optional=false)=><div className={styles.field}><label htmlFor={'offer-'+key}>{op(copy)}</label><select id={'offer-'+key} value={offer?.[key]??''} onChange={e=>controller.editOffer(key,e.target.value)}>{optional&&<option value="">{op('optional')}</option>}{values.map(value=><option key={value} value={value}>{label(value)}</option>)}</select></div>;
  const quotes=(d:SaasHonOsOfferSetDetail)=><div className={styles.cards}>{d.preview.quotes.map(q=><article key={q.offerCode} className={styles.offer}><h3>{title(q.offerKind)}</h3><p>{q.offerCode}</p><strong className={styles.price}>{price(q.priceMinor)}</strong><dl className={styles.facts}>{([
    ['monthlyEquivalent',q.monthlyEquivalentMinor===null?null:price(q.monthlyEquivalentMinor)],['annualSavings',q.annualSavingsVsRegularMonthlyMinor===null?null:price(q.annualSavingsVsRegularMonthlyMinor)],
    ['breakEven',q.lifetimeBreakEvenMonths===null?null:number(q.lifetimeBreakEvenMonths)],['founderDiscount',q.founderDiscountPercentVsRegular===null?null:number(q.founderDiscountPercentVsRegular)+'%'],
  ] as const).filter(([,value])=>value!==null).map(([key,value])=><div key={key}><dt>{op(key)}</dt><dd>{value}</dd></div>)}</dl><dl className={styles.facts}>{d.set.offers.filter(o=>o.offerCode===q.offerCode).map(o=><React.Fragment key={o.offerId}>
    <div><dt>{op('eligibility')}</dt><dd>{label(o.eligibility)}</dd></div><div><dt>{op('saleLimit')}</dt><dd>{o.saleLimit===null?op('notRecorded'):number(o.saleLimit)}</dd></div>
    <div><dt>{op('priceLock')}</dt><dd>{label(o.priceLock)}{o.priceLockMonths===null?'':' · '+number(o.priceLockMonths)}</dd></div>
    <div><dt>{op('renewal')}</dt><dd>{label(o.annualRenewal)}</dd></div><div><dt>{op('cancellation')}</dt><dd>{label(o.cancellationTiming)}</dd></div>
    <div><dt>{op('refund')}</dt><dd>{o.refundWindowDays===null?op('notRecorded'):number(o.refundWindowDays)}</dd></div>
    <div><dt>{op('credits')}</dt><dd>{o.plannedMonthlyPremiumCredits===null?op('notRecorded'):number(o.plannedMonthlyPremiumCredits)}</dd></div>
    <div><dt>{op('fairUse')}</dt><dd>{o.aiFairUseReference??op('notRecorded')}</dd></div>
    <div><dt>{op('opens')}</dt><dd>{o.salesOpensAt===null?op('notRecorded'):utcDate(o.salesOpensAt)}</dd></div><div><dt>{op('closes')}</dt><dd>{o.salesClosesAt===null?op('notRecorded'):utcDate(o.salesClosesAt)}</dd></div>
  </React.Fragment>)}</dl></article>)}</div>;
  return <div className={styles.workbench} data-pricing-design data-pricing-busy={state.busy?'true':'false'}>
    <nav className={styles.tabs} aria-label={t('Pricing & Offers')}>{(['overview','editor','preview','history'] as const).map(value=><button type="button" key={value} aria-pressed={state.screen===value} onClick={()=>navigate(value)}>{t(`pricing.${value}`)}</button>)}</nav>
    <section className={`${base.panel} ${styles.hero}`}><div><span className={styles.kicker}>HON OS</span><h2>{op('manage')}</h2><p>{op('intro')}</p></div><div className={styles.productMark}><HqIcon name="shield" size={24}/><strong>HON OS</strong><span>{t('pricing.payment')}</span></div></section>
    <aside className={styles.boundary}><HqIcon name="shield"/><p>{op('safeguards')}</p></aside>
    <div className={styles.actions}><button type="button" disabled={state.busy} onClick={()=>state.pending?void controller.load():form?void controller.open(form.setId,false,true):void controller.load()}>{op('refresh')}</button><button type="button" disabled={state.status!=='ready'||!state.owner||state.busy||!!state.pending} onClick={()=>void controller.open(null)}>{op('newSet')}</button></div>
    {pending}{error}
    {state.status==='loading'&&<p role="status">{op('loading')}</p>}
    {state.status==='failed'&&<p role="status">{op('UNAVAILABLE')}</p>}
    {state.status==='ready'&&<>
      {!state.owner&&<p role="status" className={styles.warning}>{op('readOnly')}</p>}
      {state.stale&&<p role="alert" className={styles.warning}>{op('stale')}</p>}
      {state.localCopies.length>0&&<section className={base.panel}><h3>{op('localCopies')}</h3><div className={styles.actions}>{state.localCopies.map((key,index)=><button key={key} type="button" disabled={state.busy||!!state.pending} onClick={()=>void controller.restoreLocal(key)}>{op('restoreLocal',{number:number(index+1)})}</button>)}</div></section>}
      {state.receipt&&<section className={styles.kept} role="status"><h3>{op('receipt')}</h3><p>{label(state.receipt.kind==='stop'?'SALES_STOPPED':state.receipt.data.set.status)}</p>{state.receipt.data.replayed&&<p>{op('replayed')}</p>}<p>{op('receiptNote')}</p></section>}
      <h2 ref={heading} tabIndex={-1} className={styles.screenTitle}>{t(`pricing.${state.screen}`)}</h2>
      {state.screen==='overview'&&<>
        <section className={base.panel}><h3>{op('published')}</h3>{state.management?.published?<><p>{setName(state.management.published)} · {label(state.management.published.status)}</p><button type="button" disabled={state.busy||!!state.pending} onClick={()=>openSet(state.management!.published!.setId)}>{op('open')}</button></>:<p>{op('empty')}</p>}</section>
        <section className={styles.cards}>{SAAS_HON_OS_OFFER_KINDS.map(kind=><article className={styles.offer} key={kind}><h3>{title(kind)}</h3>{(state.management?.published?.offers.filter(o=>o.offerKind===kind)??[]).map(o=><div key={o.offerId}><strong className={styles.price}>{price(o.priceMinor)}</strong><p>{o.offerCode} · {o.salesStop?label('SALES_STOPPED'):op(state.management!.onSaleOfferIds.includes(o.offerId)?'listed':'notListed')}</p></div>)}<p className={styles.note}>{op('wholeSet')}</p></article>)}</section>
        <section className={base.panel}><h3>{op('drafts')}</h3>{state.management?.drafts.length?state.management.drafts.map(s=><div key={s.setId} className={styles.versionRow}><span>{setName(s)} · {label(s.status)}</span><button type="button" disabled={state.busy||!!state.pending} onClick={()=>openSet(s.setId)}>{op('open')}</button></div>):<p>{op('empty')}</p>}</section>
      </>}
      {state.screen==='editor'&&(!form?<p>{op('choose')}</p>:<>
        <div className={styles.editorLayout}><section className={`${base.panel} ${styles.editor}`}>
          <div className={styles.editorHeading}><h3>{form.setId&&detail?setName(detail.set):op('localOnly')}</h3><span className={styles.status}>{dirty?op('unsaved'):detail?label(detail.set.status):op('localOnly')}</span></div>
          <p className={styles.note}>{op('wholeSet')}</p>{detail&&detail.set.status!=='DRAFT'&&<p className={styles.warning}>{op('immutable')}</p>}
          <form onSubmit={e=>{e.preventDefault();void controller.save();}}><fieldset disabled={!editable}><legend>{op('wholeSet')}</legend>
            <div className={styles.field}><label htmlFor="set-terms">{op('terms')}</label><textarea id="set-terms" rows={2} maxLength={500} value={form.termsReference} onChange={e=>controller.editSet('termsReference',e.target.value)}/></div>
            <div className={styles.field}><label htmlFor="set-founder-limit">{op('founderLimit')}</label><input id="set-founder-limit" type="text" inputMode="numeric" maxLength={4} value={form.founderTotalLimit} onChange={e=>controller.editSet('founderTotalLimit',e.target.value)}/></div>
            <p className={styles.note}>{op('inventoryNote')}</p>
          </fieldset>
          <div className={styles.field}><label htmlFor="offer-select">{op('choose')}</label><select id="offer-select" value={state.selected??''} onChange={e=>controller.selectOffer(e.target.value)}>{!form.offers.length&&<option value="">{op('choose')}</option>}{form.offers.map(o=><option key={o.key} value={o.key}>{title(o.offerKind)} · {o.offerCode}</option>)}</select></div>
          {offer&&<fieldset disabled={!editable}><legend>{title(offer.offerKind)}</legend>{field('offerCode','code',{max:48})}{field('displayName','name',{max:80})}{field('amount','price',{max:10})}<p className={styles.note}>{op('usd')}</p>
            <div className={styles.fieldPair}>{field('salesOpensAt','opens',{type:'datetime-local'})}{field('salesClosesAt','closes',{type:'datetime-local'})}</div><p className={styles.note}>{op('utc')}</p>
            {select('eligibility','eligibility',['ANY_ACTIVE_ORGANIZATION','NEW_ORGANIZATIONS_ONLY'])}{field('saleLimit','saleLimit',{max:5})}
            {!offer.offerKind.endsWith('LIFETIME')&&<>{select('priceLock','priceLock',['NONE','WHILE_CONTINUOUSLY_SUBSCRIBED','FIXED_MONTHS'])}{offer.priceLock==='FIXED_MONTHS'&&field('priceLockMonths','lockMonths',{max:3})}{select('cancellationTiming','cancellation',['END_OF_PAID_PERIOD'],true)}</>}
            {offer.offerKind.endsWith('ANNUAL')&&select('annualRenewal','renewal',['AUTO_RENEW_AT_LOCKED_PRICE','AUTO_RENEW_AT_CURRENT_PRICE','NO_AUTO_RENEWAL'],true)}
            {field('refundWindowDays','refund',{max:3})}{field('plannedMonthlyPremiumCredits','credits',{max:7})}{field('aiFairUseReference','fairUse',{max:500})}<p className={styles.note}>{op('planning')}</p>
          </fieldset>}
          <div className={styles.actions}><button type="submit" disabled={!editable||(!dirty&&!!form.setId)||!form.offers.length}>{op('save')}</button><button type="button" disabled={!editable||!offer} onClick={controller.removeOffer}>{op('remove')}</button></div>
          </form>
          <section><h3>{op('add')}</h3><div className={styles.actions}>{SAAS_HON_OS_OFFER_KINDS.map(kind=><button type="button" key={kind} disabled={!editable||form.offers.length>=12} onClick={()=>controller.addOffer(kind)}>{title(kind)}</button>)}</div></section>
        </section><aside className={styles.designSummary}><div className={base.panel}><h3>HON OS</h3><p>{op('safeguards')}</p><button type="button" disabled={!editable||dirty||!form.setId} onClick={()=>void controller.review()}>{op('review')}</button>{dirty&&<p className={styles.note}>{op('saveFirst')}</p>}
          {detail&&detail.set.status!=='DRAFT'&&<button type="button" disabled={!state.owner||state.busy||!!state.pending} onClick={()=>openSet(detail.set.setId,true)}>{op('copy')}</button>}
          <button type="button" disabled={!editable||dirty||!form.setId} onClick={()=>setConfirmation('discard')}>{op('discardBackend')}</button>
          {detail?.set.status==='PUBLISHED'&&detail.set.offers.map(o=><div key={o.offerId}><p>{o.offerCode} · {o.salesStop?label('SALES_STOPPED'):op(state.management!.onSaleOfferIds.includes(o.offerId)?'listed':'notListed')}</p><button type="button" disabled={!state.owner||state.busy||!!state.pending||!!o.salesStop} onClick={()=>{setStopReason('OWNER_DISABLED');setConfirmation({offer:o});}}>{op('stop')} · {title(o.offerKind)}</button></div>)}
        </div></aside></div>
        {state.review&&<section className={`${base.panel} ${styles.publication}`} data-publication-review><h2 ref={reviewHeading} tabIndex={-1}>{op('reviewTitle')}</h2><p>{setName(state.review.set)}</p><p>{op('terms')}: {state.review.set.termsReference??op('notRecorded')}</p><p>{op('founderLimit')}: {state.review.set.founderTotalLimit===null?op('notRecorded'):number(state.review.set.founderTotalLimit)}</p>{quotes(state.review)}<p>{op(state.review.preview.ready?'ready':'blocked')}</p><ul>{state.review.preview.issues.map((issue,i)=><li key={i}>{label(issue.code)}{issue.offerCode?' · '+issue.offerCode:''}</li>)}</ul><p>{op('publishWarning')}</p><label className={styles.checkbox}><input type="checkbox" checked={state.acknowledged} onChange={e=>controller.acknowledge(e.target.checked)}/>{op('ack')}</label><button type="button" disabled={!editable||dirty||!state.acknowledged||!state.review.preview.ready} onClick={()=>setConfirmation('publish')}>{op('publish')}</button></section>}
      </>)}
      {state.screen==='history'&&<section className={base.panel}><p className={styles.note}>{op('historyNote')}</p>{state.management?.history.length?state.management.history.map(h=><article key={h.setId} className={styles.versionRow}><div><h3>{op('version',{version:h.setVersion,revision:h.revision})} · {label(h.status)}</h3><p>{date(h.createdAt)}{h.publishedAt?' · '+date(h.publishedAt):''}</p></div><button type="button" disabled={state.busy||!!state.pending} onClick={()=>openSet(h.setId)}>{op('open')}</button></article>):<p>{op('empty')}</p>}<Link className={styles.historyLink} href="/hq/revenue">{t('pricing.history-link')}</Link></section>}
      {state.screen==='preview'&&<section className={`${base.panel} ${styles.customerPreview}`} data-customer-pricing-preview><p>{op('customerNote')}</p><div className={styles.customerHeader}><span className={styles.productOrb} aria-hidden="true"/><h2>HON OS</h2><p>{t('pricing.product-description')}</p></div><div className={styles.previewGrid}>{(state.management?.published?.offers??[]).filter(o=>!o.founder&&state.management!.onSaleOfferIds.includes(o.offerId)).map(o=><article key={o.offerId}><h3>{title(o.offerKind)}</h3><strong className={styles.price}>{price(o.priceMinor)}</strong><p>{label(o.annualRenewal??o.cancellationTiming)}</p>{state.customerDetail?.preview.quotes.filter(q=>q.offerCode===o.offerCode&&q.annualSavingsVsRegularMonthlyMinor!==null).map(q=><p key={q.offerCode}>{op('annualSavings')}: {price(q.annualSavingsVsRegularMonthlyMinor!)}</p>)}<p>{op('refund')}: {o.refundWindowDays===null?op('notRecorded'):number(o.refundWindowDays)}</p><p>{op('credits')}: {o.plannedMonthlyPremiumCredits===null?op('notRecorded'):number(o.plannedMonthlyPremiumCredits)}</p><p>{op('planning')}</p><button type="button" disabled>{t('pricing.checkout-unavailable')}</button></article>)}</div>{!(state.management?.published?.offers??[]).some(o=>!o.founder&&state.management!.onSaleOfferIds.includes(o.offerId))&&<p>{op('customerEmpty')}</p>}<p>{t('pricing.founder-hidden')}</p></section>}
    </>}
    {state.intent&&<DecisionDialog title={t('pricing.unsaved-title')} description={t('pricing.unsaved-local')} cancel={()=>void controller.decide('continue')}><button type="button" onClick={()=>void controller.decide('save')}>{t('pricing.save-local')}</button><button type="button" onClick={()=>void controller.decide('discard')}>{t('pricing.discard-changes')}</button></DecisionDialog>}
    {confirmationDialog}
  </div>;
}
