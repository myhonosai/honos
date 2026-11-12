import type { Metadata } from 'next';
import { MayaAtRisk } from '../../../../components/maya-at-risk/maya-at-risk';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Students at risk', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The at-risk API decides every permission for the verified school; this page only asks. */
export default async function StudentsAtRiskPage() { await requireVerifiedWebSession(); return <MayaAtRisk />; }
