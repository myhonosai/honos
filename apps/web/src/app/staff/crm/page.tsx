import type { Metadata } from 'next';
import { LeadPipeline } from '../../../components/lead-pipeline/pipeline';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Leads', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Leads as one pipeline board (0417): it replaces the separate Leads, Enroll a lead and Enrollment journey pages. */
export default async function LeadsPage() { await requireVerifiedWebSession(); return <LeadPipeline />; }
