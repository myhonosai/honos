import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentMessageHistory } from '../../../components/parent-message-history';
import { ParentSchoolMessages } from '../../../components/family-messages/parent-school-messages';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';
export const metadata = { title: 'HON | School message history', description: 'Verified guardian-family school message history availability.', referrer: 'no-referrer', robots: { index: false, follow: false } };

export default async function ParentMessageHistoryPage() {
  let authenticated = false;
  try { const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE); if (token) { verifySession(token, sessionConfig()); authenticated = true; } } catch { /* fail closed */ }
  if (!authenticated) redirect('/auth/login');
  return <><ParentSchoolMessages /><ParentMessageHistory /></>;
}
