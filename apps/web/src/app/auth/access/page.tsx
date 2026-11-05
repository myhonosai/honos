import React from 'react';
import { requireVerifiedWebSession } from '../../../server/require-web-session';
import { AccessNotice } from '../../../components/school-entry/access-notice';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Access not verified', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

export default async function AccessPage(): Promise<React.ReactElement> {
  await requireVerifiedWebSession();
  return <AccessNotice />;
}
