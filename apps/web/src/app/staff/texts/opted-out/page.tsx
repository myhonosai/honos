import type { Metadata } from 'next';
import { TextsOptedOut } from '../../../../components/texts/texts-tabs';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Opted out of texts', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Texts > Opted out. The messages API checks communication.consent.read for the verified school; this page only asks. */
export default async function Page() { await requireVerifiedWebSession(); return <TextsOptedOut />; }
