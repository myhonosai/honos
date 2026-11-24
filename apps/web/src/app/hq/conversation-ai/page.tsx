import type { Metadata } from 'next';
import { HqConversationAiProgram } from '../../../components/conversation-ai/hq-program';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Conversation AI', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the database decides who may read or change the program switch. */
export default function HqConversationAiPage() { return <HqConversationAiProgram />; }
