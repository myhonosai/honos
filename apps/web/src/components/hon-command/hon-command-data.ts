import { AI_DRAFT_WORK_AGENT_KEYS, type ActionReviewItem, type AiDraftWorkAgentKey, type AiDraftWorkItem, type SchoolCommandCenterSnapshot } from '@hon/contracts';
import type { HonInterfaceTheme } from '@hon/design-system';
import { ActionReviewAccessError, loadActionReviews } from '../action-approvals-http';
import { loadAllMyAiDraftWork } from '../ai-draft-work-http';
import { CommandCenterAccessError, loadCommandCenter } from '../command-center-http';
import { loadCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import { loadInterfaceThemePreference } from '../interface-theme-preference';
import { StaffDashboardAccessError } from '../staff-dashboard-http';

/**
 * Shared HON data layer for all three presentation modes. It composes only
 * existing authorized reads; it adds no endpoint, writes nothing and never
 * accepts a URL/form value as scope. Every read is independently authorized by
 * its own API, so a section can be DENIED while others load.
 */

export type HonScope = { organizationId: string; schoolId: string };
export type HonSectionState = 'IDLE' | 'LOADING' | 'READY' | 'EMPTY' | 'DENIED' | 'ERROR';
export interface HonSection<T> { state: HonSectionState; data: T | null; message: string }
export type HonScopeState =
  | { state: 'IDLE' | 'RESOLVING'; message: string }
  | { state: 'VERIFIED'; organizationId: string; schoolId: string; source: 'DASHBOARD' | 'CURRENT_SCHOOL'; message: string }
  | { state: 'SELECTION_REQUIRED' | 'DENIED' | 'ERROR'; message: string };

export interface HonDraftWork { items: AiDraftWorkItem[]; unavailable: AiDraftWorkAgentKey[] }
export interface HonApprovals { items: ActionReviewItem[]; more: boolean }

export interface HonCommandSnapshot {
  scope: HonScopeState;
  theme: HonInterfaceTheme | null;
  commandCenter: HonSection<SchoolCommandCenterSnapshot>;
  draftWork: HonSection<HonDraftWork>;
  approvals: HonSection<HonApprovals>;
}

export interface HonCommandApi {
  resolveScope(): Promise<{ state: 'RESOLVED'; organizationId: string; schoolId: string } | { state: 'MANUAL_ENTRY_REQUIRED' }>;
  theme(scope: HonScope): Promise<HonInterfaceTheme>;
  commandCenter(scope: HonScope): Promise<SchoolCommandCenterSnapshot>;
  draftWork(): Promise<HonDraftWork>;
  approvals(scope: HonScope): Promise<HonApprovals>;
}

export const HON_COMMAND_API: HonCommandApi = {
  resolveScope: () => loadCurrentStaffReportingSchool(),
  theme: async (scope) => (await loadInterfaceThemePreference(scope)).interfaceTheme,
  commandCenter: (scope) => loadCommandCenter(scope.organizationId, scope.schoolId),
  draftWork: () => loadAllMyAiDraftWork(),
  approvals: async (scope) => {
    const queue = await loadActionReviews(scope.schoolId, 'AWAITING_APPROVAL');
    if (queue.organizationId !== scope.organizationId) throw new Error('The approval queue did not verify the current organization. Nothing is shown.');
    return { items: [...queue.items], more: queue.nextAfter !== null };
  },
};

const idle = <T,>(message: string): HonSection<T> => ({ state: 'IDLE', data: null, message });
const loading = <T,>(message: string): HonSection<T> => ({ state: 'LOADING', data: null, message });

export function initialHonCommandSnapshot(): HonCommandSnapshot {
  return {
    scope: { state: 'IDLE', message: 'HON has not loaded any school information yet.' },
    theme: null,
    commandCenter: idle('Suggested actions load after the current school is verified.'),
    draftWork: idle('Recorded AI work loads after the current school is verified.'),
    approvals: idle('Approvals load after the current school is verified.'),
  };
}

function isDenied(error: unknown): boolean {
  return error instanceof CommandCenterAccessError || error instanceof ActionReviewAccessError || error instanceof StaffDashboardAccessError
    || (error instanceof Error && error.message === 'Current direct-human access is unavailable.');
}
function failure<T>(error: unknown, denied: string, fallback: string): HonSection<T> {
  if (isDenied(error)) return { state: 'DENIED', data: null, message: denied };
  return { state: 'ERROR', data: null, message: error instanceof Error ? `${fallback} ${error.message}` : fallback };
}

/** Framework-free controller so behaviour is testable without a DOM. */
export class HonCommandController {
  private current = initialHonCommandSnapshot();
  private generation = 0;
  private listeners = new Set<(snapshot: HonCommandSnapshot) => void>();
  private verifiedScope: HonScope | null = null;

  constructor(private readonly api: HonCommandApi = HON_COMMAND_API) {}

  snapshot(): HonCommandSnapshot { return this.current; }
  subscribe(listener: (snapshot: HonCommandSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private set(next: Partial<HonCommandSnapshot>, generation: number): void {
    if (generation !== this.generation) return;
    this.current = { ...this.current, ...next };
    for (const listener of this.listeners) listener(this.current);
  }

  /** Discards all school content, e.g. when the dashboard clears its verified school. */
  reset(): void {
    this.generation += 1;
    this.verifiedScope = null;
    this.current = initialHonCommandSnapshot();
    for (const listener of this.listeners) listener(this.current);
  }

  /**
   * `dashboardScope` is accepted only from a dashboard that has already verified
   * the school through the operations report. Otherwise the signed-subject-only
   * current-school resolver is used. Neither grants access to any section.
   */
  async open(dashboardScope?: HonScope | null, options: { loadTheme?: boolean } = {}): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.current = initialHonCommandSnapshot();
    let scope: HonScope;
    if (dashboardScope) {
      scope = { organizationId: dashboardScope.organizationId, schoolId: dashboardScope.schoolId };
      this.set({ scope: { state: 'VERIFIED', ...scope, source: 'DASHBOARD', message: 'School verified by the operations dashboard.' } }, generation);
    } else {
      this.set({ scope: { state: 'RESOLVING', message: 'Checking your current school…' } }, generation);
      try {
        const resolved = await this.api.resolveScope();
        if (generation !== this.generation) return;
        if (resolved.state !== 'RESOLVED') {
          this.set({ scope: { state: 'SELECTION_REQUIRED', message: 'You have access to more than one school, or none was resolved automatically. Choose a school on the operations dashboard, then open HON there.' } }, generation);
          return;
        }
        scope = { organizationId: resolved.organizationId, schoolId: resolved.schoolId };
        this.set({ scope: { state: 'VERIFIED', ...scope, source: 'CURRENT_SCHOOL', message: 'Current school resolved from your signed-in staff access.' } }, generation);
      } catch (error) {
        if (generation !== this.generation) return;
        this.set({ scope: isDenied(error)
          ? { state: 'DENIED', message: 'Your current staff access does not include a school HON can open. No school information is shown.' }
          : { state: 'ERROR', message: 'Your current school could not be checked. No school information is shown.' } }, generation);
        return;
      }
    }
    this.verifiedScope = scope;
    await this.load(scope, generation, options.loadTheme === true);
  }

  async refresh(): Promise<void> {
    if (!this.verifiedScope) return;
    this.generation += 1;
    await this.load(this.verifiedScope, this.generation, false);
  }

  private async load(scope: HonScope, generation: number, loadTheme: boolean): Promise<void> {
    this.set({
      commandCenter: loading('Loading verified Command Center priorities…'),
      draftWork: loading('Loading recorded AI work…'),
      approvals: loading('Loading approvals awaiting review…'),
    }, generation);
    const tasks: Promise<void>[] = [
      this.api.commandCenter(scope).then((data) => {
        this.set({ commandCenter: { state: data.recommendations.length ? 'READY' : 'EMPTY', data, message: data.recommendations.length ? 'Deterministic priorities from verified Command Center counts.' : 'No counted priorities are recorded for this school right now.' } }, generation);
      }, (error) => this.set({ commandCenter: failure(error, 'Command Center priorities are not available for your current access.', 'Command Center priorities are unavailable.') }, generation)),
      this.api.draftWork().then((result) => {
        const items = result.items.filter((item) => item.schoolId === scope.schoolId);
        const allDenied = result.unavailable.length === AI_DRAFT_WORK_AGENT_KEYS.length;
        this.set({ draftWork: allDenied
          ? { state: 'DENIED', data: null, message: 'Your current access does not include governed AI draft work (HON Complete and the drafting permission are checked by the server).' }
          : { state: items.length ? 'READY' : 'EMPTY', data: { items, unavailable: result.unavailable }, message: items.length ? 'Your most recent recorded AI draft work for this school.' : 'No recent recorded AI draft work for this school.' } }, generation);
      }, (error) => this.set({ draftWork: failure(error, 'Recorded AI work is not available for your current access.', 'Recorded AI work is unavailable.') }, generation)),
      this.api.approvals(scope).then((data) => {
        this.set({ approvals: { state: data.items.length ? 'READY' : 'EMPTY', data, message: data.items.length ? 'Proposals awaiting a qualified human review.' : 'No proposals are awaiting review for this school.' } }, generation);
      }, (error) => this.set({ approvals: failure(error, 'You do not have approval-review permission for this school. Nothing is shown.', 'The approval queue is unavailable.') }, generation)),
    ];
    if (loadTheme) {
      tasks.push(this.api.theme(scope).then((theme) => this.set({ theme }, generation), () => this.set({ theme: null }, generation)));
    }
    await Promise.all(tasks);
  }
}
