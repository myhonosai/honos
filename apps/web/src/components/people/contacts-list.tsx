import React, { useId } from 'react';
import { SCHOOL_CONTACT_ENDS_WITHIN, SCHOOL_CONTACT_SEGMENTS, type SchoolContactOptions, type SchoolContactRow } from '@hon/contracts';
import { CONTACT_QUERY_MAX, NO_CONTACT_FILTERS, type ContactFilters } from './contacts-http';
import { contactsText, type ContactsKey } from './contacts-copy';
import type { ListState } from './model';
import styles from './people.module.css';

type PeopleT = (key: 'searchLabel' | 'searchButton' | 'listLoading' | 'listDenied' | 'listUnavailable' | 'noEmail' | 'noPhone') => string;
export type ContactsListProps = Readonly<{
  language: string; list: ListState; filters: ContactFilters; options: SchoolContactOptions | null; selectedId: string | null; pt: PeopleT;
  onOpen?: ((personId: string) => void) | undefined; onFilters?: ((filters: ContactFilters) => void) | undefined; onMore?: (() => void) | undefined;
}>;
const SOON_DAYS = 30;
const DAY = 86_400_000;

/** How many of the student-only filters are set (search and segment are shown on their own). */
export function activeFilterCount(f: ContactFilters): number { return [f.rankId, f.programId, f.planId, f.endsWithinDays].filter(Boolean).length; }

/** The end-date badge for a row: soon (within 30 days), later, or already ended. */
export function endBadge(language: string, endsAt: string | null, now = Date.now()): Readonly<{ tone: 'soon' | 'later' | 'ended'; text: string }> | null {
  if (!endsAt) return null;
  const at = Date.parse(endsAt);
  if (!Number.isFinite(at)) return null;
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(new Date(at));
  if (at <= now) return { tone: 'ended', text: contactsText(language, 'ended', { date }) };
  return at - now <= SOON_DAYS * DAY ? { tone: 'soon', text: contactsText(language, 'endsSoon', { date }) } : { tone: 'later', text: contactsText(language, 'ends', { date }) };
}

/** The contacts card body: search, segment chips with counts, student filters, rows with plan, belt and end date, and paging. */
export function ContactsList(props: ContactsListProps): React.ReactElement {
  const { language, list, filters, options, selectedId, pt, onOpen, onFilters, onMore } = props;
  const t = (key: ContactsKey, vars?: Readonly<Record<string, string | number>>) => contactsText(language, key, vars);
  const base = useId();
  const counts = list.state === 'READY' ? list.counts : null;
  const set = (patch: Partial<ContactFilters>) => onFilters?.({ ...filters, ...patch });
  const active = activeFilterCount(filters);
  const busy = list.state === 'LOADING';
  return <>
    <form className={styles.search} role="search" onSubmit={e => { e.preventDefault(); set({ query: String(new FormData(e.currentTarget).get('query') ?? '') }); }}>
      <label htmlFor={`${base}-q`}>{pt('searchLabel')}</label>
      <div className={styles.searchRow}>
        <input id={`${base}-q`} name="query" type="search" maxLength={CONTACT_QUERY_MAX} autoComplete="off" defaultValue={filters.query}/>
        <button type="submit" className={styles.secondary} disabled={busy}>{pt('searchButton')}</button>
      </div>
    </form>
    <div className={styles.segments} role="group" aria-label={t('segmentsLabel')} data-testid="contact-segments">
      {SCHOOL_CONTACT_SEGMENTS.map(segment => <button key={segment} type="button" className={styles.chip} aria-pressed={filters.segment === segment}
        data-segment={segment} disabled={busy} onClick={() => set({ segment })}>
        {t(segment)}{counts ? <span className={styles.count}>{counts[segment]}</span> : null}
      </button>)}
    </div>
    <details className={styles.filters} open={active > 0 ? true : undefined}>
      <summary>{active ? t('filtersOn', { n: active }) : t('filters')}</summary>
      <p className={styles.meta}>{t('filterHelp')}</p>
      <div className={styles.filterGrid}>
        <Select id={`${base}-rank`} label={t('belt')} value={filters.rankId} any={t('any')} disabled={busy} onChange={rankId => set({ rankId })}
          choices={(options?.ranks ?? []).map(r => [r.rankId, `${r.curriculum}: ${r.rank}`])}/>
        <Select id={`${base}-program`} label={t('program')} value={filters.programId} any={t('any')} disabled={busy} onChange={programId => set({ programId })}
          choices={(options?.programs ?? []).map(p => [p.programId, p.name])}/>
        <Select id={`${base}-plan`} label={t('plan')} value={filters.planId} any={t('any')} disabled={busy} onChange={planId => set({ planId })}
          choices={(options?.plans ?? []).map(p => [p.planId, p.name])}/>
        <Select id={`${base}-ends`} label={t('endsWithin')} value={filters.endsWithinDays} any={t('any')} disabled={busy}
          onChange={days => set({ endsWithinDays: days as ContactFilters['endsWithinDays'] })}
          choices={SCHOOL_CONTACT_ENDS_WITHIN.map(n => [String(n), t('days', { n })])}/>
      </div>
      {active ? <button type="button" className={styles.secondary} disabled={busy}
        onClick={() => set({ rankId: NO_CONTACT_FILTERS.rankId, programId: '', planId: '', endsWithinDays: '' })}>{t('clear')}</button> : null}
    </details>
    <Rows {...props} t={t}/>
  </>;
}

