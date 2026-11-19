import type { Metadata } from 'next';
import { TextsSend } from '../../../../components/texts/texts-send';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Send a text', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Texts > Send. The messages API checks the send permission and the contact's consent; this page only asks. */
export default async function TextsSendPage() { await requireVerifiedWebSession(); return <TextsSend />; }
