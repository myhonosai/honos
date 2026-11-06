import React from 'react';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
import { SchoolHome } from '../../../components/home/home';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Staff Operations Dashboard', description: 'Verified school home: today’s operations, AI team readiness and HON.', referrer: 'no-referrer', robots: { index: false, follow: false } };

/**
 * School Home. Fails closed without a verified session. The school comes from the shell's
 * server-verified selection (the URL prefill is only a candidate); every panel's API
 * re-authorizes the exact school.
 */
export default async function StaffDashboardPage(): Promise<React.ReactElement> {
  await requireVerifiedWebSession();
  return <SchoolHome />;
}
