import type { Metadata } from 'next';
import { HqAiSafety } from '../../../components/hq-ai-control/hq-ai-control';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | AI Safety', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read, pause, resume or settle. */
export default function HqAiSafetyPage() { return <HqAiSafety />; }
