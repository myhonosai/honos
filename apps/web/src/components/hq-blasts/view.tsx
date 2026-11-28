import React from 'react';
import {
  HQ_BLAST_BILLING_INTERVALS, HQ_BLAST_CHANNELS, HQ_BLAST_DAILY_LIMIT, HQ_BLAST_EMAIL_BODY_MAX, HQ_BLAST_JOINED_DAYS, HQ_BLAST_PURPOSES,
  HQ_BLAST_SCHOOL_STATUSES, HQ_BLAST_SMS_BODY_MAX, HQ_BLAST_TRIAL_ENDS_DAYS, HQ_BLAST_TRIAL_STATES, type HqBlastAudiencePreview, type HqBlastChannel,
  type HqBlastDetail, type HqBlastList, type HqBlastOptions, type HqBlastPurpose, type HqBlastReceipt, type HqBlastSummary,
} from '@hon/contracts';
import s from '../comms-kit/comms.module.css';
import b from './hq-blasts.module.css';
import type { CommsOutcome } from '../hq-communications/model';
import { hqBlastText, isHqBlastKey, type HqBlastKey } from './copy';
import { hqBlastMayCancel, hqBlastProblems, type HqBlastDraft, type HqBlastFilterForm, type PickedSchool, type TriState } from './format';

export type ListRead = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; list: HqBlastList };
export type Read<T> = null | { state: 'LOADING' } | { state: 'FAILED' } | { state: 'READY'; value: T };
export type Screen = { mode: 'LIST' } | { mode: 'EDIT' } | { mode: 'DETAIL'; blastId: string };
export type SendAsk = null | { kind: 'SEND'; sendAt: string | null } | { kind: 'CANCEL' };
export type SearchResult = HqBlastOptions['schools'][number];

export type HqBlastsViewProps = Readonly<{
  language: string; formatTime: (iso: string) => string; featureLabel: (feature: string) => string;
  concealed: boolean; list: ListRead; screen: Screen; draft: HqBlastDraft | null; dirty: boolean; preview: Read<HqBlastAudiencePreview>;
  options: Read<HqBlastOptions>; search: string; searchRead: Read<readonly SearchResult[]>; detail: Read<HqBlastDetail>;
  when: 'NOW' | 'LATER'; local: string; sendAt: string | null; ask: SendAsk; outcome: CommsOutcome<HqBlastReceipt>; locked: boolean; canRetry: boolean;
  onRefresh: () => void; onReveal: () => void; onNew: () => void; onOpen: (blast: HqBlastSummary) => void; onBack: () => void;
  onDraft: (next: HqBlastDraft) => void; onFilters: (next: Partial<HqBlastFilterForm>) => void; onTag: (field: 'subject' | 'body', tag: 'first_name' | 'school_name' | 'hq_name') => void;
  onSearch: (q: string) => void; onPick: (school: PickedSchool, as: 'picked' | 'leftOut') => void; onSave: () => void; onPreviewRetry: () => void;
  onWhen: (when: 'NOW' | 'LATER') => void; onLocal: (local: string) => void; onAsk: (ask: SendAsk) => void; onConfirm: () => void;
  onTryAgain: () => void; onDismiss: () => void; onDetailRetry: () => void;
}>;

const short = (id: string) => id.slice(0, 8);
const has = <T,>(list: readonly T[], v: T) => list.includes(v);

