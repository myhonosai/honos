'use client';

import React, { useEffect, useId, useReducer, useRef, useState } from 'react';
import { PUBLIC_PLAN_CATALOG } from '@hon/config';
import { SAAS_OWNER_APPROVED_DRAFT } from '@hon/contracts';
import { HON_INTERFACE_THEMES, type HonInterfaceTheme } from '@hon/design-system';
import { displayUsd, INITIAL_SELECTION, OFFER_CHOICES, PLAN_COMPARISON, planDisplay, selectPlan } from './catalog';
import styles from './subscription.module.css';

const GUIDANCE = [
  { question: 'Which plan fits my school?', answer: 'Core includes conventional school operations and manual or assisted marketing. Complete adds governed AI workforce capabilities. Actual tools remain subject to server authorization, available services and approvals.' },
  { question: 'How do founder offers work?', answer: 'The approved program is limited to the first 50 eligible organizations: 30 monthly and 20 lifetime offers. Those are program limits, not remaining slots. Eligibility and remaining inventory must be verified by the billing backend before checkout.' },
  { question: 'Does payment activate access?', answer: 'A return from checkout is not proof of payment. The backend must verify provider evidence, and the entitlement backend must independently confirm access. This foundation cannot start checkout or activate access.' },
  { question: 'What are premium AI credits?', answer: 'The planned monthly allowance is 5,000 for Core or 12,000 for Complete, including founder offers. This comparison is not your live balance or a credit grant. Actual usage and remaining credits need an authorized backend read.' },
] as const;

