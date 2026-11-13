import type { Metadata } from 'next';
import { SchoolOnboarding } from '../../../components/school-onboarding/welcome';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Welcome and setup', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The onboarding API decides every permission and step status for the verified school; this page only asks. */
export default async function WelcomePage() { await requireVerifiedWebSession(); return <SchoolOnboarding />; }
