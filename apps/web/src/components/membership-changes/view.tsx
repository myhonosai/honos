import React from 'react';
import { MEMBERSHIP_REFUND_METHODS, type MembershipPause, type MembershipPausesAndRefunds, type SchoolMembershipListItem, type SchoolMembershipPausePolicyRead } from '@hon/contracts';
import { changeText, type ChangeKey } from './copy';
import { addDays, money, type ChangeErrorKind } from './http';
import styles from './membership-changes.module.css';

type T = (key: ChangeKey, vars?: Record<string, string>) => string;
export const CHANGE_FILTERS = ['ACTIVE', 'FROZEN', 'CANCELLED'] as const;
export type ChangeFilter = (typeof CHANGE_FILTERS)[number];
export type ChangeAction = 'pause' | 'resume' | 'cancel' | 'refund' | 'policy';
export type PolicyState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolMembershipPausePolicyRead };
export type ChangeListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' | 'TIMEZONE' }
  | { state: 'READY'; filter: ChangeFilter; items: readonly SchoolMembershipListItem[]; nextCursor: string | null; more: 'IDLE' | 'LOADING' | 'FAILED' };
export type HistoryState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; view: MembershipPausesAndRefunds };
export type ChangeOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | ChangeErrorKind; action: ChangeAction }>;
export type ChangeFields = Readonly<Record<string, string>>;

