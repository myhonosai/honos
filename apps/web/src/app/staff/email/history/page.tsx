import type { Metadata } from 'next';
import { EmailHistory } from '../../../../components/texts/texts-tabs';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Email history', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Email > History. Read only. The messages API checks communication.message.read for the verified school; this page only asks. */
export default async function Page() { await requireVerifiedWebSession(); return <EmailHistory />; }
