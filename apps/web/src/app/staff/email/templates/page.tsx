import type { Metadata } from 'next';
import { EmailTemplates } from '../../../../components/texts/texts-tabs';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Email templates', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Email > Templates. The templates API checks communication.template.read and .manage for the verified school; this page only asks. */
export default async function Page() { await requireVerifiedWebSession(); return <EmailTemplates />; }
