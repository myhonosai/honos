import type { Metadata } from 'next';
import { SchoolReportsPage } from '../../../components/school-reports/school-reports';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | School reports', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function SchoolReportsRoute() { await requireVerifiedWebSession(); return <SchoolReportsPage />; }
