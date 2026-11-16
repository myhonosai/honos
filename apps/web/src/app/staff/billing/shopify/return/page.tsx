import type { Metadata } from 'next';
import { SchoolShopifyReturn } from '../../../../../components/school-shopify/shopify';
import { requireVerifiedWebSession } from '../../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
// no-referrer: the address briefly holds Shopify's single-use signed answer.
export const metadata: Metadata = { title: 'HON | Finishing Shopify connection', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ShopifyReturnPage() { await requireVerifiedWebSession(); return <SchoolShopifyReturn />; }
