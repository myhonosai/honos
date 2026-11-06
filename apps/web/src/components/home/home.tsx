'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CommandCenterAccessError, loadCommandCenter } from '../command-center-http';
import { StaffDashboardAccessError, loadStaffDashboard } from '../staff-dashboard-http';
import { AiTeamReadinessAccessError, loadAiTeamReadiness } from '../ai-team-readiness-http';
import { CrmLeadAccessError, loadCrmLeads } from '../crm-leads-http';
import { ClassSessionsReadAccessError, loadCurrentSchoolClassSessions } from '../class-sessions-read-http';
import { WorkAccessError, loadHumanWork } from '../work-items-http';
import { HOME_LOADING, type HomeSources, type Panel } from './model';
import { SchoolHomeView } from './view';

type Scope = Readonly<{ organizationId: string; schoolId: string }>;
type Loader<K extends keyof HomeSources> = (scope: Scope, signal: AbortSignal) => Promise<HomeSources[K] extends Panel<infer T> ? T : never>;
export type HomeApi = { [K in keyof HomeSources]: Loader<K> };

const DENIED = [CommandCenterAccessError, StaffDashboardAccessError, AiTeamReadinessAccessError, CrmLeadAccessError, ClassSessionsReadAccessError, WorkAccessError];

/** Existing protected GET reads only. Each API re-authorizes the exact school; nothing here writes or invokes AI. */
export const HOME_API: HomeApi = {
  command: scope => loadCommandCenter(scope.organizationId, scope.schoolId),
  operations: scope => loadStaffDashboard(scope.organizationId, scope.schoolId),
  readiness: (scope, signal) => loadAiTeamReadiness(scope.organizationId, scope.schoolId, signal),
  leads: (scope, signal) => loadCrmLeads(scope.organizationId, scope.schoolId, 'OPEN', signal),
  sessions: (scope, signal) => loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId, signal),
  // The work queue is the caller's current school; it is shown only when it is this school.
  work: async scope => {
    const queue = await loadHumanWork('mine', 'ACTIVE');
    if (queue.schoolId.toLowerCase() !== scope.schoolId.toLowerCase()) throw new Error('Work queue belongs to another school.');
    return queue.items;
  },
};

export function panelFromError(error: unknown): Panel<never> {
  return DENIED.some(type => error instanceof type) ? { state: 'DENIED' } : { state: 'UNAVAILABLE' };
}

/**
 * Loads the Home reads for the school the shell verified, each independently. A school
 * change, session end, blur, hidden tab or page hide hides and clears every result at once;
 * reads start again only after the shell re-verifies the identity and exact school.
 */
export function SchoolHome({ api = HOME_API }: { api?: HomeApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [sources, setSources] = useState<HomeSources>(HOME_LOADING);
  const [now, setNow] = useState(() => new Date());
  const generation = useRef(0);

  useEffect(() => onShellPrivacyEvent(() => {
    // Hide first, then retire every pending read so a late response can never repaint.
    concealShellPrivateNow(); generation.current++; setSources(HOME_LOADING);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++generation.current;
    setSources(HOME_LOADING); setNow(new Date());
    if (!selection) return;
    const abort = new AbortController();
    const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
    for (const key of Object.keys(api) as (keyof HomeSources)[]) {
      (api[key] as Loader<typeof key>)(scope, abort.signal).then(
        value => { if (current === generation.current) setSources(prior => ({ ...prior, [key]: { state: 'READY', value } })); },
        error => { if (current === generation.current) setSources(prior => ({ ...prior, [key]: panelFromError(error) })); });
    }
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, api]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyed by the shell phase: a concealed node is replaced, never un-hidden in place.
  return <div key={shell.phase} data-shell-private="" data-hon-native="">
    <SchoolHomeView language={preferences.language} mode={shell.mode} artStyle={shell.artStyle} onArtStyle={shell.onArtStyle} schoolName={shell.schoolName} selection={selection} sources={sources} now={now}
      waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} />
  </div>;
}
