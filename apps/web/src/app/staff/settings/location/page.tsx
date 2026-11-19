import type { Metadata } from 'next';
import { SchoolLocationSettings } from '../../../../components/school-location/school-location';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | School location', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The school location API decides every permission for the verified school; this page only asks. */
export default async function SchoolLocationPage() { await requireVerifiedWebSession(); return <SchoolLocationSettings />; }
