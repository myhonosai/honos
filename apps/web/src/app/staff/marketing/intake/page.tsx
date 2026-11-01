import React from 'react';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, sessionConfig, verifySession } from '@hon/auth';
import { LeadSourcesIntakeMonitor } from '../../../../components/lead-sources-intake-monitor';

export const dynamic = 'force-dynamic';

export default async function LeadSourcesIntakePage(): Promise<React.ReactElement> {
  // The shared staff layout gates this page. Rechecking here yields an opaque
  // React key that clears only in-memory monitor facts when the signed session
  // changes; the raw cookie is never serialized and APIs remain authoritative.
  const token = (await cookies()).get(HON_SESSION_COOKIE)?.value ?? '';
  try {
    verifySession(token, sessionConfig());
  } catch {
    redirect('/auth/login');
  }
  const sessionViewKey = createHash('sha256').update(token).digest('hex');
  return <LeadSourcesIntakeMonitor key={sessionViewKey} />;
}
