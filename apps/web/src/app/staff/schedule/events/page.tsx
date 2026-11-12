import type { Metadata } from 'next';
import { SchoolEventsPage } from '../../../../components/school-events/school-events';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Sale days & events', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The school event API decides every permission for the verified school; this page only asks. */
export default async function SchoolEventsRoute() { await requireVerifiedWebSession(); return <SchoolEventsPage />; }