export type MembershipChangesViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  policy: PolicyState; list: ChangeListState; filter: ChangeFilter; selected: string | null; selectedLabel: string | null; history: HistoryState;
  form: ChangeAction | null; outcome: ChangeOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onFilter?: ((filter: ChangeFilter) => void) | undefined; onSelect?: ((membershipId: string | null, label: string | null) => void) | undefined;
  onMore?: (() => void) | undefined; onOpen?: ((form: ChangeAction) => void) | undefined; onClose?: (() => void) | undefined;
  onSubmit?: ((action: ChangeAction, fields: ChangeFields) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

// School-local calendar dates are shown as dates, never shifted by the viewer's time zone.
const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
const nameOf = (m: SchoolMembershipListItem, t: T) => (m.participant ? `${m.participant.givenName} ${m.participant.familyName}`.trim() : '') || t('notVisible');
function fieldsOf(form: HTMLFormElement): ChangeFields {
  const out: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') out[name] = value;
  return out;
}

function Rules({ p, t }: { p: MembershipChangesViewProps; t: T }) {
  const read = p.policy.state === 'READY' ? p.policy.read : null, policy = read?.policy ?? null;
  return <article className={styles.card} aria-labelledby="pause-rules-title" data-testid="pause-rules">
    <div className={styles.cardHead}><h2 id="pause-rules-title">{t('rulesTitle')}</h2>
      {read && p.form !== 'policy' ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onOpen?.('policy')}>{t('editRules')}</button> : null}</div>
    {p.policy.state === 'LOADING' ? <p className={styles.meta} role="status">{t('rulesLoading')}</p>
      : p.policy.state === 'DENIED' ? <p className={styles.meta} role="status">{t('rulesDenied')}</p>
      : p.policy.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('rulesUnavailable')}</p>
      : !policy ? <p>{t('rulesNone')}</p>
      : <>
        <p>{policy.pausesAllowed ? t('rulesOn', { max: String(policy.maxPauseDays), year: String(policy.maxPausedDaysPerYear) }) : t('rulesOff')}</p>
        {policy.pausesAllowed ? <p className={styles.meta}>{policy.holdFee ? t('holdFee', { fee: money(p.language, policy.holdFee.amountMinor, policy.holdFee.currency) }) : t('noHoldFee')}</p> : null}
        <p className={styles.meta}>{t('rulesVersion', { v: String(policy.version) })}</p>
      </>}
    {read && p.form === 'policy' ? <form className={styles.form} data-testid="pause-rules-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.('policy', fieldsOf(e.currentTarget)); }}>
      <label className={styles.check}><input type="checkbox" name="allowed" defaultChecked={policy?.pausesAllowed ?? false}/>{t('rulesAllowed')}</label>
      <div className={styles.grid}>
        <label className={styles.field}>{t('rulesMax')}<input type="number" name="max" min={1} max={365} step={1} defaultValue={policy?.maxPauseDays ?? ''}/></label>
        <label className={styles.field}>{t('rulesYear')}<input type="number" name="year" min={1} max={365} step={1} defaultValue={policy?.maxPausedDaysPerYear ?? ''}/></label>
      </div>
      <label className={styles.check}><input type="checkbox" name="fee" defaultChecked={policy?.holdFee !== null && policy?.holdFee !== undefined}/>{t('rulesFee')}</label>
      <div className={styles.grid}>
        <label className={styles.field}>{t('rulesFeeAmount')}<input type="text" inputMode="decimal" name="feeAmount" autoComplete="off" defaultValue={policy?.holdFee ? amountText(policy.holdFee.amountMinor, policy.holdFee.currency) : ''}/></label>
        <label className={styles.field}>{t('rulesCurrency')}<input type="text" name="feeCurrency" maxLength={3} autoComplete="off" defaultValue={policy?.holdFee?.currency ?? 'USD'}/></label>
      </div>
      <p className={styles.meta}>{t('rulesHelp')}</p>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('saveRules')}</button>
        <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('close')}</button></div>
    </form> : null}
  </article>;
}
/** Minor units back to editable major-unit text for the currency. */
function amountText(amountMinor: number, currency: string): string {
  let digits = 2;
  try { digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { /* keep 2 */ }
  return digits === 0 ? String(amountMinor) : `${Math.floor(amountMinor / 10 ** digits)}.${String(amountMinor % 10 ** digits).padStart(digits, '0')}`;
}

function PauseRow({ pause, today, language, t }: { pause: MembershipPause; today: string; language: string; t: T }) {
  return <li data-testid="pause-row">
    <span>{t('pauseRow', { from: day(language, pause.startsOn), to: day(language, pause.plannedResumeOn) })}</span>
    <span className={styles.meta}>{pause.pauseReason}</span>
    {pause.holdFee ? <span className={styles.meta}>{t('pauseFee', { fee: money(language, pause.holdFee.amountMinor, pause.holdFee.currency) })}</span> : null}
    {pause.endedKind === null ? <span className={styles.chip} data-kind="open">{t('pauseOpen')}</span>
      : <span className={styles.meta}>{t(pause.endedKind === 'RESUMED' ? 'pauseResumed' : 'pauseCancelled', { date: day(language, pause.endedOn ?? pause.startsOn) })}</span>}
    {pause.endedKind === null && pause.plannedResumeOn <= today ? <span className={`${styles.meta} ${styles.warnText}`}>{t('pauseOverdue')}</span> : null}
  </li>;
}

function Actions({ p, view, t }: { p: MembershipChangesViewProps; view: MembershipPausesAndRefunds; t: T }) {
  const policy = p.policy.state === 'READY' ? p.policy.read.policy : null;
  const open = view.pauses.find((x) => x.endedKind === null) ?? null;
  const offered = policy?.pausesAllowed === true && policy.maxPauseDays !== null;
  const submit = (action: ChangeAction) => (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); p.onSubmit?.(action, fieldsOf(e.currentTarget)); };
  const close = <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('back')}</button>;
  const ask = (action: ChangeAction, label: ChangeKey, kind: 'primary' | 'secondary' = 'secondary') =>
    <button type="button" className={styles[kind]} disabled={p.locked || p.form !== null} onClick={() => p.onOpen?.(action)}>{t(label)}</button>;
  const state = view.state;
  if (state !== 'ACTIVE' && state !== 'FROZEN' && state !== 'CANCELLED') return <p className={styles.meta}>{t('noActions', { state: t(`s_${state}`) })}</p>;
  return <div className={styles.actions} data-testid="membership-actions">
    {p.form === null ? <div className={styles.row}>
      {state === 'ACTIVE' && offered ? ask('pause', 'pause', 'primary') : null}
      {state === 'FROZEN' && open ? ask('resume', 'resume', 'primary') : null}
      {state === 'ACTIVE' || (state === 'FROZEN' && open) ? ask('cancel', 'cancel') : null}
      {state === 'CANCELLED' ? ask('refund', 'refund', 'primary') : null}
    </div> : null}
    {state === 'ACTIVE' && !offered && p.policy.state === 'READY' ? <p className={styles.meta}>{t('pauseOff')}</p> : null}
    {state === 'FROZEN' && !open ? <p className={`${styles.notice} ${styles.warn}`} role="status">{t('legacyFrozen')}</p> : null}
    {p.form === 'pause' && state === 'ACTIVE' && offered && policy?.maxPauseDays ? <form className={styles.form} data-testid="pause-form" onSubmit={submit('pause')}>
      <label className={styles.field}>{t('resumeOn')}<input type="date" name="resumeOn" required min={addDays(view.localToday, 1)} max={addDays(view.localToday, policy.maxPauseDays)}/></label>
      <p className={styles.meta}>{t('pauseHelp', { today: day(p.language, view.localToday), last: day(p.language, addDays(view.localToday, policy.maxPauseDays)) })}</p>
      {policy.holdFee ? <p className={styles.meta}>{t('holdFee', { fee: money(p.language, policy.holdFee.amountMinor, policy.holdFee.currency) })}</p> : null}
      <label className={styles.field}>{t('pauseReason')}<textarea name="pauseReason" required maxLength={1000} rows={2}/></label>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('pauseConfirm')}</button>{close}</div>
    </form> : null}
    {p.form === 'resume' && state === 'FROZEN' && open ? <form className={styles.form} data-testid="resume-form" onSubmit={submit('resume')}>
      <label className={styles.field}>{t('resumeReason')}<textarea name="resumeReason" maxLength={1000} rows={2}/></label>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('resumeConfirm')}</button>{close}</div>
    </form> : null}
    {p.form === 'cancel' && (state === 'ACTIVE' || (state === 'FROZEN' && open)) ? <form className={`${styles.form} ${styles.danger}`} data-testid="cancel-form" onSubmit={submit('cancel')}>
      <p><strong>{t('cancelHelp')}</strong></p>
      <label className={styles.field}>{t('cancelReason')}<textarea name="cancellationReason" required maxLength={1000} rows={2}/></label>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('cancelConfirm')}</button>{close}</div>
    </form> : null}
    {p.form === 'refund' && state === 'CANCELLED' ? <form className={styles.form} data-testid="refund-form" onSubmit={submit('refund')}>
      <p className={styles.meta}>{t('refundHelp')}</p>
      <div className={styles.grid}>
        <label className={styles.field}>{t('refundAmount')}<input type="text" inputMode="decimal" name="amount" required autoComplete="off"/></label>
        <label className={styles.field}>{t('refundCurrency')}<input type="text" name="currency" required maxLength={3} autoComplete="off" defaultValue={policy?.holdFee?.currency ?? 'USD'}/></label>
        <label className={styles.field}>{t('refundOn')}<input type="date" name="refundedOn" required max={view.localToday} defaultValue={view.localToday}/></label>
        <label className={styles.field}>{t('refundMethod')}<select name="method" defaultValue="CASH">
          {MEMBERSHIP_REFUND_METHODS.map((m) => <option key={m} value={m}>{t(`m_${m}`)}</option>)}</select></label>
      </div>
      <label className={styles.field}>{t('refundReason')}<textarea name="reason" required maxLength={1000} rows={2}/></label>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('refundConfirm')}</button>{close}</div>
    </form> : null}
  </div>;
}

