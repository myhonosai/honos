import type { Metadata } from 'next';
import { MembershipChanges } from '../../../../components/membership-changes/membership-changes';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Pause, cancel & refunds', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The membership API decides every permission for the verified school; this page only asks. */
export default async function MembershipChangesPage() { await requireVerifiedWebSession(); return <MembershipChanges />; }
