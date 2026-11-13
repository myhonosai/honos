import React, { useState } from 'react';
import {
  AI_ORG_AGENT_NO_CEILING_UNITS, AI_SPEND_PAUSE_CLASSES, type AiSchoolCostAlert, type AiSchoolCostAlertList, AI_UNKNOWN_DECISIONS, type AiSchoolUsage, type AiSchoolUsageReport, type AiSpendPause, type AiSpendPauseList,
  type AiUnknownDecision, type AiUnknownOpenItem, type AiUnknownQueue, type AiUnknownResolvedItem, type AiUsageAgent, type AiUsageAmount,
} from '@hon/contracts';
import { aiControlText, type AiControlKey } from './copy';
import { usd, type AiControlErrorKind } from './http';
import styles from './hq-ai-control.module.css';

type T = (key: AiControlKey, vars?: Record<string, string>) => string;
export type Names = Readonly<{ schools: ReadonlyMap<string, string>; orgs: ReadonlyMap<string, string> }>;
export type ReadState<V> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; view: V };
export type RangeKey = 'r7' | 'r30' | 'r90';
export const RANGE_DAYS: Readonly<Record<RangeKey, number>> = { r7: 7, r30: 30, r90: 90 };
export type SafetyAction = 'pause' | 'resume' | 'resolve' | 'late';
export type SafetyForm = null | { action: 'pause' } | { action: 'resume'; pauseId: string } | { action: 'resolve' | 'late'; invocationId: string };
export type SafetyOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | AiControlErrorKind; action: SafetyAction; replayed?: boolean }>;
export type Fields = Readonly<Record<string, string>>;

const short = (id: string) => id.slice(0, 8);
const schoolName = (names: Names, id: string, t: T) => names.schools.get(id.toLowerCase()) ?? t('unknownSchool', { id: short(id) });
const orgName = (names: Names, id: string | null, t: T) => id === null ? t('platform') : names.orgs.get(id.toLowerCase()) ?? t('unknownOrg', { id: short(id) });
const moment = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
function fieldsOf(form: HTMLFormElement): Fields {
  const out: Record<string, string> = {};
  for (const [name, value] of new FormData(form).entries()) if (typeof value === 'string') out[name] = value;
  return out;
}
function Notice({ state, t, onRefresh }: { state: { state: string }; t: T; onRefresh?: (() => void) | undefined }) {
  if (state.state === 'LOADING') return <p className={styles.meta} role="status">{t('loading')}</p>;
  if (state.state === 'DENIED') return <p className={styles.notice} role="status">{t('denied')}</p>;
  return <div className={styles.notice} role="status"><p>{t('unavailable')}</p>{onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh}>{t('refresh')}</button> : null}</div>;
}
function Head({ id, title, intro, t, concealed, onRefresh, onReveal, busy }: { id: string; title: string; intro: string; t: T; concealed: boolean; onRefresh?: (() => void) | undefined;
  onReveal?: (() => void) | undefined; busy: boolean }) {
  return <>
    <header className={styles.head}>
      <div><h1 id={id}>{title}</h1><p className={styles.intro}>{intro}</p></div>
      {!concealed && onRefresh ? <button type="button" className={styles.secondary} onClick={onRefresh} disabled={busy}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('scope')}</p>
    {concealed ? <div className={styles.notice} role="status"><p>{t('concealed')}</p>{onReveal ? <button type="button" className={styles.secondary} onClick={onReveal}>{t('reveal')}</button> : null}</div> : null}
  </>;
}

