import type { Metadata } from 'next';
import { SchoolWebsiteWorkspace } from '../../../../components/school-website/workspace';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Website', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The website API decides every permission; this page only asks and shows the school's own draft. */
export default async function SchoolWebsitePage() { await requireVerifiedWebSession(); return <SchoolWebsiteWorkspace />; }
