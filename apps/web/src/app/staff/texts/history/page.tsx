import type { Metadata } from 'next';
import { TextsHistory } from '../../../../components/texts/texts-tabs';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Text history', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Texts > History is read only. The messages API checks communication.message.read for the verified school; this page only asks. */
export default async function Page() { await requireVerifiedWebSession(); return <TextsHistory />; }
