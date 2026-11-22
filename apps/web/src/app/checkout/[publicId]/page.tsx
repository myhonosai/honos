import type { Metadata } from 'next';
import { PublicCheckoutPage } from '../../../components/school-checkout/public-checkout';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign up', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** A checkout page's family link (0620): no account and no tenant id; the link id alone names the page and the server decides what is shown. */
export default async function PublicCheckoutRoute({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return <PublicCheckoutPage publicId={/^[a-f0-9]{48}$/.test(publicId) ? publicId : 'invalid'}/>;
}
