import type { Metadata } from 'next';
import { AiDraftWorkInbox } from '../../../components/ai-draft-work-inbox';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'My AI Draft Work | HON',
  robots: { index: false, follow: false },
};

export default function AiDraftWorkPage() {
  return <AiDraftWorkInbox />;
}
