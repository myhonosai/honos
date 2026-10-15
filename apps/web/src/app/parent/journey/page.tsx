import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentJourney } from '../../../components/parent-journey';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HON | Family Student Journey', description: 'Verified family-safe current curriculum, schedule and shared recognition.', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function ParentJourneyPage() {
  let authenticated = false;
  try {
    const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE);
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed, including duplicate/malformed/expired cookies */ }
  if (!authenticated) redirect('/auth/login');
  return <ParentJourney />;
}
