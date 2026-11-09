import type { Metadata } from 'next';
import { MembershipList } from '../../../components/membership-list/membership-list';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Memberships', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function MembershipListPage() { await requireVerifiedWebSession(); return <MembershipList />; }
