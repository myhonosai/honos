'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { OperationalSchoolScope } from '../operational-navigation';
import { peopleApi } from '../people/http';
import { staffSearchRecords } from '../staff-search-http';
import { shellText, type ShellKey } from './copy';
import { GlobalSearchRunner, SEARCH_GROUP_TITLE, SEARCH_RECORD_KINDS, SEARCH_REMOTE_MIN, isSearchShortcut, moveActive, orderedHits,
  type SearchHit, type SearchReads, type SearchView } from './global-search-model';
import { ShellIcon } from './icons';
import { onShellPrivacyEvent } from './privacy';
import styles from './shell.module.css';

const LIVE_READS: SearchReads = {
  contacts: (scope, query, signal) => peopleApi.search(scope, query, signal),
  records: (scope, query, signal) => staffSearchRecords(scope.organizationId, scope.schoolId, query, SEARCH_RECORD_KINDS, signal),
};

export type GlobalSearchProps = {
  language: string;
  /** The verified school, or null: without it only pages are searched. */
  selection: OperationalSchoolScope | null;
  /** Called as the pop-up opens so the Menu (or anything else modal) closes first. */
  onOpening?: () => void;
  reads?: SearchReads;
};

/** The top-bar search field and its pop-up. Read only: links to pages, contacts and records, never actions. */
export function GlobalSearch({ language, selection, onOpening, reads = LIVE_READS }: GlobalSearchProps): React.ReactElement {
  const t = (key: ShellKey) => shellText(language, key);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(-1);
  const [view, setView] = useState<SearchView | null>(null);
  const runner = useMemo(() => new GlobalSearchRunner(reads, language, setView), [reads, language]);
  useEffect(() => () => runner.dispose(), [runner]);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(trigger.current?.closest<HTMLElement>('[data-hon-ui="school"]') ?? null); }, []);

  const school = selection ? `${selection.organizationId}:${selection.schoolId}` : '';
  const close = useCallback((refocus = true) => {
    setOpen(false); setText(''); setActive(-1); runner.clear();
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }, [runner]);
  const show = useCallback(() => {
    onOpening?.();
    setOpen(true); setActive(-1); runner.search('', selection);
  }, [onOpening, runner, selection]); // eslint-disable-line react-hooks/exhaustive-deps
  // A different school, or the session ending, drops everything the pop-up showed.
  useEffect(() => { close(false); }, [school]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onShellPrivacyEvent(() => close(false)), [close]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (isSearchShortcut(event)) { event.preventDefault(); if (open) input.current?.focus(); else show(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, show]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const hits = view ? orderedHits(view) : [];
  const go = (hit: SearchHit | undefined) => { if (!hit) return; close(false); window.location.assign(hit.href); };
  const onKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Enter') { event.preventDefault(); go(hits[active < 0 ? 0 : active]); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setActive(index => moveActive(index, hits.length, event.key)); }
  };
  const onType = (value: string) => { setText(value); setActive(-1); runner.search(value, selection); };

  const short = Array.from(view?.query ?? '').length < SEARCH_REMOTE_MIN;
  const notes: string[] = [];
  if (view) {
    if (!selection) notes.push(t('searchNoSchool'));
    else if (short) notes.push(t('searchMore'));
    if (view.contactState === 'FAILED') notes.push(t('searchContactsFailed'));
    if (view.recordState === 'FAILED') notes.push(t('searchRecordsFailed'));
  }
  const loading = view?.contactState === 'LOADING' || view?.recordState === 'LOADING';
  let index = -1;
  const groups = view ? (['CONTACTS', 'LEADS', 'CLASSES', 'PROGRAMS', 'CURRICULA', 'PAGES'] as const)
    .map(group => ({ group, rows: hits.filter(hit => hit.group === group) })).filter(entry => entry.rows.length) : [];

  const palette = open ? <div className={styles.searchLayer} data-global-search="">
    <div className={styles.searchScrim} aria-hidden="true" data-search-scrim="" onClick={() => close()} />
    <div className={styles.searchPanel} role="dialog" aria-modal="true" aria-label={t('searchOpen')}>
      <div className={styles.searchField}>
        <ShellIcon name="search" />
        <input ref={input} type="search" role="combobox" aria-expanded="true" aria-controls="hon-search-results" aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `hon-search-${active}` : undefined} aria-label={t('searchInput')} placeholder={t('searchPlaceholder')}
          value={text} maxLength={200} autoComplete="off" spellCheck={false} onChange={event => onType(event.target.value)} onKeyDown={onKey} />
        <button type="button" className={styles.searchEsc} aria-label={t('searchClose')} onClick={() => close()}>Esc</button>
      </div>
      <div className={styles.searchResults} id="hon-search-results" role="listbox" aria-label={t('searchOpen')} aria-busy={loading} data-shell-private="">
        {groups.map(({ group, rows }) => <section key={group} aria-label={t(SEARCH_GROUP_TITLE[group])} data-search-group={group}>
          <h2>{t(SEARCH_GROUP_TITLE[group])}</h2>
          {rows.map(hit => { index += 1; const mine = index;
            return <a key={hit.key} id={`hon-search-${mine}`} role="option" aria-selected={mine === active} href={hit.href} referrerPolicy="no-referrer"
              tabIndex={-1} onMouseMove={() => setActive(mine)} onClick={event => { event.preventDefault(); go(hit); }}>
              <span className={styles.searchIcon} aria-hidden="true"><ShellIcon name={hit.icon} size={18} /></span>
              <span><strong>{hit.title}</strong>{hit.subtitle ? <small>{hit.subtitle}</small> : null}</span>
            </a>; })}
        </section>)}
        {loading ? <p className={styles.searchNote} role="status">{t('searchLoading')}</p> : null}
        {!loading && !groups.length ? <p className={styles.searchNote} role="status">{t('searchNone')}</p> : null}
        {notes.map(note => <p key={note} className={styles.searchNote}>{note}</p>)}
      </div>
      <footer className={styles.searchFoot}><span>{t('searchHint')}</span><span>{t('searchShortcut')}</span></footer>
    </div>
  </div> : null;

  return <>
    <button ref={trigger} type="button" className={styles.searchTrigger} data-global-search-open="" aria-haspopup="dialog" aria-expanded={open}
      aria-label={t('searchOpen')} title={t('searchOpen')} onClick={show}>
      <ShellIcon name="search" /><span className={styles.searchTriggerText}>{t('searchPlaceholder')}</span><kbd>{t('searchShortcut')}</kbd>
    </button>
    {palette && host ? createPortal(palette, host) : null}
  </>;
}
