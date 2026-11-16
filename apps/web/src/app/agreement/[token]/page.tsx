import type { Metadata } from 'next';
import { SigningPage } from '../../../components/membership-agreement/signing';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Membership agreement', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The family's signing link (0410). No account: the token in the link is the only key, and the server decides everything. */
export default async function MembershipAgreementSigningPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SigningPage token={/^[A-Za-z0-9_-]{43}$/.test(token) ? token : 'invalid'} />;
}
