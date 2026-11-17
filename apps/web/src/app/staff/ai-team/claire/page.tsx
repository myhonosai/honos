import type { Metadata } from 'next';
import { SpecialistWorkspace } from '../../../../components/specialist-workspace/workspace';
import { requireVerifiedWebSession } from '../../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Claire workspace', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Each read on this page re-authorizes the verified school; this page only asks. */
export default async function ClaireWorkspacePage() { await requireVerifiedWebSession(); return <SpecialistWorkspace agent="claire" />; }
