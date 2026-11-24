import type { Metadata } from 'next';
import { SchoolDemoDataSettings } from '../../../../components/school-demo-data/school-demo-data';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Demo data', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The demo data API decides every permission for the verified school; this page only asks. */
export default async function SchoolDemoDataPage() { await requireVerifiedWebSession(); return <SchoolDemoDataSettings />; }
