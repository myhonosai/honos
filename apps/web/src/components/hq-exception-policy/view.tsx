import React, { useId } from 'react';
import type { SaasExceptionPolicyDecision, SaasExceptionPolicyView } from '@hon/contracts';
import { policyText, type PolicyKey } from './copy';
import { allowed, draftFrom, localDay, type DecisionDraft, type PolicyForm, type PolicyOutcome, type PolicyState } from './model';
import styles from '../hq-access/hq-access.module.css';

type T = (key: PolicyKey, vars?: Record<string, string>) => string;
export type PolicyViewProps = Readonly<{
  language: string; concealed: boolean; state: PolicyState; outcome: PolicyOutcome;
  /** A decision is sending or kept for Try again: every decision control is locked. */
  locked: boolean; canRetry: boolean; form: PolicyForm;
  onRefresh?: () => void; onReveal?: () => void; onOpenForm?: (form: PolicyForm) => void;
  onDecide?: (decision: 'PROPOSED' | 'APPROVED', draft: DecisionDraft) => void; onEnd?: (reason: string) => void; onTryAgain?: () => void;
}>;
const TONE: Record<SaasExceptionPolicyView['effectiveStatus'], 'ready' | 'waiting' | 'blocked'> = {
  ABSENT: 'blocked', PROPOSED: 'waiting', ACTIVE: 'ready', SCHEDULED: 'waiting', EXPIRED: 'blocked', WITHDRAWN: 'blocked', REVOKED: 'blocked', SUPERSEDED: 'blocked' };

export function outcomeText(language: string, outcome: PolicyOutcome): Readonly<{ tone: 'ok' | 'waiting' | 'blocked'; text: string }> | null {
  const t: T = (key, vars) => policyText(language, key, vars);
  if (!outcome) return null;
  switch (outcome.kind) {
    case 'SENDING': return { tone: 'waiting', text: t('sending') };
    case 'DONE': return { tone: 'ok', text: t('done', { decision: t(outcome.command) }) };
    case 'UNKNOWN': return { tone: 'waiting', text: t('unknown') };
    case 'CHANGED': return { tone: 'blocked', text: t('changed') };
    case 'DENIED': return { tone: 'blocked', text: t('notAllowed') };
    case 'INVALID': return { tone: 'blocked', text: t('invalid') };
    case 'LOCAL_INVALID': return { tone: 'blocked', text: t(outcome.command === 'WITHDRAWN' || outcome.command === 'REVOKED' ? 'localInvalidEnd' : 'localInvalid') };
    case 'REFUSED': return { tone: 'blocked', text: t('refused', { reason: t(outcome.code === 'SAAS_EXCEPTION_POLICY_LIMIT' ? 'limit'
      : outcome.code === 'SAAS_EXCEPTION_POLICY_REQUIRED' ? 'required' : 'windowInvalid') }) };
  }
}

