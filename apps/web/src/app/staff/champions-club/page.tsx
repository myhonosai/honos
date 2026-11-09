import type { Metadata } from 'next';
import { ChampionsSchool } from '../../../components/champions-school/champions-school';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Champions Club', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** The Champions Club API decides every permission for the verified school; this page only asks. */
export default async function ChampionsClubPage() { await requireVerifiedWebSession(); return <ChampionsSchool />; }
