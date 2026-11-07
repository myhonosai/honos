import type { Metadata } from 'next';
import { CreativeStudio } from '../../../components/creative-studio/creative-studio';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Creative Studio', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The school comes from the shell's verified selection; the wallet API authorizes it again. */
export default async function CreativeStudioPage() {
  await requireVerifiedWebSession();
  return <CreativeStudio />;
}
