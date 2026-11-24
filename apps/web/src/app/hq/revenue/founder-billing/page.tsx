import type { Metadata } from 'next';
import { HqFounderBilling } from '../../../../components/hq-founder-billing/hq-founder-billing';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Founder Billing', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read the founder pool and the paid review queue. */
export default function HqFounderBillingPage() { return <HqFounderBilling />; }
