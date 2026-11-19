import type { Metadata } from 'next';
import { StaffConversations } from '../../../components/conversations/staff-conversations';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Texts', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Texts > Conversations (0364). The conversations API decides every permission for the verified school; this page only asks. */
export default async function TextsPage() { await requireVerifiedWebSession(); return <StaffConversations />; }
