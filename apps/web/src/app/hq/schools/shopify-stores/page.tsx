import type { Metadata } from 'next';
import { HqShopRequests } from '../../../../components/hq-shop-requests/hq-shop-requests';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Shopify store requests', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the API decides HQ authority (owner, or an operator with billing access) on every read and command. */
export default function HqShopifyStoreRequestsPage(): React.ReactElement { return <HqShopRequests/>; }