// ---------- AI Costs ----------
export type AiCostsViewProps = Readonly<{
  language: string; concealed: boolean; range: RangeKey; usage: ReadState<AiSchoolUsageReport>; names: Names;
  onRange?: ((range: RangeKey) => void) | undefined; onRefresh?: (() => void) | undefined; onReveal?: (() => void) | undefined;
}>;
function Amounts({ a, language, t }: { a: AiUsageAmount | AiSchoolUsage; language: string; t: T }) {
  return <>
    <td data-label={t('providerCost')}>{usd(language, a.providerReportedCostMicrounits)}</td>
    <td data-label={t('estimate')}>{a.writeOffEntries ? usd(language, a.estimatedWriteOffCostMicrounits) : '—'}</td>
    <td data-label={t('late')}>{a.lateProviderExpenseEntries ? usd(language, a.lateProviderCostMicrounits) : '—'}</td>
  </>;
}
/** Read-only per-school AI usage. Every number comes from the HQ usage read; nothing is summed across credit units. */
export function AiCostsView(p: AiCostsViewProps): React.ReactElement {
  const t: T = (key, vars) => aiControlText(p.language, key, vars);
  const n = (value: number) => new Intl.NumberFormat(p.language).format(value);
  const report = p.usage.state === 'READY' ? p.usage.view : null;
  return <section className={styles.page} aria-labelledby="ai-costs-title" data-testid="hq-ai-costs">
    <Head id="ai-costs-title" title={t('costsTitle')} intro={t('costsIntro')} t={t} concealed={p.concealed} onRefresh={p.onRefresh} onReveal={p.onReveal} busy={p.usage.state === 'LOADING'}/>
    {p.concealed ? null : <>
      <nav className={styles.tabs} aria-label={t('range')}>{(['r7', 'r30', 'r90'] as const).map((r) =>
        <button key={r} type="button" className={styles.tab} aria-pressed={p.range === r} onClick={() => p.onRange?.(r)}>{t(r)}</button>)}</nav>
      {!report ? <Notice state={p.usage} t={t} onRefresh={p.onRefresh}/> : <>
        <article className={styles.card} aria-labelledby="ai-costs-schools">
          <h2 id="ai-costs-schools">{t('schoolsTitle')}</h2>
          {report.truncated ? <p className={styles.meta}>{t('truncated')}</p> : null}
          {report.schools.length === 0 ? <p className={styles.meta}>{t('noUsage')}</p> : <div className={styles.tableWrap}><table className={styles.table} data-testid="ai-usage-table">
            <thead><tr><th scope="col">{t('school')}</th><th scope="col">{t('credits')}</th><th scope="col">{t('creative')}</th><th scope="col">{t('providerCost')}</th>
              <th scope="col">{t('estimate')}</th><th scope="col">{t('late')}</th><th scope="col">{t('unresolved')}</th></tr></thead>
            <tbody>{report.schools.map((s) => {
              const agent = s.byClass.AGENT_INFERENCE, creative = s.byClass.CREATIVE_MEDIA;
              return <tr key={s.schoolId}>
                <th scope="row">{schoolName(p.names, s.schoolId, t)}
                  {agent?.byAgent && Object.keys(agent.byAgent).length ? <details><summary>{t('byAgent')}</summary><ul className={styles.plain}>
                    {(Object.entries(agent.byAgent) as [AiUsageAgent, AiUsageAmount][]).map(([k, v]) =>
                      <li key={k}>{t(`a_${k}`)}: {n(v.credits)} · {usd(p.language, v.providerReportedCostMicrounits)}</li>)}</ul></details> : null}
                  {s.byClass.HQ_INTERNAL ? <small>{t('hqInternal')}: {usd(p.language, s.byClass.HQ_INTERNAL.providerReportedCostMicrounits)}</small> : null}</th>
                <td data-label={t('credits')}>{agent ? n(agent.credits) : '—'}</td>
                <td data-label={t('creative')}>{creative ? n(creative.credits) : '—'}</td>
                <Amounts a={s} language={p.language} t={t}/>
                <td data-label={t('unresolved')}>{s.unreconciledInvocations ? <span className={styles.chip} data-kind="warn">{s.unreconciledInvocations === 1 ? t('call') : t('calls', { n: n(s.unreconciledInvocations) })}</span> : '—'}</td>
              </tr>;
            })}</tbody></table></div>}
        </article>
        <article className={styles.card} aria-labelledby="ai-costs-orgs" data-testid="ai-org-budgets">
          <h2 id="ai-costs-orgs">{t('orgsTitle')}</h2>
          {report.organizations.length === 0 ? <p className={styles.meta}>{t('noOrgs')}</p> : <ul className={styles.list}>{report.organizations.map((o) =>
            <li key={o.organizationId}>
              <strong>{orgName(p.names, o.organizationId, t)}</strong>
              <span>{o.agentCeilingCredits === AI_ORG_AGENT_NO_CEILING_UNITS ? t('orgCommittedNoCeiling', { used: n(o.agentCommittedCredits) }) : t('orgCommitted', { used: n(o.agentCommittedCredits), ceiling: n(o.agentCeilingCredits) })}</span>
              <span className={styles.meta}>{t('orgWindow', { from: moment(p.language, o.agentWindowStart), to: moment(p.language, o.agentWindowEnd) })}</span>
              {o.openUnknownHolds ? <span className={styles.meta}>{t('orgHolds', { n: n(o.openUnknownHolds) })}</span> : null}
              <span className={styles.chip} data-kind={o.aiPaused ? 'warn' : 'ok'}>{t(o.aiPaused ? 'orgPaused' : 'orgActive')}</span>
            </li>)}</ul>}
        </article>
        <p className={styles.meta}>{t('asOf', { time: moment(p.language, report.asOf) })}</p>
      </>}
    </>}
  </section>;
}