/** Presentation only. Every count and status comes from the verified server answer; the form only shows what was typed. */
export function HqBlastsView(p: HqBlastsViewProps): React.ReactElement {
  const t = (k: HqBlastKey, v?: Record<string, string>) => hqBlastText(p.language, k, v);
  const head = <header className={s.head}><div><h1>{t('title')}</h1><p>{t('intro')}</p>
    <p className={s.actions}><a className={s.ghost} href="/hq/communications">{t('inbox')}</a></p></div>
    {!p.concealed && <p className={s.actions}><button type="button" className={s.ghost} onClick={p.onRefresh}>{t('refresh')}</button>
      {p.list.state === 'READY' && p.screen.mode === 'LIST' && <button type="button" className={`${s.button} ${s.primary}`} disabled={p.locked} onClick={p.onNew}>{t('newBlast')}</button>}</p>}</header>;
  if (p.concealed) return <main className={s.page} data-hq-blasts="concealed">{head}
    <p className={s.actions} role="status"><span className={s.muted}>{t('concealed')}</span> <button type="button" className={s.button} onClick={p.onReveal}>{t('reveal')}</button></p></main>;
  if (p.list.state !== 'READY') return <main className={s.page} data-hq-blasts={p.list.state.toLowerCase()} aria-busy={p.list.state === 'LOADING'}>{head}
    <p className={s.muted} role="status">{t(p.list.state === 'LOADING' ? 'loading' : p.list.state === 'DENIED' ? 'denied' : 'unavailable')}</p></main>;
  const outcome = <Outcome t={t} outcome={p.outcome} canRetry={p.canRetry} onTryAgain={p.onTryAgain} onDismiss={p.onDismiss}/>;
  if (p.screen.mode === 'EDIT' && p.draft) return <main className={s.page} data-hq-blasts="edit">{head}{outcome}<Editor {...p} t={t} draft={p.draft}/></main>;
  if (p.screen.mode === 'DETAIL') return <main className={s.page} data-hq-blasts="detail">{head}{outcome}<Detail {...p} t={t}/></main>;
  const list = p.list.list;
  return <main className={s.page} data-hq-blasts="list">{head}{outcome}
    <p className={s.muted}>{t('sentToday', { n: String(list.sentToday), max: String(HQ_BLAST_DAILY_LIMIT) })}</p>
    {list.blasts.length === 0 ? <p className={s.empty}>{t('empty')}</p> : <ul className={b.list}>
      {list.blasts.map(x => <li key={x.blastId} className={s.panel} data-hq-blast={x.blastId}>
        <div className={b.rowHead}><strong>{x.name}</strong>
          <span className={s.badge} data-tone={x.status === 'QUEUED' ? 'ok' : x.status === 'CANCELLED' ? 'bad' : 'warn'}>{t(x.status)}</span>
          <span className={s.badge}>{t(x.channel)}</span><span className={s.badge}>{t(x.purpose)}</span></div>
        <p className={s.muted}>{x.subject ?? x.body.slice(0, 140)}</p>
        <p className={s.muted}>{x.sendAt ? t('sendsAt', { time: p.formatTime(x.sendAt) }) : t('DRAFT')}
          {x.recipientCount !== null && x.schoolCount !== null ? ` · ${t('sentTo', { owners: String(x.recipientCount), schools: String(x.schoolCount) })}` : ''}</p>
        <p className={s.actions}><button type="button" className={s.ghost} disabled={p.locked} onClick={() => p.onOpen(x)}>{t('open')}</button></p></li>)}</ul>}
  </main>;
}

type T = (k: HqBlastKey, v?: Record<string, string>) => string;

function Outcome({ t, outcome, canRetry, onTryAgain, onDismiss }: { t: T; outcome: CommsOutcome<HqBlastReceipt>; canRetry: boolean; onTryAgain: () => void; onDismiss: () => void }): React.ReactElement | null {
  if (!outcome) return null;
  if (outcome.kind === 'SENDING') return <p className={s.flash} role="status">{t('sendingNow')}</p>;
  if (outcome.kind === 'DONE') {
    const r = outcome.receipt;
    const text = r.operation === 'SAVE' ? t('saved') : r.operation === 'CANCEL' ? t('cancelled') : r.blast.sendAt && Date.parse(r.blast.sendAt) > Date.now() + 60_000 ? t('scheduled') : t('sent');
    return <p className={s.flash} data-tone="ok" role="status">{text} <button type="button" className={s.ghost} onClick={onDismiss}>{t('dismiss')}</button></p>;
  }
  const key: HqBlastKey = outcome.kind === 'REFUSED' && outcome.code && isHqBlastKey(outcome.code) ? outcome.code : outcome.kind === 'REFUSED' ? 'INVALID' : outcome.kind;
  return <p className={s.flash} data-tone="bad" role="alert" data-hq-blast-outcome={outcome.kind}>{t(key)}{' '}
    {canRetry && <button type="button" className={s.ghost} onClick={onTryAgain}>{t('tryAgain')}</button>}
    <button type="button" className={s.ghost} onClick={onDismiss}>{t('dismiss')}</button></p>;
}

