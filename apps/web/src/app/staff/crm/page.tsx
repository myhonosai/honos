import type { Metadata } from 'next';
import { Leads } from '../../../components/leads/leads';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Leads', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function LeadsPage() { await requireVerifiedWebSession(); return <Leads />; }
