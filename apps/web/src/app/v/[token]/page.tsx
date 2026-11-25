import type { Metadata } from 'next';
import { PublicVideoPage } from '../../../components/school-video/public-video';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Video', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** A school video's page (0654): no account and no tenant id; the link token alone names the video and the server decides. */
export default async function PublicVideoRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicVideoPage token={/^[A-Za-z0-9_-]{43}$/.test(token) ? token : 'invalid'}/>;
}
