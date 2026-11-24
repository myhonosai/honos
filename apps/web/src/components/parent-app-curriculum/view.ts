import type { CurriculumAppState, CurriculumCycle, CurriculumResourceRecord, StaffParentAppCurriculum } from '@hon/contracts';

/** Pure helpers for the staff page; the database computes every current/next cycle, these only word it. */
export type StaffCurriculum = StaffParentAppCurriculum['curricula'][number];

/** "2026-12-14" -> "Mon, Dec 14" (a school-local calendar date, so it is formatted as UTC to keep the day). */
export function dayLabel(date: string, language = 'en'): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(language, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function cycleBanner(state: CurriculumAppState, language = 'en'): { now: string; next: string | null } {
  const { current, next } = state.cycleState;
  if (!state.cycles.length) return { now: 'No cycles yet. Add the first cycle below.', next: null };
  if (state.settings.cycleRotation === 'STAFF_PICK' && !state.settings.saved) return { now: 'Save the setup to choose the cycle families see.', next: null };
  const nextLine = next ? `Next: ${next.name}${next.startsOn ? `, starting ${dayLabel(next.startsOn, language)}` : ''}.` : null;
  if (!current) return { now: next?.startsOn ? `Nothing yet. ${next.name} starts ${dayLabel(next.startsOn, language)}.` : 'No cycle is set yet.', next: null };
  return { now: `Now: ${current.name}${current.endsOn ? `, through ${dayLabel(current.endsOn, language)}` : ''}.`, next: nextLine };
}

export const parentMaterials = (c: StaffCurriculum): CurriculumResourceRecord[] => c.resources.filter((r) => r.status === 'ACTIVE' && r.audience === 'PARENT');

/** What the current HON Parent app (0132 library read) already shows: whole-curriculum or rank videos and links. */
export function visibleInAppToday(r: CurriculumResourceRecord): boolean { return r.cycleId === null && (r.kind === 'VIDEO' || r.kind === 'LINK'); }

export function moveCycle(cycles: readonly CurriculumCycle[], cycleId: string, step: -1 | 1): string[] | null {
  const ids = [...cycles].sort((a, b) => a.position - b.position).map((c) => c.id);
  const from = ids.indexOf(cycleId), to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}

export const KIND_LABEL: Record<CurriculumResourceRecord['kind'], string> = { VIDEO: 'Video', DOCUMENT: 'Document', LINK: 'Link' };
export const modeLabel = (c: StaffCurriculum) => (c.app.settings.displayMode === 'RANK' ? 'Rank-based' : 'Cycle-based');
