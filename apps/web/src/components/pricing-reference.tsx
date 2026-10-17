import { PUBLIC_PLAN_CATALOG, type PublicPlanTier } from '@hon/config';
import { HON_INTERFACE_THEMES } from '@hon/design-system';
import styles from './pricing-reference.module.css';

const PLAN_POSITIONING: Record<PublicPlanTier, { headline: string; detail: string }> = {
  CORE: {
    headline: 'Run your school. Grow your business.',
    detail: 'Complete conventional school CRM and marketing, paired with contextual HON assistance.',
  },
  COMPLETE: {
    headline: 'Your school. Your AI team.',
    detail: 'Everything in Core, plus a governed AI workforce.',
  },
};

const PORTRAIT_PRESENTATIONS = ['realistic', 'anime', 'chibi'] as const;

export function PricingReference(): React.ReactElement {
  return (
    <main className={styles.pricingPage}>
      <section className={styles.hero} aria-labelledby="pricing-title">
        <div className={styles.signal} aria-hidden="true" />
        <p className={styles.eyebrow}>HON OS · PUBLIC DESIGN REFERENCE</p>
        <h1 id="pricing-title">HON OS — The AI-powered operating system for martial arts schools</h1>
        <p className={styles.heroCopy}>
          A clear view of the approved Core and Complete planning metadata, designed around the work of running a martial arts school.
        </p>
        <p className={styles.referenceLabel}>Display and planning reference only · no commercial activation</p>
      </section>

      <section className={styles.planSection} aria-labelledby="plans-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>PUBLIC PLAN CATALOG</p>
            <h2 id="plans-title">Core and Complete, clearly scoped</h2>
          </div>
          <p>Only the canonical public catalog is shown here.</p>
        </div>

        <div className={styles.planGrid}>
          {PUBLIC_PLAN_CATALOG.map((plan) => {
            const positioning = PLAN_POSITIONING[plan.tier];
            return (
              <article className={styles.planCard} data-plan-tier={plan.tier} key={plan.tier}>
                <div className={styles.cardTopline}>
                  <span>{plan.displayName}</span>
                  <small>PUBLIC DISPLAY</small>
                </div>
                <h3>{positioning.headline}</h3>
                <p className={styles.planDetail}>{positioning.detail}</p>
                <div className={styles.priceBlock}>
                  <span>Monthly display metadata</span>
                  <strong>${plan.monthlyDisplayPriceUsd}<small>/month</small></strong>
                  <p>Non-binding display metadata</p>
                </div>
                <dl className={styles.planMetadata}>
                  <div>
                    <dt>Premium AI planning allowance</dt>
                    <dd>{plan.premiumAiCreditPlanningAllowance.toLocaleString()} credits</dd>
                  </div>
                  <div>
                    <dt>Planning status</dt>
                    <dd>Planning only · not a credit grant</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className={styles.presentationSection} aria-labelledby="presentation-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>ONE HON OS · DIFFERENT PRESENTATIONS</p>
            <h2 id="presentation-title">Three Platform Views</h2>
          </div>
          <p>Choose presentation density, not a plan or permission model.</p>
        </div>
        <div className={styles.presentationGrid}>
          {HON_INTERFACE_THEMES.map((theme) => (
            <article key={theme.id}>
              <span>{theme.label}</span>
              <p>{theme.detail}</p>
            </article>
          ))}
        </div>
        <div className={styles.neutralityNote}>
          <p>
            Big-Button / Phone, Modern HON, and Classic CRM are independent presentation choices. Realistic, anime, and chibi agent visuals are presentation assets only.
          </p>
          <ul aria-label="Independent agent visual presentations">
            {PORTRAIT_PRESENTATIONS.map((presentation) => <li key={presentation}>{presentation}</li>)}
          </ul>
          <p>Neither visual choice maps to a plan, entitlement, provider, or authority.</p>
        </div>
      </section>

      <aside className={styles.boundary} aria-label="Pricing reference boundary">
        <span>BOUNDARY</span>
        <div>
          <strong>No commercial activation occurs here.</strong>
          <p>
            This design reference activates no billing, subscription, payment, offer, credit grant, signup, or commercial account flow. It makes no claim of live provider availability or marketing performance.
          </p>
        </div>
      </aside>
    </main>
  );
}
