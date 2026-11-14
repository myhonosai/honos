import type { Metadata } from 'next';
import { SchoolSocial } from '../../../../components/school-social/social';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Social accounts', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The social API decides every permission and whether connecting is turned on; this page only asks. */
export default async function SocialAccountsPage() { await requireVerifiedWebSession(); return <SchoolSocial />; }
