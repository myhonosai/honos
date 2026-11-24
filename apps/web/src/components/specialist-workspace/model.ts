import { ATTENDANCE_STATUSES, type AttendanceStatus, type CreativeGeneration, type CurrentSchoolClassSession, type MembershipPlanListing, type OperationalSnapshot, type SchoolReportPeriod, type SchoolReports } from '@hon/contracts';
import type { HonDelegateTarget } from '../hon-command/hon-suggestions';

/**
 * Workspaces for the four read-only analysis specialists (0260 / K2). Each page shows the facts that specialist reads
 * from existing protected GET reads, and asks that specialist one question at a time. Nothing here writes or sends.
 */
export const SPECIALIST_KEYS = ['alex', 'jordan', 'claire', 'lena'] as const;
export type SpecialistKey = typeof SPECIALIST_KEYS[number];
export const isSpecialistKey = (value: unknown): value is SpecialistKey => (SPECIALIST_KEYS as readonly unknown[]).includes(value);
export const specialistWorkspaceHref = (agent: SpecialistKey): string => `/staff/ai-team/${agent}`;

/** At most this many classes are listed for Jordan's week; the count above the list is the full loaded number. */
export const JORDAN_WEEK_LIST_MAX = 10;
const DAY = 86_400_000;

/** Non-cancelled classes starting in [now, now + 7 days), earliest first. */
export function weekSessions(sessions: readonly CurrentSchoolClassSession[], now: Date): CurrentSchoolClassSession[] {
  const from = now.getTime(), to = from + 7 * DAY;
  return sessions.filter(s => s.status !== 'CANCELLED' && Date.parse(s.startsAt) >= from && Date.parse(s.startsAt) < to)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** The attendance outcomes in the staff dashboard window, in a fixed order, plus the days the window covers. */
export function attendanceOutcomes(snapshot: OperationalSnapshot): { days: number; rows: { key: AttendanceStatus; value: number }[] } {
  const days = Math.max(1, Math.round((Date.parse(snapshot.to) - Date.parse(snapshot.from)) / DAY));
  return { days, rows: ATTENDANCE_STATUSES.map(key => ({ key, value: snapshot.attendance.inRangeByStatus[key] })) };
}

/** Newest month first, at most `limit` months. */
export function recentMonths(reports: SchoolReports, limit = 3): SchoolReportPeriod[] {
  return [...reports.periods].sort((a, b) => b.month.localeCompare(a.month)).slice(0, limit);
}

/** Campaigns by status from the same list Marcus uses (archived campaigns are already left out). */
export function campaignCounts(targets: readonly HonDelegateTarget[]): { status: 'DRAFT' | 'ACTIVE' | 'PAUSED'; count: number }[] {
  return (['ACTIVE', 'DRAFT', 'PAUSED'] as const).map(status => ({ status, count: targets.filter(t => t.detail === status.toLowerCase()).length }));
}

/** Plans open for sale now, cheapest first within each currency. */
export function publishedPlans(plans: readonly MembershipPlanListing[]): MembershipPlanListing[] {
  return plans.filter(p => p.availability === 'AVAILABLE').sort((a, b) => a.currency.localeCompare(b.currency) || a.priceMinor - b.priceMinor || a.displayName.localeCompare(b.displayName));
}

/** Creative Studio work created in the last 30 days, by status. Only the loaded records (at most 50) are counted. */
export function recentCreative(generations: readonly CreativeGeneration[], now: Date): { total: number; byStatus: { status: string; count: number }[] } {
  const since = now.getTime() - 30 * DAY;
  const recent = generations.filter(g => Date.parse(g.createdAt) >= since);
  const counts = new Map<string, number>();
  for (const g of recent) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
  return { total: recent.length, byStatus: [...counts].map(([status, count]) => ({ status, count })).sort((a, b) => a.status.localeCompare(b.status)) };
}
