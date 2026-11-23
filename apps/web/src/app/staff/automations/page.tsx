import type { Metadata } from 'next';
import { Automations } from '../../../components/automations/automations';
import { requireVerifiedWebSession } from '../../../server/require-web-session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'HON | Automations', referrer: 'no-referrer', robots: { index: false, follow: false } };

/** Automations (AU-1/AU-2): the school's automations, ready-made recipes and the step-by-step builder. */
export default async function AutomationsPage() { await requireVerifiedWebSession(); return <Automations />; }
