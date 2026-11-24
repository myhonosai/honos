import type { Metadata } from 'next';
import { SchoolPos } from '../../../../components/school-pos/school-pos';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Point of Sale', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The Point of Sale API decides every permission for the verified school and prices every sale; this page only asks. */
export default async function PointOfSalePage() { await requireVerifiedWebSession(); return <SchoolPos />; }
