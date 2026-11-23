import type { Metadata } from 'next';
import { SchoolMedia } from '../../../../components/school-media/school-media';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Media', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The media API decides every permission for the verified school; this page only asks. */
export default async function SchoolMediaPage() { await requireVerifiedWebSession(); return <SchoolMedia />; }