function Chips<V extends string>({ label, values, chosen, text, onToggle, disabled }: { label: string; values: readonly V[]; chosen: readonly V[]; text: (v: V) => string; onToggle: (v: V) => void; disabled: boolean }): React.ReactElement {
  return <fieldset className={b.group}><legend>{label}</legend><ul className={s.chips}>
    {values.map(v => <li key={v}><button type="button" className={s.chip} aria-pressed={has(chosen, v)} disabled={disabled} onClick={() => onToggle(v)}>{text(v)}</button></li>)}</ul></fieldset>;
}
function Tri({ t, label, value, onChange, disabled }: { t: T; label: string; value: TriState; onChange: (v: TriState) => void; disabled: boolean }): React.ReactElement {
  return <label className={s.label}>{label}<select className={s.field} value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value as TriState)}>
    <option value="">{t('any')}</option><option value="yes">{t('yes')}</option><option value="no">{t('no')}</option></select></label>;
}
const toggle = <V,>(list: readonly V[], v: V): V[] => list.includes(v) ? list.filter(x => x !== v) : [...list, v];

function Editor(p: HqBlastsViewProps & { t: T; draft: HqBlastDraft }): React.ReactElement {
  const { t, draft } = p, f = draft.filters, lock = p.locked, problems = hqBlastProblems(draft);
  const max = draft.channel === 'EMAIL' ? HQ_BLAST_EMAIL_BODY_MAX : HQ_BLAST_SMS_BODY_MAX, n = draft.body.trim().length;
  const opts = p.options?.state === 'READY' ? p.options.value : null;
  const set = (patch: Partial<HqBlastDraft>) => p.onDraft({ ...draft, ...patch });
  const tagButtons = (field: 'subject' | 'body') => <p className={b.tags}><span className={s.muted}>{t('tags')}</span>
    {(['first_name', 'school_name', 'hq_name'] as const).map(tag => <button key={tag} type="button" className={b.small} disabled={lock} data-hq-blast-tag={`${field}:${tag}`}
      onClick={() => p.onTag(field, tag)}>{t(`tag_${tag}`)}</button>)}</p>;
  const chip = (x: PickedSchool, as: 'picked' | 'leftOut') => {
    const name = x.name ?? t('unnamed', { id: short(x.schoolId) });
    return <li key={x.schoolId}><button type="button" className={s.chip} aria-pressed="true" disabled={lock} aria-label={t('remove', { name })} onClick={() => p.onPick(x, as)}>{name} ×</button></li>;
  };
  return <div className={b.layout}>
    <section className={s.panel} aria-label={t('compose')}>
      <p className={s.actions}><button type="button" className={s.ghost} disabled={lock} onClick={p.onBack}>{t('back')}</button></p>
      <h2>{t('compose')}</h2>
      <div className={b.form}>
        <label className={s.label}>{t('name')}<input className={s.field} value={draft.name} maxLength={100} disabled={lock} onChange={e => set({ name: e.currentTarget.value })}/></label>
        <Chips label={t('channel')} values={HQ_BLAST_CHANNELS} chosen={[draft.channel]} text={v => t(v)} disabled={lock}
          onToggle={(v: HqBlastChannel) => set({ channel: v, subject: v === 'EMAIL' ? draft.subject : '' })}/>
        <label className={s.label}>{t('purpose')}<select className={s.field} value={draft.purpose} disabled={lock} onChange={e => set({ purpose: e.currentTarget.value as HqBlastPurpose })}>
          {HQ_BLAST_PURPOSES.map(x => <option key={x} value={x}>{t(x)}</option>)}</select></label>
        <p className={s.muted}>{t('purposeHint')}</p>
        {draft.channel === 'EMAIL' && <><label className={s.label}>{t('subject')}<input className={s.field} value={draft.subject} maxLength={150} disabled={lock}
          onChange={e => set({ subject: e.currentTarget.value })}/></label>{tagButtons('subject')}</>}
        <label className={s.label}>{t('body')}<textarea className={s.field} rows={draft.channel === 'EMAIL' ? 10 : 5} value={draft.body} disabled={lock}
          onChange={e => set({ body: e.currentTarget.value })}/></label>
        {tagButtons('body')}
        <p className={b.counter} data-over={n > max ? 'true' : undefined} aria-live="polite" data-hq-blast-counter={draft.channel}>
          {n > max ? t('tooLong', { n: String(n - max) }) : t(draft.channel === 'EMAIL' ? 'emailCount' : 'textCount', { n: String(n), max: String(max) })}</p>
        {draft.channel === 'EMAIL' && <p className={s.muted}>{t('footer')}</p>}
      </div>
    </section>
    <section className={s.panel} aria-label={t('who')}>
      <h2>{t('who')}</h2><p className={s.muted}>{t('whoHint')}</p>
      {p.options?.state === 'FAILED' && <p className={s.muted} role="status">{t('optionsFailed')}</p>}
      <div className={b.form}>
        <Chips label={t('status')} values={HQ_BLAST_SCHOOL_STATUSES} chosen={f.statuses} text={v => t(v)} disabled={lock} onToggle={v => p.onFilters({ statuses: toggle(f.statuses, v) })}/>
        {opts && opts.planNames.length > 0 && <Chips label={t('plan')} values={opts.planNames} chosen={f.planNames} text={v => v} disabled={lock} onToggle={v => p.onFilters({ planNames: toggle(f.planNames, v) })}/>}
        <label className={b.check}><input type="checkbox" checked={f.noPlan} disabled={lock} onChange={e => p.onFilters({ noPlan: e.currentTarget.checked })}/>{t('noPlan')}</label>
        <div className={b.row}>
          <Tri t={t} label={t('founder')} value={f.founder} disabled={lock} onChange={v => p.onFilters({ founder: v })}/>
          <Tri t={t} label={t('freePlan')} value={f.freePlan} disabled={lock} onChange={v => p.onFilters({ freePlan: v })}/>
        </div>
        <Chips label={t('billing')} values={HQ_BLAST_BILLING_INTERVALS} chosen={f.billingIntervals} text={v => t(v)} disabled={lock} onToggle={v => p.onFilters({ billingIntervals: toggle(f.billingIntervals, v) })}/>
        <div className={b.row}>
          <label className={s.label}>{t('trial')}<select className={s.field} value={f.trial} disabled={lock} onChange={e => p.onFilters({ trial: e.currentTarget.value as HqBlastFilterForm['trial'] })}>
            <option value="">{t('any')}</option>{HQ_BLAST_TRIAL_STATES.map(x => <option key={x} value={x}>{t(x)}</option>)}</select></label>
          {(f.trial === '' || f.trial === 'ON_TRIAL') && <label className={s.label}>{t('trialEnds')}<select className={s.field} value={f.trialEndsWithinDays} disabled={lock}
            onChange={e => p.onFilters({ trialEndsWithinDays: e.currentTarget.value as HqBlastFilterForm['trialEndsWithinDays'] })}>
            <option value="">{t('any')}</option>{HQ_BLAST_TRIAL_ENDS_DAYS.map(x => <option key={x} value={String(x)}>{t('days', { n: String(x) })}</option>)}</select></label>}
        </div>
        <div className={b.row}>
          <label className={s.label}>{t('joined')}<select className={s.field} value={f.joined} disabled={lock} onChange={e => p.onFilters({ joined: e.currentTarget.value as HqBlastFilterForm['joined'] })}>
            <option value="">{t('any')}</option>{HQ_BLAST_JOINED_DAYS.map(x => <option key={x} value={String(x)}>{t('joinedDays', { n: String(x) })}</option>)}
            <option value="RANGE">{t('joinedRange')}</option></select></label>
          {f.joined === 'RANGE' && <><label className={s.label}>{t('from')}<input type="date" className={s.field} value={f.joinedFrom} disabled={lock} onChange={e => p.onFilters({ joinedFrom: e.currentTarget.value })}/></label>
            <label className={s.label}>{t('to')}<input type="date" className={s.field} value={f.joinedTo} disabled={lock} onChange={e => p.onFilters({ joinedTo: e.currentTarget.value })}/></label></>}
        </div>
        {opts && opts.countries.length > 0 && <Chips label={t('country')} values={opts.countries} chosen={f.countries} text={v => v} disabled={lock} onToggle={v => p.onFilters({ countries: toggle(f.countries, v) })}/>}
        {opts && opts.regions.length > 0 && <Chips label={t('region')} values={[...new Set(opts.regions.filter(r => f.countries.length === 0 || f.countries.includes(r.country)).map(r => r.region))]}
          chosen={f.regions} text={v => v} disabled={lock} onToggle={v => p.onFilters({ regions: toggle(f.regions, v) })}/>}
        <label className={s.label}>{t('cities')}<input className={s.field} value={f.cities} maxLength={2100} disabled={lock} onChange={e => p.onFilters({ cities: e.currentTarget.value })}/></label>
        {opts && opts.features.length > 0 && <>
          <Chips label={t('has')} values={opts.features} chosen={f.featuresIncluded} text={p.featureLabel} disabled={lock} onToggle={v => p.onFilters({ featuresIncluded: toggle(f.featuresIncluded, v) })}/>
          <Chips label={t('lacks')} values={opts.features} chosen={f.featuresMissing} text={p.featureLabel} disabled={lock} onToggle={v => p.onFilters({ featuresMissing: toggle(f.featuresMissing, v) })}/></>}
        <label className={b.check}><input type="checkbox" checked={f.canGetTexts} disabled={lock} onChange={e => p.onFilters({ canGetTexts: e.currentTarget.checked })}/>{t('canGetTexts')}</label>
        <fieldset className={b.group}><legend>{t('schools')}</legend>
          <input className={s.field} type="search" aria-label={t('findSchool')} placeholder={t('findSchool')} value={p.search} maxLength={80} disabled={lock}
            onChange={e => p.onSearch(e.currentTarget.value)}/>
          {p.searchRead?.state === 'LOADING' && <p className={s.muted} role="status">{t('searching')}</p>}
          {p.searchRead?.state === 'FAILED' && <p className={s.muted} role="alert">{t('searchFailed')}</p>}
          {p.searchRead?.state === 'READY' && (p.searchRead.value.length === 0 ? <p className={s.muted}>{t('noMatch')}</p> : <ul className={b.results}>
            {p.searchRead.value.map(x => <li key={x.schoolId}><span>{x.schoolDisplayName} <span className={s.muted}>{x.organizationDisplayName}</span></span>
              <span className={s.actions}><button type="button" className={b.small} disabled={lock} onClick={() => p.onPick({ schoolId: x.schoolId, name: x.schoolDisplayName }, 'picked')}>{t('add')}</button>
                <button type="button" className={b.small} disabled={lock} onClick={() => p.onPick({ schoolId: x.schoolId, name: x.schoolDisplayName }, 'leftOut')}>{t('leaveOut')}</button></span></li>)}</ul>)}
          {draft.picked.length > 0 && <><p className={s.muted}>{t('picked')}</p><ul className={s.chips}>{draft.picked.map(x => chip(x, 'picked'))}</ul></>}
          {draft.leftOut.length > 0 && <><p className={s.muted}>{t('leftOut')}</p><ul className={s.chips}>{draft.leftOut.map(x => chip(x, 'leftOut'))}</ul></>}
        </fieldset>
      </div>
      {problems.length > 0 && <ul className={b.problems} data-hq-blast-problems={problems.join(' ')}>{problems.map(x => <li key={x}>{t(`p_${x}`)}</li>)}</ul>}
      <p className={s.actions}><button type="button" className={`${s.button} ${s.primary}`} disabled={lock || problems.length > 0 || (!p.dirty && draft.blastId !== null)} onClick={p.onSave}>
        {t(lock ? 'saving' : 'save')}</button></p>
    </section>
    <Preview {...p} t={t} draft={draft}/>
  </div>;
}

