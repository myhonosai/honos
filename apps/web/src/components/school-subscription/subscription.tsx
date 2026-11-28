'use client';

import { useLocale } from '../localization/provider';
import React, { useEffect, useId, useRef, useState } from 'react';
import { SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS } from '@hon/contracts';
import { HON_INTERFACE_THEMES, type HonInterfaceTheme } from '@hon/design-system';
import styles from './subscription.module.css';
import { useSchoolCheckout } from './use-checkout';
import { SchoolAccountStatus } from './account';
import { HonOsPrices } from './hon-os-prices';

const GUIDANCE = [
  { question: 'What does HON OS include?', answer: 'HON OS is one plan with everything in it: school operations, marketing tools, HON and the AI team, and Creative Studio credits each month. You only choose monthly or yearly, and founder pricing while founder spots last.' },
  { question: 'How do founder offers work?', answer: 'Founder pricing is limited to the first 50 eligible schools. A spot is counted only when a school’s first payment is verified, so the limit is not the number of spots left. A lifetime offer is shown only when HQ publishes one, with its own sale limit; it does not use the 50 founder spots. Earlier lifetime purchases are unchanged.' },
  { question: 'Does payment activate access?', answer: 'A return from checkout is not proof of payment. HON reloads backend payment evidence, and account activation is confirmed separately. Verified test payment can still show Pending Account Activation. This page never grants or changes features.' },
  { question: 'What are creative credits?', answer: 'Creative credits are used for Creative Studio images, video and other media. Each eligible paid school is planned to receive 12,000 included creative credits a month, the same on every plan, with optional top-ups. This is not your live balance or a credit grant. Your actual balance needs an authorized backend read.' },
  { question: 'Is the AI team included?', answer: 'Yes. The HON AI team in your plan is included in your subscription. Conversations, drafts and delegated work never use creative credits and are never charged per message. Fair-use limits keep the service reliable; reaching one pauses some AI work and charges nothing.' },
] as const;

/** What the one HON OS plan includes, in the website's words. Descriptive only: server entitlements decide every feature. */
const INCLUDED = ['Leads, memberships and classes', 'Belt testing and attendance', 'Payments and marketing tools', 'HON and the AI team, with no per-message charges', 'No HON fee on tuition', 'All three views: Big Button, Modern and Classic'] as const;

/**
 * The school's HON OS subscription page. HON OS is one plan (monthly or yearly, standard or founder): the prices and the
 * Subscribe section come from HonOsPrices, which reads this school's server offers. Account and payment status follow.
 */
