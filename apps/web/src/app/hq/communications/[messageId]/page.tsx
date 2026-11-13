import type { Metadata } from 'next';
import { HqMessage } from '../../../../components/hq-communications/hq-message';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | HQ message', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The HQ layout verifies the session; the communications API decides HQ authority by purpose on every read and command. */
export default async function HqMessagePage({ params }: { params: Promise<{ messageId: string }> }): Promise<React.ReactElement> {
  const { messageId } = await params;
  return <HqMessage key={messageId} messageId={messageId}/>;
}
