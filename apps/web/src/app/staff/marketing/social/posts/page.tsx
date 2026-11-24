import type { Metadata } from 'next';
import { SchoolSocialPosts } from '../../../../../components/school-social-posts/posts';
import { requireVerifiedWebSession } from '../../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Posts', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The social API decides every permission and whether publishing is turned on; this page only asks. */
export default async function SocialPostsPage() { await requireVerifiedWebSession(); return <SchoolSocialPosts />; }
