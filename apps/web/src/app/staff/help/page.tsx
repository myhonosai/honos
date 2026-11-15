import type { Metadata } from 'next';
import { SchoolSupport } from '../../../components/school-support/help';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Ask for help', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The support API decides every permission and what this school may see; this page only asks. */
export default async function HelpPage() { await requireVerifiedWebSession(); return <SchoolSupport />; }
