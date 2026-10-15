import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentTestingStatus } from '../../../components/parent-testing-status';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Family testing status', description: 'Verified family-safe redacted current testing status.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function ParentTestingPage() {
  let authenticated = false;
  try { const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE); if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <ParentTestingStatus/>;
}
