import React, { useId } from 'react';
import { SAAS_ACCESS_EXCEPTION_PURPOSES, SAAS_ACCESS_OVERVIEW_STATUSES, type SaasAccessOverview, type SaasAccessOverviewOrganization,
  type SaasAccessOverviewStatus } from '@hon/contracts';
import { accessText, type AccessKey } from './copy';
import { POLICY_REFUSALS } from './http';
import { localDay, type AccessCommand, type AccessOutcome, type GrantDraft, type OverviewState } from './model';
import styles from './hq-access.module.css';

type T = (key: AccessKey, vars?: Record<string, string>) => string;
export type OpenForm = Readonly<{ command: AccessCommand; organizationId: string }> | null;
export type AccessViewProps = Readonly<{
  language: string; concealed: boolean; state: OverviewState; filter: SaasAccessOverviewStatus | null; outcome: AccessOutcome;
  /** A command is sending or kept for Try again: every command control is locked. */
  locked: boolean; canRetry: boolean; form: OpenForm;
  onFilter?: (status: SaasAccessOverviewStatus | null) => void; onMore?: () => void; onRefresh?: () => void; onReveal?: () => void;
  onOpenForm?: (form: OpenForm) => void; onGrant?: (org: SaasAccessOverviewOrganization, draft: GrantDraft) => void;
  onRevoke?: (org: SaasAccessOverviewOrganization, reason: string) => void; onTryAgain?: () => void;
}>;
const TIER = { ESSENTIAL: 'Essential', CORE: 'Core', COMPLETE: 'Complete' } as const;
const TONE: Record<SaasAccessOverviewStatus, string> = { AWAITING_FIRST_PAYMENT: 'waiting', EXCEPTION_IN_EFFECT: 'ready', EXCEPTION_SCHEDULED: 'waiting',
  PAID_ACCESS: 'ready', PROVISIONED_ACCESS: 'ready', NO_ACCESS: 'blocked' };

export function outcomeText(language: string, outcome: AccessOutcome): Readonly<{ tone: 'ok' | 'waiting' | 'blocked'; text: string }> | null {
  const t: T = (key, vars) => accessText(language, key, vars);
  if (!outcome) return null;
  const prefix = `${outcome.organization}: `;
  switch (outcome.kind) {
    case 'SENDING': return { tone: 'waiting', text: prefix + t('sending') };
    case 'DONE': return { tone: 'ok', text: prefix + t(outcome.command === 'grant' ? 'granted' : 'revoked') };
    case 'UNKNOWN': return { tone: 'waiting', text: prefix + t('unknown') };
    case 'CHANGED': return { tone: 'blocked', text: prefix + t('changed') };
    case 'DENIED': return { tone: 'blocked', text: prefix + t('notAllowed') };
    case 'INVALID': return { tone: 'blocked', text: prefix + t('invalid') };
    case 'LOCAL_INVALID': return { tone: 'blocked', text: prefix + t(outcome.command === 'grant' ? 'localInvalid' : 'localInvalidRevoke') };
    case 'REFUSED': return { tone: 'blocked', text: prefix + t('refused', { reason: t(outcome.code === 'SAAS_EXCEPTION_TOO_LONG' ? 'tooLong' : outcome.code !== null && POLICY_REFUSALS.has(outcome.code) ? 'policyRefused' : 'windowInvalid') }) };
  }
}

