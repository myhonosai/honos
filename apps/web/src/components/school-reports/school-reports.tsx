'use client';
import React, { useEffect, useRef, useState } from 'react';
import { SCHOOL_REPORT_MONTHS_DEFAULT } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ReportsError, schoolReportsApi, type SchoolReportsApi } from './http';
import { SchoolReportsView, type ReportsReadState } from './view';

/**
 * School reports (R1, 0331). Reads month by month totals for the selected school; a school change, a session end or the
 * shell's privacy events hide the page at once and retire any read in flight. Nothing here writes, sends or charges.
 */
export function SchoolReportsPage({ api = schoolReportsApi }: { api?: SchoolReportsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [months, setMonths] = useState<number>(SCHOOL_REPORT_MONTHS_DEFAULT);
  const [report, setReport] = useState<ReportsReadState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; setReport({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setReport({ state: 'LOADING' });
    // Read only while the shell shows this school; a concealed page reads again once it is shown.
    if (!orgId || !schoolId || shell.phase !== 'READY') return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    api.read({ organizationId: orgId, schoolId }, months, signal, owned).then(
      (read) => { if (owned()) setReport({ state: 'READY', read }); },
      (error) => {
        if (!owned() || abort.signal.aborted) return;
        const kind = error instanceof ReportsError ? error.kind : 'UNAVAILABLE';
        setReport({ state: kind === 'DENIED' ? 'DENIED' : kind === 'TIMEZONE' ? 'TIMEZONE' : 'UNAVAILABLE' });
      });
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, months, refresh, shell.phase]);

  return <SchoolReportsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
    hasSchool={Boolean(orgId && schoolId)} months={months} report={report} onMonths={setMonths} onRefresh={() => setRefresh((x) => x + 1)}/>;
}
