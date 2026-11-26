import type { Metadata } from 'next';
import { HqCommunications } from '../../../../components/hq-communications/hq-communications';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON HQ | Texts and email settings', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** HQ senders (email from / texting service) and the full HQ message list. Writing to owners happens in the inbox. */
export default function Page(): React.ReactElement {
  return <HqCommunications target={null}/>;
}
