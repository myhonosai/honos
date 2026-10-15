import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HON_SESSION_COOKIE, cookieValue, sessionConfig, verifySession } from '@hon/auth';
import { ParentHome } from '../../components/parent-home';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'HON | Parent Home',
  description: 'Verified family navigation to available HON information.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export default async function ParentPage() {
  let authenticated = false;
  try {
    const token = cookieValue((await headers()).get('cookie'), HON_SESSION_COOKIE);
    if (token) { verifySession(token, sessionConfig()); authenticated = true; }
  } catch { /* fail closed, including duplicate, malformed, expired, or unconfigured cookies */ }
  if (!authenticated) redirect('/auth/login');
  return <ParentHome />;
}
