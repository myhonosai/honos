import type { Metadata } from 'next';
import { HqTrials } from '../../../../components/hq-trials/hq-trials';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Free Trials', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read trial governance. This page changes nothing. */
export default function HqTrialsPage() { return <HqTrials />; }