function Preview(p: HqBlastsViewProps & { t: T; draft: HqBlastDraft }): React.ReactElement {
  const { t, draft } = p;
  if (!draft.blastId || p.dirty) return <section className={s.panel} aria-label={t('preview')} data-hq-blast-preview="unsaved"><h2>{t('preview')}</h2><p className={s.muted}>{t('saveFirst')}</p></section>;
  const pr = p.preview;
  if (!pr || pr.state === 'LOADING') return <section className={s.panel} aria-label={t('preview')} aria-busy="true"><h2>{t('preview')}</h2><p className={s.muted} role="status">{t('previewLoading')}</p></section>;
  if (pr.state === 'FAILED') return <section className={s.panel} aria-label={t('preview')}><h2>{t('preview')}</h2><p className={s.muted} role="alert">{t('previewFailed')}</p>
    <button type="button" className={s.ghost} onClick={p.onPreviewRetry}>{t('tryAgain')}</button></section>;
  const v = pr.value, canSend = v.schoolsReached > 0 && !v.tooLarge;
  const counts: [HqBlastKey, number][] = [['matched', v.schoolsMatched], ['reached', v.schoolsReached], ['owners', v.ownersReached], ['skippedNoOwners', v.skipped.noOwners],
    ['skippedNotReachable', v.skipped.notReachable], ['skippedRecent', v.skipped.recentlySent], ['ownersNotReachable', v.skipped.ownersNotReachable]];
  const askText = p.ask?.kind === 'SEND' ? t(p.ask.sendAt ? 'confirmLater' : 'confirm', { name: draft.name.trim(), owners: String(v.ownersReached), schools: String(v.schoolsReached),
    time: p.ask.sendAt ? p.formatTime(p.ask.sendAt) : '' }) : '';
  return <section className={s.panel} aria-label={t('preview')} data-hq-blast-preview="ready">
    <h2>{t('preview')}</h2>
    <dl className={b.counts}>{counts.map(([k, n]) => <div key={k}><dt>{t(k)}</dt><dd>{n}</dd></div>)}</dl>
    {v.tooLarge && <p className={s.flash} data-tone="bad" role="alert">{t('tooLarge')}</p>}
    {v.sample ? <div className={b.sample} data-hq-blast-sample="true"><strong>{t('sample', { school: v.sample.schoolDisplayName })}</strong>
      {v.sample.subject && <strong>{v.sample.subject}</strong>}<span>{v.sample.body}</span><span className={s.muted}>{t('sampleNote')}</span></div> : <p className={s.muted}>{t('none')}</p>}
    {v.schools.length > 0 && <ul className={b.results}>{v.schools.map(x => <li key={x.schoolId}><span>{x.schoolDisplayName}</span>
      <span className={s.badge} data-tone={x.outcome === 'QUEUED' ? 'ok' : 'warn'}>{t(`o_${x.outcome}`)}</span></li>)}</ul>}
    <div className={b.form}>
      <Chips label={t('when')} values={['NOW', 'LATER'] as const} chosen={[p.when]} text={x => t(x === 'NOW' ? 'sendNow' : 'schedule')} disabled={p.locked} onToggle={p.onWhen}/>
      {p.when === 'LATER' && <label className={s.label}>{t('when')}<input type="datetime-local" className={s.field} value={p.local} disabled={p.locked} onChange={e => p.onLocal(e.currentTarget.value)}/></label>}
      {p.when === 'LATER' && p.local && !p.sendAt && <p className={s.muted} role="alert">{t('scheduleBad')}</p>}
    </div>
    {p.ask?.kind === 'SEND' ? <div className={s.flash} role="alertdialog" aria-label={askText} data-hq-blast-ask="send"><p>{askText}</p>
      <p className={s.actions}><button type="button" className={`${s.button} ${s.primary}`} disabled={p.locked} onClick={p.onConfirm}>{t('confirmYes')}</button>
        <button type="button" className={s.ghost} disabled={p.locked} onClick={() => p.onAsk(null)}>{t('confirmNo')}</button></p></div>
      : <p className={s.actions}><button type="button" className={`${s.button} ${s.primary}`} data-hq-blast-send="true" disabled={p.locked || !canSend || (p.when === 'LATER' && !p.sendAt)}
        onClick={() => p.onAsk({ kind: 'SEND', sendAt: p.when === 'LATER' ? p.sendAt : null })}>{t(p.when === 'LATER' ? 'schedule' : 'sendNow')}</button></p>}
  </section>;
}