// ---------- AI cost limit alerts (0343) ----------
export type AlertOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | AiControlErrorKind; replayed?: boolean }>;
export const alertKey = (a: Pick<AiSchoolCostAlert, 'schoolId' | 'level'>) => `${a.schoolId.toLowerCase()}:${a.level}`;
export type AiCostAlertsViewProps = Readonly<{
  language: string; concealed: boolean; alerts: ReadState<AiSchoolCostAlertList>; open: string | null; outcome: AlertOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onReveal?: (() => void) | undefined; onOpen?: ((key: string) => void) | undefined; onClose?: (() => void) | undefined;
  onSubmit?: ((key: string, reason: string) => void) | undefined; onTryAgain?: (() => void) | undefined; onDiscard?: (() => void) | undefined;
}>;
function AlertRow({ a, p, t }: { a: AiSchoolCostAlert; p: AiCostAlertsViewProps; t: T }) {
  const key = alertKey(a), pct = new Intl.NumberFormat(p.language, { maximumFractionDigits: 2 }).format(a.usedBasisPoints / 100);
  return <li data-testid="cost-alert" data-level={a.level} data-open={a.acknowledgement === null}>
    <span className={styles.chip} data-kind={a.acknowledgement ? 'ok' : 'warn'}>{t(`lv_${a.level}`)}</span>
    <strong>{a.schoolName}</strong>{a.trial ? <span className={styles.chip}>{t('alertTrial')}</span> : null}
    <span>{t('alertUsed', { used: usd(p.language, a.committedCostMicros), ceiling: usd(p.language, a.ceilingMicros), pct })}</span>
    <span className={styles.meta}>{a.crossedAt ? t('alertCrossed', { time: moment(p.language, a.crossedAt) }) : t('alertHolds')}</span>
    {a.acknowledgement ? <span className={styles.meta}>{t('alertAcked', { time: moment(p.language, a.acknowledgement.acknowledgedAt), reason: a.acknowledgement.reason })}</span>
      : p.open === key ? <form className={styles.form} data-testid="ack-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.(key, fieldsOf(e.currentTarget).reason ?? ''); }}>
        <Reason name="reason" label="ackReason" t={t}/>
        <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t('ackConfirm')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('back')}</button></div>
      </form> : <button type="button" className={styles.secondary} disabled={p.locked || p.open !== null} onClick={() => p.onOpen?.(key)}>{t('ackButton')}</button>}
  </li>;
}
/** Schools at 75%, 90% or 100% of their internal AI cost limit, read fresh from the database. Acknowledging changes no limit or spend decision. */
export function AiCostAlertsView(p: AiCostAlertsViewProps): React.ReactElement {
  const t: T = (key, vars) => aiControlText(p.language, key, vars);
  const list = p.alerts.state === 'READY' ? p.alerts.view : null;
  return <section className={styles.page} aria-labelledby="ai-alerts-title" data-testid="hq-ai-cost-alerts">
    <Head id="ai-alerts-title" title={t('alertsTitle')} intro={t('alertsIntro')} t={t} concealed={p.concealed} onRefresh={p.onRefresh} onReveal={p.onReveal} busy={p.locked}/>
    {p.concealed ? null : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="alert-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t('sending') : p.outcome.kind === 'DONE' ? `${t('ackDone')}${p.outcome.replayed ? ` ${t('replayed')}` : ''}` : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry ? <div className={styles.row}>{p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
          {p.onDiscard ? <button type="button" className={styles.secondary} onClick={p.onDiscard}>{t('discard')}</button> : null}</div> : null}</div> : null}
      <article className={styles.card} aria-labelledby="ai-alerts-list">
        <div className={styles.rowHead}><h2 id="ai-alerts-list">{t('alertsTitle')}</h2>
          {list && list.openCount > 0 ? <span className={styles.chip} data-kind="warn" data-testid="alerts-open">{t('alertsOpen', { n: new Intl.NumberFormat(p.language).format(list.openCount) })}</span> : null}</div>
        {!list ? <Notice state={p.alerts} t={t} onRefresh={p.onRefresh}/> : <>
          {list.alerts.length === 0 ? <p className={styles.meta}>{t('alertsNone')}</p>
            : <ul className={styles.list}>{list.alerts.map((a) => <AlertRow key={alertKey(a)} a={a} p={p} t={t}/>)}</ul>}
          {list.alerts.length >= 500 ? <p className={styles.meta}>{t('alertsTruncated')}</p> : null}
          <p className={styles.meta}>{t('asOf', { time: moment(p.language, list.asOf) })}</p>
        </>}
      </article>
    </>}
  </section>;
}

