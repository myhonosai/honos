'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale } from '../localization/provider';
import { useHqModern } from './shell';
import { HqIcon } from './icon';
import { DESIGN_OFFER_LAYOUTS, emptyOfferDesign, hasUnsavedDesign, designPrice, designProblems, isAnnualDesign, isFounderDesign, isLifetimeDesign, customerDesignVisible,
  type DesignOfferLayout, type OfferDesign, type DesignProblem } from './pricing-offers-model';
import base from './hq-modern.module.css';
import styles from './pricing-offers.module.css';

type Screen = 'overview' | 'editor' | 'preview' | 'history';
/** Local presentation work only. No offer API, persistence, publish, provider or financial operation exists here. */
export function HqPricingOffers(): React.ReactElement {
  const { t, formattingLocale, number } = useLocale();
  const { overview } = useHqModern();
  const owner = overview.callerHqRole === 'OWNER'; // Presentation only; never a substitute for the future API's authority.
  const [screen, setScreen] = useState<Screen>('overview');
  const [drafts, setDrafts] = useState<Partial<Record<DesignOfferLayout, OfferDesign>>>({});
  const [draft, setDraft] = useState<OfferDesign>(() => emptyOfferDesign('monthly'));
  const [errors, setErrors] = useState<DesignProblem[]>([]), [kept, setKept] = useState(false);
  const [review, setReview] = useState(false), [acknowledged, setAcknowledged] = useState(false);
  const [pendingLayout, setPendingLayout] = useState<DesignOfferLayout | null>(null);
  const [retainedLayout, setRetainedLayout] = useState<DesignOfferLayout | null>(null);
  const switchDialog = useRef<HTMLDialogElement | null>(null), continueButton = useRef<HTMLButtonElement | null>(null);
  const switchOpener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null), reviewHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    if (pendingLayout && switchDialog.current && !switchDialog.current.open) {
      switchDialog.current.showModal(); continueButton.current?.focus();
    }
  }, [pendingLayout]);
  const title = (layout: DesignOfferLayout) => t(`pricing.${layout}`);
  const billing = (layout: DesignOfferLayout) => t(isLifetimeDesign(layout) ? 'pricing.one-time' : isAnnualDesign(layout) ? 'pricing.recurring-year' : 'pricing.recurring-month');
  const price = (d: OfferDesign) => designPrice(d.amount, d.currency, formattingLocale) ?? t('pricing.no-price');
  const navigate = (next: Screen) => { setReview(false); setAcknowledged(false); setScreen(next); requestAnimationFrame(() => heading.current?.focus()); };
  function switchTo(layout: DesignOfferLayout): void {
    setPendingLayout(null); setDraft({ ...(drafts[layout] ?? emptyOfferDesign(layout)) });
    setErrors([]); setKept(false); navigate('editor');
  }
  function select(layout: DesignOfferLayout): void {
    if (layout === draft.layout) { navigate('editor'); return; }
    if (hasUnsavedDesign(draft, drafts[draft.layout])) {
      switchOpener.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
      setPendingLayout(layout); return;
    }
    switchTo(layout);
  }
  function continueEditing(): void {
    setPendingLayout(null); setScreen('editor');
    requestAnimationFrame(() => {
      if (switchOpener.current?.isConnected) switchOpener.current.focus();
      else heading.current?.focus();
    });
  }
  function change<K extends keyof OfferDesign>(key: K, value: OfferDesign[K]): void {
    if (!owner) return;
    setDraft(old => ({ ...old, [key]: value })); setErrors([]); setKept(false); setReview(false); setAcknowledged(false);
  }
  const errorFor = (problem: DesignProblem) => errors.includes(problem) || undefined;
  const field = (key: Exclude<keyof OfferDesign, 'layout'>, label: Parameters<typeof t>[0], options: { area?: boolean; type?: string; problem?: DesignProblem; max?: number; hint?: Parameters<typeof t>[0] } = {}) => {
    const common = { id: `offer-${key}`, value: draft[key], maxLength: options.max ?? (options.area ? 2000 : 160),
      'aria-invalid': options.problem ? errorFor(options.problem) : undefined,
      'aria-describedby': options.problem && errors.includes(options.problem) ? `offer-error-${options.problem}` : undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(key, key === 'currency' ? event.target.value.toUpperCase() : event.target.value) };
    return <div className={styles.field}><label htmlFor={common.id}>{t(label)}</label>{options.area ? <textarea {...common} rows={3} /> : <input {...common} type={options.type ?? 'text'} autoComplete="off" inputMode={['amount', 'credits', 'founderLimit', 'annualDiscount'].includes(key) ? 'decimal' : undefined} />}{options.hint && <p className={styles.note}>{t(options.hint)}</p>}</div>;
  };
  // Drafts are explicitly internal. Founder data cannot enter the customer preview without a future verified contract.
  const previewDrafts = DESIGN_OFFER_LAYOUTS.map(layout => layout === draft.layout ? draft : drafts[layout] ?? emptyOfferDesign(layout)).filter(customerDesignVisible);
  return <div className={styles.workbench} data-pricing-design>
    <nav className={styles.tabs} aria-label={t('Pricing & Offers')}>{(['overview', 'editor', 'preview', 'history'] as const).map(value => <button key={value} type="button" aria-pressed={screen === value} onClick={() => navigate(value)}>{t(`pricing.${value}`)}</button>)}</nav>
    <section className={`${base.panel} ${styles.hero}`}><div><span className={styles.kicker}>{t('pricing.design')}</span><h2>{t('pricing.heading')}</h2><p>{t('pricing.intro')}</p></div><div className={styles.productMark}><HqIcon name="shield" size={24}/><strong>HON OS</strong><span>{t('pricing.payment')}</span></div></section>
    <aside className={styles.boundary} aria-label={t('pricing.design')}><HqIcon name="attention"/><div><strong>{t('pricing.backend')}</strong><p>{t('pricing.notice')}</p></div></aside>
    {retainedLayout && <p role="status" className={styles.kept}>{t('pricing.switch-retained', { offer: title(retainedLayout) })}</p>}
    <h2 ref={heading} tabIndex={-1} className={styles.screenTitle}>{t(`pricing.${screen}`)}</h2>
    {screen === 'overview' && <>
      <section className={styles.cards} aria-label={t('pricing.overview')}>{DESIGN_OFFER_LAYOUTS.map(layout => <article key={layout} className={styles.offer}>
        <div className={styles.offerTop}><HqIcon name={isLifetimeDesign(layout) ? 'gift' : isFounderDesign(layout) ? 'trophy' : 'chart'}/><span className={styles.status}>{t(drafts[layout] ? 'pricing.local-draft' : 'pricing.not-configured')}</span></div>
        <h3>{title(layout)}</h3><p>{billing(layout)}</p><strong className={styles.price}>{drafts[layout] ? price(drafts[layout]!) : t('pricing.no-price')}</strong><p className={styles.note}>HON OS · {t('pricing.design')}</p>
        <button type="button" onClick={() => select(layout)}>{t('pricing.edit')}<span className={styles.srOnly}> · {title(layout)}</span><HqIcon name="arrow" size={16}/></button>
      </article>)}</section>
      <section className={base.panel}><h3>{t('pricing.published')}</h3><p>{t('pricing.no-published')}</p><Link className={styles.historyLink} href="/hq/revenue">{t('pricing.history-link')} →</Link></section>
    </>}
    {screen === 'editor' && <div className={styles.editorLayout}><section className={`${base.panel} ${styles.editor}`}>
      <div className={styles.editorHeading}><h3>{title(draft.layout)}</h3><span className={styles.status}>{t('pricing.local-draft')}</span></div>
      {!owner && <p role="status" className={styles.warning}>{t('pricing.owner-only')}</p>}
      <form onSubmit={event => { event.preventDefault(); if (!owner) return; const problems = designProblems(draft); setErrors(problems); setKept(false); if (!problems.length) { setDrafts(old => ({ ...old, [draft.layout]: { ...draft } })); setKept(true); } }}>
        <fieldset disabled={!owner}><legend>{t('pricing.payment')}</legend>
          <div className={styles.field}><label htmlFor="offer-layout">{t('pricing.payment')}</label><select id="offer-layout" value={draft.layout} onChange={event => select(event.target.value as DesignOfferLayout)}>{DESIGN_OFFER_LAYOUTS.map(layout => <option key={layout} value={layout}>{title(layout)}</option>)}</select></div>
          <p className={styles.note}>{billing(draft.layout)}</p>
          {field('name', 'pricing.name', { problem: 'terms' })}
          <div className={styles.fieldPair}>{field('amount', 'pricing.amount', { max: 13, problem: 'price' })}{field('currency', 'pricing.currency', { max: 3, problem: 'price' })}</div>
          <div className={styles.fieldPair}>{field('saleStart', 'pricing.sale-start', { type: 'date', problem: 'dates' })}{field('saleEnd', 'pricing.sale-end', { type: 'date', problem: 'dates' })}</div>
          {field('terms', 'pricing.terms', { area: true, problem: 'terms' })}
        </fieldset>
        {isFounderDesign(draft.layout) && <fieldset disabled={!owner}><legend>{t('pricing.founder')}</legend>{field('eligibility', 'pricing.eligibility', { area: true, problem: 'eligibility' })}{field('founderLimit', 'pricing.limit', { max: 6, problem: 'founder' })}<p className={styles.note}>{t('pricing.founder-note')}</p></fieldset>}
        {isAnnualDesign(draft.layout) && <fieldset disabled={!owner}><legend>{t('pricing.annual-config')}</legend>{field('annualDiscount', 'pricing.discount', { max: 5, problem: 'annual', hint: 'pricing.discount-note' })}</fieldset>}
        {isLifetimeDesign(draft.layout) ? <fieldset disabled={!owner}><legend>{t('pricing.lifetime-config')}</legend>{field('serviceTerms', 'pricing.service-terms', { area: true, problem: 'lifetime' })}{field('fairUse', 'pricing.fair-use', { area: true, problem: 'lifetime' })}<p className={styles.note}>{t('pricing.lifetime-note')}</p></fieldset>
          : <fieldset disabled={!owner}><legend>{t('pricing.renewal')}</legend>{field('renewal', 'pricing.renewal', { area: true, problem: 'renewal' })}</fieldset>}
        <fieldset disabled={!owner}><legend>{t('pricing.usage')}</legend>{field('credits', 'pricing.credits', { max: 8, problem: 'usage' })}{field('usageLimits', 'pricing.limits', { area: true, problem: 'usage' })}<p className={styles.note}>{t('pricing.usage-note')}</p></fieldset>
        {errors.length > 0 && <div className={styles.warning} role="alert"><strong>{t('pricing.validation')}</strong><ul>{errors.map(problem => <li key={problem} id={`offer-error-${problem}`}>{t(`pricing.error.${problem}`)}</li>)}</ul></div>}
        <div className={styles.actions}><button type="submit" disabled={!owner}>{t('pricing.keep')}</button><button type="button" disabled={!owner} onClick={() => { setDraft(emptyOfferDesign(draft.layout)); setDrafts(old => { const next = { ...old }; delete next[draft.layout]; return next; }); setErrors([]); setKept(false); setReview(false); setAcknowledged(false); }}>{t('pricing.reset')}</button></div>
      </form>
      {kept && <p role="status" className={styles.kept}>{t('pricing.kept')}</p>}
    </section><aside className={styles.designSummary}><div className={base.panel}><span className={styles.kicker}>HON OS</span><h3>{title(draft.layout)}</h3><strong className={styles.price}>{price(draft)}</strong><p>{billing(draft.layout)}</p><p className={styles.note}>{t('pricing.notice')}</p><button type="button" disabled={!owner} onClick={() => { setReview(true); setAcknowledged(false); }}>{t('pricing.review')}</button></div><p className={styles.note}>{t('pricing.check-history')}</p></aside></div>}
    {screen === 'preview' && <section className={`${base.panel} ${styles.customerPreview}`} data-customer-pricing-preview><p className={styles.kicker}>{t('pricing.preview-note')}</p><div className={styles.customerHeader}><span className={styles.productOrb} aria-hidden="true"/><h2>HON OS</h2><p>{t('pricing.product-description')}</p></div><div className={styles.previewGrid}>{previewDrafts.map(d => <article key={d.layout}><h3>{title(d.layout)}</h3><strong className={styles.price}>{price(d)}</strong><p>{billing(d.layout)}</p><p dir="auto">{isLifetimeDesign(d.layout) ? d.serviceTerms : d.renewal}</p><p dir="auto">{d.terms}</p><p>{t('pricing.local-draft')}</p><button type="button" disabled>{t('pricing.checkout-unavailable')}</button></article>)}</div><p className={styles.warning}>{t('pricing.founder-hidden')}</p><p className={styles.note}>{t('pricing.capabilities')}</p></section>}
    {screen === 'history' && <section className={base.panel}><HqIcon name="shield" size={28}/><h3>{t('pricing.unavailable')}</h3><p>{t('pricing.history-note')}</p><p>{t('pricing.check-history')}</p><Link className={styles.historyLink} href="/hq/revenue">{t('pricing.history-link')} →</Link></section>}
    {review && screen === 'editor' && <section className={`${base.panel} ${styles.publication}`} aria-labelledby="offer-publication-title"><h2 id="offer-publication-title" ref={reviewHeading} tabIndex={-1}>{t('pricing.publication')}</h2><h3>HON OS · {title(draft.layout)}</h3><p>{price(draft)} · {billing(draft.layout)}</p><p dir="auto">{draft.terms}</p><ul>{(['pricing.check-backend', 'pricing.check-history', 'pricing.check-policy', 'pricing.check-payment'] as const).map(key => <li key={key}><HqIcon name="shield" size={17}/>{t(key)}</li>)}</ul>
      {designProblems(draft).length > 0 && <div className={styles.warning}><p>{t('pricing.validation')}</p><ul>{designProblems(draft).map(problem => <li key={problem}>{t(`pricing.error.${problem}`)}</li>)}</ul></div>}
      <label className={styles.checkbox}><input type="checkbox" checked={acknowledged} disabled={!owner} onChange={event => setAcknowledged(event.target.checked)}/>{t('pricing.ack')}</label><div className={styles.actions}><button type="button" disabled aria-describedby="offer-publish-blocked">{t('pricing.publish-unavailable')}</button><button type="button" onClick={() => { setReview(false); requestAnimationFrame(() => heading.current?.focus()); }}>{t('pricing.close-review')}</button></div><p id="offer-publish-blocked" className={styles.note}>{t('pricing.backend')}</p>
    </section>}
    {pendingLayout && <dialog ref={switchDialog} className={styles.switchDialog} aria-labelledby="offer-switch-title" aria-describedby="offer-switch-description" onCancel={event => { event.preventDefault(); continueEditing(); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }}>
      <h2 id="offer-switch-title">{t('pricing.unsaved-title')}</h2>
      <p id="offer-switch-description">{t('pricing.unsaved-description', { current: title(draft.layout), next: title(pendingLayout) })}</p>
      <p className={styles.note}>{t('pricing.unsaved-local')}</p>
      <div className={styles.actions}>
        <button type="button" disabled={!owner} onClick={() => {
          if (!owner) return;
          // Incomplete design notes are safe to retain locally; this is not publication validation.
          setDrafts(old => ({ ...old, [draft.layout]: { ...draft } })); setRetainedLayout(draft.layout); switchTo(pendingLayout);
        }}>{t('pricing.save-local')}</button>
        <button type="button" disabled={!owner} onClick={() => { if (owner) switchTo(pendingLayout); }}>{t('pricing.discard-changes')}</button>
        <button ref={continueButton} type="button" onClick={continueEditing}>{t('pricing.continue-editing')}</button>
      </div>
    </dialog>}
  </div>;
}
