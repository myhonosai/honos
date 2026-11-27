import React from 'react';
import { CREATIVE_JOB_PROVIDERS, type CreativeJobProvider, type CreativeLimitsHqView, type CreativeProviderLimitStatus } from '@hon/contracts';
import type { MarketingOutcome } from '../hq-marketing/model';
import { limitsText, type LimitsKey } from './copy';
import type { LimitsReceipt } from './http';
import { capsFor, dollarsFromMicros, usedShare, type ProviderDraft, type SchoolDraft } from './model';
import styles from '../hq-access/hq-access.module.css';

export type LimitsState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: CreativeLimitsHqView };
export type LimitsOutcome = MarketingOutcome<LimitsReceipt>;
export type LimitsViewProps = Readonly<{
  language: string; formattingLocale: string; concealed: boolean; state: LimitsState;
  /** School names from the HQ wallet list, by lower-case id. Missing names fall back to the id. */
  schools: ReadonlyMap<string, string>;
  outcome: LimitsOutcome; locked: boolean; canRetry: boolean; editing: CreativeJobProvider | null;
  onRefresh: () => void; onReveal: () => void; onEdit: (provider: CreativeJobProvider | null) => void;
  onProvider: (p: CreativeProviderLimitStatus, d: ProviderDraft) => void; onSchool: (d: SchoolDraft) => void; onTryAgain: () => void;
}>;

const usd = (locale: string, micros: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(Math.floor(micros / 10_000) / 100);
const time = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const n = (locale: string, v: number) => new Intl.NumberFormat(locale).format(v);

function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }): React.ReactElement {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function Outcome({ t, outcome, canRetry, onTryAgain }: { t: (k: LimitsKey) => string; outcome: LimitsOutcome; canRetry: boolean; onTryAgain: () => void }): React.ReactElement | null {
  if (!outcome) return null;
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-limits-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.outcome} data-tone="ok" role="status" data-limits-outcome="done">{t(outcome.receipt.replayed ? 'replayed' : 'saved')}</p>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-limits-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const key: LimitsKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? 'localInvalid' : 'refused';
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-limits-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}