// ---------- AI Safety ----------
export type AiSafetyViewProps = Readonly<{
  language: string; concealed: boolean; pauses: ReadState<AiSpendPauseList>; unknown: ReadState<AiUnknownQueue>; names: Names;
  form: SafetyForm; outcome: SafetyOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onReveal?: (() => void) | undefined; onOpen?: ((form: Exclude<SafetyForm, null>) => void) | undefined; onClose?: (() => void) | undefined;
  onSubmit?: ((form: Exclude<SafetyForm, null>, fields: Fields) => void) | undefined; onTryAgain?: (() => void) | undefined; onDiscard?: (() => void) | undefined;
}>;
function Buttons({ p, t, confirm }: { p: AiSafetyViewProps; t: T; confirm: AiControlKey }) {
  return <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked}>{t(confirm)}</button>
    <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onClose}>{t('back')}</button></div>;
}
function Reason({ name, label, t }: { name: string; label: AiControlKey; t: T }) {
  return <label className={styles.field}>{t(label)}<textarea name={name} required minLength={10} maxLength={500} rows={2}/></label>;
}
function ProviderEvidence({ t }: { t: T }) {
  return <div className={styles.grid}>
    <label className={styles.field}>{t('generationId')}<input name="providerGenerationId" required maxLength={200} autoComplete="off"/></label>
    <label className={styles.field}>{t('inputTokens')}<input name="inputTokens" required inputMode="numeric" autoComplete="off"/></label>
    <label className={styles.field}>{t('outputTokens')}<input name="outputTokens" required inputMode="numeric" autoComplete="off"/></label>
    <label className={styles.field}>{t('costUsd')}<input name="providerCost" required inputMode="decimal" autoComplete="off"/></label>
  </div>;
}
function SettleForm({ p, t, item }: { p: AiSafetyViewProps; t: T; item: AiUnknownOpenItem }) {
  const [decision, setDecision] = useState<AiUnknownDecision>('RECORD_PROVIDER_COST');
  const form = { action: 'resolve', invocationId: item.invocationId } as const;
  return <form className={styles.form} data-testid="settle-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.(form, fieldsOf(e.currentTarget)); }}>
    <label className={styles.field}>{t('decision')}<select name="decision" value={decision} onChange={(e) => setDecision(e.target.value as AiUnknownDecision)}>
      {AI_UNKNOWN_DECISIONS.map((d) => <option key={d} value={d}>{t(`d_${d}`)}</option>)}</select></label>
    {decision === 'RECORD_PROVIDER_COST' ? <ProviderEvidence t={t}/> : null}
    {decision === 'NO_PROVIDER_CHARGE' ? <label className={styles.field}>{t('lookupRef')}<input name="providerLookupReference" required maxLength={200} autoComplete="off"/></label> : null}
    {decision === 'WRITE_OFF' ? <label className={styles.field}>{t('estimateUsd')}<input name="estimate" required inputMode="decimal" autoComplete="off"/></label> : null}
    <Reason name="reason" label="settleReason" t={t}/>
    <p className={styles.meta}>{t('settleHelp')}</p>
    <Buttons p={p} t={t} confirm="settleConfirm"/>
  </form>;
}
function PauseRow({ pause, p, t }: { pause: AiSpendPause; p: AiSafetyViewProps; t: T }) {
  const open = p.form?.action === 'resume' && p.form.pauseId === pause.pauseId;
  const form = { action: 'resume', pauseId: pause.pauseId } as const;
  return <li data-testid="pause-row" data-status={pause.status}>
    <div className={styles.rowHead}><strong>{orgName(p.names, pause.organizationId, t)} · {t(`c_${pause.spendClass}`)}</strong>
      <span className={styles.chip} data-kind={pause.status === 'ACTIVE' ? 'warn' : undefined}>{t(pause.status === 'ACTIVE' ? 'active' : 'ended')}</span></div>
    <span>{pause.reason}</span>
    <span className={styles.meta}>{t('pausedAt', { time: moment(p.language, pause.pausedAt) })}</span>
    {pause.endedAt ? <span className={styles.meta}>{t('endedAt', { time: moment(p.language, pause.endedAt) })} · {t('endReason', { reason: pause.endReason ?? '' })}</span> : null}
    {pause.status === 'ACTIVE' && !open ? <button type="button" className={styles.secondary} disabled={p.locked || p.form !== null} onClick={() => p.onOpen?.(form)}>{t('resume')}</button> : null}
    {open ? <form className={styles.form} data-testid="resume-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.(form, fieldsOf(e.currentTarget)); }}>
      <Reason name="reason" label="resumeReason" t={t}/><Buttons p={p} t={t} confirm="resumeConfirm"/></form> : null}
  </li>;
}
function OpenRow({ item, p, t }: { item: AiUnknownOpenItem; p: AiSafetyViewProps; t: T }) {
  const open = p.form?.action === 'resolve' && p.form.invocationId === item.invocationId;
  return <li data-testid="unknown-row">
    <div className={styles.rowHead}><strong>{t('openRow', { agent: t(`a_${item.agent}`), school: schoolName(p.names, item.schoolId, t), credits: String(item.reservedCredits) })}</strong>
      <span className={styles.chip} data-kind="warn">{t(`st_${item.status}`)}</span></div>
    <span className={styles.meta}>{item.heldAt ? t('heldAt', { time: moment(p.language, item.heldAt) }) : t('heldUnknown')}{item.countsAgainstCurrentWindow ? ` · ${t('countsNow')}` : ''}</span>
    {!open ? <button type="button" className={styles.secondary} disabled={p.locked || p.form !== null} onClick={() => p.onOpen?.({ action: 'resolve', invocationId: item.invocationId })}>{t('settle')}</button>
      : <SettleForm p={p} t={t} item={item}/>}
  </li>;
}
function ResolvedRow({ item, p, t }: { item: AiUnknownResolvedItem; p: AiSafetyViewProps; t: T }) {
  const open = p.form?.action === 'late' && p.form.invocationId === item.invocationId;
  const form = { action: 'late', invocationId: item.invocationId } as const;
  return <li data-testid="resolved-row">
    <strong>{t('resolvedRow', { agent: t(`a_${item.agent}`), school: schoolName(p.names, item.schoolId, t), decision: t(`d_${item.decision}`) })}</strong>
    <span>{item.reason}</span>
    <span className={styles.meta}>{moment(p.language, item.resolvedAt)} · {t('released', { n: String(item.releasedCredits) })}
      {item.customerCredits !== null ? ` · ${t('customerCredits', { n: String(item.customerCredits) })}` : ''}</span>
    {item.lateProviderExpense ? <span className={styles.meta}>{t('lateRecorded', { cost: usd(p.language, item.lateProviderExpense.providerCostMicrounits), time: moment(p.language, item.lateProviderExpense.recordedAt) })}</span> : null}
    {item.decision === 'WRITE_OFF' && !item.lateProviderExpense && !open
      ? <button type="button" className={styles.secondary} disabled={p.locked || p.form !== null} onClick={() => p.onOpen?.(form)}>{t('recordLate')}</button> : null}
    {open ? <form className={styles.form} data-testid="late-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.(form, fieldsOf(e.currentTarget)); }}>
      <p className={styles.meta}>{t('lateHelp')}</p><ProviderEvidence t={t}/><Reason name="reason" label="settleReason" t={t}/><Buttons p={p} t={t} confirm="lateConfirm"/></form> : null}
  </li>;
}

