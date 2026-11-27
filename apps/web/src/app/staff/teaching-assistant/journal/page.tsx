import type { Metadata } from 'next';
import { KaiJournal } from '../../../../components/kai-journal/kai-journal';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Kai teaching journal', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The journal API decides every permission for the verified school; this page only asks. */
export default async function KaiJournalPage() { await requireVerifiedWebSession(); return <KaiJournal />; }
