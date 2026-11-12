import type { Metadata } from 'next';
import { HqCreativeCredits } from '../../../components/hq-creative-credits/hq-creative-credits';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Creative Credits', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read creative credit wallets. This page changes nothing. */
export default function HqCreativeCreditsPage() { return <HqCreativeCredits />; }
