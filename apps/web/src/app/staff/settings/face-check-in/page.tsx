import type { Metadata } from 'next';
import { FaceCheckInSettings } from '../../../../components/face-check-in/settings';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Face check-in', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The face check-in API decides every permission for the verified school; this page only asks. */
export default async function FaceCheckInSettingsPage() { await requireVerifiedWebSession(); return <FaceCheckInSettings />; }
