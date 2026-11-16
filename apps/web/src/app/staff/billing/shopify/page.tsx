import type { Metadata } from 'next';
import { SchoolShopify } from '../../../../components/school-shopify/shopify';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Shopify', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The Shopify API decides every permission and whether connecting is turned on; this page only asks. */
export default async function ShopifyPage() { await requireVerifiedWebSession(); return <SchoolShopify />; }
