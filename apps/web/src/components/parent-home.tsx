'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_HON_INTERFACE_THEME, HON_INTERFACE_THEMES, type HonInterfaceTheme } from '@hon/design-system';
import { loadParentBilling, ParentBillingAccessError } from './parent-billing-http';
import { loadParentJourney, ParentJourneyAccessError } from './parent-journey-http';
import { loadParentTestingStatus, ParentTestingStatusAccessError } from './parent-testing-status-http';
import s from './parent-home.module.css';

export type ParentHomeReadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'access-lost'; message: string };

const loading: ParentHomeReadState = { kind: 'loading' };

function UnavailableCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className={`${s.card} ${s.unavailable}`} aria-labelledby={`${title.toLowerCase().replaceAll(' ', '-')}-heading`}>
    <p className={s.eyebrow}>UNAVAILABLE</p><h2 id={`${title.toLowerCase().replaceAll(' ', '-')}-heading`}>{title}</h2><p>{children}</p>
  </section>;
}

function HomeCard({ title, eyebrow, description, href, note }: { title: string; eyebrow: string; description: string; href: string; note: string }) {
  return <section className={s.card} aria-labelledby={`${title.toLowerCase().replaceAll(' ', '-')}-heading`}>
    <p className={s.eyebrow}>{eyebrow}</p><h2 id={`${title.toLowerCase().replaceAll(' ', '-')}-heading`}>{title}</h2><p>{description}</p>
    <Link href={href} prefetch={false} className={s.cardLink}>Open {title}</Link><p className={s.note}>{note}</p>
  </section>;
}

function DomainCard({ title, eyebrow, description, href, note, state }: { title: string; eyebrow: string; description: string; href: string; note: string; state: ParentHomeReadState }) {
  if (state.kind === 'ready') return <HomeCard title={title} eyebrow={eyebrow} description={description} href={href} note={note} />;
  if (state.kind === 'loading') return null;
  return <UnavailableCard title={title}>{state.message}</UnavailableCard>;
}

/**
 * A page-level composition only. It never receives family, child, school, or
 * billing selectors, and it intentionally discards successful response data.
 * Each destination rechecks its own fixed family-scope read boundary.
 */
export function ParentHomeCards({ journey, testing, billing }: { journey: ParentHomeReadState; testing: ParentHomeReadState; billing: ParentHomeReadState }) {
  return <div className={s.cards}>
    {journey.kind === 'ready' && <>
      <HomeCard title="Schedule" eyebrow="AUTHORIZED BOOKINGS" description="View the current family schedule in Student Journey." href="/parent/journey#schedule" note="The Journey read chooses the authorized family and its bounded window. No booking, cancellation, check-in, or attendance action starts here." />
      <HomeCard title="Student Journey" eyebrow="CURRENT PROGRESS" description="Review current curriculum, shared recognition, and authorized bookings." href="/parent/journey" note="Only current family-safe observations are shown there. Progress, readiness, promotion, and testing outcomes are never inferred." />
      <HomeCard title="Documents" eyebrow="CURRENT PUBLICATIONS" description="Open the existing family document review and acknowledgement desk." href="/parent/documents" note="Document access is checked again by its own family-safe route. This Home never assumes an acknowledgement or creates one." />
      <UnavailableCard title="Planned Absences">A parent planned-absence read is not currently available. This Home does not submit a request, show a request status, cancel a booking, or infer absence history.</UnavailableCard>
    </>}
    {journey.kind === 'unavailable' && <UnavailableCard title="Student Journey">{journey.message}</UnavailableCard>}
    {testing.kind !== 'access-lost' && <DomainCard title="Testing Status" eyebrow="RECORDED STATUS" description="Review redacted current testing observations for your verified family." href="/parent/testing" note="Testing status is a separate read with its own live family-scope enforcement. It does not predict readiness, eligibility, payment, grades, promotion, or certificates." state={testing} />}
    {billing.kind !== 'access-lost' && <DomainCard title="Billing" eyebrow="REDACTED OBSERVATIONS" description="Review current membership and linked invoice/payment observations when guardian access is verified." href="/parent/billing" note="Billing is a separate guarded read. No payment method, provider, payer identity, collection, retry, change, or payment action begins here." state={billing} />}
  </div>;
}

