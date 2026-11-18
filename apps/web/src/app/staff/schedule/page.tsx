import type { Metadata } from 'next';
import { SchoolSchedulePage } from '../../../components/school-calendar/schedule-page';
import { parseCalendarTab, parseCalendarView } from '../../../components/school-calendar/range';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Calendar', referrer: 'no-referrer', robots: { index: false, follow: false } };

type CalendarPageProps = { searchParams: Promise<Record<string, unknown>> };

/** One page for the schedule. `tab` and `view` take closed values only; every read and write is re-checked by its API. */
export default async function SchoolCalendarRoute({ searchParams }: CalendarPageProps) {
  await requireVerifiedWebSession();
  const query = await searchParams;
  return <SchoolSchedulePage initialTab={parseCalendarTab(query.tab)} initialView={parseCalendarView(query.view)}/>;
}
