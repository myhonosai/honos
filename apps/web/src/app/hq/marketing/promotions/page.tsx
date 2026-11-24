import type { Metadata } from 'next';
import { HqPlanPromotions } from '../../../../components/hq-plan-promotions/hq-plan-promotions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Plan promotions', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the promotions API decides HQ marketing authority on every read and HQ-owner authority on every command. */
export default function HqPlanPromotionsPage(): React.ReactElement { return <HqPlanPromotions/>; }
