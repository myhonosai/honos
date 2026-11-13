import type { Metadata } from 'next';
import { StaffFamilyInbox } from '../../../components/family-messages/staff-family-inbox';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Family messages', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The family messages API decides every permission for the verified school; this page only asks. */
export default async function FamilyMessagesPage() { await requireVerifiedWebSession(); return <StaffFamilyInbox />; }
