import type { Metadata } from 'next';
import { PublicCalendarPage } from '../../../components/school-calendar/public-calendar';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Class calendar', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Shared class calendar link (0552): no account and no tenant id; the link id alone names the calendar and the server decides what it shows. */
export default async function PublicCalendarRoute({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <PublicCalendarPage publicId={/^[a-f0-9]{48}$/.test(publicId) ? publicId : 'invalid'} />;
}
