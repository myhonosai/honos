import type { Metadata } from 'next';
import { TextsTemplates } from '../../../../components/texts/texts-tabs';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Text templates', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Texts > Templates. The templates API checks communication.template.read and .manage for the verified school; this page only asks. */
export default async function Page() { await requireVerifiedWebSession(); return <TextsTemplates />; }
