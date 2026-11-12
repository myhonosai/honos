import { FounderSetup } from '../../../components/founder-setup/guide';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON HQ | Founder Setup', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };
export default async function Page(): Promise<React.ReactElement> { await requireVerifiedWebSession(); return <FounderSetup plane="hq" />; }
