import type { Metadata } from 'next';
import { SchoolBrandingSettings } from '../../../../components/school-branding/school-branding';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | School branding', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The branding settings API decides every permission for the verified school; this page only asks. */
export default async function SchoolBrandingPage() { await requireVerifiedWebSession(); return <SchoolBrandingSettings />; }
