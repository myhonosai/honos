import type { Metadata } from 'next';
import { TrainAi } from '../../../../components/conversation-ai/train-ai';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Train AI', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The conversation AI API decides every permission for the verified school; this page only asks. */
export default async function TrainAiPage() { await requireVerifiedWebSession(); return <TrainAi />; }
