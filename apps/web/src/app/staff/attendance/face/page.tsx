import type { Metadata } from 'next';
import { FaceCheckInScan } from '../../../../components/face-check-in/scan';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Face check-in', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function FaceCheckInScanPage() { await requireVerifiedWebSession(); return <FaceCheckInScan />; }