/** Pure view. Rules, memberships, pauses and refunds come only from the school's reads; nothing shows before the shell verifies the school. */
export function MembershipChangesView(p: MembershipChangesViewProps): React.ReactElement {
  const t: T = (key, vars) => changeText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.hasSchool ? t('noSchool') : null;
  const ready = p.list.state === 'READY' && p.list.filter === p.filter ? p.list : null;
  const view = p.history.state === 'READY' && p.history.view.membershipId.toLowerCase() === p.selected?.toLowerCase() ? p.history.view : null;
  const chosen = ready?.items.find((m) => m.membershipId.toLowerCase() === p.selected?.toLowerCase()) ?? null;
  return <section className={styles.page} aria-labelledby="membership-changes-title" data-hon-native="" data-testid="membership-changes">
    <header className={styles.head}>
      <div><h1 id="membership-changes-title">{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.locked}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('scope')}</p>
    {notice ? <p className={styles.notice} role="status">{notice}</p> : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="change-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t('sending') : p.outcome.kind === 'DONE' ? t(`done_${p.outcome.action}`) : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry && p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
      <Rules p={p} t={t}/>
      <article className={styles.card} aria-labelledby="membership-pick-title">
        <h2 id="membership-pick-title">{t('pickTitle')}</h2>
        <nav className={styles.tabs} aria-label={t('filterLabel')}>{CHANGE_FILTERS.map((f) =>
          <button key={f} type="button" className={styles.tab} aria-pressed={p.filter === f} disabled={p.locked} onClick={() => p.onFilter?.(f)}>{t(`f_${f}`)}</button>)}</nav>
        {p.list.state === 'LOADING' || (p.list.state === 'READY' && !ready) ? <p className={styles.meta} role="status">{t('listLoading')}</p>
          : p.list.state === 'DENIED' ? <p className={styles.meta} role="status">{t('listDenied')}</p>
          : p.list.state === 'TIMEZONE' ? <p className={styles.meta} role="status">{t('listTimezone')}</p>
          : p.list.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('listUnavailable')}</p>
          : ready && ready.items.length === 0 ? <p className={styles.meta}>{t('listNone')}</p>
          : ready ? <>
            <label className={styles.field}>{t('membershipLabel')}
              <select value={chosen ? chosen.membershipId : ''} disabled={p.locked} onChange={(e) => { const m = ready.items.find((x) => x.membershipId === e.target.value); p.onSelect?.(m ? m.membershipId : null, m ? `${nameOf(m, t)} — ${m.planCode}` : null); }} data-testid="membership-select">
                <option value="">{t('choose')}</option>
                {ready.items.map((m) => <option key={m.membershipId} value={m.membershipId}>{`${nameOf(m, t)} — ${m.planCode}`}</option>)}
              </select></label>
            {ready.nextCursor ? <button type="button" className={styles.secondary} onClick={p.onMore} disabled={p.locked || ready.more === 'LOADING'}>{t('more')}</button> : null}
            {ready.more === 'FAILED' ? <p className={styles.meta} role="status">{t('listUnavailable')}</p> : null}
          </> : null}
      </article>
      {p.selected && p.selectedLabel ? <article className={styles.card} aria-labelledby="membership-selected-title" data-testid="membership-selected">
        <h2 id="membership-selected-title">{t('selectedTitle')}: {p.selectedLabel}</h2>
        {p.history.state === 'DENIED' ? <p className={styles.meta} role="status">{t('historyDenied')}</p>
          : p.history.state === 'GONE' ? <p className={styles.meta} role="status">{t('historyGone')}</p>
          : p.history.state === 'UNAVAILABLE' ? <p className={styles.meta} role="status">{t('historyUnavailable')}</p>
          : !view ? <p className={styles.meta} role="status">{t('historyLoading')}</p>
          : <>
            <p>{t('state')}: <span className={styles.chip} data-state={view.state}>{t(`s_${view.state}`)}</span></p>
            <p className={styles.meta}>{t('schoolToday', { date: day(p.language, view.localToday) })}</p>
            <Actions p={p} view={view} t={t}/>
            <h3>{t('pausesTitle')}</h3>
            {view.pauses.length === 0 ? <p className={styles.meta}>{t('noPauses')}</p>
              : <ul className={styles.list}>{view.pauses.map((x) => <PauseRow key={x.pauseId} pause={x} today={view.localToday} language={p.language} t={t}/>)}</ul>}
            <h3>{t('refundsTitle')}</h3>
            {view.refunds.length === 0 ? <p className={styles.meta}>{t('noRefunds')}</p>
              : <ul className={styles.list}>{view.refunds.map((r) => <li key={r.refundId} data-testid="refund-row">
                <span>{t('refundRow', { amount: money(p.language, r.amountMinor, r.currency), date: day(p.language, r.refundedOn), method: t(`m_${r.method}`) })}</span>
                <span className={styles.meta}>{r.reason}</span></li>)}</ul>}
          </>}
      </article> : null}
    </>}
  </section>;
}