/** Pure view. Every fact is from the HQ access overview read; grant and revoke appear only for the HQ owner and only where the read allows them. */
export function HqAccessView(props: AccessViewProps): React.ReactElement {
  const { language, concealed, state, filter, outcome, canRetry, onFilter, onMore, onRefresh, onReveal, onTryAgain } = props;
  const t: T = (key, vars) => accessText(language, key, vars);
  const number = (n: number) => new Intl.NumberFormat(language).format(n);
  const status = outcomeText(language, outcome);
  return <section className={styles.access} aria-labelledby="hq-access-title">
    <header className={styles.head}>
      <div><h1 id="hq-access-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {!concealed && onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={state.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {concealed ? <div className={styles.notice} role="status"><p>{t('concealed')}</p>{onReveal ? <button type="button" className={styles.secondary} onClick={onReveal}>{t('reveal')}</button> : null}</div>
      : state.state === 'LOADING' ? <p className={styles.notice} role="status">{t('loading')}</p>
      : state.state === 'DENIED' ? <p className={styles.notice} role="status">{t('denied')}</p>
      : state.state === 'UNAVAILABLE' ? <p className={styles.notice} role="status">{t('unavailable')}</p> : null}
    {status && !concealed ? <div className={styles.outcome} data-tone={status.tone} role="status"><p>{status.text}</p>
      {outcome?.kind === 'UNKNOWN' && canRetry && onTryAgain ? <button type="button" className={styles.primary} onClick={onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
    {!concealed && state.state === 'READY' ? <>
      <Policy view={state.view} t={t}/>
      <nav className={styles.filters} aria-label={t('summary')}>
        <button type="button" aria-pressed={filter === null} onClick={() => onFilter?.(null)}>{t('all')} <span>{number(state.view.summary.total)}</span></button>
        {SAAS_ACCESS_OVERVIEW_STATUSES.map(s => <button key={s} type="button" aria-pressed={filter === s} data-tone={TONE[s]} onClick={() => onFilter?.(s)}>
          {t(s)} <span data-testid={`hq-access-count-${s}`}>{number(state.view.summary[s])}</span></button>)}
      </nav>
      {state.organizations.length ? <ul className={styles.list} data-testid="hq-access-list">
        {state.organizations.map(org => <li key={org.organizationId}><Organization {...props} org={org} view={state.view} t={t}/></li>)}
      </ul> : <p className={styles.notice}>{t('none')}</p>}
      {state.view.nextCursor ? <button type="button" className={styles.secondary} onClick={onMore} disabled={state.loadingMore}>{t('more')}</button> : null}
      {state.moreFailed ? <p className={styles.meta} role="status">{t('unavailable')}</p> : null}
    </> : null}
  </section>;
}

function Policy({ view, t }: { view: SaasAccessOverview; t: T }) {
  return <div className={styles.policy}>
    <p>{view.paidAccessProgram === 'ACTIVE' ? t('paidOn') : t('paidOff')}</p>
    <p>{view.exceptionPolicy.ready && view.exceptionPolicy.maxDays !== null ? t('policyReady', { days: String(view.exceptionPolicy.maxDays) }) : t('policyMissing')}</p>
    {!view.viewer.canGrantAndRevokeExceptions ? <p data-testid="hq-access-owner-only">{t('ownerOnly')}</p> : null}
    <p><a href="/hq/schools/access/policy">{t('policyLink')}</a></p>
  </div>;
}

function Organization(props: AccessViewProps & { org: SaasAccessOverviewOrganization; view: SaasAccessOverview; t: T }) {
  const { org, view, t, language, form, locked, onOpenForm } = props;
  const date = (stamp: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(stamp));
  const base = useId();
  const owner = view.viewer.canGrantAndRevokeExceptions;
  const x = org.currentException;
  const canGrant = owner && org.exceptionGrant.eligible && view.exceptionPolicy.ready;
  const canRevoke = owner && x?.revocable === true;
  const open = form?.organizationId === org.organizationId ? form.command : null;
  const shown = org.schools.map(s => s.schoolDisplayName).join(', ');
  return <article className={styles.card} aria-labelledby={`${base}-name`} data-access-status={org.accessStatus}>
    <div className={styles.cardHead}>
      <h2 id={`${base}-name`}>{org.organizationDisplayName}</h2>
      <span className={styles.status} data-tone={TONE[org.accessStatus]}>{t(org.accessStatus)}</span>
    </div>
    <p className={styles.meta}>{t('schools', { n: String(org.schoolCount) })}{shown ? `: ${shown}` : ''}{org.schoolCount > org.schools.length ? ` ${t('moreSchools', { n: String(org.schoolCount - org.schools.length) })}` : ''}</p>
    <dl className={styles.facts}>
      <div><dt>{t('plan')}</dt><dd>{org.entitlement ? `${TIER[org.entitlement.tier]} · ${org.entitlement.effectiveUntil ? t('until', { date: date(org.entitlement.effectiveUntil) }) : t('noEnd')}` : t('planNone')}</dd></div>
      <div><dt>{t('exception')}</dt><dd>{x ? `${t(x.purpose)} · ${t(`lifecycle${x.lifecycle}` as AccessKey)} · ${t('window', { from: date(x.startsAt), to: date(x.expiresAt) })}` : t('exceptionNone')}</dd></div>
      <div><dt>{t('subscription')}</dt><dd>{org.subscription ? `${org.subscription.planCode} · ${org.subscription.status}` : t('subscriptionNone')}</dd></div>
      <div><dt>{t('owner')}</dt><dd>{t(org.ownerOnboarding.status)}</dd></div>
    </dl>
    {org.openCheckout ? <p className={styles.meta}>{t('checkoutOpen')}</p> : null}
    {!org.exceptionGrant.eligible && !x?.revocable ? <p className={styles.meta}>{t('cannotGrant')} {org.exceptionGrant.blockers.map(b => t(b)).join('; ')}.</p> : null}
    {canGrant || canRevoke ? <div className={styles.actions}>
      {canGrant && open !== 'grant' ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.({ command: 'grant', organizationId: org.organizationId })}>{t('grantOpen')}</button> : null}
      {canRevoke && open !== 'revoke' ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.({ command: 'revoke', organizationId: org.organizationId })}>{t('revokeOpen')}</button> : null}
    </div> : null}
    {canGrant && open === 'grant' ? <GrantForm {...props}/> : null}
    {canRevoke && open === 'revoke' ? <RevokeForm {...props}/> : null}
  </article>;
}