function Detail(p: HqBlastsViewProps & { t: T }): React.ReactElement {
  const { t } = p, d = p.detail;
  const back = <p className={s.actions}><button type="button" className={s.ghost} disabled={p.locked} onClick={p.onBack}>{t('back')}</button></p>;
  if (!d || d.state === 'LOADING') return <section className={s.panel} aria-busy="true">{back}<p className={s.muted} role="status">{t('loading')}</p></section>;
  if (d.state === 'FAILED') return <section className={s.panel}>{back}<p className={s.muted} role="alert">{t('unavailable')}</p>
    <button type="button" className={s.ghost} onClick={p.onDetailRetry}>{t('tryAgain')}</button></section>;
  const { blast, results, schools } = d.value, r = results.deliveries, sc = results.schools, mayCancel = hqBlastMayCancel(blast, r);
  const schoolCounts: [HqBlastKey, number][] = [['r_queued', sc.queued], ['r_noOwners', sc.noOwners], ['r_notReachable', sc.notReachable], ['r_recentlySent', sc.recentlySent]];
  const deliveryCounts = (Object.keys(r) as (keyof typeof r)[]).map(k => [`d_${k}` as HqBlastKey, r[k]] as const);
  return <section className={s.panel} data-hq-blast-detail={blast.status}>{back}
    <div className={b.rowHead}><h2>{blast.name}</h2><span className={s.badge} data-tone={blast.status === 'QUEUED' ? 'ok' : blast.status === 'CANCELLED' ? 'bad' : 'warn'}>{t(blast.status)}</span>
      <span className={s.badge}>{t(blast.channel)}</span><span className={s.badge}>{t(blast.purpose)}</span></div>
    {blast.sendAt && <p className={s.muted}>{t('sendsAt', { time: p.formatTime(blast.sendAt) })}</p>}
    <div className={b.sample}>{blast.subject && <strong>{blast.subject}</strong>}<span>{blast.body}</span></div>
    <h2>{t('results')}</h2>
    <dl className={b.counts}>{[...schoolCounts, ...deliveryCounts].map(([k, n]) => <div key={k}><dt>{t(k)}</dt><dd>{n}</dd></div>)}</dl>
    {blast.status === 'QUEUED' && (mayCancel ? (p.ask?.kind === 'CANCEL'
      ? <div className={s.flash} role="alertdialog" data-hq-blast-ask="cancel"><p>{t('cancelAsk', { name: blast.name })}</p>
        <p className={s.actions}><button type="button" className={s.button} disabled={p.locked} onClick={p.onConfirm}>{t('cancelYes')}</button>
          <button type="button" className={s.ghost} disabled={p.locked} onClick={() => p.onAsk(null)}>{t('confirmNo')}</button></p></div>
      : <p className={s.actions}><button type="button" className={s.ghost} disabled={p.locked} data-hq-blast-cancel="true" onClick={() => p.onAsk({ kind: 'CANCEL' })}>{t('cancel')}</button></p>)
      : <p className={s.muted}>{t('cantCancel')}</p>)}
    <h2>{t('perSchool')}</h2>
    <ul className={b.results}>{schools.map(x => <li key={x.schoolId}><span>{x.schoolDisplayName}</span>
      <span className={s.actions}><span className={s.badge} data-tone={x.outcome === 'QUEUED' ? 'ok' : 'warn'}>{t(`o_${x.outcome}`)}</span>
        {x.messageId && <a className={s.ghost} href={`/hq/communications/${x.messageId}`}>{t('message')}</a>}</span></li>)}</ul>
  </section>;
}
