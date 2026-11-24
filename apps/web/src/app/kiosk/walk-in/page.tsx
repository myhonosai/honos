import { WalkInVisitorPage } from '../../../components/walk-in-kiosk/visitor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Walk-in', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

/** The visitor tablet. Public: no session, no roster. It only works with the token handed over in memory by the staff page. */
export default function WalkInVisitorRoute() { return <WalkInVisitorPage />; }