export function SchoolSubscription(): React.ReactElement {
  const [selection, dispatch] = useReducer(selectPlan, INITIAL_SELECTION);
  const [view, setView] = useState<HonInterfaceTheme>('modern');
  const [guideOpen, setGuideOpen] = useState(false);
  const [answer, setAnswer] = useState<number | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const restoreReviewFocus = useRef(false);
  const guideButton = useRef<HTMLButtonElement>(null);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const guideId = useId();
  const selected = planDisplay(selection.tier, selection.offer);
  const limits = SAAS_OWNER_APPROVED_DRAFT.founderProgram;

  useEffect(() => {
    if (selection.reviewing) reviewHeading.current?.focus();
    else if (restoreReviewFocus.current) { restoreReviewFocus.current = false; reviewButton.current?.focus(); }
  }, [selection.reviewing]);
  useEffect(() => { if (guideOpen) guideHeading.current?.focus(); }, [guideOpen]);
  function closeGuide() { setGuideOpen(false); guideButton.current?.focus(); }
  function edit() { restoreReviewFocus.current = true; dispatch({ type: 'EDIT' }); }

  return <main className={styles.page} data-view={view}>
    <a href="#plan-content" className={styles.skip}>Skip to plan selection</a>
    <div className={styles.wrap}>
      <header className={styles.header}>
        <a href="/staff/launch" className={styles.brand} aria-label="HON OS school setup"><span aria-hidden="true">◈</span> HON OS <small>School subscription</small></a>
        <a href="/staff/launch" className={styles.back}>School setup ↗</a>
      </header>
      <div className={styles.toolbar}>
        <p className={styles.kicker}>YOUR SCHOOL. YOUR NEXT CHAPTER.</p>
        <fieldset className={styles.views}><legend>View</legend>{HON_INTERFACE_THEMES.map((theme) => <button type="button" key={theme.id} aria-pressed={view === theme.id} onClick={() => setView(theme.id)}>{theme.id === 'big-button' ? 'Big Button' : theme.id === 'modern' ? 'Modern' : 'Classic'}</button>)}</fieldset>
      </div>
      <section className={styles.intro} aria-labelledby="subscription-title">
        <div><h1 id="subscription-title">More time to teach.<br/><em>Room to grow.</em></h1><p>Compare Core and Complete for your school. Review an offer before checkout.</p></div>
      </section>
      <div className={styles.notice} role="note"><strong>Plan-selection foundation</strong><span>Compare and review approved display terms. Purchases, founder reservations and payments are unavailable. No card details are collected.</span></div>
      <section id="plan-content" className={styles.selection} aria-labelledby="choose-title">
        <div className={styles.sectionTitle}><div><p className={styles.kicker}>01 / CHOOSE YOUR PLAN</p><h2 id="choose-title">Built for the way you run your school.</h2></div><a href="#compare">Compare features ↓</a></div>
        <fieldset className={styles.offers}><legend>Offer type</legend>{OFFER_CHOICES.map((offer) => <label key={offer.kind} className={selection.offer === offer.kind ? styles.chosenOffer : ''}><input type="radio" name="offer" value={offer.kind} checked={selection.offer === offer.kind} onChange={() => dispatch({ type: 'OFFER', offer: offer.kind })}/><span><strong>{offer.label}</strong><small>{offer.description}</small></span></label>)}</fieldset>
        <p className={styles.small}>Founder program: first {limits.totalLimit} eligible organizations · {limits.monthlyLimit} monthly / {limits.lifetimeLimit} lifetime. <strong>Remaining slots and your eligibility are unavailable.</strong></p>
        <div className={styles.plans} role="group" aria-label="Compare and select a HON plan">
          {PUBLIC_PLAN_CATALOG.map((plan) => { const display = planDisplay(plan.tier, selection.offer); const active = selection.tier === plan.tier; return <article className={`${styles.plan} ${active ? styles.selected : ''}`} key={plan.tier}>
            <div className={styles.planTop}><span className={styles.tag}>{plan.tier === 'CORE' ? 'THE COMPLETE SCHOOL FOUNDATION' : 'YOUR SCHOOL + A GOVERNED AI TEAM'}</span><span aria-hidden="true">{plan.tier === 'CORE' ? '◈' : '✧'}</span></div>
            <h3>HON {plan.displayName}</h3><p>{plan.tier === 'CORE' ? 'Run your school. Grow your business.' : 'Your school. Your AI team.'}</p>
            <div className={styles.price}><strong>{displayUsd(display.priceMinor)}</strong><span>{display.intervalLabel}</span></div><p className={styles.small}>USD · {display.offerLabel} · display price</p>
            <button type="button" className={styles.choose} aria-pressed={active} onClick={() => dispatch({ type: 'PLAN', tier: plan.tier })}>{active ? 'Selected' : 'Select'} HON {plan.displayName}<span aria-hidden="true">{active ? ' ✓' : ' →'}</span></button>
            <ul>{(plan.tier === 'CORE' ? ['Conventional CRM & school operations', 'Scheduling, memberships & curriculum', 'Manual & assisted marketing tools', 'Contextual HON assistance capability'] : ['Everything in HON Core', 'Seven specialist school AI role identities', 'Approved delegated work & orchestration', 'AI-managed campaign capability']).map((feature) => <li key={feature}><span aria-hidden="true">✓</span>{feature}</li>)}</ul>
            <div className={styles.allowance}><strong>{plan.premiumAiCreditPlanningAllowance.toLocaleString('en-US')}</strong><span>planned premium AI credits / month<br/><small>Not a granted allowance or live balance</small></span></div>
          </article>; })}
        </div>
        <p className={styles.small}>Both plans include all three views. Capability inclusion describes the approved plan catalog; it does not mean every integration or AI job is operational. No new Essential or annual subscriptions are offered.</p>
      </section>
      <section className={styles.review} aria-labelledby="review-title">
        <div><p className={styles.kicker}>02 / REVIEW YOUR SELECTION</p><h2 id="review-title" ref={reviewHeading} tabIndex={-1}>{selection.reviewing ? 'Your subscription summary' : 'A clear choice. No surprises.'}</h2><p>HON {selected.displayName} · {selected.offerLabel}</p><div className={styles.summaryPrice}>{displayUsd(selected.priceMinor)} <span>USD {selected.intervalLabel}</span></div>
          <p className={styles.small} role="status">{selection.reviewing ? 'Review only. No offer has been reserved and no checkout has started.' : 'Selection stays on this page. It does not change your current plan.'}</p>
        </div>
        <div>{!selection.reviewing ? <><p>Final price, taxes, availability and applicable terms must be verified by the authorized billing service before purchase.</p><button ref={reviewButton} type="button" className={styles.primary} onClick={() => dispatch({ type: 'REVIEW' })}>Review selection →</button></> : <>
          <dl className={styles.terms}><div><dt>Billing</dt><dd>{selection.offer === 'FOUNDER_LIFETIME' ? 'One-time subscription purchase; lifetime scope requires final published terms.' : 'Monthly subscription; renewal and cancellation terms require final published terms.'}</dd></div><div><dt>Monthly premium allowance</dt><dd>{selected.premiumAiCreditPlanningAllowance.toLocaleString('en-US')} planned credits; not a current balance.</dd></div><div><dt>Availability & taxes</dt><dd>Unverified. This is not a final quote. Founder selection does not reserve a slot.</dd></div><div><dt>Access</dt><dd>Backend payment verification and independent entitlement confirmation required. Selecting another tier does not upgrade your school.</dd></div></dl>
          <label className={styles.confirm}><input type="checkbox" checked={selection.acknowledged} onChange={(event) => dispatch({ type: 'ACKNOWLEDGE', checked: event.target.checked })}/><span>I have reviewed this selection. I understand this is not a purchase or an owner-authorization check.</span></label>
          <button type="button" className={styles.primary} disabled aria-describedby="checkout-reason">Secure checkout unavailable</button><p id="checkout-reason" className={styles.small}>The school checkout integration is pending. Even after confirmation, no payment can start here.</p><button type="button" className={styles.textButton} onClick={edit}>Edit selection</button>
        </>}</div>
      </section>
      <aside className={styles.account} aria-label="Current HON subscription"><span className={styles.tag}>ACCOUNT STATUS</span><h2>Current subscription unavailable</h2><p>School billing access, subscription, entitlements, invoices and live AI balance cannot be verified here yet.</p><span className={styles.unavailable}>Checkout not connected</span></aside>
      <section id="compare" className={styles.comparison} aria-labelledby="compare-title"><p className={styles.kicker}>THE FUNCTIONAL DIFFERENCE</p><h2 id="compare-title">Your foundation. Your AI advantage.</h2><p>Approved capability catalog. Server permissions, current entitlements, connected services and approvals still govern every operation.</p><details><summary>View full feature comparison</summary><div className={styles.tableWrap}><table><caption className={styles.srOnly}>HON Core and Complete approved plan capabilities</caption><thead><tr><th scope="col">Capability</th><th scope="col">Core</th><th scope="col">Complete</th></tr></thead><tbody>{PLAN_COMPARISON.map((row) => <tr key={row.capability}><th scope="row">{row.label}{row.note && <small>{row.note}</small>}</th><td>{row.core ? 'Included' : '—'}</td><td>{row.complete ? 'Included' : '—'}</td></tr>)}</tbody></table></div></details></section>
      <section className={styles.next} aria-labelledby="next-title"><div><p className={styles.kicker}>03 / WHAT HAPPENS NEXT</p><h2 id="next-title">A verified start for your school.</h2></div><ol><li><strong>Confirm school billing access</strong><p>The authorized backend must verify the exact school purchaser and available offers.</p></li><li><strong>Use secure hosted checkout</strong><p>Pending integration. Test mode only when available; no live payments.</p></li><li><strong>Verify payment, then access</strong><p>A success URL never proves payment or access. Invoices and actual credit balances require authorized records.</p></li><li><strong>Continue school setup</strong><p>Prepare your programs and classes through the existing <a href="/staff/launch">school setup workspace</a>.</p></li></ol></section>
      <footer className={styles.footer}>HON SaaS subscription · Separate from your school’s family billing · All prices USD</footer>
    </div>
    {guideOpen && <aside id={guideId} className={styles.guide} aria-labelledby="hon-guide-title" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeGuide(); } }}><header><div><span className={styles.kicker}>HON · PLAN GUIDE</span><h2 id="hon-guide-title" ref={guideHeading} tabIndex={-1}>A little guidance?</h2></div><button type="button" aria-label="Minimize HON plan guide" onClick={closeGuide}>−</button></header><p>Local product guidance. AI conversation and voice are unavailable. No school data is read and no actions are performed.</p><div className={styles.questions}>{GUIDANCE.map((item, index) => <button type="button" key={item.question} aria-pressed={answer === index} onClick={() => setAnswer(index)}>{item.question}</button>)}</div><p role="status" className={styles.answer}>{answer === null ? 'Choose a question above.' : GUIDANCE[answer]!.answer}</p></aside>}
    <button ref={guideButton} type="button" className={styles.guideToggle} aria-expanded={guideOpen} aria-controls={guideOpen ? guideId : undefined} onClick={() => guideOpen ? closeGuide() : setGuideOpen(true)}><span aria-hidden="true">✧</span> {guideOpen ? 'Minimize HON' : 'HON plan guide'}</button>
  </main>;
}
