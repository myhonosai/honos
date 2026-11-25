'use client';

import React, { useEffect, useRef, useState } from 'react';
import { schoolEntryApi } from '../school-entry/http';
import type { StaffReportingSchoolChoice } from '../staff-reporting-schools-http';
import { SCHOOL_SHELL_NAV, schoolShellHref } from '../school-shell/catalog';
import styles from './switcher.module.css';

/**
 * Account switcher under the logo (owner, 2026-11-24; like HighLevel's sub-account switcher). Navigation only:
 * it lists HON HQ for HQ people and the schools this person already has access to. Every school page and API
 * still verifies the school itself; the list grants nothing.
 */
const copy = {
  en: { label: 'Switch account', hq: 'HON HQ', hqSub: 'Company control plane', search: 'Find a school', none: 'No other schools', current: 'Current' },
  ko: { label: '계정 전환', hq: 'HON HQ', hqSub: '회사 관리', search: '도장 찾기', none: '다른 도장이 없습니다', current: '현재' },
  es: { label: 'Cambiar de cuenta', hq: 'HON HQ', hqSub: 'Panel de la empresa', search: 'Buscar escuela', none: 'No hay otras escuelas', current: 'Actual' },
} as const;
const text = (language: string) => language === 'ko' ? copy.ko : language === 'es' ? copy.es : copy.en;

export type SwitcherCurrent = { kind: 'hq' } | { kind: 'school'; schoolId: string; schoolName: string | null };
export const schoolHomeHref = (choice: Pick<StaffReportingSchoolChoice, 'organizationId' | 'schoolId'>) =>
  schoolShellHref(SCHOOL_SHELL_NAV[0]!.routes[0]!, { organizationId: choice.organizationId, schoolId: choice.schoolId });

/** Close an open menu on a click or tap outside it, or on Escape (owner preference for every menu). Returns the unbind. */
export function bindSwitcherDismiss(menu: HTMLDetailsElement, doc: Document): () => void {
  const close = () => { if (menu.open) menu.open = false; };
  const pointer = (event: Event) => { if (menu.open && !menu.contains(event.target as Node)) close(); };
  const key = (event: KeyboardEvent) => { if (menu.open && event.key === 'Escape') { close(); menu.querySelector('summary')?.focus(); } };
  doc.addEventListener('pointerdown', pointer); doc.addEventListener('keydown', key);
  return () => { doc.removeEventListener('pointerdown', pointer); doc.removeEventListener('keydown', key); };
}

/** Pure view, so it can be rendered and tested without a network. */
export function SchoolSwitcherView({ language, current, isHq, schools, query = '', onQuery = () => {}, onOpen }: {
  language: string; current: SwitcherCurrent; isHq: boolean; schools: readonly StaffReportingSchoolChoice[]; query?: string; onQuery?: (q: string) => void; onOpen?: () => void;
}): React.ReactElement | null {
  const c = text(language);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => menu.current ? bindSwitcherDismiss(menu.current, document) : undefined);
  // Shown to HQ people everywhere, and to anyone with more than one school (multi-location organizations).
  if (!isHq && schools.length < 2) return null;
  const q = query.trim().toLocaleLowerCase();
  const shown = schools.filter(s => !q || s.schoolName.toLocaleLowerCase().includes(q) || s.organizationName.toLocaleLowerCase().includes(q));
  const currentLabel = current.kind === 'hq' ? c.hq : current.schoolName ?? schools.find(s => s.schoolId === current.schoolId)?.schoolName ?? c.label;
  return <details ref={menu} className={styles.switcher} data-account-switcher="" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open) onOpen?.(); }}>
    <summary aria-label={`${c.label}: ${currentLabel}`}><span className={styles.current}>{currentLabel}</span><span aria-hidden="true" className={styles.caret}>▾</span></summary>
    <div className={styles.panel} role="menu" aria-label={c.label}>
      {schools.length > 6 && <input type="search" className={styles.search} aria-label={c.search} placeholder={c.search} value={query} onChange={e => onQuery(e.target.value)} />}
      {isHq && <a role="menuitem" href="/hq" data-switch-to="hq" aria-current={current.kind === 'hq' ? 'true' : undefined}><strong>{c.hq}</strong><small>{c.hqSub}</small></a>}
      {shown.map(s => <a key={s.schoolId} role="menuitem" href={schoolHomeHref(s)} data-switch-to={s.schoolId}
        aria-current={current.kind === 'school' && current.schoolId === s.schoolId ? 'true' : undefined}><strong>{s.schoolName}</strong><small>{s.organizationName}</small></a>)}
      {shown.length === 0 && <p className={styles.none}>{c.none}</p>}
    </div>
  </details>;
}

async function readIsHq(signal: AbortSignal): Promise<boolean> {
  const response = await fetch('/api/v1/hq/session', { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) return false;
  const body = await response.json() as { data?: { hqRole?: unknown } };
  return typeof body?.data?.hqRole === 'string';
}

/**
 * Loads the lists quietly. Inside HQ the shell already proved HQ access, so nothing is fetched until the
 * menu is first opened. Inside a school it loads on mount, to decide whether to show at all.
 * Any failure shows the switcher without that part (or not at all).
 */
export function SchoolSwitcher({ language, current, inHq = false }: { language: string; current: SwitcherCurrent; inHq?: boolean }): React.ReactElement | null {
  const [isHq, setIsHq] = useState(inHq);
  const [schools, setSchools] = useState<readonly StaffReportingSchoolChoice[]>([]);
  const [query, setQuery] = useState('');
  const [wanted, setWanted] = useState(!inHq);
  useEffect(() => {
    if (!wanted) return;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]);
    if (!inHq) readIsHq(signal).then(value => { if (!abort.signal.aborted) setIsHq(value); }, () => {});
    schoolEntryApi.choices(signal).then(result => { if (!abort.signal.aborted && result.state === 'SELECTION_REQUIRED') setSchools(result.schools); }, () => {});
    return () => abort.abort();
  }, [wanted, inHq]);
  return <SchoolSwitcherView language={language} current={current} isHq={isHq} schools={schools} query={query} onQuery={setQuery}
    onOpen={() => setWanted(true)} />;
}
