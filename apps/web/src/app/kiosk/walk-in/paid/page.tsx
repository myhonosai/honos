import { headers } from 'next/headers';
import { WalkInPaidView } from '../../../../components/walk-in-kiosk/visitor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Walk-in', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

/**
 * Where the visitor's phone lands after Stripe's page (paid or not: both come back here). It knows nothing about the payment
 * and reads nothing; the tablet asks the server and shows the result.
 */
export default async function WalkInPaidRoute() {
  const language = ((await headers()).get('accept-language') ?? 'en').split(',')[0] ?? 'en';
  return <WalkInPaidView language={language}/>;
}
