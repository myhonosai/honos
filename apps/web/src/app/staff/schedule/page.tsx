import type { Metadata } from 'next';
import { ClassRoster } from '../../../components/class-roster/class-roster';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Class rosters', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ClassRosterPage() { await requireVerifiedWebSession(); return <ClassRoster />; }
