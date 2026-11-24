import type { Metadata } from 'next';
import { TextsSend } from '../../../../components/texts/texts-send';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Send a text', referrer: 'no-referrer', robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Props = { searchParams: Promise<{ template?: unknown }> };

/** Texts > Send. The messages API checks the send permission and the contact's consent; this page only asks. ?template= only pre-fills the message. */
export default async function TextsSendPage({ searchParams }: Props) {
  await requireVerifiedWebSession();
  const template = (await searchParams).template;
  return <TextsSend templateId={typeof template === 'string' && UUID.test(template) ? template.toLowerCase() : null} />;
}