/** Pure view. Every fact is from the exception-policy read; decision controls appear only for the HQ owner and only where the read allows them. */
export function HqExceptionPolicyView(props: PolicyViewProps): React.ReactElement {
  const { language, concealed, state, outcome, canRetry, onRefresh, onReveal, onTryAgain } = props;
  const t: T = (key, vars) => policyText(language, key, vars);
  const status = outcomeText(language, outcome);
  return <section className={styles.access} aria-labelledby="hq-policy-title" data-testid="hq-exception-policy">
    <header className={styles.head}>
      <div><p className={styles.meta}><a href="/hq/schools/access">{t('back')}</a></p>
        <h1 id="hq-policy-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {!concealed && onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={state.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    {concealed ? <div className={styles.notice} role="status"><p>{t('concealed')}</p>{onReveal ? <button type="button" className={styles.secondary} onClick={onReveal}>{t('reveal')}</button> : null}</div>
      : state.state === 'LOADING' ? <p className={styles.notice} role="status">{t('loading')}</p>
      : state.state === 'DENIED' ? <p className={styles.notice} role="status">{t('denied')}</p>
      : state.state === 'UNAVAILABLE' ? <p className={styles.notice} role="status">{t('unavailable')}</p> : null}
    {status && !concealed ? <div className={styles.outcome} data-tone={status.tone} role="status" data-testid="hq-policy-outcome"><p>{status.text}</p>
      {outcome?.kind === 'UNKNOWN' && canRetry && onTryAgain ? <button type="button" className={styles.primary} onClick={onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
    {!concealed && state.state === 'READY' ? <Ready {...props} view={state.view} t={t}/> : null}
  </section>;
}

function Ready(props: PolicyViewProps & { view: SaasExceptionPolicyView; t: T }) {
  const { view, t, language, form, locked, onOpenForm } = props;
  const date = (stamp: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(stamp));
  const can = allowed(view), c = view.current;
  const effect = view.effectiveStatus === 'SCHEDULED' && c ? t('effectSCHEDULED', { date: date(c.validFrom) }) : t(`effect${view.effectiveStatus}` as PolicyKey);
  return <>
    <div className={styles.policy}>
      <p>{view.paidAccessProgram === 'ACTIVE' ? t('paidOn') : t('paidOff')} {view.aiCreditProgram === 'ACTIVE' ? t('creditsOn') : t('creditsOff')}</p>
      <p data-testid="hq-policy-terms">{t('terms', { version: String(view.terms.policyVersion), days: String(view.terms.exceptionMaxDays) })}</p>
      {!view.viewer.canDecide ? <p data-testid="hq-policy-owner-only">{t('ownerOnly')}</p> : null}
    </div>
    <article className={styles.card} aria-labelledby="hq-policy-current" data-effective-status={view.effectiveStatus}>
      <div className={styles.cardHead}>
        <h2 id="hq-policy-current">{t('current')}</h2>
        <span className={styles.status} data-tone={TONE[view.effectiveStatus]} data-testid="hq-policy-status">{t(view.effectiveStatus)}</span>
      </div>
      {c ? <Facts p={c} t={t} date={date}/> : <p className={styles.meta}>{t('none')}</p>}
      <p className={styles.meta} data-testid="hq-policy-effect">{effect}</p>
      {can.decide || can.end ? <div className={styles.actions}>
        {can.decide && form !== 'DECIDE' ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.('DECIDE')}>{t('decideOpen')}</button> : null}
        {can.end && form !== 'END' ? <button type="button" className={styles.secondary} disabled={locked} onClick={() => onOpenForm?.('END')}>{t(can.end === 'WITHDRAWN' ? 'withdrawOpen' : 'revokeOpen')}</button> : null}
      </div> : null}
      {can.decide && form === 'DECIDE' ? <DecideForm {...props}/> : null}
      {can.end && form === 'END' ? <EndForm {...props} end={can.end}/> : null}
    </article>
    {view.history.length ? <section className={styles.card} aria-labelledby="hq-policy-history">
      <h2 id="hq-policy-history" style={{ margin: 0, fontSize: 17 }}>{t('history')}</h2>
      <p className={styles.meta}>{t('historyNote', { n: String(view.historyLimit) })}</p>
      <ol className={styles.list} data-testid="hq-policy-history">
        {view.history.map(p => <li key={p.approvalId} className={styles.form}>
          <div className={styles.cardHead}><h3 style={{ margin: '0 auto 0 0', fontSize: 15 }}>{t('revision', { n: String(p.revision) })}</h3>
            <span className={styles.status} data-tone={p.status === 'APPROVED' ? 'ready' : p.status === 'PROPOSED' ? 'waiting' : 'blocked'}>{t(p.status)}</span></div>
          <Facts p={p} t={t} date={date}/>
        </li>)}
      </ol>
    </section> : null}
  </>;
}

function Facts({ p, t, date }: { p: SaasExceptionPolicyDecision; t: T; date: (s: string) => string }) {
  const last = new Date(Date.parse(p.validUntil) - 1).toISOString();
  return <dl className={styles.facts}>
    <div><dt>{t('window')}</dt><dd>{t('windowValue', { from: date(p.validFrom), to: date(last) })}</dd></div>
    <div><dt>{t('maxDays')}</dt><dd>{t('daysValue', { n: String(p.maxDays) })}</dd></div>
    <div><dt>{t('termsVersion')}</dt><dd>{p.termsVersion}</dd></div>
    <div><dt>{t('recorded')}</dt><dd>{date(p.recordedAt)}</dd></div>
    <div style={{ gridColumn: '1 / -1' }}><dt>{t('reasonLabel')}</dt><dd>{p.reason}</dd></div>
  </dl>;
}

function DecideForm({ view, t, locked, onDecide, onOpenForm }: PolicyViewProps & { view: SaasExceptionPolicyView; t: T }) {
  const base = useId();
  const draft = draftFrom(view.current), max = view.terms.exceptionMaxDays, today = localDay(new Date());
  return <form className={styles.form} aria-labelledby={`${base}-title`} noValidate data-testid="hq-policy-decide" onSubmit={e => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = submitter?.value === 'APPROVED' ? 'APPROVED' : 'PROPOSED';
    onDecide?.(decision, { maxDays: v('maxDays'), startDate: v('startDate'), endDate: v('endDate'), reason: v('reason'), confirmed: f.get('confirmed') === 'yes' });
  }}>
    <h3 id={`${base}-title`}>{t('decideTitle')}</h3>
    <fieldset disabled={locked} className={styles.fields}>
      <legend className={styles.hidden}>{t('decideTitle')}</legend>
      <div className={styles.pair}>
        <div><label htmlFor={`${base}-days`}>{t('days')}</label>
          <input id={`${base}-days`} name="maxDays" type="number" min={1} max={max} step={1} defaultValue={draft.maxDays || String(max)} aria-describedby={`${base}-days-help`}/>
          <small id={`${base}-days-help`} className={styles.meta}>{t('daysHelp', { max: String(max) })}</small></div>
        <div><label htmlFor={`${base}-start`}>{t('starts')}</label>
          <input id={`${base}-start`} name="startDate" type="date" min={today} defaultValue={draft.startDate} aria-describedby={`${base}-start-help`}/>
          <small id={`${base}-start-help`} className={styles.meta}>{t('startsHelp')}</small></div>
        <div><label htmlFor={`${base}-end`}>{t('ends')}</label>
          <input id={`${base}-end`} name="endDate" type="date" min={today} defaultValue={draft.endDate} aria-describedby={`${base}-end-help`}/>
          <small id={`${base}-end-help`} className={styles.meta}>{t('endsHelp')}</small></div>
      </div>
      <label htmlFor={`${base}-reason`}>{t('reason')}</label>
      <textarea id={`${base}-reason`} name="reason" rows={2} minLength={10} maxLength={500} aria-describedby={`${base}-reason-help`}/>
      <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}>
        <input type="checkbox" name="confirmed" value="yes" style={{ width: 20, minHeight: 20, marginTop: 2 }}/> <span>{t('confirm')}</span></label>
      <div className={styles.actions}>
        <button type="submit" name="decision" value="APPROVED" className={styles.primary}>{t('approve')}</button>
        <button type="submit" name="decision" value="PROPOSED" className={styles.secondary}>{t('propose')}</button>
        <button type="button" className={styles.secondary} onClick={() => onOpenForm?.(null)}>{t('cancel')}</button>
      </div>
    </fieldset>
  </form>;
}

