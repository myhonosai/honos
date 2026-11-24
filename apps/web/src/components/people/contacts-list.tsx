import React, { useId, useState } from 'react';
import { SCHOOL_CONTACT_ENDS_WITHIN, SCHOOL_CONTACT_MEMBERSHIP_FILTERS, SCHOOL_CONTACT_SEGMENTS, SCHOOL_CONTACT_SORTS, type SchoolContactOptions,
  type SchoolContactRow, type SchoolContactSort } from '@hon/contracts';
import { CONTACT_QUERY_MAX, NO_BELT, NO_CONTACT_FILTERS, contactFiltersOk, type ContactFilters } from './contacts-http';
import { contactsText, type ContactsKey } from './contacts-copy';
import type { ListState } from './model';
import styles from './people.module.css';
import own from './contacts-list.module.css';

type PeopleT = (key: 'searchLabel' | 'searchButton' | 'listLoading' | 'listDenied' | 'listUnavailable' | 'noEmail' | 'noPhone') => string;
export type ContactsListProps = Readonly<{
  language: string; list: ListState; filters: ContactFilters; options: SchoolContactOptions | null; selectedId: string | null; pt: PeopleT;
  onOpen?: ((personId: string) => void) | undefined; onFilters?: ((filters: ContactFilters) => void) | undefined; onMore?: (() => void) | undefined;
}>;
const SOON_DAYS = 30;
const DAY = 86_400_000;

