import { HqPricingOffers } from '../../../components/hq-modern/pricing-offers';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Pricing & Offers', robots: { index: false, follow: false } };
export default function Page(): React.ReactElement { return <HqPricingOffers />; }