export function SchoolSubscription({ returnedFromCheckout = false }: { returnedFromCheckout?: boolean }): React.ReactElement {
  const { t, text, formattingLocale, setSchoolContext } = useLocale();
  useEffect(()=>{document.title=t(returnedFromCheckout?'Checkout status.':'School subscription')+' | HON OS';},[t,returnedFromCheckout]);
  const billing = useSchoolCheckout();
  const currentSchool=billing.account?.context.schoolId;
  useEffect(()=>{if(currentSchool)setSchoolContext(currentSchool);return()=>{if(currentSchool)setSchoolContext(null);};},[currentSchool,setSchoolContext]);
  const [view, setView] = useState<HonInterfaceTheme>('modern');
  const [guideOpen, setGuideOpen] = useState(false);
  const [answer, setAnswer] = useState<number | null>(null);
  const guideButton = useRef<HTMLButtonElement>(null);
  const guideHeading = useRef<HTMLHeadingElement>(null);
  const guideId = useId();
  useEffect(() => { if (returnedFromCheckout || billing.account?.plan.checkout || billing.commandError) document.getElementById('school-account-title')?.focus(); }, [billing.account, billing.commandError, returnedFromCheckout]);
  useEffect(() => { if (guideOpen) guideHeading.current?.focus(); }, [guideOpen]);
  function closeGuide() { setGuideOpen(false); guideButton.current?.focus(); }

  return <main className={styles.page} data-view={view}>
    <a href="#plan-content" className={styles.skip}>{t("Skip to plan selection")}</a>
    <div className={styles.wrap}>
      <header className={styles.header}>
        <a href="/staff/launch" className={styles.brand} aria-label={t("HON OS school setup")}><span aria-hidden="true">◈</span>{" "}{t("HON OS")}{" "}<small>{t("School subscription")}</small></a>
        <a href="/staff/launch" className={styles.back}>{t("School setup ↗")}</a>
      </header>
      <div className={styles.toolbar}>
        <p className={styles.kicker}>{t("YOUR SCHOOL. YOUR NEXT CHAPTER.")}</p>
        <fieldset className={styles.views}><legend>{t("View")}</legend>{HON_INTERFACE_THEMES.map((theme) => <button type="button" key={theme.id} aria-pressed={view === theme.id} onClick={() => setView(theme.id)}>{theme.id === 'big-button' ? t("Big Button") : theme.id === 'modern' ? t("Modern") : t("Classic")}</button>)}</fieldset>
      </div>
      <section className={styles.intro} aria-labelledby="subscription-title">
        <div><h1 id="subscription-title">{returnedFromCheckout ? <><em>{t("Checkout status.")}</em></> : <>{t("More time to teach.")}<br/><em>{t("Room to grow.")}</em></>}</h1><p>{returnedFromCheckout ? t("Review payment and account access.") : t("HON OS is one plan for your whole school. Choose monthly or yearly below.")}</p></div>
      </section>
      {returnedFromCheckout && <><p role="status" className={styles.returnNotice}>{t("Test mode. HON verifies payment separately from account activation.")}</p><SchoolAccountStatus billing={billing}/></>}
      <section id="plan-content" className={styles.selection} aria-labelledby="included-title" data-one-plan>
        <div className={styles.sectionTitle}><div><p className={styles.kicker}>{t("WHAT'S INCLUDED")}</p><h2 id="included-title">{t("One plan. Everything in it.")}</h2></div></div>
        <p>{t("Everything your school runs on.")}</p>
        <ul className={styles.included}>
          {INCLUDED.map((item) => <li key={item}><span aria-hidden="true">✓</span>{text(item)}</li>)}
          <li><span aria-hidden="true">✓</span>{t("{credits} Creative Studio credits every month", { credits: SAAS_CREATIVE_MONTHLY_INCLUDED_CREDITS.toLocaleString(formattingLocale) })}</li>
        </ul>
        <HonOsPrices account={billing.account}/>
        <p className={styles.small}>{t("HON confirms the price and your eligibility when you subscribe. Choosing a price here never changes your plan by itself.")}</p>
      </section>
      {!returnedFromCheckout && <SchoolAccountStatus billing={billing}/>}
      <footer className={styles.footer}>{t("HON SaaS subscription · Separate from your school’s family billing · All prices USD")}</footer>
    </div>
    {guideOpen && <aside id={guideId} className={styles.guide} aria-labelledby="hon-guide-title" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeGuide(); } }}><header><div><span className={styles.kicker}>{t("HON · PLAN GUIDE")}</span><h2 id="hon-guide-title" ref={guideHeading} tabIndex={-1}>{t("A little guidance?")}</h2></div><button type="button" aria-label={t("Minimize HON plan guide")} onClick={closeGuide}>−</button></header><p>{t("Local product guidance. AI conversation and voice are unavailable. No school data is read and no actions are performed.")}</p><div className={styles.questions}>{GUIDANCE.map((item, index) => <button type="button" key={text(item.question)} aria-pressed={answer === index} onClick={() => setAnswer(index)}>{text(item.question)}</button>)}</div><p role="status" className={styles.answer}>{answer === null ? t("Choose a question above.") : text(GUIDANCE[answer]!.answer)}</p></aside>}
    <button ref={guideButton} type="button" className={styles.guideToggle} aria-label={guideOpen ? t("Minimize HON") : t("HON plan guide")} aria-expanded={guideOpen} aria-controls={guideOpen ? guideId : undefined} onClick={() => guideOpen ? closeGuide() : setGuideOpen(true)}><span aria-hidden="true">✧</span><span className={styles.guideLabel}>{guideOpen ? t("Minimize HON") : t("HON plan guide")}</span><span className={styles.guideCompact} aria-hidden="true">HON</span></button>
  </main>;
}