/** How many filters in the panel are set (search, segment and sort are shown on their own; a range counts once). */
export function activeFilterCount(f: ContactFilters): number {
  return [f.rankId, f.programId, f.planId, f.endsWithinDays || f.endsFrom || f.endsTo, f.membership, f.ageMin || f.ageMax, f.tag].filter(Boolean).length;
}
/** C4: age groups for a martial arts school, as [min, max] ('' = open). */
export const CONTACT_AGE_BANDS: readonly (readonly [string, string])[] = [['3', '5'], ['6', '8'], ['9', '12'], ['13', '17'], ['18', '']];
const bandKey = (min: string, max: string) => `${min}-${max}`;
const CLEAR_PANEL: Partial<ContactFilters> = { rankId: NO_CONTACT_FILTERS.rankId, programId: '', planId: '', endsWithinDays: '', membership: '', endsFrom: '', endsTo: '',
  ageMin: '', ageMax: '', tag: '' };

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
  const [bad, setBad] = useState(false);
  // Only a set the server accepts is sent; an impossible range keeps the last good list and says so.
  const set = (patch: Partial<ContactFilters>) => {
    const next = { ...filters, ...patch };
    if (!contactFiltersOk(next)) { setBad(true); return; }
    setBad(false); onFilters?.(next);
  };
  const active = activeFilterCount(filters);
  const busy = list.state === 'LOADING';
  const band = filters.ageMin || filters.ageMax ? bandKey(filters.ageMin, filters.ageMax) : '';
  const [customAge, setCustomAge] = useState(false);
  const ageValue = customAge || (band && !CONTACT_AGE_BANDS.some(([a, b]) => bandKey(a, b) === band)) ? 'CUSTOM' : band;
  const [rangeEnds, setRangeEnds] = useState(false);
  const endsValue = rangeEnds || filters.endsFrom || filters.endsTo ? 'RANGE' : filters.endsWithinDays;
  return <>
    <form className={styles.search} role="search" onSubmit={e => { e.preventDefault(); set({ query: String(new FormData(e.currentTarget).get('query') ?? '') }); }}>
      <label htmlFor={`${base}-q`}>{pt('searchLabel')}</label>
      <div className={styles.searchRow}>
        <input id={`${base}-q`} name="query" type="search" maxLength={CONTACT_QUERY_MAX} autoComplete="off" defaultValue={filters.query}/>
        <button type="submit" className={styles.secondary} disabled={busy}>{pt('searchButton')}</button>
      </div>
    </form>
    <div className={own.sortRow}>
      <label htmlFor={`${base}-sort`}>{t('sortLabel')}</label>
      <select id={`${base}-sort`} value={filters.sort} disabled={busy} data-testid="contact-sort"
        onChange={e => set({ sort: e.currentTarget.value as SchoolContactSort })}>
        {SCHOOL_CONTACT_SORTS.map(s => <option key={s} value={s}>{t(`sort${s}`)}</option>)}
      </select>
    </div>
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
          choices={[[NO_BELT, t('noBelt')], ...(options?.ranks ?? []).map(r => [r.rankId, `${r.curriculum}: ${r.rank}`] as const)]}/>
        <Select id={`${base}-membership`} label={t('membership')} value={filters.membership} any={t('any')} disabled={busy}
          onChange={m => set({ membership: m as ContactFilters['membership'] })} choices={SCHOOL_CONTACT_MEMBERSHIP_FILTERS.map(m => [m, t(`mem${m}`)])}/>
        <Select id={`${base}-program`} label={t('program')} value={filters.programId} any={t('any')} disabled={busy} onChange={programId => set({ programId })}
          choices={(options?.programs ?? []).map(p => [p.programId, p.name])}/>
        <Select id={`${base}-plan`} label={t('plan')} value={filters.planId} any={t('any')} disabled={busy} onChange={planId => set({ planId })}
          choices={(options?.plans ?? []).map(p => [p.planId, p.name])}/>
        <Select id={`${base}-ends`} label={t('endsWithin')} value={endsValue} any={t('any')} disabled={busy}
          onChange={v => { setRangeEnds(v === 'RANGE'); if (v !== 'RANGE') set({ endsWithinDays: v as ContactFilters['endsWithinDays'], endsFrom: '', endsTo: '' }); else if (filters.endsWithinDays) set({ endsWithinDays: '' }); }}
          choices={[...SCHOOL_CONTACT_ENDS_WITHIN.map(n => [String(n), t('days', { n })] as const), ['RANGE', t('endsBetween')]]}/>
        <Select id={`${base}-age`} label={t('age')} value={ageValue} any={t('any')} disabled={busy}
          onChange={v => { setCustomAge(v === 'CUSTOM'); if (v === '') set({ ageMin: '', ageMax: '' });
            else if (v !== 'CUSTOM') { const [min = '', max = ''] = v.split('-'); set({ ageMin: min, ageMax: max }); } }}
          choices={[...CONTACT_AGE_BANDS.map(([a, b]) => [bandKey(a, b), b ? t('ageBand', { min: a, max: b }) : t('ageAdults')] as const), ['CUSTOM', t('ageCustom')]]}/>
        {(options?.tags?.length || filters.tag) ? <Select id={`${base}-tag`} label={t('tag')} value={filters.tag} any={t('any')} disabled={busy} onChange={tag => set({ tag })}
          choices={(options?.tags ?? []).map(tag => [tag, tag])}/> : null}
      </div>
      {endsValue === 'RANGE' ? <div className={styles.filterGrid} data-testid="contact-ends-range">
        <DateField id={`${base}-ends-from`} label={t('endsFrom')} value={filters.endsFrom} disabled={busy} onChange={endsFrom => set({ endsFrom })}/>
        <DateField id={`${base}-ends-to`} label={t('endsTo')} value={filters.endsTo} disabled={busy} onChange={endsTo => set({ endsTo })}/>
      </div> : null}
      {ageValue === 'CUSTOM' ? <div className={styles.filterGrid} data-testid="contact-age-range">
        <AgeField id={`${base}-age-min`} label={t('ageFrom')} value={filters.ageMin} disabled={busy} onCommit={ageMin => set({ ageMin })}/>
        <AgeField id={`${base}-age-max`} label={t('ageTo')} value={filters.ageMax} disabled={busy} onCommit={ageMax => set({ ageMax })}/>
      </div> : null}
      {bad ? <p className={own.bad} role="alert">{t('badRange')}</p> : null}
      {active ? <button type="button" className={styles.secondary} disabled={busy}
        onClick={() => { setBad(false); setCustomAge(false); setRangeEnds(false); set(CLEAR_PANEL); }}>{t('clear')}</button> : null}
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

function DateField({ id, label, value, disabled, onChange }: { id: string; label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <div className={styles.filterField}>
    <label htmlFor={id}>{label}</label>
    <input id={id} className={own.input} type="date" value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}/>
  </div>;
}

/** A whole age 0-120, sent when the field is left or Enter is pressed (not on every key). */
function AgeField({ id, label, value, disabled, onCommit }: { id: string; label: string; value: string; disabled: boolean; onCommit: (value: string) => void }) {
  const commit = (raw: string) => { const v = raw.trim(); if (v !== value) onCommit(v); };
  return <div className={styles.filterField}>
    <label htmlFor={id}>{label}</label>
    <input id={id} key={value} className={own.input} type="number" inputMode="numeric" min={0} max={120} step={1} defaultValue={value} disabled={disabled}
      onBlur={e => commit(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); } }}/>
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
      {p.age !== null ? <span className={own.age}>{t('rowAge', { n: p.age })}</span> : null}
      <span className={styles.segment} data-segment={p.segment}>{t(`row${p.segment}`)}</span>
      {p.membershipState === 'PAUSED' || p.membershipState === 'CANCELLING'
        ? <span className={own.state} data-state={p.membershipState}>{t(`state${p.membershipState}`)}</span> : null}
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