/** Emergency pauses and lost AI outcomes. Lists come only from the HQ reads; the HQ owner's authority is decided by the database. */
export function AiSafetyView(p: AiSafetyViewProps): React.ReactElement {
  const t: T = (key, vars) => aiControlText(p.language, key, vars);
  const pauses = p.pauses.state === 'READY' ? p.pauses.view : null, queue = p.unknown.state === 'READY' ? p.unknown.view : null;
  const orgChoices = [...p.names.orgs.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return <section className={styles.page} aria-labelledby="ai-safety-title" data-testid="hq-ai-safety">
    <Head id="ai-safety-title" title={t('safetyTitle')} intro={t('safetyIntro')} t={t} concealed={p.concealed} onRefresh={p.onRefresh} onReveal={p.onReveal} busy={p.locked}/>
    {p.concealed ? null : <>
      {p.outcome ? <div className={styles.notice} role="status" data-testid="safety-outcome" data-kind={p.outcome.kind}>
        <p>{p.outcome.kind === 'SENDING' ? t('sending') : p.outcome.kind === 'DONE' ? `${t(`done_${p.outcome.action}`)}${p.outcome.replayed ? ` ${t('replayed')}` : ''}` : t(`e_${p.outcome.kind}`)}</p>
        {p.canRetry ? <div className={styles.row}>{p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}
          {p.onDiscard ? <button type="button" className={styles.secondary} onClick={p.onDiscard}>{t('discard')}</button> : null}</div> : null}</div> : null}
      <article className={styles.card} aria-labelledby="ai-pauses-title" data-testid="ai-pauses">
        <div className={styles.rowHead}><h2 id="ai-pauses-title">{t('pausesTitle')}</h2>
          {pauses && p.form?.action !== 'pause' ? <button type="button" className={styles.primary} disabled={p.locked || p.form !== null} onClick={() => p.onOpen?.({ action: 'pause' })}>{t('newPause')}</button> : null}</div>
        {!pauses ? <Notice state={p.pauses} t={t} onRefresh={p.onRefresh}/> : <>
          {p.form?.action === 'pause' ? <form className={styles.form} data-testid="pause-form" onSubmit={(e) => { e.preventDefault(); p.onSubmit?.({ action: 'pause' }, fieldsOf(e.currentTarget)); }}>
            <div className={styles.grid}>
              <label className={styles.field}>{t('pauseScope')}<select name="organizationId" defaultValue="">
                <option value="">{t('platform')}</option>{orgChoices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
              <label className={styles.field}>{t('pauseClass')}<select name="spendClass" defaultValue="ALL">
                {AI_SPEND_PAUSE_CLASSES.map((c) => <option key={c} value={c}>{t(`c_${c}`)}</option>)}</select></label>
            </div>
            <Reason name="reason" label="pauseReason" t={t}/>
            <p className={styles.meta}>{t('pauseHelp')}</p>
            <Buttons p={p} t={t} confirm="pauseConfirm"/>
          </form> : null}
          {pauses.pauses.length === 0 ? <p className={styles.meta}>{t('noPauses')}</p>
            : <ul className={styles.list}>{pauses.pauses.map((x) => <PauseRow key={x.pauseId} pause={x} p={p} t={t}/>)}</ul>}
        </>}
      </article>
      <article className={styles.card} aria-labelledby="ai-unknown-title" data-testid="ai-unknown">
        <h2 id="ai-unknown-title">{t('unknownTitle')}</h2>
        {!queue ? <Notice state={p.unknown} t={t} onRefresh={p.onRefresh}/> : <>
          {queue.open.length === 0 ? <p className={styles.meta}>{t('noOpen')}</p>
            : <ul className={styles.list}>{queue.open.map((x) => <OpenRow key={`${x.agent}:${x.invocationId}`} item={x} p={p} t={t}/>)}</ul>}
          <h3>{t('resolvedTitle')}</h3>
          {queue.resolved.length === 0 ? <p className={styles.meta}>{t('noResolved')}</p>
            : <ul className={styles.list}>{queue.resolved.map((x) => <ResolvedRow key={x.resolutionId} item={x} p={p} t={t}/>)}</ul>}
          <p className={styles.meta}>{t('asOf', { time: moment(p.language, queue.asOf) })}</p>
        </>}
      </article>
    </>}
  </section>;
}
