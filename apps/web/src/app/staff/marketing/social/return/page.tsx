import type { Metadata } from 'next';
import { SchoolSocialReturn } from '../../../../../components/school-social/social';
import { requireVerifiedWebSession } from '../../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
// no-referrer: the address briefly holds the single-use connection state.
export const metadata: Metadata = { title: 'HON | Finishing connection', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function SocialReturnPage() { await requireVerifiedWebSession(); return <SchoolSocialReturn />; }