export function ParentHome(): React.ReactElement {
  const [theme, setTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [journey, setJourney] = useState<ParentHomeReadState>(loading);
  const [testing, setTesting] = useState<ParentHomeReadState>(loading);
  const [billing, setBilling] = useState<ParentHomeReadState>(loading);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  const conceal = useCallback((message: string) => {
    ++generation.current;
    pending.current?.abort();
    pending.current = null;
    setJourney({ kind: 'access-lost', message });
    setTesting({ kind: 'access-lost', message });
    setBilling({ kind: 'access-lost', message });
  }, []);

  const hide = useCallback(() => {
    conceal('Family Home content is hidden. Return to this page to reverify access.');
  }, [conceal]);

  const verify = useCallback(async () => {
    const token = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setJourney(loading); setTesting(loading); setBilling(loading);

    void loadParentJourney(controller.signal).then(() => {
      if (generation.current === token) setJourney({ kind: 'ready' });
    }).catch(error => {
      if (generation.current !== token || error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ParentJourneyAccessError) conceal(error.message);
      else setJourney({ kind: 'unavailable', message: error instanceof Error ? error.message : 'Student Journey is unavailable. No family result is shown.' });
    });

    void loadParentTestingStatus(controller.signal).then(() => {
      if (generation.current === token) setTesting({ kind: 'ready' });
    }).catch(error => {
      if (generation.current !== token || error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ParentTestingStatusAccessError) {
        if (error.status === 401) conceal(error.message);
        else setTesting({ kind: 'access-lost', message: error.message });
      } else setTesting({ kind: 'unavailable', message: error instanceof Error ? error.message : 'Testing Status is unavailable. No status is shown.' });
    });

    void loadParentBilling(controller.signal).then(() => {
      if (generation.current === token) setBilling({ kind: 'ready' });
    }).catch(error => {
      if (generation.current !== token || error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ParentBillingAccessError) {
        if (error.status === 401) conceal(error.message);
        else setBilling({ kind: 'access-lost', message: error.message });
      } else setBilling({ kind: 'unavailable', message: error instanceof Error ? error.message : 'Billing is unavailable. No billing result is shown.' });
    });
  }, [conceal]);

  useEffect(() => {
    void verify();
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); else void verify(); };
    const focus = () => { if (document.visibilityState !== 'hidden') void verify(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', hide);
    window.addEventListener('focus', focus);
    window.addEventListener('pagehide', hide);
    return () => {
      ++generation.current;
      pending.current?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', hide);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pagehide', hide);
    };
  }, [hide, verify]);

  const checking = [journey, testing, billing].some(state => state.kind === 'loading');
  const familyAccessLost = journey.kind === 'access-lost';

  return <main className={`theme-${theme} ${s.page}`}><div className={s.shell}>
    <nav className={s.nav} aria-label="Parent Home navigation"><Link href="/parent" aria-current="page" className={s.wordmark}>HON <span>Parent Home</span></Link><Link href="/auth/login" prefetch={false}>Sign in</Link></nav>
    <header className={s.header}><p className={s.eyebrow}>YOUR FAMILY · VERIFIED READS ONLY</p><h1>One clear place to start.</h1><p>Open the family information that is currently available to you. This Home has no AI, messages, payments, booking controls, or actions.</p></header>
    <section className={s.controls} aria-label="Presentation and access"><div className={s.themes}><span>Presentation</span>{HON_INTERFACE_THEMES.map(item => <button key={item.id} type="button" aria-pressed={theme === item.id} onClick={() => setTheme(item.id)}>{item.label}</button>)}</div><button type="button" disabled={checking} onClick={() => void verify()}>{checking ? 'Checking verified access…' : 'Refresh verified access'}</button></section>
    <div aria-live="polite" aria-atomic="true">
      {checking && <p className={s.state} role="status">Loading Parent Home. Each available area is being checked through its existing family-safe read route; no previous family content is retained.</p>}
      {familyAccessLost && <section className={s.error} role="alert"><strong>Family access unavailable</strong><p>{journey.message}</p><Link href="/auth/login" prefetch={false}>Sign in again</Link></section>}
    </div>
    {!familyAccessLost && <ParentHomeCards journey={journey} testing={testing} billing={billing} />}
    <footer className={s.footer}>Messages are intentionally not shown because no parent-safe message read is currently available. Every destination independently verifies its own family scope. Presentation choices are visual only and do not change access, data, or actions.</footer>
  </div></main>;
}
