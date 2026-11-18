import type { Metadata } from 'next';
import { AgreementSigningPage } from '../../../components/agreement-link/signing-page';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Membership agreement', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** 0499 family signing link: no account and no tenant id; the token alone names the link and the server decides everything. */
export default async function AgreementLinkRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <AgreementSigningPage token={/^[A-Za-z0-9_-]{43}$/.test(token) ? token : 'invalid'} />;
}
