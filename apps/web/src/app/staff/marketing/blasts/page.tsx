import type { Metadata } from 'next';
import { SchoolBlasts } from '../../../../components/school-blasts/school-blasts';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Blasts', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The blasts API decides every permission for the verified school; this page only asks. */
export default async function SchoolBlastsPage() { await requireVerifiedWebSession(); return <SchoolBlasts />; }