function ProviderForm({ t, p, locked, onSave, onCancel }: { t: (k: LimitsKey, v?: Record<string, string>) => string; p: CreativeProviderLimitStatus; locked: boolean;
  onSave: (d: ProviderDraft) => void; onCancel: () => void }): React.ReactElement {
  const id = `hq-cl-${p.providerId.toLowerCase()}`;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    onSave({ dollars: String(f.get('dollars') ?? ''), reason: String(f.get('reason') ?? '') }); };
  return <form className={styles.form} onSubmit={submit} aria-labelledby={`${id}-t`} data-limits-provider-form={p.providerId}>
    <h4 id={`${id}-t`}>{t('setLimit', { provider: t(p.providerId) })}</h4>
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor={`${id}-d`}>{t('dollars')}</label>
      <input id={`${id}-d`} name="dollars" required inputMode="decimal" autoComplete="off" aria-describedby={`${id}-dh`}
        defaultValue={p.dailyLimitMicros === null ? '' : dollarsFromMicros(p.dailyLimitMicros)}/>
      <p id={`${id}-dh`} className={styles.meta}>{t('dollarsHelp')}</p>
      <label htmlFor={`${id}-r`}>{t('reason')}</label>
      <input id={`${id}-r`} name="reason" required minLength={10} maxLength={500} autoComplete="off" aria-describedby={`${id}-rh`}/>
      <p id={`${id}-rh`} className={styles.meta}>{t('reasonHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('saveLimit')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button></div>
  </form>;
}

function SchoolForm({ t, view, schools, locked, onSave }: { t: (k: LimitsKey) => string; view: CreativeLimitsHqView; schools: ReadonlyMap<string, string>;
  locked: boolean; onSave: (d: SchoolDraft) => void }): React.ReactElement {
  // Schools HQ can name, plus any school that already has its own caps.
  const ids = [...new Set([...schools.keys(), ...view.schoolCaps.map(c => c.schoolId.toLowerCase())])]
    .sort((a, b) => (schools.get(a) ?? a).localeCompare(schools.get(b) ?? b));
  const [chosen, setChosen] = React.useState('');
  const caps = chosen ? capsFor(view, chosen) : view.defaultSchoolCaps;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    onSave({ schoolId: v('schoolId'), images: v('images'), videos: v('videos'), avatarVideos: v('avatarVideos'), reason: v('reason') }); };
  return <form className={styles.form} onSubmit={submit} aria-labelledby="hq-cl-school-t" data-limits-school-form="">
    <h3 id="hq-cl-school-t">{t('setSchool')}</h3>
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor="hq-cl-school">{t('school')}</label>
      <select id="hq-cl-school" name="schoolId" required value={chosen} onChange={e => setChosen(e.currentTarget.value)}>
        <option value="">{t('pickSchool')}</option>{ids.map(id => <option key={id} value={id}>{schools.get(id) ?? id}</option>)}</select>
      {/* Keyed by school so the fields start from that school's current caps. */}
      <div className={styles.pair} key={chosen}>
        <div><label htmlFor="hq-cl-img">{t('images')}</label><input id="hq-cl-img" name="images" required inputMode="numeric" autoComplete="off" defaultValue={String(caps.images)}/></div>
        <div><label htmlFor="hq-cl-vid">{t('videos')}</label><input id="hq-cl-vid" name="videos" required inputMode="numeric" autoComplete="off" defaultValue={String(caps.videos)}/></div>
        <div><label htmlFor="hq-cl-av">{t('avatarVideos')}</label><input id="hq-cl-av" name="avatarVideos" required inputMode="numeric" autoComplete="off" defaultValue={String(caps.avatarVideos)}/></div>
      </div>
      <p className={styles.meta}>{t('capsHelp')}</p>
      <label htmlFor="hq-cl-sr">{t('reason')}</label>
      <input id="hq-cl-sr" name="reason" required minLength={10} maxLength={500} autoComplete="off"/>
      <p className={styles.meta}>{t('reasonHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked || !chosen}>{t('saveSchool')}</button></div>
  </form>;
}

/** Presentation only. Every number comes from the verified server answer; the database alone decides who may change them. */
export function CreativeLimitsView(props: LimitsViewProps): React.ReactElement {
  const { language, formattingLocale: loc, concealed, state, locked, schools } = props;
  const t = (key: LimitsKey, vars?: Record<string, string>) => limitsText(language, key, vars);
  const head = <header className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p><p className={styles.meta}><a href="/hq/creative-credits">{t('back')}</a></p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-limits="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-limits={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view, name = (id: string) => schools.get(id.toLowerCase()) ?? id;
  const providers = CREATIVE_JOB_PROVIDERS.map(id => v.providers.find(p => p.providerId === id)).filter((p): p is CreativeProviderLimitStatus => !!p);
  return <section className={styles.access} data-hq-limits="ready">{head}
    <p className={styles.meta}>{t('day', { start: time(loc, v.day.start), end: time(loc, v.day.end) })} {t('ownerOnly')}</p>
    <Outcome t={t} outcome={props.outcome} canRetry={props.canRetry} onTryAgain={props.onTryAgain}/>
    <h2>{t('providersTitle')}</h2>
    <ul className={styles.list} aria-label={t('providersTitle')}>{providers.map(p => {
      const share = usedShare(p);
      return <li key={p.providerId} className={styles.card} data-limits-provider={p.providerId}>
        <div className={styles.cardHead}><h3>{t(p.providerId)}</h3>
          <span className={styles.status} data-tone={p.dailyLimitMicros === null ? 'blocked' : share !== null && share >= 1 ? 'blocked' : 'ready'}>
            {p.dailyLimitMicros === null ? t('unset') : usd(loc, p.dailyLimitMicros)}</span></div>
        {p.dailyLimitMicros === null ? <p className={styles.notice} data-limits-unset="">{t('noLimit')}</p> : <>
          <Facts rows={[[t('limit'), usd(loc, p.dailyLimitMicros)], [t('committed'), usd(loc, p.committedTodayMicros)], [t('open'), n(loc, p.openJobs)],
            [t('overdue'), n(loc, p.overdueJobs)], [t('reason'), p.reason ?? '']]}/>
          <meter min={0} max={1} value={share ?? 0} aria-label={t('committed')} style={{ width: '100%' }}/></>}
        {p.dailyLimitMicros === null && (p.openJobs > 0 || p.committedTodayMicros > 0) && <Facts rows={[[t('committed'), usd(loc, p.committedTodayMicros)], [t('open'), n(loc, p.openJobs)],
          [t('overdue'), n(loc, p.overdueJobs)]]}/>}
        {p.overdueJobs > 0 && <p className={styles.meta}>{t('overdueNote')}</p>}
        {props.editing === p.providerId
          ? <ProviderForm t={t} p={p} locked={locked} onSave={d => props.onProvider(p, d)} onCancel={() => props.onEdit(null)}/>
          : <div className={styles.actions}><button type="button" className={styles.secondary} disabled={locked} onClick={() => props.onEdit(p.providerId)}>{t('edit')}</button></div>}
      </li>;
    })}</ul>
    <h2>{t('schoolsTitle')}</h2>
    <p className={styles.meta}>{t('schoolsIntro')} {t('defaults', { images: n(loc, v.defaultSchoolCaps.images), videos: n(loc, v.defaultSchoolCaps.videos),
      avatarVideos: n(loc, v.defaultSchoolCaps.avatarVideos) })}</p>
    {v.schoolCaps.length === 0 ? <p className={styles.notice} data-limits-overrides="none">{t('noOverrides')}</p>
      : <ul className={styles.list} aria-label={t('schoolsTitle')}>{v.schoolCaps.map(c => <li key={c.schoolId} className={styles.card} data-limits-school={c.schoolId}>
        <div className={styles.cardHead}><h3>{name(c.schoolId)}</h3><span className={styles.status} data-tone="waiting">{t('custom')}</span></div>
        <Facts rows={[[t('images'), n(loc, c.images)], [t('videos'), n(loc, c.videos)], [t('avatarVideos'), n(loc, c.avatarVideos)], [t('reason'), c.reason]]}/>
      </li>)}</ul>}
    <SchoolForm t={t} view={v} schools={schools} locked={locked} onSave={props.onSchool}/>
    <h2>{t('unavailableTitle')}</h2>
    <p className={styles.meta}>{t('unavailableIntro')}</p>
    {v.requesterUnavailable.length === 0 ? <p className={styles.meta} data-limits-kept="none">{t('unavailableNone')}</p>
      : <ul className={styles.list} aria-label={t('unavailableTitle')}>{v.requesterUnavailable.map(j => <li key={j.jobId} className={styles.meta} data-limits-kept={j.jobId}>
        {`${t(j.providerId)} · ${name(j.schoolId)} · ${t('closedAt', { time: time(loc, j.closedAt) })}`}</li>)}</ul>}
  </section>;
}
