'use client';
import React, { useEffect, useRef, useState } from 'react';
import { SCHOOL_DASHBOARD_RANGE_DEFAULT, SCHOOL_REPORT_MONTHS_DEFAULT, type SchoolDashboardRange } from '@hon/contracts';
import { SCHOOL_SHELL_NAV, schoolShellHref } from '../school-shell/catalog';
import type { DashboardReadState, SchoolDashboardViewProps } from './dashboard';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { ReportsError, schoolReportsApi, type SchoolReportsApi } from './http';
import { SchoolReportsView, type LocationsReadState, type ReportsReadState, type ReportsScopeChoice, type ReportsViewChoice } from './view';

const LINK_PATHS = { memberships: '/staff/memberships', trials: '/staff/crm/trials', leads: '/staff/crm', receivables: '/staff/billing/receivables',
  progress: '/staff/curriculum/progress', renewals: '/staff/billing/renewals', goal: '/staff/planning/goal', revenue: '/staff/planning/revenue' } as const;
/** Links only to pages the school menu has (the monthly goal planner shows up once its page is in the menu). */
export function dashboardLinks(selection: Parameters<typeof schoolShellHref>[1]): SchoolDashboardViewProps['links'] {
  const known = new Map(SCHOOL_SHELL_NAV.flatMap((item) => item.routes.map((route) => [route.href, route] as const)));
  const links: Partial<Record<keyof typeof LINK_PATHS, string>> = {};
  for (const [key, path] of Object.entries(LINK_PATHS) as [keyof typeof LINK_PATHS, string][]) {
    const route = known.get(path);
    if (!route || route.hidden) continue;
    links[key] = schoolShellHref(route, selection);
  }
  return links;
}

/**
 * School reports (R1, 0331) and the same across locations (R2, 0332). Reads month by month totals for the selected school or its locations; a school change, a session end or the
 * shell's privacy events hide the page at once and retire any read in flight. Nothing here writes, sends or charges.
 */
export function SchoolReportsPage({ api = schoolReportsApi }: { api?: SchoolReportsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [months, setMonths] = useState<number>(SCHOOL_REPORT_MONTHS_DEFAULT);
  const [report, setReport] = useState<ReportsReadState>({ state: 'LOADING' });
  const [scope, setScope] = useState<ReportsScopeChoice>('THIS');
  const [locations, setLocations] = useState<LocationsReadState>({ state: 'LOADING' });
  const [locationMonth, setLocationMonth] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<ReportsViewChoice>('OVERVIEW');
  const [range, setRange] = useState<SchoolDashboardRange>(SCHOOL_DASHBOARD_RANGE_DEFAULT);
  const [dashboard, setDashboard] = useState<DashboardReadState>({ state: 'LOADING' });
  const gen = useRef(0), privacy = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; privacy.current++; gen.current++; }; }, []);
  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); gen.current++; privacy.current++; setReport({ state: 'LOADING' }); setLocations({ state: 'LOADING' }); setDashboard({ state: 'LOADING' });
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++gen.current, shown = privacy.current;
    setReport({ state: 'LOADING' }); setLocations({ state: 'LOADING' }); setDashboard({ state: 'LOADING' });
    // Read only while the shell shows this school; a concealed page reads again once it is shown.
    if (!orgId || !schoolId || shell.phase !== 'READY') return;
    const owned = () => mounted.current && current === gen.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    const failed = (error: unknown) => {
      const kind = error instanceof ReportsError ? error.kind : 'UNAVAILABLE';
      return { state: kind === 'SESSION' ? 'UNAVAILABLE' as const : kind };
    };
    // Only the view in use is read: this school, or every location where the reader may see reports.
    if (view === 'OVERVIEW') {
      api.dashboard({ organizationId: orgId, schoolId }, range, signal, owned).then(
        (read) => { if (owned()) setDashboard({ state: 'READY', read }); },
        (error) => { if (owned() && !abort.signal.aborted) { const f = failed(error).state; setDashboard({ state: f === 'TOO_MANY' ? 'UNAVAILABLE' : f }); } });
    } else if (scope === 'THIS') {
      api.read({ organizationId: orgId, schoolId }, months, signal, owned).then(
        (read) => { if (owned()) setReport({ state: 'READY', read }); },
        (error) => { if (owned() && !abort.signal.aborted) setReport(failed(error)); });
    } else {
      api.locations({ organizationId: orgId, schoolId }, months, signal, owned).then(
        (read) => { if (owned()) setLocations({ state: 'READY', read }); },
        (error) => { if (owned() && !abort.signal.aborted) setLocations(failed(error)); });
    }
    return () => { abort.abort(); };
  }, [api, orgId, schoolId, months, scope, view, range, refresh, shell.phase]);

  return <SchoolReportsView language={preferences.language} waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'}
    hasSchool={Boolean(orgId && schoolId)} months={months} report={report} scope={scope} locations={locations} locationMonth={locationMonth}
    onMonths={setMonths} onScope={setScope} onLocationMonth={setLocationMonth} onRefresh={() => setRefresh((x) => x + 1)}
    view={view} onView={setView} range={range} dashboard={dashboard} onRange={setRange} links={dashboardLinks(selection)}/>;
}
