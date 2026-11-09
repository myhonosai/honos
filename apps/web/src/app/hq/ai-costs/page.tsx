import type { Metadata } from 'next';
import { HqAiCosts } from '../../../components/hq-ai-control/hq-ai-control';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | AI Costs', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the AI usage API decides HQ billing authority on every read. */
export default function HqAiCostsPage() { return <HqAiCosts />; }
