import type { Metadata } from 'next';
import { PublicReferralPage } from '../../../components/family-referrals/public-referral';

export const metadata: Metadata = { title: 'You are invited', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ReferPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const lower = code.toLowerCase(); // a messaging app may change the case of the link
  return <PublicReferralPage code={/^[0-9a-f]{16}$/.test(lower) ? lower : 'invalid'} />;
}
