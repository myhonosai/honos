import type { Metadata } from 'next';
import { EmailSend } from '../../../components/texts/texts-send';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Send an email', referrer: 'no-referrer', robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ template?: unknown }> };

/** Email > Send (TE4). The messages API checks the send permission and the contact's email consent; this page only asks. ?template= only pre-fills the email. */
export default async function EmailSendPage({ searchParams }: Props) {
  await requireVerifiedWebSession();
  const template = (await searchParams).template;
  return <EmailSend templateId={typeof template === 'string' && UUID.test(template) ? template.toLowerCase() : null} />;
}