function EndForm({ t, locked, onEnd, onOpenForm, end }: PolicyViewProps & { t: T; end: 'WITHDRAWN' | 'REVOKED' }) {
  const base = useId();
  return <form className={styles.form} aria-labelledby={`${base}-title`} noValidate data-testid="hq-policy-end" onSubmit={e => {
    e.preventDefault(); onEnd?.(String(new FormData(e.currentTarget).get('reason') ?? ''));
  }}>
    <h3 id={`${base}-title`}>{t(end === 'WITHDRAWN' ? 'withdrawTitle' : 'revokeTitle')}</h3>
    <fieldset disabled={locked} className={styles.fields}>
      <legend className={styles.hidden}>{t(end === 'WITHDRAWN' ? 'withdrawTitle' : 'revokeTitle')}</legend>
      <p className={styles.meta}>{t('endNote')}</p>
      <label htmlFor={`${base}-reason`}>{t('reason')}</label>
      <textarea id={`${base}-reason`} name="reason" rows={2} minLength={10} maxLength={500} aria-describedby={`${base}-reason-help`}/>
      <small id={`${base}-reason-help`} className={styles.meta}>{t('reasonHelp')}</small>
      <div className={styles.actions}>
        <button type="submit" className={styles.danger}>{t(end === 'WITHDRAWN' ? 'withdraw' : 'revoke')}</button>
        <button type="button" className={styles.secondary} onClick={() => onOpenForm?.(null)}>{t('cancel')}</button>
      </div>
    </fieldset>
  </form>;
}
