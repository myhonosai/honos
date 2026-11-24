import type { CurriculumAppEntry, CurriculumAppItem, CurriculumAppSectionLabel } from '@hon/contracts/parent-app-curriculum';

/** Pure wording for the Curriculum screen. The app never works out the current rank or cycle; it words what HON returned. */

/** A calendar date from HON ("2026-11-29") as "Nov 29". Formatted in UTC so the phone's time zone can't move the day. */
export function formatCurriculumDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

/** The one line under a curriculum's name: the child's rank, or the cycle the school is teaching now. */
export function nowLine(entry: Pick<CurriculumAppEntry, 'mode' | 'rank' | 'cycle'>): string {
  if (entry.mode === 'RANK') return entry.rank ? `Current rank: ${entry.rank.name}` : 'No rank yet';
  if (!entry.cycle) return 'Your school has not picked the current cycle yet';
  return entry.cycle.endsOn ? `Now: ${entry.cycle.name}, through ${formatCurriculumDate(entry.cycle.endsOn)}` : `Now: ${entry.cycle.name}`;
}

/** "Coming next" line, or null when the school does not show what is next. */
export function nextLine(entry: Pick<CurriculumAppEntry, 'mode' | 'next'>): string | null {
  if (!entry.next) return null;
  if (entry.mode === 'RANK') return `Next rank: ${entry.next.name}`;
  return entry.next.startsOn ? `Next: ${entry.next.name}, starts ${formatCurriculumDate(entry.next.startsOn)}` : `Next: ${entry.next.name}`;
}

export function sectionTitle(mode: CurriculumAppEntry['mode'], label: CurriculumAppSectionLabel): string {
  if (label === 'ALL') return 'For everyone';
  if (label === 'REVIEW') return 'Earlier ranks to review';
  if (mode === 'RANK') return label === 'CURRENT' ? 'For this rank' : 'Coming next rank';
  return label === 'CURRENT' ? 'This cycle' : 'Next cycle';
}

export const KIND_TEXT: Record<CurriculumAppItem['kind'], { tag: string; action: string }> = {
  VIDEO: { tag: 'VIDEO', action: 'Watch' }, DOCUMENT: { tag: 'DOCUMENT', action: 'Open document' }, LINK: { tag: 'LINK', action: 'Open link' },
};

/** How many items a section shows before "Show all". */
export const SECTION_PREVIEW = 5;
export function hasMaterial(entry: Pick<CurriculumAppEntry, 'sections'>): boolean { return entry.sections.some(s => s.items.length > 0); }
