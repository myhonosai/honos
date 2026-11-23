import type { Metadata } from 'next';
import { StaffRankSetup } from '../../../../components/rank-setup/rank-setup';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Rank setup', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The rank setup API decides every permission for the verified school; this page only asks. */
export default async function RankSetupRoute() { await requireVerifiedWebSession(); return <StaffRankSetup />; }
