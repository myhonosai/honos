import type { Metadata } from 'next';
import { ClassSeriesPage } from '../../../../components/class-series/class-series';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Weekly timetable', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The class series API decides every permission for the verified school; this page only asks. */
export default async function WeeklyTimetablePage() { await requireVerifiedWebSession(); return <ClassSeriesPage />; }