function GrantForm({ org, view, t, locked, onGrant, onOpenForm }: AccessViewProps & { org: SaasAccessOverviewOrganization; view: SaasAccessOverview; t: T }) {
  const base = useId();
  const max = view.exceptionPolicy.maxDays ?? 1;
  const schools = org.schools.filter(s => s.schoolStatus === 'ACTIVE');
  const today = new Date(), last = new Date(today.getTime() + 30 * 86_400_000);
  const tier = org.entitlement?.tier === 'CORE' ? 'CORE' : 'COMPLETE';
  return <form className={styles.form} aria-labelledby={`${base}-title`} noValidate onSubmit={e => {
    e.preventDefault(); const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onGrant?.(org, { schoolId: v('schoolId'), purpose: v('purpose'), scopeTier: v('scopeTier'), startDate: v('startDate'), days: v('days'), reason: v('reason') });
  }}>
    <h3 id={`${base}-title`}>{t('grantTitle')}</h3>
    <fieldset disabled={locked} className={styles.fields}>
      <legend className={styles.hidden}>{t('grantTitle')}</legend>
      <div className={styles.pair}>
        <div><label htmlFor={`${base}-school`}>{t('school')}</label>
          <select id={`${base}-school`} name="schoolId" defaultValue={schools[0]?.schoolId}>{schools.map(s => <option key={s.schoolId} value={s.schoolId}>{s.schoolDisplayName}</option>)}</select></div>
        <div><label htmlFor={`${base}-purpose`}>{t('purpose')}</label>
          <select id={`${base}-purpose`} name="purpose">{SAAS_ACCESS_EXCEPTION_PURPOSES.map(p => <option key={p} value={p}>{t(p)}</option>)}</select></div>
        <div><label htmlFor={`${base}-scope`}>{t('scope')}</label>
          <select id={`${base}-scope`} name="scopeTier" defaultValue={tier}><option value="CORE">{t('CORE')}</option><option value="COMPLETE">{t('COMPLETE')}</option></select></div>
        <div><label htmlFor={`${base}-days`}>{t('days')}</label>
          <input id={`${base}-days`} name="days" type="number" min={1} max={max} step={1} defaultValue={Math.min(30, max)} aria-describedby={`${base}-days-help`}/>
          <small id={`${base}-days-help`} className={styles.meta}>{t('daysHelp', { max: String(max) })}</small></div>
      </div>
      <label htmlFor={`${base}-start`}>{t('starts')}</label>
      <input id={`${base}-start`} name="startDate" type="date" min={localDay(today)} max={localDay(last)} aria-describedby={`${base}-start-help`}/>
      <small id={`${base}-start-help`} className={styles.meta}>{t('startsNow')}. {t('startsHelp')}</small>
      <label htmlFor={`${base}-reason`}>{t('reason')}</label>
      <textarea id={`${base}-reason`} name="reason" rows={2} minLength={10} maxLength={500} aria-describedby={`${base}-reason-help`}/>
      <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
      <p className={styles.meta}>{t('noCredits')}</p>
    </fieldset>
    <div className={styles.actions}>
      <button type="submit" className={styles.primary} disabled={locked}>{t('grant')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.(null)}>{t('cancel')}</button>
    </div>
  </form>;
}

function RevokeForm({ org, t, locked, onRevoke, onOpenForm }: AccessViewProps & { org: SaasAccessOverviewOrganization; t: T }) {
  const base = useId();
  return <form className={styles.form} aria-labelledby={`${base}-title`} noValidate onSubmit={e => {
    e.preventDefault(); onRevoke?.(org, String(new FormData(e.currentTarget).get('reason') ?? ''));
  }}>
    <h3 id={`${base}-title`}>{t('revokeTitle')}</h3>
    <p className={styles.meta}>{t('revokeNote')}</p>
    <fieldset disabled={locked} className={styles.fields}>
      <legend className={styles.hidden}>{t('revokeTitle')}</legend>
      <label htmlFor={`${base}-reason`}>{t('reason')}</label>
      <textarea id={`${base}-reason`} name="reason" rows={2} minLength={10} maxLength={500} aria-describedby={`${base}-reason-help`}/>
      <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
    </fieldset>
    <div className={styles.actions}>
      <button type="submit" className={styles.danger} disabled={locked}>{t('revoke')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.(null)}>{t('cancel')}</button>
    </div>
  </form>;
}
