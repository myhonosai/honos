'use client';
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT } from '../session-invalidation';
import { parseAccountSelectors, type AccountInitialSelectors } from './selectors';
import { AccountStatusController, type AccountStatusSnapshot } from './controller';
import { accountText, accountValue } from './copy';
import styles from './workbench.module.css';

export function SchoolAccountStatus({ sessionSubject, initialOrganizationId, initialSchoolId }: { sessionSubject: string } & AccountInitialSelectors): React.ReactElement {
  const locale = useLocale(), language = locale.preferences.language;
  const t = (key: Parameters<typeof accountText>[1]) => accountText(language, key), value = (code: string) => accountValue(language, code);
  const initial = parseAccountSelectors({ organizationId: initialOrganizationId, schoolId: initialSchoolId });
  const controller = useRef<AccountStatusController | null>(null); if (!controller.current) controller.current = new AccountStatusController(sessionSubject);
  const c = controller.current, [s, set] = useState(c.snapshot()), [org, setOrg] = useState(initial.initialOrganizationId ?? ''), [school, setSchool] = useState(initial.initialSchoolId ?? '');
  const [mode, setMode] = useState<'modern' | 'classic' | 'big'>('modern');
  const [privacyEpoch, setPrivacyEpoch] = useState(0);
  const area = useRef<HTMLDivElement | null>(null), status = useRef<HTMLParagraphElement | null>(null), priorBusy = useRef(false), priorPhase = useRef(s.phase);
  const hideDom = () => { if (area.current) { area.current.hidden = true; area.current.inert = true; for (const link of area.current.querySelectorAll('a')) link.removeAttribute('href'); } };
  useEffect(() => {
    c.activate(); const publish = (next: AccountStatusSnapshot) => {
      if (!['IDLE', 'OPEN'].includes(next.phase)) { hideDom(); if (next.phase !== 'VERIFYING') { setOrg(''); setSchool(''); setPrivacyEpoch(epoch => epoch + 1); } }
      set(next);
    };
    const unsubscribe = c.subscribe(publish); publish(c.snapshot());
    const hide = (event: Event) => { hideDom(); c.conceal(event.type === HON_SESSION_INVALIDATED_EVENT ? 'SESSION' : 'CONCEALED'); };
    const visibility = () => { if (document.visibilityState !== 'visible') hide(new Event('visibilitychange')); };
    const events = ['blur', 'pagehide', HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, hide); document.addEventListener('visibilitychange', visibility);
    if (document.visibilityState !== 'visible') hide(new Event('visibilitychange'));
    return () => { hideDom(); unsubscribe(); c.dispose(); for (const event of events) window.removeEventListener(event, hide); document.removeEventListener('visibilitychange', visibility); };
  }, [c]);
  const current = s.revision === c.snapshot().revision, privateVisible = current && ['IDLE', 'OPEN'].includes(s.phase);
  const busy = [s.account, s.standing, s.wallet].some(card => card.phase === 'LOADING');
  useEffect(() => { if (privateVisible && s.revision === c.snapshot().revision && area.current) { area.current.hidden = false; area.current.inert = false; } }, [privateVisible, s.revision, c]);
  useEffect(() => {
    const completed = priorBusy.current && !busy, restored = priorPhase.current === 'VERIFYING' && s.phase === 'IDLE'; priorBusy.current = busy; priorPhase.current = s.phase;
    if (current && privateVisible && (completed || restored)) status.current?.focus({ preventScroll: true });
  }, [busy, current, privateVisible, s.phase, s.revision]);
  const edit = (update: () => void) => { if (c.changeScope(s.revision)) { hideDom(); update(); } };
  const date = (stamp: string | null) => stamp === null ? t('notRecorded') : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(stamp)) + ' UTC';
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const row = (label: Parameters<typeof accountText>[1], content: ReactNode) => <div key={label}><dt>{t(label)}</dt><dd>{content}</dd></div>;
  const cardStatus = (phase: string) => <p role={phase === 'DENIED' || phase === 'UNAVAILABLE' ? 'alert' : 'status'} aria-live="polite">{t(phase === 'LOADING' ? 'loading' : phase === 'READY' ? 'readyCard' : phase === 'DENIED' ? 'deniedCard' : phase === 'UNAVAILABLE' ? 'unavailableCard' : 'idleCard')}</p>;
  const account = s.account.data, standing = s.standing.data, wallet = s.wallet.data;
  return <main className={`${styles.page} ${styles[mode]}`} data-testid="school-account-status" data-interface-theme={mode}>
    <header><p>HON OS</p><h1>{t('title')}</h1><p>{t('intro')}</p></header>
    <fieldset className={styles.modes}><legend>{t('mode')}</legend>{(['modern', 'classic', 'big'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{t(m)}</button>)}</fieldset>
    <p className={styles.help}>{t('modeHelp')}</p>
    <p ref={status} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" data-testid="account-status">{t(s.phase)}</p>
    {!privateVisible && !['SESSION', 'IDENTITY'].includes(s.phase) && <button type="button" disabled={s.phase === 'VERIFYING'} data-testid="account-restore" onClick={() => void c.restore(s.revision)}>{t('restore')}</button>}
    <div key={privacyEpoch} ref={area} hidden={!privateVisible} inert={!privateVisible} data-testid="account-private">
      {privateVisible && <>
        <fieldset className={styles.selectors}><legend>{t('selectors')}</legend>
          <label>{t('org')}<input data-testid="account-org" autoComplete="off" value={org} onChange={event => edit(() => setOrg(event.target.value))}/></label>
          <label>{t('school')}<input data-testid="account-school" autoComplete="off" value={school} onChange={event => edit(() => setSchool(event.target.value))}/></label>
          <p className={styles.help}>{t('selectorHelp')}</p>
        </fieldset>
        {s.inputError && <p role="alert">{t('inputError')}</p>}
        <div className={styles.actions}>
          <button type="button" data-testid="account-read-billing" disabled={s.account.phase === 'LOADING' || s.standing.phase === 'LOADING'} onClick={() => void c.loadBilling({ schoolId: school, ...(org === '' ? {} : { organizationId: org }) }, s.revision)}>{t('billingRead')}</button>
          <button type="button" data-testid="account-read-wallet" disabled={s.wallet.phase === 'LOADING'} onClick={() => void c.loadWallet({ schoolId: school, ...(org === '' ? {} : { organizationId: org }) }, s.revision)}>{t('walletRead')}</button>
        </div>
        <div className={styles.cards}>
          <section aria-labelledby="account-heading" data-testid="account-card"><h2 id="account-heading">{t('accountTitle')}</h2><p className={styles.help}>{t('accountHelp')}</p>{cardStatus(s.account.phase)}
            {account && <>
              <dl>{row('organization', account.organizationName)}{row('org', account.organizationId)}{row('school', account.schoolId)}
                {row('access', value(account.access.state))}{row('activation', value(account.access.activation))}{row('alignment', value(account.access.alignment))}{row('program', value(account.access.paidAccessProgram))}
                {row('payment', value(account.payment.status))}{row('verification', value(account.payment.verification))}{row('providerMode', value(account.payment.providerVerification))}{row('paidThrough', date(account.payment.paidThroughAt))}{row('asOf', date(account.asOf))}</dl>
              <h3>{t('entitlement')}</h3>{account.entitlement ? <dl>{row('entitlement', value(account.entitlement.status))}{row('inEffect', t(account.entitlement.inEffect ? 'yes' : 'no'))}{row('starts', date(account.entitlement.effectiveFrom))}{row('ends', date(account.entitlement.effectiveUntil))}</dl> : <p>{t('noEntitlement')}</p>}
              <h3>{t('subscription')}</h3>{account.subscription ? <dl>{row('subscription', value(account.subscription.status))}{row('source', value(account.subscription.source))}{row('interval', value(account.subscription.billingInterval))}{row('serviceStarted', date(account.subscription.serviceStartedAt))}{row('period', account.subscription.currentPeriod ? `${date(account.subscription.currentPeriod.startsAt)} → ${date(account.subscription.currentPeriod.endsAt)}` : t('notRecorded'))}</dl> : <p>{t('noSubscription')}</p>}
            </>}
          </section>
          <section aria-labelledby="standing-heading" data-testid="standing-card"><h2 id="standing-heading">{t('standingTitle')}</h2><p className={styles.help}>{t('standingHelp')}</p>{cardStatus(s.standing.phase)}
            {standing && <><h3>{value(standing.state)}</h3><dl>{row('paymentIssue', t(standing.paymentIssue ? 'yes' : 'no'))}{row('payment', value(standing.paymentStatus))}{row('renewalDue', date(standing.renewalDueAt))}{row('graceEnds', date(standing.graceEndsAt))}{row('suspended', date(standing.suspendedAt))}{row('ownerWindow', date(standing.ownerReadOnlyUntil))}{row('policy', t('proposed'))}{row('policyVersion', number(standing.policyVersion))}{row('program', value(standing.paidAccessProgram))}{row('asOf', date(standing.asOf))}</dl><p>{t('recovery')}</p><p>{t('noDeletion')}</p></>}
          </section>
          <section aria-labelledby="wallet-heading" data-testid="wallet-card"><h2 id="wallet-heading">{t('walletTitle')}</h2><p className={styles.help}>{t('walletHelp')}</p>{cardStatus(s.wallet.phase)}
            {wallet && <><dl>{row('walletScope', wallet.schoolId)}{row('program', value(wallet.programStatus))}{row('eligible', t(wallet.eligibility.eligible ? 'yes' : 'no'))}{row('reason', wallet.eligibility.reason === null ? t('notRecorded') : value(wallet.eligibility.reason))}{row('window', wallet.eligibility.window ? `${date(wallet.eligibility.window.startsAt)} → ${date(wallet.eligibility.window.endsAt)}` : t('notRecorded'))}{row('available', number(wallet.balance.availableCredits))}{row('held', number(wallet.balance.heldCredits))}</dl>
              {wallet.balance.byKind.length ? <div className={styles.table}><table><caption>{t('walletTitle')}</caption><thead><tr>{(['kind', 'granted', 'available', 'held', 'consumed'] as const).map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead><tbody>{wallet.balance.byKind.map(kind => <tr key={kind.kind}><th scope="row">{value(kind.kind)}</th><td>{number(kind.grantedCredits)}</td><td>{number(kind.availableCredits)}</td><td>{number(kind.heldCredits)}</td><td>{number(kind.consumedCredits)}</td></tr>)}</tbody></table></div> : <p>{t('emptyWallet')}</p>}
              <p className={styles.help}>{t('walletBoundary')}</p></>}
          </section>
        </div>
      </>}
    </div>
    <aside className={styles.note}><h2>{t('agentTitle')}</h2><p>{t('agentHelp')}</p></aside>
    <p className={styles.help}>{t('snapshotHelp')}</p>
    <nav aria-label={t('nav')} className={styles.actions}><a href="/auth/login">{t('signIn')}</a><a href="/staff/entry">{t('back')}</a></nav>
  </main>;
}
