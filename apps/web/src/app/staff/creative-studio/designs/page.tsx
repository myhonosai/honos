import type { Metadata } from 'next';
import { Designs } from '../../../../components/design-editor/designs';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Designs', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Flyers, posters, postcards and social posts. The school comes from the shell; the designs API authorizes it again. */
export default async function CreativeDesignsPage() {
  await requireVerifiedWebSession();
  return <Designs />;
}
