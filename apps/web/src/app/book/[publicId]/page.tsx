import type { Metadata } from 'next';
import { PublicEventPage } from '../../../components/school-events/public-event';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Book a time', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Family booking link: no account and no tenant id; the link id alone names the event and the server decides everything. */
export default async function PublicEventRoute({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <PublicEventPage publicId={/^[a-f0-9]{48}$/.test(publicId) ? publicId : 'invalid'} />;
}
