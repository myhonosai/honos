import { schoolEntryApi, SchoolEntryError, type SchoolEntryApi, type SchoolScope } from './http';
import type { StaffReportingSchoolChoice } from '../staff-reporting-schools-http';

export type EntryPhase = 'IDLE' | 'LOADING' | 'CHOICE' | 'READY' | 'CONCEALED' | 'SESSION' | 'DENIED' | 'UNAVAILABLE' | 'IDENTITY';
export type EntrySnapshot = Readonly<{ phase: EntryPhase; revision: number; choices: readonly StaffReportingSchoolChoice[]; selection: SchoolScope | null }>;
/** Mounted private memory holds navigation selectors, never authorization or command recovery. */
export class SchoolEntryController {
  private state: EntrySnapshot = { phase: 'IDLE', revision: 0, choices: [], selection: null };
  private listeners = new Set<(state: EntrySnapshot) => void>();
  private abort: AbortController | null = null;
  private mounted = true;
  constructor(private readonly subject: string, private readonly api: SchoolEntryApi = schoolEntryApi) {}
  snapshot(): EntrySnapshot { return this.state; }
  subscribe(fn: (state: EntrySnapshot) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  activate(): void { this.mounted = true; }
  private replace(phase: EntryPhase, choices: readonly StaffReportingSchoolChoice[] = [], selection: SchoolScope | null = null): void {
    this.state = { phase, revision: this.state.revision + 1, choices, selection };
    for (const fn of this.listeners) fn(this.state);
  }
  conceal(phase: 'CONCEALED' | 'SESSION' = 'CONCEALED'): void {
    this.abort?.abort(); this.abort = null;
    // Privacy events and effect cleanup must never downgrade a terminal identity
    // or session failure into a restorable state in this mounted controller.
    const terminal = this.state.phase === 'SESSION' || this.state.phase === 'IDENTITY';
    this.replace(phase === 'SESSION' ? phase : terminal ? this.state.phase : phase);
  }
  dispose(): void { this.mounted = false; this.conceal(); this.listeners.clear(); }
  canNavigate(revision: number, scope: SchoolScope): boolean {
    return this.mounted && this.state.phase === 'READY' && this.state.revision === revision
      && this.state.selection?.schoolId === scope.schoolId && this.state.selection.organizationId === scope.organizationId;
  }
  async load(): Promise<void> { await this.run(); }
  async choose(schoolId: string, revision: number): Promise<void> {
    if (revision !== this.state.revision || !['CHOICE', 'READY'].includes(this.state.phase)) return;
    const option = this.state.choices.find(c => c.schoolId === schoolId);
    if (!option) return;
    await this.run({ organizationId: option.organizationId, schoolId: option.schoolId });
  }
  private async run(chosen?: SchoolScope): Promise<void> {
    if (!this.mounted || this.state.phase === 'LOADING' || this.state.phase === 'SESSION' || this.state.phase === 'IDENTITY') return;
    this.abort?.abort(); const abort = new AbortController(); this.abort = abort;
    this.replace('LOADING'); const revision = this.state.revision;
    const current = () => this.mounted && this.abort === abort && !abort.signal.aborted && revision === this.state.revision;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]);
    try {
      await this.api.identity(this.subject, signal); if (!current()) return;
      let selection = chosen, choices: readonly StaffReportingSchoolChoice[] = [];
      if (!selection) {
        const result = await this.api.current(signal); if (!current()) return;
        if (result.state === 'RESOLVED') selection = { organizationId: result.organizationId, schoolId: result.schoolId };
        else {
          const result = await this.api.choices(signal); if (!current()) return;
          if (result.state !== 'SELECTION_REQUIRED') throw new SchoolEntryError('UNAVAILABLE');
          choices = result.schools;
        }
      }
      if (selection) { await this.api.verifySchool(selection, signal); if (!current()) return; }
      await this.api.identity(this.subject, signal); if (!current()) return;
      this.replace(selection ? 'READY' : 'CHOICE', choices, selection ?? null);
    } catch (error) {
      if (!current()) return;
      this.replace(error instanceof SchoolEntryError ? error.kind : 'UNAVAILABLE');
    } finally { if (this.abort === abort) this.abort = null; }
  }
}

/** Only organization/school selectors are carried; every destination independently authorizes. */
export function schoolWorkflowLinks(scope: SchoolScope): ReadonlyArray<{ key: 'crm' | 'registration' | 'membership' | 'booking' | 'attendance' | 'dashboard'; href: string }> {
  const ids = new URLSearchParams({ organizationId: scope.organizationId, schoolId: scope.schoolId }).toString();
  return [
    { key: 'crm', href: `/staff/crm/journey?${ids}` },
    { key: 'registration', href: `/staff/crm/journey?${ids}` },
    { key: 'membership', href: `/staff/crm/journey?${ids}` },
    // Student booking/attendance start in the existing lead -> verified membership handoff.
    { key: 'booking', href: `/staff/crm/journey?${ids}` },
    { key: 'attendance', href: `/staff/crm/journey?${ids}` },
    { key: 'dashboard', href: `/staff/dashboard?${ids}` },
  ];
}
