import type { JourneyBooking, JourneyChild, JourneyProgram, ParentJourneyView } from '@hon/contracts/parent-journey-view';

/**
 * Pure view logic for Home and Journey. The journey contract carries no child identifiers, so a child is addressed
 * by its position in the current verified response. A selection is a display filter only and is never sent to the API.
 */
export type ChildSelection = 'all' | number;

export interface NextClass { childName: string; childKey: string; booking: JourneyBooking }

export function nextClass(view: ParentJourneyView, selection: ChildSelection, now: Date): NextClass | null {
  const children = selection === 'all' ? view.children.map((c, i) => [c, i] as const)
    : view.children[selection] ? [[view.children[selection]!, selection] as const] : [];
  let best: NextClass | null = null;
  for (const [child, index] of children) {
    if (child.schedule.status !== 'AVAILABLE') continue;
    for (const booking of child.schedule.items) {
      if (Date.parse(booking.startsAt) <= now.getTime()) continue;
      if (booking.bookingStatus === 'CANCELLED' || booking.sessionStatus === 'CANCELLED') continue;
      if (!best || Date.parse(booking.startsAt) < Date.parse(best.booking.startsAt)) best = { childName: child.name, childKey: `child-${index}`, booking };
    }
  }
  return best;
}

const BOOKING_LABELS: Record<JourneyBooking['bookingStatus'], string> = {
  BOOKED: 'Booked', WAITLISTED: 'Waitlisted', CANCELLED: 'Cancelled', CHECKED_IN: 'Checked in', NO_SHOW: 'Missed',
};
export function bookingLabel(status: JourneyBooking['bookingStatus']): string { return BOOKING_LABELS[status]; }

export function requirementCounts(program: JourneyProgram) {
  if (program.requirements.status !== 'AVAILABLE') return { met: 0, recorded: 0, total: 0, available: false };
  const items = program.requirements.items;
  return { met: items.filter(r => r.status === 'MET').length, recorded: items.filter(r => r.status !== null).length, total: items.length, available: true };
}

export interface ChildSummary { key: string; index: number; name: string; profileAvailable: boolean; program: string | null; rank: string | null; latestAchievement: string | null }

export function childSummaries(view: ParentJourneyView): ChildSummary[] {
  return view.children.map((child, index) => {
    const program = child.programs[0] ?? null;
    const latest = child.achievements.status === 'AVAILABLE'
      ? [...child.achievements.items].sort((a, b) => b.awardedOn.localeCompare(a.awardedOn))[0]?.name ?? null : null;
    return { key: `child-${index}`, index, name: child.name, profileAvailable: child.profileAvailable, program: program?.name ?? null, rank: program?.rank ?? null, latestAchievement: latest };
  });
}

export function formatClassTime(iso: string, timeZone: string | null): { text: string; zoneNote: string | null } {
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  const text = new Intl.DateTimeFormat('en-US', timeZone ? { ...options, timeZone } : options).format(new Date(iso));
  return { text, zoneNote: timeZone ? null : "Shown in your phone's time zone" };
}

export function upcomingFor(child: JourneyChild, now: Date, limit: number): JourneyBooking[] {
  if (child.schedule.status !== 'AVAILABLE') return [];
  return child.schedule.items.filter(b => Date.parse(b.startsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, limit);
}

/** Award dates are calendar dates (YYYY-MM-DD); format in UTC so the day never shifts with the phone's zone. */
export function formatAwardDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}