function Select({ id, label, value, any, choices, disabled, onChange }: { id: string; label: string; value: string; any: string; disabled: boolean;
  choices: readonly (readonly [string, string])[]; onChange: (value: string) => void }) {
  return <div className={styles.filterField}>
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled || (!choices.length && !value)} onChange={e => onChange(e.currentTarget.value)}>
      <option value="">{any}</option>
      {choices.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
    </select>
  </div>;
}

function Rows({ language, list, filters, selectedId, pt, onOpen, onMore, t }: ContactsListProps & { t: (key: ContactsKey, vars?: Readonly<Record<string, string | number>>) => string }) {
  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{pt('listLoading')}</p>;
  if (list.state === 'DENIED') return <p className={styles.meta} role="status">{pt('listDenied')}</p>;
  if (list.state === 'UNAVAILABLE') return <p className={styles.meta} role="status">{pt('listUnavailable')}</p>;
  if (!list.rows.length) return <p className={styles.meta} data-testid="people-list-empty">{t('none')}</p>;
  const total = list.counts[filters.segment];
  return <>
    <ul className={styles.list} data-testid="people-list">{list.rows.map(p => <li key={p.personId}><Row language={language} p={p} selected={p.personId === selectedId} pt={pt} t={t} onOpen={onOpen}/></li>)}</ul>
    <p className={styles.meta} role="status">{t('shown', { shown: list.rows.length, total })}</p>
    {list.nextCursor ? <div className={styles.actions}>
      {list.more === 'FAILED' ? <p className={styles.meta} role="status">{t('moreFailed')}</p> : null}
      <button type="button" className={styles.secondary} disabled={list.more === 'LOADING'} onClick={onMore}>
        {list.more === 'LOADING' ? t('loadingMore') : list.more === 'FAILED' ? t('tryMore') : t('showMore')}
      </button>
    </div> : null}
  </>;
}

function Row({ language, p, selected, pt, t, onOpen }: { language: string; p: SchoolContactRow; selected: boolean; pt: PeopleT;
  t: (key: ContactsKey, vars?: Readonly<Record<string, string | number>>) => string; onOpen?: ((id: string) => void) | undefined }) {
  const badge = endBadge(language, p.membershipEndsAt);
  const plan = [p.planName, p.programName].filter(Boolean).join(' · ');
  return <button type="button" className={styles.person} aria-current={selected ? 'true' : undefined} onClick={() => onOpen?.(p.personId)} data-segment={p.segment}>
    <span className={styles.personHead}>
      <strong>{p.givenName} {p.familyName}</strong>
      <span className={styles.segment} data-segment={p.segment}>{t(`row${p.segment}`)}</span>
    </span>
    {p.segment === 'STUDENT' ? <span className={styles.facts}>
      <span>{plan || t('noPlan')}</span>
      {p.ranks.map((r, i) => <span key={`${r.rank}-${i}`} className={styles.rank}>
        <span className={styles.swatch} style={r.color ? { background: r.color } : undefined} aria-hidden="true"/>{r.rank}
      </span>)}
      {badge ? <span className={styles.ends} data-tone={badge.tone}>{badge.text}</span> : null}
    </span> : null}
    <small>{p.email ?? pt('noEmail')} · {p.phoneE164 ?? pt('noPhone')}</small>
  </button>;
}
