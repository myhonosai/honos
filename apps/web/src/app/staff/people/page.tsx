import type { Metadata } from 'next';
import { People } from '../../../components/people/people';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | People', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function PeoplePage() { await requireVerifiedWebSession(); return <People />; }
