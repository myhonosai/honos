import type { Metadata } from 'next';
import { StaffConversations } from '../../../components/conversations/staff-conversations';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Conversations', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The conversations API decides every permission for the verified school; this page only asks. */
export default async function ConversationsPage() { await requireVerifiedWebSession(); return <StaffConversations />; }
