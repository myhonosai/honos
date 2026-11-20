import type { Metadata } from 'next';
import { SchoolReferralsWorkbench } from '../../../../components/family-referrals/staff-referrals';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Family referrals', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function FamilyReferralsPage() { await requireVerifiedWebSession(); return <SchoolReferralsWorkbench />; }
