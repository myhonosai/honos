import type { Metadata } from 'next';
import { AiTeamPage } from '../../../components/ai-team/ai-team-page';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | AI team', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Read-only roster. The readiness API decides every permission for the verified school; this page only asks. */
export default async function AiTeamRoute() { await requireVerifiedWebSession(); return <AiTeamPage />; }
