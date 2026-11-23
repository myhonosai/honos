'use client';
import React, { useEffect, useRef, useState } from 'react';
import { SCHOOL_SHELL_NAV, schoolShellHref } from '../school-shell/catalog';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ReportsError, schoolReportsApi, type SchoolReportsApi } from '../school-reports/http';
import { AttendanceReportView, type AttendanceReportReadState, type StudentFilter } from './view';

/**
 * Attendance report page (AR1, 0633). Reads the selected school's report; a school change, a session end or the shell's
 * privacy events hide the page at once and retire any read in flight. Nothing here writes, sends or charges.
 */
export function AttendanceReportPage({ api = schoolReportsApi }: { api?: Pick<SchoolReportsApi, 'attendance'> }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState<StudentFilter>('MISSING');
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<AttendanceReportReadState>({ state: 'LOADING' });
  const [busy, setBusy] = useState(false);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; setReport({ state: 'LOADING' }); setBusy(false); setSearch('');
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);
  // Another school starts from this week and this month again.
  useEffect(() => { setWeek(undefined); setMonth(undefined); setSearch(''); setReport({ state: 'LOADING' }); }, [orgId, schoolId]);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    if (!orgId || !schoolId || shell.phase !== 'READY') { setReport({ state: 'LOADING' }); setBusy(false); return; }
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    // A week or month change keeps the last report on screen (marked busy) until the new one arrives.
    setBusy(true);
    api.attendance({ organizationId: orgId, schoolId }, { ...(week ? { week } : {}), ...(month ? { month } : {}) }, signal, owned).then(
      (read) => { if (owned()) { setReport({ state: 'READY', read }); setBusy(false); } },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof ReportsError ? error.kind : 'UNAVAILABLE';
        setReport({ state: kind === 'DENIED' || kind === 'TIMEZONE' ? kind : 'UNAVAILABLE' }); setBusy(false);
      });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, week, month, refresh, shell.phase]);

  const routes = SCHOOL_SHELL_NAV.flatMap((item) => item.routes);
  const contacts = routes.find((route) => route.href === '/staff/people' && !route.hidden), history = routes.find((route) => route.href === '/staff/migration/classes');
  return <AttendanceReportView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
    hasSchool={Boolean(orgId && schoolId)} report={report} busy={busy}
    month={month ?? (report.state === 'READY' ? report.read.classes.month : 'ALL')} filter={filter} search={search}
    contactsHref={contacts ? schoolShellHref(contacts, selection) : undefined} importHref={history ? schoolShellHref(history, selection) : undefined}
    onWeek={setWeek} onMonth={setMonth} onFilter={setFilter} onSearch={setSearch} onRefresh={() => setRefresh((x) => x + 1)}/>;
}
