'use client';
import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { CommandCenterAccessError, loadCommandCenter } from '../command-center-http';
import { StaffDashboardAccessError, loadStaffDashboard } from '../staff-dashboard-http';
import { AiTeamReadinessAccessError, loadAiTeamReadiness } from '../ai-team-readiness-http';
import { ClassSessionsReadAccessError, loadCurrentSchoolClassSessions } from '../class-sessions-read-http';
import { WorkAccessError, loadHumanWork } from '../work-items-http';
import { PlannedAbsenceReviewAccessError, loadPlannedAbsenceReviewQueue } from '../planned-absence-review-http';
import { ReportsError, schoolReportsApi } from '../school-reports/http';
import { PlanAccessError, readPlanCatalog } from '../membership-plans/http';
import { CreativeGenerationError, listCreativeGenerations } from '../creative-studio/generation-http';
import { HON_CONVERSATION_API, HonConversationError, type HonConversationApi } from '../hon-command/hon-conversation-http';
import type { Panel } from '../home/model';
import { SpecialistAsk } from './ask';
import type { SpecialistKey } from './model';
import { SPECIALIST_SOURCES, SpecialistWorkspaceView, WORKSPACE_LOADING, type WorkspaceSourceKey, type WorkspaceSources } from './view';
import { HON_AI_TEAM } from '@hon/design-system';

type Scope = Readonly<{ organizationId: string; schoolId: string }>;
type Loader<K extends WorkspaceSourceKey> = (scope: Scope, signal: AbortSignal) => Promise<WorkspaceSources[K] extends Panel<infer V> ? V : never>;
export type WorkspaceApi = { [K in WorkspaceSourceKey]: Loader<K> };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The panels' existing protected GET reads. Each API re-authorizes the exact school; none of these reads writes or starts
 * AI work. Only the Ask box (SpecialistAsk) starts a governed Ask HON turn, and only when a person sends a question.
 */
export const WORKSPACE_API: WorkspaceApi = {
  readiness: (scope, signal) => loadAiTeamReadiness(scope.organizationId, scope.schoolId, signal),
  command: scope => loadCommandCenter(scope.organizationId, scope.schoolId),
  work: async scope => {
    const queue = await loadHumanWork('mine', 'ACTIVE');
    if (!same(queue.schoolId, scope.schoolId)) throw new Error('Work queue belongs to another school.');
    return queue.items;
  },
  sessions: (scope, signal) => loadCurrentSchoolClassSessions(scope.organizationId, scope.schoolId, signal),
  // The review queue is the caller's current school; another school's queue is never shown here.
  absences: async (scope, signal) => {
    const queue = await loadPlannedAbsenceReviewQueue(signal);
    return same(queue.organizationId, scope.organizationId) && same(queue.schoolId, scope.schoolId) ? queue.items : null;
  },
  operations: scope => loadStaffDashboard(scope.organizationId, scope.schoolId),
  reports: (scope, signal) => schoolReportsApi.read(scope, 3, signal, () => !signal.aborted),
  plans: (scope, signal) => readPlanCatalog(scope, signal),
  campaigns: (scope, signal) => HON_CONVERSATION_API.targets('marcus', scope, signal, () => !signal.aborted),
  creative: async (scope, signal) => (await listCreativeGenerations(scope.schoolId, signal)).generations,
};

const DENIED_TYPES = [CommandCenterAccessError, StaffDashboardAccessError, AiTeamReadinessAccessError, ClassSessionsReadAccessError, WorkAccessError, PlanAccessError];
/** A refusal shows "not in your access"; anything else is "could not be verified". Neither shows a value. */
export function workspacePanelFromError(error: unknown): Panel<never> {
  const denied = DENIED_TYPES.some(type => error instanceof type)
    || (error instanceof PlannedAbsenceReviewAccessError && (error.status === 401 || error.status === 403))
    || (error instanceof ReportsError && (error.kind === 'DENIED' || error.kind === 'SESSION'))
    || (error instanceof CreativeGenerationError && (error.kind === 'DENIED' || error.kind === 'SESSION'))
    || (error instanceof HonConversationError && (error.kind === 'FORBIDDEN' || error.kind === 'SESSION'));
  return denied ? { state: 'DENIED' } : { state: 'UNAVAILABLE' };
}

/**
 * A workspace for Alex, Jordan, Claire or Lena. Loads only that specialist's reads for the school the shell verified,
 * each independently. A school change, session end, blur or hidden tab conceals and retires every read at once.
 */
export function SpecialistWorkspace({ agent, api = WORKSPACE_API, honApi }: { agent: SpecialistKey; api?: WorkspaceApi; honApi?: HonConversationApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const orgId = selection?.organizationId ?? null, schoolId = selection?.schoolId ?? null;
  const [sources, setSources] = useState<WorkspaceSources>(WORKSPACE_LOADING);
  const [now, setNow] = useState(() => new Date());
  const generation = useRef(0);

  useEffect(() => onShellPrivacyEvent(() => {
    concealShellPrivateNow(); generation.current++; setSources(WORKSPACE_LOADING);
  }, [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);

  useEffect(() => {
    const current = ++generation.current;
    setSources(WORKSPACE_LOADING); setNow(new Date());
    if (!orgId || !schoolId) return;
    const abort = new AbortController(), scope = { organizationId: orgId, schoolId };
    for (const key of SPECIALIST_SOURCES[agent]) {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
      (api[key] as Loader<typeof key>)(scope, signal).then(
        value => { if (current === generation.current) setSources(prior => ({ ...prior, [key]: { state: 'READY', value } })); },
        error => { if (current === generation.current && !abort.signal.aborted) setSources(prior => ({ ...prior, [key]: workspacePanelFromError(error) })); });
    }
    return () => { abort.abort(); };
  }, [agent, api, orgId, schoolId]);

  const name = HON_AI_TEAM.find(m => m.id === agent)?.name ?? agent;
  // Keyed by the shell phase and school: a concealed node is replaced, never un-hidden in place.
  return <div key={`${shell.phase}:${schoolId ?? ''}`} data-shell-private="">
    <SpecialistWorkspaceView agent={agent} language={preferences.language} artStyle={shell.artStyle} now={now} sources={sources}
      waiting={shell.phase === 'IDLE' || shell.phase === 'LOADING'} concealed={shell.phase === 'CONCEALED'} hasSchool={Boolean(orgId && schoolId)}
      renderAsk={orgId && schoolId ? () => <SpecialistAsk agent={agent} name={name} language={preferences.language} school={{ organizationId: orgId, schoolId }}
        {...(honApi ? { api: honApi } : {})} /> : undefined} />
  </div>;
}
